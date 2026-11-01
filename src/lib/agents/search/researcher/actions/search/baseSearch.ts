// TypeScript: runs a search action's queries and turns the results into ranked, selected evidence passages (M2).
import BaseEmbedding from '@/lib/models/base/embedding';
import BaseLLM from '@/lib/models/base/llm';
import {
  searchSearxng,
  SearxngSearchOptions,
  SearxngSearchResult,
} from '@/lib/searxng';
import SessionManager from '@/lib/session';
import { Chunk, ResearchBlock, SearchResultsResearchBlock } from '@/lib/types';
import { SearchAgentConfig } from '../../../types';
import z from 'zod';
import Scraper, { MIN_TEXT_CHARS } from '@/lib/scraper';
import { splitText } from '@/lib/utils/splitText';
import { normalizeUrl } from '@/lib/utils/normalizeUrl';
import { chunkDocument, chunkText } from '@/lib/utils/chunkDocument';
import {
  Evidence,
  evidenceToChunk,
  pageToEvidence,
  selectEvidence,
  snippetToEvidence,
} from '@/lib/evidence';
import { getReranker, Reranker, rerankSafely } from '@/lib/rerank';
import {
  getBalancedReadsPages,
  getEvidenceBudget,
  getRerankerKind,
} from '@/lib/config/serverRegistry';

type Trace = InstanceType<typeof SessionManager>['trace'];

/* Mode settings for the evidence pipeline. */
// How many top sources balanced and quality mode fetch and read.
const PAGES_TO_READ = { balanced: 6, quality: 10 } as const;
// How many pages are fetched at the same time.
const FETCH_CONCURRENCY = 4;
// Only the first chunks of a long page go to the reranker, so a 2-core box
// scores at most ~120 passages per search (about 8 s on the deploy box).
const MAX_CHUNKS_PER_PAGE = 12;
// Passages per source and the number of distinct sources to aim for.
const MAX_PER_SOURCE = 4;
const MIN_SOURCES = 3;
// Rerank time limits; on timeout the embedding reranker is used instead.
const SNIPPET_RERANK_TIMEOUT_MS = 10000;
const PASSAGE_RERANK_TIMEOUT_MS = 30000;

/* Runs one SearXNG query. A failing query is recorded on the trace and
   returns null, so the other queries of the same search still count. */
const searchOrNull = async (
  q: string,
  opts: SearxngSearchOptions,
  trace: Trace,
) => {
  try {
    return await searchSearxng(q, opts, trace);
  } catch (err) {
    console.log(`SearXNG query failed for "${q}":`, err);
    trace.error('search.query', err);
    return null;
  }
};

// Runs fn over items with at most `limit` running at once; keeps order.
const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
};

// Pushes the research block's sub-steps to the UI.
const pushSubSteps = (
  session: InstanceType<typeof SessionManager>,
  researchBlock: ResearchBlock,
) =>
  session.updateBlock(researchBlock.id, [
    {
      op: 'replace',
      path: '/data/subSteps',
      value: researchBlock.data.subSteps,
    },
  ]);

type SearchInput = {
  queries: string[];
  mode: SearchAgentConfig['mode'];
  searchConfig?: SearxngSearchOptions;
  researchBlock: ResearchBlock;
  session: InstanceType<typeof SessionManager>;
  llm: BaseLLM<any>;
  embedding: BaseEmbedding<any>;
  // The standalone question; passages are ranked against it. When missing,
  // the queries joined by spaces are used.
  question?: string;
};

/*
  Flow (M2):
  1. Every query goes to SearXNG; each result becomes one search_snippet
     passage, deduplicated by normalised URL (queries and best rank kept).
  2. Speed (and balanced with page reading off): rerank the snippets
     against the question, select within the budget, return.
  3. Balanced and quality: rerank the snippets, fetch the top 6 (10) new
     sources, chunk each page by section, rerank page passages plus the
     snippets of pages that could not be read, select, return.
  4. Quality with reranker 'off': the pre-M2 LLM picker and extractor.
*/
export const executeSearch = async (input: SearchInput): Promise<Chunk[]> => {
  const researchBlock = input.researchBlock;
  /* Per-request tracer; a no-op unless tracing is on. */
  const trace = input.session.trace;
  const question = input.question?.trim() || input.queries.join(' ');

  researchBlock.data.subSteps.push({
    id: crypto.randomUUID(),
    type: 'searching',
    searching: input.queries,
  });
  pushSubSteps(input.session, researchBlock);

  /* ---- 1. Search ---- */

  const searchResultsBlockId = crypto.randomUUID();
  let searchResultsEmitted = false;

  // One snippet passage per source, keyed by normalised URL.
  const snippets = new Map<string, Evidence>();
  // The results in the pre-M2 shape, for the legacy quality path only.
  const legacyResults: Chunk[] = [];
  let failedQueries = 0;

  // Shows this query's results in the UI's search_results step.
  const emitSearchResults = (chunks: Chunk[]) => {
    if (!searchResultsEmitted) {
      searchResultsEmitted = true;
      researchBlock.data.subSteps.push({
        id: searchResultsBlockId,
        type: 'search_results',
        reading: chunks,
      });
    } else {
      const subStep = researchBlock.data.subSteps.find(
        (step) => step.id === searchResultsBlockId,
      ) as SearchResultsResearchBlock | undefined;
      subStep?.reading.push(...chunks);
    }
    pushSubSteps(input.session, researchBlock);
  };

  const search = async (q: string) => {
    const res = await searchOrNull(
      q,
      {
        ...(input.searchConfig ? input.searchConfig : {}),
      },
      trace,
    );

    if (!res) {
      failedQueries++;
      return;
    }

    const results: SearxngSearchResult[] = Array.isArray(res.results)
      ? res.results.filter((r) => r && typeof r.url === 'string')
      : [];
    const shown: Chunk[] = [];

    results.forEach((r, i) => {
      legacyResults.push({
        content: r.content || r.title,
        metadata: {
          title: r.title,
          url: r.url,
          similarity: 1,
          embedding: [],
        },
      });

      const snippet = snippetToEvidence(r, q, i + 1);
      const existing = snippets.get(snippet.canonicalUrl);

      if (existing) {
        // Same page from another query: remember the query and best rank.
        if (!existing.queries.includes(q)) existing.queries.push(q);
        if (snippet.rank !== undefined)
          existing.rank = Math.min(existing.rank ?? Infinity, snippet.rank);
        if (snippet.engines)
          existing.engines = [
            ...new Set([...(existing.engines ?? []), ...snippet.engines]),
          ];
        if (!existing.text || existing.text === existing.title)
          existing.text = snippet.text;
      } else {
        snippets.set(snippet.canonicalUrl, snippet);
      }

      shown.push(evidenceToChunk(snippet));
    });

    emitSearchResults(shown);
  };

  await Promise.all(input.queries.map(search));

  // Every query failed: nothing to rank or read.
  if (input.queries.length > 0 && failedQueries === input.queries.length) {
    return [];
  }

  /* ---- 4. Legacy quality path ---- */

  if (input.mode === 'quality' && getRerankerKind() === 'off') {
    return legacyQualitySearch(input, legacyResults);
  }

  // Best search rank first, so 'off' and ties keep the engine's order.
  const candidates = [...snippets.values()].sort(
    (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity),
  );
  if (candidates.length === 0) return [];

  const reranker = await getReranker(input.embedding, trace);
  const baseBudget = getEvidenceBudget();
  const budget =
    input.mode === 'quality' ? Math.round(baseBudget * 1.5) : baseBudget;

  const rerank = (stage: string, items: Evidence[], timeoutMs: number) =>
    rerankEvidence({
      stage,
      items,
      reranker,
      question,
      timeoutMs,
      embedding: input.embedding,
      trace,
    });

  /* ---- 2. Speed: snippets only ---- */

  const rankedSnippets = await rerank(
    'snippets',
    candidates,
    SNIPPET_RERANK_TIMEOUT_MS,
  );

  const readsPages =
    input.mode === 'quality' ||
    (input.mode === 'balanced' && getBalancedReadsPages());

  if (!readsPages) {
    return finishSelection(rankedSnippets, budget, trace);
  }

  /* ---- 3. Balanced and quality: read the top pages ---- */

  // Pages read by an earlier search of this request are not read again;
  // their passages are already in that search's output.
  const alreadyRead = new Set<string>();
  researchBlock.data.subSteps.forEach((step) => {
    if (step.type === 'reading') {
      step.reading.forEach((chunk) => {
        alreadyRead.add(normalizeUrl(chunk.metadata.url));
      });
    }
  });

  const toRead = rankedSnippets
    .filter((s) => !alreadyRead.has(s.canonicalUrl))
    .slice(0, PAGES_TO_READ[input.mode === 'quality' ? 'quality' : 'balanced']);

  const readingBlockId = crypto.randomUUID();
  let readingEmitted = false;

  // Shows a page that was read in the UI's reading step.
  const emitReading = (url: string, title: string) => {
    const chunk: Chunk = { content: '', metadata: { url, title } };
    if (!readingEmitted) {
      readingEmitted = true;
      researchBlock.data.subSteps.push({
        id: readingBlockId,
        type: 'reading',
        reading: [chunk],
      });
    } else {
      const subStep = researchBlock.data.subSteps.find(
        (step) => step.id === readingBlockId,
      );
      if (subStep && subStep.type === 'reading') subStep.reading.push(chunk);
    }
    pushSubSteps(input.session, researchBlock);
  };

  // Fetches one source. Returns its page passages, or its snippet (marked
  // extraction 'failed') when the page could not be read.
  const readSource = async (snippet: Evidence): Promise<Evidence[]> => {
    let scraped: Awaited<ReturnType<typeof Scraper.scrape>> | undefined;
    try {
      scraped = await Scraper.scrape(snippet.url, trace);
    } catch (err) {
      console.log('Error scraping data from', snippet.url, err);
      trace.error(`fetch ${snippet.url}`, err);
    }

    let chunks: ReturnType<typeof chunkText> = [];
    if (scraped && !scraped.failed) {
      try {
        chunks = scraped.html
          ? chunkDocument(scraped.html, { url: snippet.url })
          : chunkText(scraped.text);
        // Readability found text but the walk found no blocks: use the text.
        if (chunks.length === 0 && scraped.text)
          chunks = chunkText(scraped.text);
      } catch (err) {
        trace.error(`chunk ${snippet.url}`, err);
      }
    }

    if (!scraped || scraped.failed || chunks.length === 0) {
      return [{ ...snippet, extraction: 'failed' }];
    }

    const extraction = scraped.text.length < MIN_TEXT_CHARS ? 'thin' : 'ok';
    emitReading(snippet.url, scraped.title || snippet.title);

    trace.event('chunk', {
      url: snippet.url,
      chunks: chunks.length,
      kept: Math.min(chunks.length, MAX_CHUNKS_PER_PAGE),
      extraction,
    });

    return pageToEvidence(scraped, chunks.slice(0, MAX_CHUNKS_PER_PAGE), {
      url: snippet.url,
      extraction,
      queries: snippet.queries,
      fallbackTitle: snippet.title,
      engines: snippet.engines,
      rank: snippet.rank,
      publishedAt: snippet.publishedAt,
    });
  };

  const perSource = await mapWithConcurrency(
    toRead,
    FETCH_CONCURRENCY,
    readSource,
  );
  const pool = perSource.flat();

  if (pool.length === 0) return [];

  const rankedPassages = await rerank(
    'passages',
    pool,
    PASSAGE_RERANK_TIMEOUT_MS,
  );

  return finishSelection(rankedPassages, budget, trace);
};

/*
  Reranks evidence against the question and returns it best first with
  `score` set. Never throws: rerankSafely falls back to embeddings, then to
  the given order. Records the 'rerank' span.
*/
const rerankEvidence = async (args: {
  stage: string;
  items: Evidence[];
  reranker: Reranker;
  question: string;
  timeoutMs: number;
  embedding: BaseEmbedding<any>;
  trace: Trace;
}): Promise<Evidence[]> => {
  const { items, trace } = args;
  const span = trace.span('rerank', {
    stage: args.stage,
    reranker: args.reranker.name,
    candidates: items.length,
    topK: items.length,
  });
  const startedAt = Date.now();

  // The title gives the model context the passage itself may lack.
  const passages = items.map((e, i) => ({
    id: String(i),
    text: e.title ? `${e.title}\n${e.text}` : e.text,
  }));

  const { results, usedReranker } = await rerankSafely(
    args.reranker,
    args.embedding,
    args.question,
    passages,
    { timeoutMs: args.timeoutMs },
    trace,
  );

  span.end({ durationMs: Date.now() - startedAt, usedReranker });

  const ranked: Evidence[] = [];
  const seen = new Set<number>();
  for (const r of results) {
    const i = Number(r.id);
    if (!items[i] || seen.has(i)) continue;
    seen.add(i);
    ranked.push({ ...items[i], score: r.score });
  }
  // Defensive: anything the reranker did not return goes last, in order.
  items.forEach((e, i) => {
    if (!seen.has(i)) ranked.push(e);
  });
  return ranked;
};

// Applies the evidence budget, records 'select' and 'evidence' trace
// events, and converts the result to the Chunk shape callers expect.
const finishSelection = (
  ranked: Evidence[],
  budget: number,
  trace: Trace,
): Chunk[] => {
  const { selected, distinctSources, droppedDuplicates } = selectEvidence(
    ranked,
    { budget, maxPerSource: MAX_PER_SOURCE, minSources: MIN_SOURCES },
  );

  trace.event('select', {
    budget,
    candidates: ranked.length,
    selected: selected.length,
    distinctSources,
    droppedDuplicates,
  });
  trace.event('evidence', {
    items: selected.map((e) => ({
      id: e.chunkId,
      sourceKind: e.sourceKind,
      extraction: e.extraction,
      score: e.score,
    })),
  });

  return selected.map(evidenceToChunk);
};

/*
  The pre-M2 quality path, kept unchanged for reranker 'off': an LLM picks
  up to 3 results, their pages are scraped, and an LLM extracts facts from
  each 4000-token piece.
*/
const legacyQualitySearch = async (
  input: SearchInput,
  searchResults: Chunk[],
): Promise<Chunk[]> => {
  const researchBlock = input.researchBlock;
  const trace = input.session.trace;

  const pickerPrompt = `
      Assistant is an AI search result picker. Assistant's task is to pick 2-3 of the most relevant search results based off the query which can be then scraped for information to answer the query.
      Assistant will be shared with the search results retrieved from a search engine along with the queries used to retrieve those results. Assistant will then pick maxiumum 3 of the most relevant search results based on the queries and the content of the search results. Assistant should only pick search results that are relevant to the query and can help in answering the question.
      
      ## Things to taken into consideration when picking the search results:
      1. Relevance to the query: The search results should be relevant to the query provided. Irrelevant results should be ignored.
      2. Content quality: The content of the search results should be of high quality and provide valuable information that can help in answering the question.
      3. Favour known and reputable sources: If there are search results from known and reputable sources that are relevant to the query, those should be prioritized.
      4. Diversity: If there are multiple search results that are relevant and of high quality, try to pick results that provide diverse perspectives or information to get a well-rounded understanding of the topic.
      5. Avoid picking search results that are too similar to each other in terms of content to maximize the amount of information gathered.
      6. Maximum 3 results: Assistant should pick a maximum of 3 search results. If there are more than 3 relevant and high-quality search results, pick the top 3 based on the above criteria. If the queries are very specific and there are only 1 or 2 relevant search results, it's okay to pick only those 1 or 2 results.
      7. Try to pick only one high quality result unless there are diverse perspective in multiple results then you can pick a maximum of 3.
      8. Analyze the title, the snippet and the URL to determine the relevant to query, quality of the content that might be present inside and the reputation of the source before picking the search result.
      
      ## Output format
      Assistant should output an array of indices corresponding to the search results that were picked based on the above criteria. The indices should be based on the order of the search results provided to Assistant. For example, if Assistant picks the 1st, 3rd, and 5th search results, Assistant should output [0, 2, 4].
      
      <example_output>
      {
       "picked_indices": [0,2,4]
      }
      </example_output>
      `;

  const pickerSchema = z.object({
    picked_indices: z
      .array(z.number())
      .describe('The array of the picked indices to be scraped for answering'),
  });

  const pickSpan = trace.span('pick', { candidates: searchResults.length });

  const pickerResponse = await input.llm.generateObject<typeof pickerSchema>({
    schema: pickerSchema,
    messages: [
      {
        role: 'system',
        content: pickerPrompt,
      },
      {
        role: 'user',
        content: `<queries>${input.queries.join(', ')}</queries>\n<search_results>${searchResults.map((result, index) => `<result indice=${index}>${JSON.stringify(result)}</result>`).join('\n')}</search_results>`,
      },
    ],
  });

  const pickedIndices = pickerResponse.picked_indices.slice(0, 3);
  const pickedResults = pickedIndices
    .map((i) => searchResults[i])
    .filter((r) => r !== undefined);

  /* Normalised keys (normalizeUrl.ts) so ?utm_ variants, http/https and
       trailing slashes of an already-read page are not read again. */
  const alreadyExtractedURLs = new Set<string>();

  researchBlock.data.subSteps.forEach((step) => {
    if (step.type === 'reading') {
      step.reading.forEach((chunk) => {
        alreadyExtractedURLs.add(normalizeUrl(chunk.metadata.url));
      });
    }
  });

  const filteredResults = pickedResults.filter(
    (r) => !alreadyExtractedURLs.has(normalizeUrl(r.metadata.url)),
  );

  pickSpan.end({
    pickedCount: pickedResults.length,
    alreadyReadCount: pickedResults.length - filteredResults.length,
    urls: filteredResults.map((r) => r.metadata.url),
  });

  if (filteredResults.length > 0) {
    researchBlock.data.subSteps.push({
      id: crypto.randomUUID(),
      type: 'reading',
      reading: filteredResults,
    });

    input.session.updateBlock(researchBlock.id, [
      {
        path: '/data/subSteps',
        op: 'replace',
        value: researchBlock.data.subSteps,
      },
    ]);
  }

  const extractedFacts: Chunk[] = [];

  const extractorPrompt = `
      Assistant is an AI information extractor. Assistant will be shared with scraped information from a website along with the queries used to retrieve that information. Assistant's task is to extract relevant facts from the scraped data to answer the queries.

      ## Things to taken into consideration when extracting information:
      1. Relevance to the query: The extracted information must dynamically adjust based on the query's intent. If the query asks "What is [X]", you must extract the definition/identity. If the query asks for "[X] specs" or "features", you must provide deep, granular technical details.
         - Example: For "What is [Product]", extract the core definition. For "[Product] capabilities", extract every technical function mentioned.
      2. Concentrate on extracting factual information that can help in answering the question rather than opinions or commentary. Ignore marketing fluff like "best-in-class" or "seamless."
      3. Noise to signal ratio: If the scraped data is noisy (headers, footers, UI text), ignore it and extract only the high-value information. 
         - Example: Discard "Click for more" or "Subscribe now" messages.
      4. Avoid using filler sentences or words; extract concise, telegram-style information.
         - Example: Change "The device features a weight of only 1.2kg" to "Weight: 1.2kg."
      5. Duplicate information: If a fact appears multiple times (e.g., in a paragraph and a technical table), merge the details into a single, high-density bullet point to avoid redundancy.
      6. Numerical Data Integrity: NEVER summarize or generalize numbers, benchmarks, or table data. Extract raw values exactly as they appear.
         - Example: Do not say "Improved coding scores." Say "LiveCodeBench v6: 80.0%."

      ## Example
      For example, if the query is "What are the health benefits of green tea?" and the scraped data contains various pieces of information about green tea, Assistant should focus on extracting factual information related to the health benefits of green tea such as "Green tea contains antioxidants which can help in reducing inflammation" and ignore irrelevant information such as "Green tea is a popular beverage worldwide".
      
      It can also remove filler words to reduce the sentence to "Contains antioxidants; reduces inflammation." 
      
      For tables/numerical data extraction, Assistant should extract the raw numerical data or the content of the table without trying to summarize it to avoid losing important details. For example, if a table lists specific battery life hours for different modes, Assistant should list every mode and its corresponding hour count rather than giving a general average.
      
      Make sure the extracted facts are in bullet points format to make it easier to read and understand.

      ## Output format
      Assistant should reply with a JSON object containing a key "extracted_facts" which is a string of the bulleted facts. Return only raw JSON without markdown formatting (no \`\`\`json blocks).

      <example_output>
      {
        "extracted_facts": "- Fact 1\n- Fact 2\n- Fact 3"
      }
      </example_output>
      `;

  const extractorSchema = z.object({
    extracted_facts: z
      .string()
      .describe(
        'The extracted facts that are relevant to the query and can help in answering the question should be listed here in a concise manner.',
      ),
  });

  await Promise.all(
    filteredResults.map(async (result, i) => {
      try {
        const scrapedData = await Scraper.scrape(
          result.metadata.url,
          trace,
        ).catch((err) => {
          console.log('Error scraping data from', result.metadata.url, err);
          trace.error(`fetch ${result.metadata.url}`, err);
        });

        if (!scrapedData) return;

        let accumulatedContent = '';
        const chunks = splitText(scrapedData.content, 4000, 500);

        await Promise.all(
          chunks.map(async (chunk, chunkIndex) => {
            const extractStartedAt = Date.now();
            try {
              const extractorOutput = await input.llm.generateObject<
                typeof extractorSchema
              >({
                schema: extractorSchema,
                messages: [
                  {
                    role: 'system',
                    content: extractorPrompt,
                  },
                  {
                    role: 'user',
                    content: `<queries>${input.queries.join(', ')}</queries>\n<scraped_data>${chunk}</scraped_data>`,
                  },
                ],
              });

              accumulatedContent += extractorOutput.extracted_facts + '\n';

              trace.event('extract', {
                url: result.metadata.url,
                chunkIndex,
                durationMs: Date.now() - extractStartedAt,
                outputChars: extractorOutput.extracted_facts?.length ?? 0,
              });
            } catch (err) {
              console.log('Error extracting information from chunk', err);

              trace.event('extract', {
                url: result.metadata.url,
                chunkIndex,
                durationMs: Date.now() - extractStartedAt,
                outputChars: 0,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        );

        extractedFacts.push({
          ...result,
          content: accumulatedContent,
        });
      } catch (err) {
        console.log(
          'Error scraping or extracting information from',
          result.metadata.url,
          err,
        );
        trace.error(`read ${result.metadata.url}`, err);
      }
    }),
  );

  return extractedFacts;
};
