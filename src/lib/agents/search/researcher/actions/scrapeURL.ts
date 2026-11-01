// TypeScript: the scrape_url action. Reads pages the user named, splits them into passages and keeps the ones that answer the question (M2 evidence path).
import z from 'zod';
import { ResearchAction } from '../../types';
import { Chunk, ResearchBlock } from '@/lib/types';
import Scraper, { MIN_TEXT_CHARS } from '@/lib/scraper';
import { splitText } from '@/lib/utils/splitText';
import { chunkDocument, chunkText } from '@/lib/utils/chunkDocument';
import { Evidence, evidenceToChunk, pageToEvidence } from '@/lib/evidence';
import {
  budgetFor,
  finishSelection,
  PASSAGE_RERANK_TIMEOUT_MS,
  rerankEvidence,
} from '@/lib/evidence/pipeline';
import { getReranker } from '@/lib/rerank';
import {
  getEvidenceBudget,
  getRerankerKind,
} from '@/lib/config/serverRegistry';

// The user named these pages, so more of each goes to the reranker than
// for a web search page (12). 3 URLs x 40 stays near the ~120 passages a
// 2-core box scores in about 8 s.
const MAX_CHUNKS_PER_PAGE = 40;

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

const schema = z.object({
  urls: z.array(z.string()).describe('A list of URLs to scrape content from.'),
});

const actionDescription = `
Use this tool to scrape and extract content from the provided URLs. This is useful when you the user has asked you to extract or summarize information from specific web pages. You can provide up to 3 URLs at a time. NEVER CALL THIS TOOL EXPLICITLY YOURSELF UNLESS INSTRUCTED TO DO SO BY THE USER.
You should only call this tool when the user has specifically requested information from certain web pages, never call this yourself to get extra information without user instruction.

For example, if the user says "Please summarize the content of https://example.com/article", you can call this tool with that URL to get the content and then provide the summary or "What does X mean according to https://example.com/page", you can call this tool with that URL to get the content and provide the explanation.
`;

type ExecuteConfig = Parameters<ResearchAction['execute']>[1];

/*
  Flow:
  1. Every URL is scraped (at most 3), and each page read is shown in the
     UI's reading step.
  2. Reranker 'off': the pre-M2 path, an LLM extracts facts from each
     4000-token piece of a long page.
  3. Otherwise each page is chunked by section (chunkDocument for HTML,
     chunkText for plain text), its passages become full_page evidence,
     are reranked against the standalone question and selected within the
     evidence budget. A page that could not be read is returned as one
     passage marked extraction 'failed', outside the selection, so the
     writer can say it could not be read.
*/
const scrapeURLAction: ResearchAction<typeof schema> = {
  name: 'scrape_url',
  schema: schema,
  getToolDescription: () =>
    'Use this tool to scrape and extract content from the provided URLs. This is useful when you the user has asked you to extract or summarize information from specific web pages. You can provide up to 3 URLs at a time. NEVER CALL THIS TOOL EXPLICITLY YOURSELF UNLESS INSTRUCTED TO DO SO BY THE USER.',
  getDescription: () => actionDescription,
  enabled: (_) => true,
  execute: async (params, additionalConfig) => {
    params.urls = params.urls.slice(0, 3);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    );
    const research =
      researchBlock && researchBlock.type === 'research'
        ? (researchBlock as ResearchBlock)
        : undefined;

    const pushSubSteps = () => {
      if (!research) return;
      additionalConfig.session.updateBlock(additionalConfig.researchBlockId, [
        {
          op: 'replace',
          path: '/data/subSteps',
          value: research.data.subSteps,
        },
      ]);
    };

    // Shows a page in the UI's reading step (one step for all URLs).
    const readingBlockId = crypto.randomUUID();
    const emitReading = (url: string, title: string) => {
      if (!research) return;
      const chunk: Chunk = { content: '', metadata: { url, title } };
      const subStep = research.data.subSteps.find(
        (step) => step.id === readingBlockId,
      );
      if (subStep && subStep.type === 'reading') {
        subStep.reading.push(chunk);
      } else {
        research.data.subSteps.push({
          id: readingBlockId,
          type: 'reading',
          reading: [chunk],
        });
      }
      pushSubSteps();
    };

    if (getRerankerKind() === 'off') {
      return {
        type: 'search_results',
        results: await legacyScrape(params.urls, additionalConfig, emitReading),
      };
    }

    /* Per-request tracer; a no-op unless tracing is on. */
    const trace = additionalConfig.session.trace;
    const question = additionalConfig.question?.trim() || params.urls.join(' ');

    // Pages that could not be read: one 'failed' passage each.
    const failures: Evidence[] = [];
    const failed = (url: string, title: string, reason: string) =>
      failures.push(
        ...pageToEvidence(
          { title },
          [{ headingPath: [], text: `Could not read ${url}: ${reason}` }],
          { url, extraction: 'failed', queries: [] },
        ),
      );

    const perPage = await Promise.all(
      params.urls.map(async (url): Promise<Evidence[]> => {
        let scraped: Awaited<ReturnType<typeof Scraper.scrape>>;
        try {
          scraped = await Scraper.scrape(url, trace);
        } catch (error) {
          trace.error(`scrape_url ${url}`, error);
          failed(url, `Error scraping ${url}`, String(error));
          return [];
        }

        emitReading(url, scraped.title);

        let chunks: ReturnType<typeof chunkText> = [];
        if (!scraped.failed) {
          try {
            chunks = scraped.html
              ? chunkDocument(scraped.html, { url })
              : chunkText(scraped.text);
            // Readability found text but the walk found no blocks.
            if (chunks.length === 0 && scraped.text)
              chunks = chunkText(scraped.text);
          } catch (err) {
            trace.error(`chunk ${url}`, err);
          }
        }

        if (scraped.failed || chunks.length === 0) {
          failed(url, scraped.title, 'no readable text');
          return [];
        }

        const extraction = scraped.text.length < MIN_TEXT_CHARS ? 'thin' : 'ok';
        trace.event('chunk', {
          url,
          chunks: chunks.length,
          kept: Math.min(chunks.length, MAX_CHUNKS_PER_PAGE),
          extraction,
        });

        return pageToEvidence(scraped, chunks.slice(0, MAX_CHUNKS_PER_PAGE), {
          url,
          extraction,
          queries: [],
        });
      }),
    );

    const pool = perPage.flat();
    let results: Chunk[] = [];

    if (pool.length > 0) {
      const reranker = await getReranker(additionalConfig.embedding, trace);
      const ranked = await rerankEvidence({
        stage: 'scrape',
        items: pool,
        reranker,
        question,
        timeoutMs: PASSAGE_RERANK_TIMEOUT_MS,
        embedding: additionalConfig.embedding,
        trace,
      });

      const budget = budgetFor(additionalConfig.mode, getEvidenceBudget());
      const pagesRead = new Set(pool.map((e) => e.sourceId)).size;

      // The user picked these pages: one page may fill the budget, and
      // every page read gets at least its best passage.
      results = finishSelection(
        ranked,
        budget,
        trace,
        (stats) => {
          if (!research) return;
          research.data.subSteps.push({
            id: crypto.randomUUID(),
            type: 'ranking',
            ...stats,
          });
          pushSubSteps();
        },
        { maxPerSource: budget, minSources: pagesRead },
      );
    }

    return {
      type: 'search_results',
      results: [...results, ...failures.map(evidenceToChunk)],
    };
  },
};

/*
  The pre-M2 path, kept for reranker 'off': a page longer than one
  4000-token piece is summarised by an LLM extractor, piece by piece.
*/
const legacyScrape = async (
  urls: string[],
  additionalConfig: ExecuteConfig,
  emitReading: (url: string, title: string) => void,
): Promise<Chunk[]> => {
  const results: Chunk[] = [];
  /* Per-request tracer; a no-op unless tracing is on. */
  const trace = additionalConfig.session.trace;

  await Promise.all(
    urls.map(async (url) => {
      try {
        const scraped = await Scraper.scrape(url, trace);

        emitReading(url, scraped.title);

        const chunks = splitText(scraped.content, 4000, 500);

        let accumulatedContent = '';

        if (chunks.length > 1) {
          try {
            await Promise.all(
              chunks.map(async (chunk, chunkIndex) => {
                const extractStartedAt = Date.now();
                const extracted = await additionalConfig.llm.generateObject<
                  typeof extractorSchema
                >({
                  messages: [
                    {
                      role: 'system',
                      content: extractorPrompt,
                    },
                    {
                      role: 'user',
                      content: `<queries>Summarize</queries>\n<scraped_data>${chunk}</scraped_data>`,
                    },
                  ],
                  schema: extractorSchema,
                });

                accumulatedContent += extracted.extracted_facts + '\n';

                trace.event('extract', {
                  url,
                  chunkIndex,
                  durationMs: Date.now() - extractStartedAt,
                  outputChars: extracted.extracted_facts?.length ?? 0,
                });
              }),
            );
          } catch (err) {
            console.log(
              'Error during extraction, falling back to raw content',
              err,
            );
            trace.event('extract', {
              url,
              outputChars: 0,
              error: err instanceof Error ? err.message : String(err),
              fallback: 'first chunk',
            });
            accumulatedContent = chunks[0];
          }
        } else {
          accumulatedContent = scraped.content;
        }

        results.push({
          content: accumulatedContent,
          metadata: {
            url,
            title: scraped.title,
          },
        });
      } catch (error) {
        trace.error(`scrape_url ${url}`, error);
        results.push({
          content: `Failed to fetch content from ${url}: ${error}`,
          metadata: {
            url,
            title: `Error scraping ${url}`,
          },
        });
      }
    }),
  );

  return results;
};

export default scrapeURLAction;
