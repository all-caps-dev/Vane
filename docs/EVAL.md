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

Spans: `classify`, `widgets`, `research`, `embed` (speed and balanced), `pick` (quality), `write`.
Events: `request`, `research.iteration`, `research.actions`, `search.query`, `fetch`, `extract`, `dedup`, `sources`, `citations`, `citations.removed`.

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
