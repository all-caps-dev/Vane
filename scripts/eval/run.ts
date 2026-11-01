// TypeScript (run directly with Node 24+ type stripping): eval runner for Vane's /api/search.
//
// Usage: node scripts/eval/run.ts --help
//
// Only "erasable" TypeScript is allowed here (types, `as`, no enums, no
// parameter properties), because Node strips the types and runs the rest as
// plain JavaScript. No dependencies beyond Node itself.

import fs from 'node:fs';
import path from 'node:path';

const USAGE = `Vane eval runner

Usage:
  node scripts/eval/run.ts [options]

Options:
  --url <base>             Vane base URL (default http://127.0.0.1:3000)
  --fixtures <file>        Fixture JSON (default scripts/eval/fixtures.json)
  --mode <m>               speed | balanced | quality (default speed)
  --out <dir>              Output folder (default data/eval)
  --only <ids>             Comma-separated fixture ids, e.g. f01,f02
  --concurrency <n>        Fixtures run at once (default 1)
  --chat <providerId:key>  Chat model override (default: first provider with chat models)
  --embedding <providerId:key>
                           Embedding model override (default: first provider with embedding models)
  --timeout <ms>           Per-request timeout (default 300000)
  --help                   Show this help

Writes <out>/results-<mode>-<stamp>.jsonl and <out>/summary-<mode>-<stamp>.html.
Fixture schema: { version, fixtures: [{ id, tags, turns (1 or more), requiredFacts,
acceptableSourceDomains, freshness, expectAbstain, notes, needsHumanCheck? }] }
Every turn's answer is stored; required facts are matched against all turns.
`;

type Mode = 'speed' | 'balanced' | 'quality';

type Fixture = {
  id: string;
  tags: string[];
  turns: string[];
  requiredFacts: string[];
  acceptableSourceDomains: string[];
  freshness?: unknown;
  expectAbstain: boolean;
  notes?: string;
  // True when a fact could not be checked against its primary source and a
  // person should confirm the judgement by hand.
  needsHumanCheck: boolean;
};

type ModelRef = { providerId: string; key: string };

type Source = {
  content?: string;
  metadata?: { url?: string; title?: string; [k: string]: unknown };
};

type Args = {
  url: string;
  fixtures: string;
  mode: Mode;
  out: string;
  only: string[];
  concurrency: number;
  chat?: string;
  embedding?: string;
  timeoutMs: number;
  help: boolean;
};

// ---------------------------------------------------------------------------
// scanCitations: mirrors src/lib/utils/citations.ts. It is copied rather than
// imported because importing a .ts path breaks the repo's tsc check. Keep the
// two in sync.
type CitationStats = {
  citations: number[];
  uniqueCitations: number[];
  citationCount: number;
  maxIndex: number;
  sourceCount: number;
  outOfRangeCount: number;
};

const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

const scanCitations = (answer: string, sourceCount: number): CitationStats => {
  const citations: number[] = [];
  for (const match of (answer ?? '').matchAll(MARKER)) {
    for (const part of match[1].split(',')) {
      const n = parseInt(part.trim(), 10);
      if (Number.isFinite(n)) citations.push(n);
    }
  }
  const uniqueCitations = Array.from(new Set(citations)).sort((a, b) => a - b);
  return {
    citations,
    uniqueCitations,
    citationCount: citations.length,
    maxIndex: citations.length > 0 ? Math.max(...citations) : 0,
    sourceCount,
    outOfRangeCount: citations.filter((n) => n < 1 || n > sourceCount).length,
  };
};
// ---------------------------------------------------------------------------

// The writer prompt's "no information" phrase (src/lib/prompts/search/writer.ts).
const ABSTAIN_PATTERN = /could not find/i;

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    url: 'http://127.0.0.1:3000',
    fixtures: 'scripts/eval/fixtures.json',
    mode: 'speed',
    out: 'data/eval',
    only: [],
    concurrency: 1,
    timeoutMs: 300000,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };

    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--url':
        args.url = next().replace(/\/+$/, '');
        break;
      case '--fixtures':
        args.fixtures = next();
        break;
      case '--mode': {
        const mode = next();
        if (mode !== 'speed' && mode !== 'balanced' && mode !== 'quality') {
          throw new Error(`--mode must be speed, balanced or quality`);
        }
        args.mode = mode;
        break;
      }
      case '--out':
        args.out = next();
        break;
      case '--only':
        args.only = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--concurrency':
        args.concurrency = Math.max(1, parseInt(next(), 10) || 1);
        break;
      case '--chat':
        args.chat = next();
        break;
      case '--embedding':
        args.embedding = next();
        break;
      case '--timeout':
        args.timeoutMs = Math.max(1000, parseInt(next(), 10) || 300000);
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return args;
};

// Splits "providerId:key" on the FIRST colon, since model keys such as
// "llama3.1:latest" can contain colons and provider ids (UUIDs) cannot.
const parseModelRef = (value: string, flag: string): ModelRef => {
  const at = value.indexOf(':');
  if (at <= 0 || at === value.length - 1) {
    throw new Error(`${flag} must look like providerId:key`);
  }
  return { providerId: value.slice(0, at), key: value.slice(at + 1) };
};

const loadFixtures = (file: string): Fixture[] => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const list: unknown[] = Array.isArray(raw?.fixtures) ? raw.fixtures : [];
  if (list.length === 0) throw new Error(`No fixtures found in ${file}`);

  return list.map((f: any, i) => {
    if (!f || typeof f.id !== 'string') {
      throw new Error(`Fixture #${i + 1} has no string id`);
    }
    if (!Array.isArray(f.turns) || f.turns.length < 1) {
      throw new Error(`Fixture ${f.id}: turns must have at least 1 string`);
    }
    return {
      id: f.id,
      tags: Array.isArray(f.tags) ? f.tags : [],
      turns: f.turns.map(String),
      requiredFacts: Array.isArray(f.requiredFacts) ? f.requiredFacts : [],
      acceptableSourceDomains: Array.isArray(f.acceptableSourceDomains)
        ? f.acceptableSourceDomains
        : [],
      freshness: f.freshness,
      expectAbstain: f.expectAbstain === true,
      notes: typeof f.notes === 'string' ? f.notes : undefined,
      needsHumanCheck: f.needsHumanCheck === true,
    };
  });
};

// GET /api/providers and pick the first usable chat and embedding models,
// unless --chat / --embedding were given.
const pickModels = async (
  args: Args,
): Promise<{ chatModel: ModelRef; embeddingModel: ModelRef }> => {
  const chatOverride = args.chat ? parseModelRef(args.chat, '--chat') : null;
  const embeddingOverride = args.embedding
    ? parseModelRef(args.embedding, '--embedding')
    : null;
  if (chatOverride && embeddingOverride) {
    return { chatModel: chatOverride, embeddingModel: embeddingOverride };
  }

  const res = await fetch(`${args.url}/api/providers`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GET /api/providers failed: ${res.status}`);
  const body = (await res.json()) as {
    providers?: {
      id: string;
      chatModels?: { key: string }[];
      embeddingModels?: { key: string }[];
    }[];
  };
  const providers = body.providers ?? [];

  // A provider whose model list failed reports a fake chat model keyed 'error'.
  const usable = (models?: { key: string }[]) =>
    (models ?? []).filter((m) => m.key && m.key !== 'error');

  const chatProvider = providers.find((p) => usable(p.chatModels).length > 0);
  const embeddingProvider = providers.find(
    (p) => usable(p.embeddingModels).length > 0,
  );

  const chatModel =
    chatOverride ??
    (chatProvider
      ? {
          providerId: chatProvider.id,
          key: usable(chatProvider.chatModels)[0].key,
        }
      : null);
  const embeddingModel =
    embeddingOverride ??
    (embeddingProvider
      ? {
          providerId: embeddingProvider.id,
          key: usable(embeddingProvider.embeddingModels)[0].key,
        }
      : null);

  if (!chatModel) throw new Error('No provider with chat models found');
  if (!embeddingModel)
    throw new Error('No provider with embedding models found');
  return { chatModel, embeddingModel };
};

// One POST /api/search call (non-streaming), body as in docs/API/SEARCH.md.
const askOnce = async (
  args: Args,
  models: { chatModel: ModelRef; embeddingModel: ModelRef },
  query: string,
  history: [string, string][],
): Promise<{ message: string; sources: Source[]; latencyMs: number }> => {
  const startedAt = Date.now();
  const res = await fetch(`${args.url}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      optimizationMode: args.mode,
      sources: ['web'],
      query,
      history,
      chatModel: models.chatModel,
      embeddingModel: models.embeddingModel,
      stream: false,
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /api/search ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { message?: string; sources?: Source[] };
  return {
    message: typeof body.message === 'string' ? body.message : '',
    sources: Array.isArray(body.sources) ? body.sources : [],
    latencyMs,
  };
};

// Normalises "https://www.Example.com/path" to "example.com".
const normaliseDomain = (domain: string): string =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '');

const hostnameOf = (url?: string): string => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
};

// One turn of a fixture as stored in the results line. A turn that never ran
// (an earlier turn errored) has only its question.
type TurnRecord = {
  question: string;
  answer?: string;
  sources?: Source[];
  latencyMs?: number;
};

const runFixture = async (
  args: Args,
  models: { chatModel: ModelRef; embeddingModel: ModelRef },
  fixture: Fixture,
) => {
  const base = {
    id: fixture.id,
    tags: fixture.tags,
    mode: args.mode,
    expectAbstain: fixture.expectAbstain,
    // Only written when set, so ordinary lines stay the same shape as before.
    ...(fixture.needsHumanCheck ? { needsHumanCheck: true } : {}),
  };

  // Filled in as each turn finishes, so an error part-way through still
  // records the turns that did run.
  const done: TurnRecord[] = [];

  try {
    // Ask every turn in order, feeding each earlier question and answer back
    // as history, the way the chat UI does.
    let history: [string, string][] = [];
    for (const question of fixture.turns) {
      const reply = await askOnce(args, models, question, history);
      done.push({
        question,
        answer: reply.message,
        sources: reply.sources,
        latencyMs: reply.latencyMs,
      });
      history = [...history, ['human', question], ['assistant', reply.message]];
    }

    // The top-level answer, sources, latency and citation stats describe the
    // final turn, as they always have, so compare.ts and older readers work.
    const final = done[done.length - 1];
    const scored = {
      message: final.answer ?? '',
      sources: final.sources ?? [],
      latencyMs: final.latencyMs ?? 0,
    };
    const answer = scored.message;

    // Required facts are matched against every turn's answer joined, because
    // a multi-turn fixture's facts are spread across turns ("Turn 1: ...").
    const allAnswers = done
      .map((t) => t.answer ?? '')
      .join('\n\n')
      .toLowerCase();
    const misses = fixture.requiredFacts.filter(
      (fact) => !allAnswers.includes(String(fact).toLowerCase()),
    );
    const factHits = fixture.requiredFacts.length - misses.length;

    const domains = fixture.acceptableSourceDomains
      .map(normaliseDomain)
      .filter(Boolean);
    const matchedSources = scored.sources.filter((s) => {
      const host = hostnameOf(s.metadata?.url);
      return (
        host !== '' && domains.some((d) => host === d || host.endsWith(`.${d}`))
      );
    });

    const abstained = ABSTAIN_PATTERN.test(answer);

    return {
      ...base,
      turns: done,
      latencyMs: scored.latencyMs,
      // Kept for older readers: the first turn's latency on multi-turn fixtures.
      turn1LatencyMs: done.length > 1 ? done[0].latencyMs : undefined,
      answerChars: answer.length,
      sourceCount: scored.sources.length,
      citations: scanCitations(answer, scored.sources.length),
      requiredFacts: {
        hits: factHits,
        total: fixture.requiredFacts.length,
        misses,
      },
      factHitRate:
        fixture.requiredFacts.length > 0
          ? factHits / fixture.requiredFacts.length
          : null,
      acceptableDomainHits: matchedSources.length,
      matchedDomains: matchedSources.map((s) => hostnameOf(s.metadata?.url)),
      abstained,
      abstainMatchesExpectation: abstained === fixture.expectAbstain,
      error: null,
      answer,
      sources: scored.sources,
    };
  } catch (err) {
    return {
      ...base,
      // Completed turns in full, then the questions that never got an answer.
      turns: [
        ...done,
        ...fixture.turns
          .slice(done.length)
          .map((question): TurnRecord => ({ question })),
      ],
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

type Result = Awaited<ReturnType<typeof runFixture>>;

// Runs fixtures with at most `limit` in flight, keeping the input order.
const runPool = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(lanes);
  return results;
};

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Nearest-rank percentile.
const percentile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
};

const summarise = (results: Result[]) => {
  const ok = results.filter((r) => !r.error) as Extract<
    Result,
    { error: null }
  >[];
  const latencies = ok.map((r) => r.latencyMs);
  const factRates = ok
    .map((r) => r.factHitRate)
    .filter((x): x is number => typeof x === 'number');

  return {
    fixturesRun: results.length,
    succeeded: ok.length,
    errors: results.length - ok.length,
    meanLatencyMs: mean(latencies),
    p95LatencyMs: percentile(latencies, 95),
    meanSourceCount: mean(ok.map((r) => r.sourceCount)),
    pctWithOutOfRangeCitations: ok.length
      ? (100 * ok.filter((r) => r.citations.outOfRangeCount > 0).length) /
        ok.length
      : null,
    meanRequiredFactHitRate: mean(factRates),
    abstainCount: ok.filter((r) => r.abstained).length,
    abstainMatchesExpectation: ok.filter((r) => r.abstainMatchesExpectation)
      .length,
  };
};

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmt = (n: number | null | undefined, digits = 0): string =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : 'n/a';

const renderHtml = (
  meta: Record<string, string>,
  summary: ReturnType<typeof summarise>,
  results: Result[],
): string => {
  const metaRows = Object.entries(meta)
    .map(
      ([k, v]) =>
        `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
    )
    .join('');

  const summaryRows: [string, string][] = [
    ['Fixtures run', `${summary.fixturesRun} (${summary.succeeded} ok)`],
    ['Mean latency', `${fmt(summary.meanLatencyMs)} ms`],
    ['p95 latency', `${fmt(summary.p95LatencyMs)} ms`],
    ['Mean sources', fmt(summary.meanSourceCount, 1)],
    [
      'With out-of-range citations',
      `${fmt(summary.pctWithOutOfRangeCitations, 1)}%`,
    ],
    [
      'Mean required-fact hit rate',
      summary.meanRequiredFactHitRate === null
        ? 'n/a'
        : `${fmt(summary.meanRequiredFactHitRate * 100, 1)}%`,
    ],
    [
      'Abstained',
      `${summary.abstainCount} (matches expectation: ${summary.abstainMatchesExpectation}/${summary.succeeded})`,
    ],
    ['Errors', String(summary.errors)],
  ];

  const fixtureRows = results
    .map((r) => {
      const tags = escapeHtml(r.tags.join(', '));
      if (r.error) {
        return `<tr class="err"><td>${escapeHtml(r.id)}</td><td>${tags}</td><td colspan="5">Error: ${escapeHtml(r.error)}</td></tr>`;
      }
      const ok = r as Extract<Result, { error: null }>;
      const citesBad = ok.citations.outOfRangeCount;
      const citesOk = ok.citations.citationCount - citesBad;
      const preview = ok.answer.slice(0, 300);
      const misses = ok.requiredFacts.misses.length
        ? `<div class="muted">missed: ${escapeHtml(ok.requiredFacts.misses.join('; '))}</div>`
        : '';
      const sourcesList = ok.sources
        .map(
          (s, i) =>
            `<li>[${i + 1}] <a href="${escapeHtml(s.metadata?.url)}">${escapeHtml(s.metadata?.title || s.metadata?.url)}</a></li>`,
        )
        .join('');
      return `<tr>
<td>${escapeHtml(ok.id)}${ok.abstained ? '<div class="muted">abstained</div>' : ''}</td>
<td>${tags}</td>
<td>${fmt(ok.latencyMs)} ms</td>
<td>${ok.sourceCount}</td>
<td class="${citesBad ? 'bad' : ''}">${citesOk} ok / ${citesBad} bad</td>
<td>${ok.requiredFacts.hits}/${ok.requiredFacts.total}${misses}</td>
<td>${ok.acceptableDomainHits}</td>
</tr>
<tr class="answer"><td colspan="7"><p>${escapeHtml(preview)}${ok.answer.length > 300 ? '…' : ''}</p>
<details><summary>Full answer and sources</summary><pre>${escapeHtml(ok.answer)}</pre><ol class="plain">${sourcesList}</ol></details></td></tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vane eval: ${escapeHtml(meta.mode)} ${escapeHtml(meta.stamp)}</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0 auto; padding: 1rem; max-width: 70rem; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .25rem 1rem; margin: 0; }
  dt { font-size: .8rem; color: #555; }
  dd { margin: 0 0 .5rem; word-break: break-all; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: .4rem .5rem; border-bottom: 1px solid #ddd; }
  th { background: #f3f3f3; font-size: .85rem; }
  tr.answer td { border-bottom: 2px solid #bbb; font-size: .9rem; }
  tr.answer p { margin: 0 0 .25rem; }
  tr.err td { background: #fdecea; }
  td.bad { color: #a40000; font-weight: 600; }
  .muted { color: #666; font-size: .8rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; background: #f7f7f7; padding: .5rem; }
  ol.plain { padding-left: 1.25rem; word-break: break-all; }
  @media (prefers-color-scheme: dark) {
    body { background: #121212; color: #e6e6e6; }
    th { background: #222; } th, td { border-color: #333; }
    dt, .muted { color: #aaa; } pre { background: #1d1d1d; }
    tr.err td { background: #3a1d1d; } td.bad { color: #ff8a80; } a { color: #8ab4f8; }
  }
</style>
</head>
<body>
<h1>Vane eval run</h1>
<dl>${metaRows}</dl>
<h2>Summary</h2>
<div class="scroll"><table><tbody>
${summaryRows.map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('\n')}
</tbody></table></div>
<h2>Fixtures</h2>
<div class="scroll"><table>
<thead><tr><th>Id</th><th>Tags</th><th>Latency</th><th>Sources</th><th>Cites</th><th>Facts</th><th>Domains hit</th></tr></thead>
<tbody>
${fixtureRows}
</tbody></table></div>
</body>
</html>
`;
};

const main = async () => {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  let fixtures = loadFixtures(args.fixtures);
  if (args.only.length) {
    fixtures = fixtures.filter((f) => args.only.includes(f.id));
    if (!fixtures.length) throw new Error(`--only matched no fixtures`);
  }

  const models = await pickModels(args);
  const startedAt = new Date();
  // UTC stamp for file names, e.g. 20261031T160501Z
  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

  console.log(
    `Running ${fixtures.length} fixture(s), mode=${args.mode}, concurrency=${args.concurrency}, chat=${models.chatModel.key}, embedding=${models.embeddingModel.key}`,
  );

  const results = await runPool(fixtures, args.concurrency, async (f) => {
    const r = await runFixture(args, models, f);
    console.log(
      r.error
        ? `  ${f.id}: ERROR ${r.error}`
        : `  ${f.id}: ${r.latencyMs} ms, ${(r as any).sourceCount} sources`,
    );
    return r;
  });

  const summary = summarise(results);

  fs.mkdirSync(args.out, { recursive: true });
  const jsonlPath = path.join(args.out, `results-${args.mode}-${stamp}.jsonl`);
  const htmlPath = path.join(args.out, `summary-${args.mode}-${stamp}.html`);

  fs.writeFileSync(
    jsonlPath,
    results.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  fs.writeFileSync(
    htmlPath,
    renderHtml(
      {
        mode: args.mode,
        stamp,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        url: args.url,
        fixtures: args.fixtures,
        chatModel: `${models.chatModel.providerId}:${models.chatModel.key}`,
        embeddingModel: `${models.embeddingModel.providerId}:${models.embeddingModel.key}`,
        concurrency: String(args.concurrency),
      },
      summary,
      results,
    ),
  );

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${jsonlPath}\nWrote ${htmlPath}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
