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
Events: `request`, `research.iteration`, `research.actions`, `search.plan` (M3), `search.query`, `fetch`, `chunk`, `rerank.fallback`, `select`, `evidence`, `extract` (reranker `off` only), `gap` (M3), `budget.exhausted`, `dedup`, `sources`, `citations`, `citations.removed`.

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
- **Selection.** Up to the evidence budget (16 passages, quality 24; the default is 12 since the source-priors change, see below), at most 4 passages from one page, at least 3 distinct pages when there are 3, near-duplicate passages (over 80% shared words) dropped.
- **Modes.** Speed reranks the snippets and does not fetch pages. Balanced (with "Read pages in balanced mode" on) reranks the snippets, reads the top 6 pages (4 at a time, first 12 passages of each), and reranks the page passages plus the snippets of pages that could not be read. Quality reads the top 10 pages with a 1.5x budget; the LLM picker and the per-chunk LLM extractor are no longer used unless the reranker is set to `off`, in which case quality behaves exactly as before M2. Speed no longer drops results below 0.5 cosine similarity; the selection budget replaces that threshold.
- **Writer context.** The writer sees one `<source index=N url="..." title="..." kind="full_page|search_snippet|upload">` per page with `<passage id="..." heading="...">` elements inside, so `[N]` still means source N. Source cards in the UI, the `source` block and the API's `sources` list one entry per page, not per passage. The writer prompt now says to cite a source only when its passage supports the sentence (general knowledge carries no citation) and to prefer `full_page` sources for specific claims.

New trace fields:

- `rerank` span: `stage` (`snippets` or `passages`; `scrape` and `uploads` since the uploads change below), `reranker` (configured), `usedReranker` (what actually produced the order after any fallback), `candidates`, `topK`, `durationMs`.
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
| Evidence budget (passages)  | `evidenceBudget`     | `12` (1 to 64; quality uses 1.5x)        | `VANE_EVIDENCE_BUDGET`                                         |

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

## Uploads and scrape_url on the evidence path

After M3, `uploads_search` and `scrape_url` still returned pre-M2 chunks (no `sourceKind`, no stable ids, an LLM extractor on long scraped pages). They now use the same rerank-and-select steps as web search, moved into a shared module, `src/lib/evidence/pipeline.ts` (`rerankEvidence`, `finishSelection`, `budgetFor`, the per-source cap and the rerank timeouts); `baseSearch.ts` imports it.

- **scrape_url** (`researcher/actions/scrapeURL.ts`). Each page (at most 3) is chunked with `chunkDocument` (HTML) or `chunkText` (plain text), the first 40 passages of each become `full_page` evidence, reranked against the standalone question, and selected within the evidence budget (quality 1.5x). One page may fill the budget (no 4-per-source cap) and every page read keeps at least its best passage. A page that could not be read is returned after the selection as one passage with `extraction: 'failed'`. The per-chunk LLM extractor runs only when the reranker is `off`, exactly as before. The UI gets the `reading` step as before and a `ranking` step.
- **uploads_search** (`researcher/actions/uploadsSearch.ts`). `UploadStore.query` now asks for 30 candidates (was 10). Each becomes an `upload` passage: `url` and `canonicalUrl` are `file_id://<fileId>`, `sourceId` is `sourceIdFor('file_id://<fileId>')` (the same id `groupBySource` derives), `chunkId` is `<sourceId>:c<n>` where `n` is the chunk's position in the file's stored chunks, and `headingPath` is empty. A chunk the store returns twice (once per query) is dropped before the rerank. The cap per file is the larger of 4 and the budget divided by the number of files, so a single uploaded file can fill the budget. The `upload_searching` and `upload_search_results` steps are unchanged (one card per file); a `ranking` step sits between them.
- **Upload chunking** (`src/lib/uploads/manager.ts`). New uploads are split with `chunkText` (at most 350 tokens, paragraph and sentence aware) instead of `splitText(512, 128)`. Only the text is stored, so `.content.json` keeps its `{ content, embedding }` shape and files uploaded earlier load and search as before.
- **Prompts.** The academic, discussion and uploads tool descriptions follow the M3 query rules (one query for a simple question, two or three only when the question has parts, entities verbatim, a year only for recent or current questions, no repeats), with new examples. The `__reasoning_preamble` examples no longer promise a "comprehensive answer".

Trace: the `rerank` span's `stage` can now also be `scrape` or `uploads`; `chunk`, `select` and `evidence` events are recorded for scrape_url, and `select` and `evidence` for uploads_search.

## M4: model thinking for internal calls

DeepSeek V4.1 Flash on TensorFold thinks before every reply, including the small structured calls that only steer the search; a classifier-shaped call measured 5.4 s with thinking and 1.2 s without. The server-scope setting **Model thinking for internal calls** (key `internalThinking`, environment variable `VANE_INTERNAL_THINKING`, default `default`) set to `off` adds `chat_template_kwargs: { thinking: false }` to the request body of the classifier, the researcher loop's tool-calling planner, the gap check and the weather, stock and calculation widgets; the writer's answer, and the legacy picker and extractor, still think. Only the OpenAI provider sends the field (in `generateText`, `streamText` and `generateObject`), and only when the setting is `off`, because real OpenAI rejects unknown body fields; use it with an OpenAI-compatible server that honours `chat_template_kwargs.thinking`, such as vLLM, SGLang or TensorFold. Like the other select settings, the environment variable applies only while no value is saved.

## Hardening (Fleet #343)

Behaviour fixes with no change to prompts or ranking.

- **DNS rebinding pin** (`src/lib/scraper.ts`, `src/lib/utils/safeUrl.ts`). The HTTP fetch path used to check a host's addresses and then let `fetch` resolve the name again, so a DNS server could answer "public" to the guard and "127.0.0.1" to the connection. Now `resolvePublicHttpUrl` returns the addresses it checked and each hop gets its own undici `Agent` whose `connect.lookup` answers only for that host and only with those addresses. The URL keeps the host name, so the Host header, TLS SNI and certificate check are unchanged. Every redirect hop is still checked again and pinned to its own addresses. undici is not a new package: jsdom already depends on it, and its `Agent` is passed to Node's own `fetch` as `dispatcher`.
- **Browser subresources** (`subresourceBlockReason` in `src/lib/scraper.ts`). Images, scripts and XHR now get the DNS check as well as the literal check. Answers are cached per host name for 60 s per page (the lookup promise is shared, so many images from one CDN cost one lookup). A name that does not resolve is aborted quietly; a private one is recorded as `blocked` in the `fetch` event. The browser still resolves the name itself when it connects, so this narrows rebinding for subresources rather than closing it; only the HTTP path is pinned.
- **NAT64** (`isPrivateAddress`). `64:ff9b::/96` (RFC 6052) and `64:ff9b:1::/48` (RFC 8215 local use) count as private, since a NAT64 gateway turns `64:ff9b::a9fe:a9fe` into a connection to 169.254.169.254.
- **`/api/search` errors without `stream`** (`src/app/api/search/route.ts`). A failed search used to reject the route's promise with a `Response`, which Next treats as a thrown error and answers with its own generic 500. It now resolves with status 500 and `{ "message": "Search error", "error": { "data": "..." } }`. The streaming path is unchanged.
- **One HTML parse per page** (`ScrapeResult.articleHtml`, `chunkDocument(html, { articleHtml })`). The scraper already runs JSDOM and Readability; it now returns Readability's article HTML as `articleHtml`, and the evidence pipeline hands it to `chunkDocument`, which then skips its own page parse and Readability pass. `html` is still returned. The scraper now lifts Wikipedia-style wrapped headings before Readability (as `chunkDocument` always did), so `text` may gain a few section headings. Measured on the 2 MB cap of en.wikipedia.org/wiki/United_States (3 runs, Apple M4 Pro): chunking took 1257 ms before and 307 ms after, with identical chunks (171).
- **Reranker warm-up** (`src/lib/rerank/warmup.ts`, called from `src/instrumentation.ts`, Node runtime only). When the reranker is `transformers`, the model starts loading in the background at server start and one line is logged: `Reranker <model> (<dtype>) ready in N ms` or `Reranker <model> warm-up failed: ...`. Startup never waits for it and it never throws; a failed warm-up means the first search tries the load again, as before.
- **One retry on a connection error** (`src/lib/models/providers/openai/connectionRetry.ts`). In the OpenAI provider's `generateObject` and `generateText` (not `streamText`), a call that fails with the SDK's `APIConnectionError`, or with `ECONNREFUSED`, `other side closed` or `fetch failed` anywhere in its error or cause chain, waits 2.5 s and runs once more, with one `console.warn` line. A second failure is thrown. Timeouts (`APIConnectionTimeoutError`) are not retried, since that would wait the whole timeout again. The SDK's own quick retries still run first.

## Budgets

Every request has hard limits, enforced in code (`src/lib/agents/search/budgets.ts`), not asked for in a prompt. They were set on 2026-11-01 after quality mode on the 2-core, 4 GB deploy box took 238 to 666 s per question with 59 to 115 sources, 80 to 144 page fetches and 9 to 25 researcher iterations, and was then OOM-killed on a single question. Balanced mode on the same questions took about 41 s with 8 sources and a judged fact score of 0.74.

| Budget                                 | Speed | Balanced | Quality | What happens when it runs out                                                      |
| -------------------------------------- | ----- | -------- | ------- | ---------------------------------------------------------------------------------- |
| `maxFetches` (pages fetched)           | 0     | 12       | 24      | No more pages are read; the remaining results stay search snippets                 |
| `maxBrowserFetches` (Playwright tries) | 0     | 3        | 6       | Thin or failed pages are not retried in the browser; thin HTTP text is kept        |
| `maxSearchCalls` (research searches)   | 1     | 4        | 8       | Further searches return nothing and the research loop stops                        |
| `maxResearchMs` (research loop time)   | 30 s  | 90 s     | 180 s   | No new research iteration starts; the gap round and the writer run with what is in |
| Research iterations (`MAX_ITERATIONS`) | 2     | 6        | 6       | The loop ends                                                                      |
| Gap rounds (`MAX_GAP_ROUNDS`)          | 0     | 1        | 2       | The second quality round runs only if the first found gaps and new sources arrived |

- The Researcher creates one `RequestBudget` per request and puts it on the session next to the tracer. `executeSearch` takes one search call per search and `Scraper.scrape` takes one fetch per page and one browser fetch per Playwright fallback. Gap-round searches do not take search calls (the round count caps them) but do take fetches. `scrape_url` (a page the user named) is not budgeted.
- Pages per search are still capped too: 6 in balanced and 8 in quality (was 10). The quality evidence budget stays at 1.5 times the base.
- A PDF or any other non-page content type, and any URL ending in a download extension such as `.pdf`, is never sent to the browser fallback.
- Override any number with `VANE_BUDGET_<MODE>_<NAME>`, for example `VANE_BUDGET_QUALITY_MAX_FETCHES=30` or `VANE_BUDGET_BALANCED_MAX_RESEARCH_MS=120000`. Names are `MAX_FETCHES`, `MAX_BROWSER_FETCHES`, `MAX_SEARCH_CALLS` and `MAX_RESEARCH_MS`. The variables are read once per process; a value that is not a whole number of zero or more is ignored. Iterations and gap rounds have no variable.

Trace fields:

- `budget.exhausted` event, once per budget per request: `budget` (the name above), `limit`, `elapsedMs` (since research started).
- `research` span: `budget` (the limits in force), `stoppedBy` (`maxResearchMs` or `maxSearchCalls` when a budget ended the loop) and `budgetUsed` (fetches, browser fetches and search calls taken, and which budgets ran out).
- `fetch` event: `browserSkipped` (`content-type`, `download` or `budget`) when the browser fallback was not tried, with `contentType` for a refused type; `outcome: 'skipped'` with `reason: 'budget'` when the fetch budget was already spent.
- `gap` event: `round` (1 or 2).

To measure quality mode after a deploy, run the full 30-fixture set (not the 3-fixture example file) with a timeout above the 180 s research budget plus the writer, then compare it with a balanced run of the same fixtures:

```
node scripts/eval/run.ts --url http://127.0.0.1:3000 --fixtures <30-fixture file> --mode quality --timeout 420000 --out data/eval
```

## Source priors (experimental)

The 2026-10-31 judge found the facts mostly right but cited to blogs and version trackers instead of first-party pages (w3.org for WCAG, truenas.com, nvidia.com, npm or GitHub releases for versions, access-board.gov). Two changes push selection toward first-party pages. Both are on by default and both turn off with one setting.

- **Prior** (`src/lib/sourcePriors.ts`). `sourcePrior(evidence, { entities, intent })` gives each page a value from 0 to 1: `0` for an aggregator or tracker (medium.com, dev.to, linkedin.com, pinterest, quora.com, deepwiki.com, releasebot.io, versionping.app, any domain with "tracker" in its name), `0.25` for anything else, `0.6` for a documentation page (`docs.` or `developer.` host, `readthedocs`, `/docs/` or `/documentation/` in the path), `0.8` for a standards body or registry (w3.org, ietf.org, rfc-editor.org, iso.org, access-board.gov, section508.gov, npmjs.com, pypi.org, crates.io, pkg.go.dev, a GitHub repo's releases or tags page) or the vendor's own domain, and `1.0` for first party plus a docs page. "Vendor" means the registrable domain (subdomains ignored, so proxmox.rdem-systems.com is not Proxmox) equals a word, or two or three joined words, of a classifier entity: "TrueNAS" matches truenas.com, "Home Assistant" matches home-assistant.io; on GitHub the repo owner or name is checked ("llama.cpp" matches github.com/ggml-org/llama.cpp). Generic words ("Community", "Code") and standard names (WCAG, ARIA, so wcag.com is not the W3C) never count. For `opinion` questions first-party pages get no bonus. Nothing depends on the eval fixtures.
- **Where it applies.** After every rerank of a web search (the snippet rerank, which decides which pages are read, and the passage rerank, which feeds selection), the scores of that one rerank are min-max scaled to 0..1 and each item is ordered by `scaled score + weight * prior`. Scores from different rerankers or different reranks are never compared. The raw `score` is kept; `prior` is added. Academic and discussion search, and reranker `off`, are unchanged.
- **official_docs variant.** When the planner marks a query `official_docs` and the classifier gave entities, the first such query also runs with a vendor domain guess appended as a plain word (`Proxmox VE 9 release notes proxmox.com`). The guess is the standards body for a standard name (WCAG to w3.org, Section 508 to section508.gov) or the first distinctive entity word plus `.com`. It is not a `site:` operator: SearXNG passes `site:` through, but only some engines (Google, Bing, DuckDuckGo, Brave) honour it, and a wrong guess there would return nothing. The variant only fits under the 3-query cap; it never replaces a planned query.

| Setting                                   | Key                 | Default                    | Environment variable       |
| ----------------------------------------- | ------------------- | -------------------------- | -------------------------- |
| Prefer first-party sources (experimental) | `sourcePriorWeight` | `0.5` (0 to 2; `0` is off) | `VANE_SOURCE_PRIOR_WEIGHT` |

The evidence budget default also moved from 16 to 12. 16 was the first guess in M2; the UI shows 8 source cards either way. A saved value in Settings still wins over the new default, so an instance that already saved `16` keeps it until it is changed.

New trace fields:

- `rerank.prior` event, one per rerank when the prior ran: `stage`, `weight`, `boosted` (items above neutral), `penalised` (below neutral), `moved` (items whose position changed).
- `search.variant` event, one per `web_search` call with an `official_docs` query: `from`, and either `query` and `domain`, or `skipped` (`no_domain`, `cap` or `already_named`).
- `evidence` event items carry `prior` when one was applied.

## Run the tests

```
npm test
```

This runs vitest once (`vitest run`). Tests live in `src/**/__tests__/`.

## Run the eval

Start Vane (with a SearXNG URL and at least one chat and one embedding model configured), then:

```
node scripts/eval/run.ts --url http://127.0.0.1:3000 --mode speed --out data/eval
```

Needs Node 24 or newer (it runs the TypeScript file directly). `node scripts/eval/run.ts --help` lists every option, including `--fixtures <file>`, `--only f01,f02`, `--concurrency`, `--timeout`, and `--chat providerId:key` / `--embedding providerId:key` to override the default of the first provider that has models.

### Fixtures

`scripts/eval/fixtures.json` is the canonical set and the default for `--fixtures`: 30 real questions (homelab, accessibility, local-model hardware and tooling), fact-checked against primary sources on 2026-10-31 and updated 2026-11-01. Keep fixture ids stable when a fixture is rewritten, so runs stay comparable by id; say in `notes` what changed and when. `scripts/eval/fixtures.example.json` is a three-fixture placeholder that shows the shape.

Each fixture has:

- `id`, `tags`
- `turns`: one or more questions, asked in order in one conversation
- `requiredFacts`: what a good answer states; facts for a later turn start "Turn 2: ..."
- `acceptableSourceDomains`
- `freshness`: how fast the answer goes stale (`none`, `historical`, `recent`, `current`)
- `expectAbstain`: true when the question asks about something that does not exist
- `notes`: corrections, current values, run-day checks and known bad answers, for the judge
- `needsHumanCheck` (optional): true when the facts could not be confirmed against the primary source (for example the site blocked automated fetchers). The fixture stays in the set; the judge flags its line and a person confirms it.

### Multi-turn fixtures

For a fixture with several turns, each answer is fed back as history for the next turn, the way the chat UI does. Every turn is stored in the results line:

```json
{
  "id": "f04",
  "turns": [
    { "question": "How do I expose ...?", "answer": "Use tailscale serve ...", "sources": [ ... ], "latencyMs": 9120 },
    { "question": "How is that different ...?", "answer": "Funnel ...", "sources": [ ... ], "latencyMs": 8410 }
  ],
  "latencyMs": 8410,
  "turn1LatencyMs": 9120,
  "answer": "Funnel ...",
  "sources": [ ... ]
}
```

The top-level `answer`, `sources`, `latencyMs`, `sourceCount`, `citations`, acceptable-domain hits and `abstained` still describe the final turn, as before, so older readers keep working. Required facts are matched against all turns' answers joined. On an error, `turns` holds the turns that finished plus the questions that never got an answer. Results files written before turn storage hold plain question strings in `turns`; compare.ts reads both.

### Output files

Each run writes two files to `--out`:

- `results-<mode>-<UTC stamp>.jsonl`: one line per fixture with every turn's question, answer, sources and latency, then the final turn's latency, source count, citation stats, required-fact hits and misses, acceptable-domain hits, whether the answer abstained ("could not find"), any error, and the raw answer and sources. `needsHumanCheck: true` is copied from the fixture when set.
- `summary-<mode>-<UTC stamp>.html`: one self-contained page. The summary table gives mean and p95 latency, mean source count, the share of answers citing a source number that does not exist, the mean required-fact hit rate, the abstain count and errors. Below it, one row per fixture; open "Full answer and sources" to see the whole answer.

Fact hits are case-insensitive substring matches, so treat them as a smoke signal, not a grade.

## Comparing runs

`scripts/eval/compare.ts` puts two or more results files side by side in one self-contained HTML page. Runs may use different modes; each run's mode is shown next to its label.

```
node scripts/eval/compare.ts --run "baseline=data/eval/results-speed-<stamp>.jsonl" --run "M1=data/eval/results-speed-<stamp>.jsonl" --out data/eval/compare.html
```

The first `--run` is the baseline. The page has three sections:

- **Summary:** one column per run. Fixtures run, succeeded, errors, mean, median and p95 latency, mean sources, the share of answers with zero sources and with out-of-range citations, total out-of-range citations, mean answer length, abstain count, abstained when expected (abstentions among fixtures with `expectAbstain`, over how many such fixtures succeeded) and mean acceptable-domain hits. The best value in each row is bold: lower for latency, errors, zero sources and out-of-range citations, higher for the rest. Fixtures run, answer length and abstain count are not ranked.
- **Per fixture:** one row per fixture id (the union across runs), with latency in seconds, sources, out-of-range citations, abstained and any error for each run. The row heading shows the tags and, for multi-turn fixtures, the turn count. A cell is red for an error or out-of-range citations, green when latency is at least 30% lower than the baseline. A fixture missing from a run shows `n/a`.
- **Answers side by side:** one collapsed block per fixture, headed with the turn count and every question. Each run's panel shows the turn count, each earlier turn's answer and sources in its own collapsed block, then the final turn's answer (first 600 characters, full text in a nested block) and its sources.

`--judge <file>` adds judged scores. The file is JSONL, one line per run and fixture, written by a person or a judging model after reading the answers:

```json
{
  "run": "M1",
  "id": "f01",
  "factScore": 0.5,
  "unsupportedClaims": ["Says 9.0 shipped in July"],
  "citedWrongly": false,
  "notes": "Right Debian release, wrong month; below Perplexity."
}
```

`run` must match a `--run` label (other lines are skipped with a warning), `factScore` is 0 to 1, `unsupportedClaims` is empty when every claim is supported, `citedWrongly` (optional) is true when the answer cites `[n]` with no sources, and `notes` is optional. With a judge file the summary adds the mean judged fact score and the share of answers with at least one unsupported claim (lower is better), the matrix adds a Judged column, and the detail shows the claims, notes and a "cited wrongly" flag.

## Judging runs with an agent

Substring fact hits are a smoke signal. The grade comes from a judge: a separate agent run that reads the fixtures and the answers and writes the judge JSONL above.

- `scripts/eval/JUDGE.md` is the rule book: how `factScore` is built (per-fact 1, 0.5 or 0, averaged; version-and-date facts need both; abstain fixtures score 1.0 for "could not find or confirm", 0.5 for an adjacent answer that never confirms, 0.0 for describing the thing as real), what counts as an unsupported claim, `citedWrongly`, the one-sentence notes against a Perplexity-grade answer, the consistency rules across runs, and the exact output shape. It also says which fixture notes call for a run-day check of a live page.
- `scripts/eval/judge-template.md` is the prompt to paste into the judge: fill in the repository path, the fixtures path, each results file with its label, the output path and the date.

To judge:

1. Run the eval for each configuration you want to compare (`run.ts`), noting each results file.
2. Copy `scripts/eval/judge-template.md`, fill in the placeholders, and start a separate agent run with it. Use a strong model, and not the one that wrote the answers.
3. The judge reads `JUDGE.md`, writes the JSONL, checks it with compare.ts, and reports means per run, lines with unsupported claims or wrong citations, skipped errors, run-day pages read, and fixtures that need a human check.
4. Build the page: `node scripts/eval/compare.ts --run "a=..." --run "b=..." --judge <judge.jsonl> --out data/eval/compare.html`.

Fixtures with `needsHumanCheck: true` are still judged; their notes say so, and a person should confirm those lines before quoting the score.
