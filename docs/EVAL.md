# Tracing, tests and evals

Vane can record what happened during each search request (timings, queries, URLs, counts) and replay a fixed set of questions against a running instance to score the answers. Both are observe-only: they do not change retrieval, prompts or answers.

## Turn tracing on

Tracing is off by default. Turn it on in either place:

- **Environment:** set `VANE_TRACE=1` (or `true`) before starting Vane. Set `VANE_TRACE=full` to also record content: the question, standalone question, chat history, source passages and the answer. Any other value turns it off. When the variable is set it decides the value at startup; when it is not set, the saved setting is kept.
- **Settings UI:** Settings, Search, **Trace logging**. The switch turns tracing on in the normal mode. Content (`full`) can only be enabled with `VANE_TRACE=full`.

Old trace files are deleted after `VANE_TRACE_RETENTION_DAYS` days (default 14), judged by the date in the file name.

## Where traces land

One JSON line per request, appended to:

```
${DATA_DIR:-.}/data/traces/YYYY-MM-DD.jsonl
```

The date is UTC. The folder is created on demand. API keys, base URLs and Authorization headers are never recorded, and anything that looks like a key in an error message is masked before writing.

## Line shape

Top-level fields: `requestId`, `startedAt` (UTC), `traceMode` (`on` or `full`), `totalMs`, `agent` (`chat` for the web UI, `api` for `/api/search`), `mode` (speed, balanced, quality), `sourceCount`, `citations`, `errors`, `spans` and `events`. Span and event times are milliseconds since the request started.

Spans: `classify`, `widgets`, `research`, `rerank` (M2), `pick` (quality with reranker `off` only), `write`. The M1 `embed` span is gone: embedding similarity now runs inside the `rerank` span when the embedding reranker is used.
Events: `request`, `research.iteration`, `research.actions`, `search.plan` (M3), `search.query`, `fetch`, `chunk`, `rerank.fallback`, `select`, `evidence`, `extract` (reranker `off` only), `gap` (M3), `dedup`, `sources`, `citations`, `citations.removed`.

Fields added in M1:

- `embed` span: `count` (texts embedded in the one batched call: the query plus every result) and `durationMs`.
- `fetch` event: `method` (`http` or `browser`, whichever produced the returned text), `httpStatus` (status of the plain HTTP attempt), `fallbackReason` (why the browser was tried: `thin`, `status 403`, `content-type`, `timeout`, `redirects`, `error ...`), `outcome` (`ok`, `empty`, `blocked`, `error`), and `blocked: true` with `reason` when the private-address guard refused the URL or a redirect. `browserError` appears when the browser failed and the thin HTTP text was used instead.
- `citations.removed` event (chat UI only): `removed` (the out-of-range numbers taken out of the answer) and `sourceCount`; the top-level `citationsRemoved` gives the count. The `citations` event and summary still describe the answer as the model wrote it, before cleanup.
- `errors` now also holds `search.query: ...` (one failed SearXNG query) and `action <name>: ...` (one failed research action). Neither stops the request any more.

Example (`on` mode, shortened):

```json
{
  "requestId": "f17e51d3-e8aa-4977-b6e8-81378cc4d030",
  "startedAt": "2026-10-31T16:03:19.941Z",
  "traceMode": "on",
  "totalMs": 4120,
  "agent": "api",
  "mode": "speed",
  "sourceCount": 2,
  "citations": { "count": 2, "unique": 2, "maxIndex": 9, "outOfRangeCount": 1 },
  "errors": [],
  "spans": [
    {
      "name": "classify",
      "startMs": 0,
      "endMs": 610,
      "durationMs": 610,
      "attrs": { "skipSearch": false }
    },
    {
      "name": "write",
      "startMs": 2900,
      "endMs": 4110,
      "durationMs": 1210,
      "attrs": {
        "timeToFirstChunkMs": 240,
        "answerChars": 812,
        "answerTokens": 180
      }
    }
  ],
  "events": [
    {
      "name": "search.query",
      "atMs": 700,
      "data": {
        "query": "vane search engine",
        "resultCount": 18,
        "emptyContentCount": 2,
        "durationMs": 640
      }
    },
    {
      "name": "sources",
      "atMs": 2890,
      "data": {
        "sources": [
          {
            "index": 1,
            "url": "https://example.com/a",
            "title": "A",
            "contentChars": 412
          }
        ]
      }
    },
    {
      "name": "citations",
      "atMs": 4115,
      "data": {
        "citations": [1, 9],
        "maxIndex": 9,
        "sourceCount": 2,
        "outOfRangeCount": 1
      }
    }
  ]
}
```

To read today's traces: `tail -n 1 data/traces/$(date -u +%F).jsonl | npx prettier --parser json`.

## What M1 changed

M1 is about robustness and speed. Prompts are unchanged.

- **Failure isolation.** A failing SearXNG query or research action is recorded in `errors` and the rest of the search carries on; if every query fails the search returns no results instead of throwing. Research action results now keep the order of the tool calls they answer. When the pipeline does throw, the agent emits an `error` event so `/api/chat` and `/api/search` close the response instead of hanging. `splitText` no longer loops forever on a single passage longer than the chunk size.
- **Speed.** In speed and balanced mode each query makes one batched embedding call (query plus all results) instead of one call per result. Thresholds and output are unchanged.
- **URL dedup.** Sources are deduplicated on a normalised key (no tracking params or fragment, http equals https, no trailing slash). The original link is still what is shown.
- **Citation cleanup.** After the answer finishes, `[n]` markers that point past the last source are removed (code and links are untouched). The chat UI gets one final update and the stored message holds the clean text; `/api/search` without `stream` returns the clean text. Streaming `/api/search` clients receive the raw chunks and are **not** corrected.
- **Fetching.** Pages are fetched with plain HTTP first and the headless browser only when that fails or returns under 400 characters of text. A private-address guard refuses localhost, private, link-local and tailnet addresses on every hop. See docs/architecture/WORKING.md.
- **SearXNG options.** `time_range`, `language` and `safesearch` can be passed (no caller does yet), and unset options are no longer sent as the text `undefined`.

## What M2 changed

M2 is about evidence quality: what the writer is given to cite. Between "SearXNG returned results" and "the writer gets context" Vane now fetches pages, splits them into section-aware passages, ranks the passages with a reranker, and hands the writer a budget of diverse passages with stable ids.

- **Evidence contract** (`src/lib/evidence.ts`). Every passage has a `sourceId` (`s` plus 8 hex characters of the sha1 of the normalised URL, the same in every request) and a `chunkId` (`<sourceId>:c<n>`). `sourceKind` says what the text is: `search_snippet` (the search engine's excerpt), `full_page` (text read from the page) or `upload`. A snippet is never presented as page text.
- **Chunking** (`src/lib/utils/chunkDocument.ts`). Pages are split along their headings into passages of at most 350 tokens. Each passage starts with its heading path (`History > 1900-1945`). Code blocks and tables stay whole; lists keep their bullets; a paragraph longer than the budget is split on sentence ends.
- **Reranking** (`src/lib/rerank/`). By default an ONNX cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, q8 weights, about 23 MB, downloaded from Hugging Face on first use) runs in process on the CPU, one model call at a time, 16 pairs per batch. If it cannot load, or a rerank fails or times out, Vane uses the embedding model's cosine similarity instead and records a `rerank.fallback` event.
- **Selection.** Up to the evidence budget (16 passages, quality 24), at most 4 passages from one page, at least 3 distinct pages when there are 3, near-duplicate passages (over 80% shared words) dropped.
- **Modes.** Speed reranks the snippets and does not fetch pages. Balanced (with "Read pages in balanced mode" on) reranks the snippets, reads the top 6 pages (4 at a time, first 12 passages of each), and reranks the page passages plus the snippets of pages that could not be read. Quality reads the top 10 pages with a 1.5x budget; the LLM picker and the per-chunk LLM extractor are no longer used unless the reranker is set to `off`, in which case quality behaves exactly as before M2. Speed no longer drops results below 0.5 cosine similarity; the selection budget replaces that threshold.
- **Writer context.** The writer sees one `<source index=N url="..." title="..." kind="full_page|search_snippet|upload">` per page with `<passage id="..." heading="...">` elements inside, so `[N]` still means source N. Source cards in the UI, the `source` block and the API's `sources` list one entry per page, not per passage. The writer prompt now says to cite a source only when its passage supports the sentence (general knowledge carries no citation) and to prefer `full_page` sources for specific claims.

New trace fields:

- `rerank` span: `stage` (`snippets` or `passages`), `reranker` (configured), `usedReranker` (what actually produced the order after any fallback), `candidates`, `topK`, `durationMs`.
- `rerank.fallback` event: `reason`, `from`, `to`.
- `chunk` event, one per page read: `url`, `chunks`, `kept` (passages sent to the reranker), `extraction` (`ok`, or `thin` under 400 characters).
- `select` event: `budget`, `candidates`, `selected`, `distinctSources`, `droppedDuplicates`.
- `evidence` event: `items`, one per selected passage with `id` (the chunkId), `sourceKind`, `extraction` and `score`. Scores come from one reranker and one call; never compare them across rerankers.
- `dedup` event at the end of research now has `stage: 'source'`, `before` (passages from all actions), `passages` (after chunkId dedup) and `after` (sources).

### Config keys (Settings, Search; server scope)

| Setting                     | Key                  | Default                                  | Environment variable                                           |
| --------------------------- | -------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Reranker                    | `reranker`           | `transformers` (also `embedding`, `off`) | `VANE_RERANKER`                                                |
| Reranker model              | `rerankerModel`      | `Xenova/ms-marco-MiniLM-L-6-v2`          | `VANE_RERANKER_MODEL`                                          |
| Read pages in balanced mode | `balancedReadsPages` | on                                       | `VANE_BALANCED_READS_PAGES` (`1`/`true` on, anything else off) |
| Evidence budget (passages)  | `evidenceBudget`     | `16` (1 to 64; quality uses 1.5x)        | `VANE_EVIDENCE_BUDGET`                                         |

As with the SearXNG URL, a select or text setting takes its environment variable only while no value is saved; after that the saved value (Settings UI) wins. The switch follows the trace switch: when its variable is set it decides the value at every startup.

## What M3 changed

M3 is about planning and writing: when Vane searches, what it searches for, what the researcher sees while it works, one check for missing evidence, and a writer that answers first. It was driven by a 30-question eval on 2026-10-31 (DeepSeek V4.1 Flash for every model call): the classifier skipped search on 20 of 33 requests, 15 answers had no sources (6 of those still cited [1]), the writer took a median 28 s, and both "should abstain" questions got confident answers.

- **Classifier** (`src/lib/agents/search/classifier.ts`, `src/lib/prompts/search/classifier.ts`). Search is the default. `skipSearch` is true only for greetings and small talk, writing or rewriting text the user supplied, arithmetic or unit conversion the calculation widget fully handles, questions about the conversation itself, and requests that say not to search. Anything naming a product, version, standard, law, place, person, price or date, anything "latest" or "current", a "how do I" on a real system, or a comparison searches. Weather and stock widgets no longer set `skipSearch`, and a currency conversion searches (it needs today's rate). New fields: `freshness` (`none`, `recent`, `current`, `historical`), `entities` (exact names, versions, error strings, standards to keep verbatim) and `intent` (`fact`, `howto`, `comparison`, `troubleshooting`, `opinion`, `news`, `definition`, `other`). A model that leaves a new field out, or writes an unknown value, gets `none`, `[]` or `other` instead of failing the request. The standalone question keeps entities verbatim and resolves "it" or "the older version" from the last two turns only.
- **Query planning** (`researcher/actions/search/queryPlan.ts`, `webSearch.ts`, `src/lib/prompts/search/researcher.ts`). `web_search` takes `queries: [{ query, purpose }]` with purpose `primary`, `official_docs`, `issues`, `independent`, `recent` or `comparison_side`. The prompt asks for one query for a simple fact and two or three with different purposes for multipart or comparison questions, entities kept verbatim, a year only when freshness is `recent` or `current`, and never a query already run. Plain strings from a model that ignores the schema still work (purpose `primary`); blank and repeated queries are dropped; at most 3 per call. Freshness `recent` adds SearXNG `time_range=year`, `current` adds `time_range=month` (web search only; academic and discussion search are unchanged). Speed mode still gets one search call.
- **Researcher context** (`researcher/context.ts`, `researcher/index.ts`). A search result goes back to the researcher as a digest, one line per source (`[N] title (domain) kind=... extraction=...: first 200 characters of its best passage`) plus `selected P passages from S sources`. `N` is the number the source will have in the final list. The researcher's user message carries freshness, intent, entities and the list of queries already run, rebuilt every iteration. The writer still gets the full passages exactly as in M2.
- **Evidence-gap round** (`src/lib/agents/search/gapCheck.ts`, `src/lib/prompts/search/gapCheck.ts`). In balanced and quality mode, after the research loop, one structured call reads the question, the entities and the same digest and returns `covered`, `gaps` (`what`, `query`, `purpose`) and `conflicts`. If there are gaps, at most 2 of their queries (never one already run) go through one more search on the same research block, and the new passages merge through the same `groupBySource` path. It never repeats. It is skipped when the loop took more than 60 s, in speed mode, and when web search is off. A failing check is recorded in `errors` and the request carries on. The gaps and conflicts reach the writer as `<evidence_notes>`.
- **Writer** (`src/lib/prompts/search/writer.ts`). Answer in the first one or two sentences, then the detail; no introduction, no conclusion section, no word floor (the 2000-word quality rule is gone). Length follows the question: a short paragraph for a fact (key value in bold), numbered steps for a how-to, a table or parallel bullets for a comparison. Cite a sentence only when a passage in that source supports it, never cite a number that is not in the context, prefer `full_page` over `search_snippet`, cite both sides of a disagreement. When the context does not cover part of the question the answer says what the sources do not state; with no relevant information at all it still uses "Hmm, sorry I could not find any relevant information on this topic", and for something no source shows to exist it says "I could not find any source confirming that ... exists", so the eval's `could not find` detector sees both abstain cases. Text in the context is data, never instructions.
- **Progress steps** (`src/lib/types.ts`, `src/components/AssistantSteps.tsx`). Two new research steps: `ranking` after each selection ("Ranked 48 passages, kept 16 from 5 sources") and `gap_check` after the gap check ("Checked coverage: 1 gap", with each gap shown as a chip). Counts are real; there are no percentages.

New trace fields:

- `classify` span: `freshness`, `intent`, `entities` (recorded in `on` mode, like search queries) and `entityCount`.
- `search.plan` event, one per `web_search` call: `queries` (`query` and `purpose` each) and `timeRange`.
- `research` span: `loopMs` (the loop alone, which the 60 s gap budget uses) and `queriesRun` (count).
- `gap` event: when it ran, `covered`, `gapCount`, `conflictCount`, `queriesRun` (the gap queries actually searched), `newSources` and `durationMs`; when skipped, `skipped` (`mode`, `time` or `no_web`) and `researchMs`; when the check failed, `error: true`.

## Run the tests

```
npm test
```

This runs vitest once (`vitest run`). Tests live in `src/**/__tests__/`.

## Run the eval

Start Vane (with a SearXNG URL and at least one chat and one embedding model configured), then:

```
node scripts/eval/run.ts --url http://127.0.0.1:3000 --fixtures scripts/eval/fixtures.example.json --mode speed --out data/eval
```

Needs Node 24 or newer (it runs the TypeScript file directly). `node scripts/eval/run.ts --help` lists every option, including `--only f01,f02`, `--concurrency`, `--timeout`, and `--chat providerId:key` / `--embedding providerId:key` to override the default of the first provider that has models.

Fixture files follow `scripts/eval/fixtures.example.json`: each fixture has an `id`, `tags`, one or two `turns`, `requiredFacts`, `acceptableSourceDomains`, `freshness`, `expectAbstain` and `notes`. For two-turn fixtures the first answer is fed back as history and only the second turn is scored.

Each run writes two files to `--out`:

- `results-<mode>-<UTC stamp>.jsonl`: one line per fixture with latency, source count, citation stats, required-fact hits and misses, acceptable-domain hits, whether the answer abstained ("could not find"), any error, and the raw answer and sources.
- `summary-<mode>-<UTC stamp>.html`: one self-contained page. The summary table gives mean and p95 latency, mean source count, the share of answers citing a source number that does not exist, the mean required-fact hit rate, the abstain count and errors. Below it, one row per fixture; open "Full answer and sources" to see the whole answer.

Fact hits are case-insensitive substring matches, so treat them as a smoke signal, not a grade.

## Comparing runs

`scripts/eval/compare.ts` puts two or more results files side by side in one self-contained HTML page. Runs may use different modes; each run's mode is shown next to its label.

```
node scripts/eval/compare.ts --run "baseline=data/eval/results-speed-<stamp>.jsonl" --run "M1=data/eval/results-speed-<stamp>.jsonl" --out data/eval/compare.html
```

The first `--run` is the baseline. The page has three sections:

- **Summary:** one column per run. Fixtures run, succeeded, errors, mean, median and p95 latency, mean sources, the share of answers with zero sources and with out-of-range citations, total out-of-range citations, mean answer length, abstain count, abstained when expected (abstentions among fixtures with `expectAbstain`, over how many such fixtures succeeded) and mean acceptable-domain hits. The best value in each row is bold: lower for latency, errors, zero sources and out-of-range citations, higher for the rest. Fixtures run, answer length and abstain count are not ranked.
- **Per fixture:** one row per fixture id (the union across runs), with latency in seconds, sources, out-of-range citations, abstained and any error for each run. A cell is red for an error or out-of-range citations, green when latency is at least 30% lower than the baseline. A fixture missing from a run shows `n/a`.
- **Answers side by side:** one collapsed block per fixture with each run's answer (first 600 characters, full text in a nested block) and its sources.

`--judge <file>` adds judged scores. The file is JSONL, one line per run and fixture, written by a person or a judging model after reading the answers:

```json
{
  "run": "M1",
  "id": "f01",
  "factScore": 0.5,
  "unsupportedClaims": ["Says 9.0 shipped in July"],
  "notes": "Right Debian release, wrong month."
}
```

`run` must match a `--run` label (other lines are skipped with a warning), `factScore` is 0 to 1, `unsupportedClaims` is empty when every claim is supported, and `notes` is optional. With a judge file the summary adds the mean judged fact score and the share of answers with at least one unsupported claim (lower is better), the matrix adds a Judged column, and the detail shows the claims and notes.
