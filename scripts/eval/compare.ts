// TypeScript (run directly with Node 24+ type stripping): compares results files from scripts/eval/run.ts in one HTML page.
//
// Usage: node scripts/eval/compare.ts --help
//
// Same rules as run.ts: only "erasable" TypeScript (types, `as`, no enums, no
// parameter properties), because Node strips the types and runs the rest as
// plain JavaScript. No dependencies beyond Node itself.
//
// Optional judge file (--judge): JSONL, one line per (run, fixture) pair,
// written by a person or a judging model after reading the answers:
//   { "run": "<label>", "id": "f01", "factScore": 0.0-1.0,
//     "unsupportedClaims": ["..."], "notes": "..." }
// - run: must match a --run label exactly (lines for unknown labels are ignored with a warning)
// - factScore: 0 to 1, how much of the required facts the answer got right
// - unsupportedClaims: claims the sources do not support; empty array when none
// - notes: free text, shown in the per-fixture detail

import fs from 'node:fs';
import path from 'node:path';

const USAGE = `Vane eval comparison

Usage:
  node scripts/eval/compare.ts --run "label=path/to/results.jsonl" [--run ...] --out <file.html> [--judge <judge.jsonl>]

Options:
  --run <label=file>   A results-<mode>-<stamp>.jsonl from run.ts, with a short label.
                       Repeat for each run; the first run is the baseline for the
                       latency colouring. Runs may use different modes.
  --out <file.html>    Where to write the self-contained HTML page.
  --judge <file>       Optional JSONL of judgements, one line per run and fixture:
                       { "run": "<label>", "id": "f01", "factScore": 0.0-1.0,
                         "unsupportedClaims": ["..."], "notes": "..." }
  --help               Show this help
`;

// ---------------------------------------------------------------------------
// Shapes. These mirror what run.ts writes. Every field except id and error is
// optional, because an errored fixture only has id, tags, mode, turns,
// expectAbstain, latencyMs (null) and error.
type Source = {
  content?: string;
  metadata?: { url?: string; title?: string; [k: string]: unknown };
};

type ResultLine = {
  id: string;
  tags?: string[];
  mode?: string;
  turns?: string[];
  expectAbstain?: boolean;
  latencyMs: number | null;
  turn1LatencyMs?: number;
  answerChars?: number;
  sourceCount?: number;
  citations?: {
    citationCount: number;
    uniqueCitations: number[];
    maxIndex: number;
    outOfRangeCount: number;
  };
  requiredFacts?: { hits: number; total: number; misses: string[] };
  factHitRate?: number | null;
  acceptableDomainHits?: number;
  matchedDomains?: string[];
  abstained?: boolean;
  abstainMatchesExpectation?: boolean;
  error: string | null;
  answer?: string;
  sources?: Source[];
};

type Judgement = {
  run: string;
  id: string;
  factScore: number;
  unsupportedClaims: string[];
  notes?: string;
};

type Run = {
  label: string;
  file: string;
  modes: string[]; // usually one; more than one means a mixed file
  byId: Map<string, ResultLine>;
  ids: string[]; // fixture ids in file order
};

type Args = {
  runs: { label: string; file: string }[];
  out: string;
  judge?: string;
  help: boolean;
};

// ---------------------------------------------------------------------------
// Arguments and file loading

const parseArgs = (argv: string[]): Args => {
  const args: Args = { runs: [], out: '', help: false };

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
      case '--run': {
        // Split on the FIRST "=", so a path may contain "=".
        const value = next();
        const at = value.indexOf('=');
        if (at <= 0 || at === value.length - 1) {
          throw new Error(`--run must look like label=path/to/results.jsonl`);
        }
        const label = value.slice(0, at).trim();
        if (args.runs.some((r) => r.label === label)) {
          throw new Error(`--run label "${label}" is used twice`);
        }
        args.runs.push({ label, file: value.slice(at + 1) });
        break;
      }
      case '--out':
        args.out = next();
        break;
      case '--judge':
        args.judge = next();
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (!args.help) {
    if (args.runs.length === 0) throw new Error('Give at least one --run');
    if (!args.out) throw new Error('--out is required');
  }
  return args;
};

// Reads a JSONL file into parsed objects, skipping blank lines and naming the
// line number when one is not valid JSON.
const readJsonl = (file: string): unknown[] =>
  fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line !== '')
    .map(({ line, n }) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${file}:${n} is not valid JSON`);
      }
    });

const loadRun = (label: string, file: string): Run => {
  const byId = new Map<string, ResultLine>();
  const ids: string[] = [];
  const modes = new Set<string>();

  readJsonl(file).forEach((raw, i) => {
    const r = raw as ResultLine;
    if (!r || typeof r.id !== 'string') {
      throw new Error(`${file}: line ${i + 1} has no string id`);
    }
    if (byId.has(r.id)) {
      console.warn(
        `warning: ${label}: fixture ${r.id} appears twice, keeping the last`,
      );
    } else {
      ids.push(r.id);
    }
    // Older or hand-made lines may lack `error`; treat that as success.
    byId.set(r.id, { ...r, error: r.error ?? null });
    if (r.mode) modes.add(r.mode);
  });

  if (byId.size === 0) throw new Error(`${file} has no results`);
  return { label, file, modes: [...modes], byId, ids };
};

// Judgements keyed by "label\u0000id" so lookups are one Map.get.
const judgeKey = (run: string, id: string) => `${run}\u0000${id}`;

const loadJudge = (file: string, labels: string[]): Map<string, Judgement> => {
  const out = new Map<string, Judgement>();
  const unknown = new Set<string>();

  readJsonl(file).forEach((raw, i) => {
    const j = raw as Partial<Judgement>;
    const where = `${file}: line ${i + 1}`;
    if (!j || typeof j.run !== 'string' || typeof j.id !== 'string') {
      throw new Error(`${where} needs string "run" and "id"`);
    }
    if (
      typeof j.factScore !== 'number' ||
      !(j.factScore >= 0 && j.factScore <= 1)
    ) {
      throw new Error(`${where}: factScore must be a number from 0 to 1`);
    }
    if (
      j.unsupportedClaims !== undefined &&
      !Array.isArray(j.unsupportedClaims)
    ) {
      throw new Error(`${where}: unsupportedClaims must be an array`);
    }
    if (!labels.includes(j.run)) {
      unknown.add(j.run);
      return;
    }
    out.set(judgeKey(j.run, j.id), {
      run: j.run,
      id: j.id,
      factScore: j.factScore,
      unsupportedClaims: (j.unsupportedClaims ?? []).map(String),
      notes: typeof j.notes === 'string' ? j.notes : undefined,
    });
  });

  if (unknown.size) {
    console.warn(
      `warning: judge lines for unknown run label(s) ignored: ${[...unknown].join(', ')}`,
    );
  }
  return out;
};

// ---------------------------------------------------------------------------
// Statistics

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Nearest-rank percentile, the same method as run.ts.
const percentile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
};

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? (100 * part) / whole : null;

// Which direction is "better" for a summary row. "none" rows are not bolded.
type Better = 'lower' | 'higher' | 'none';

type SummaryRow = {
  label: string;
  better: Better;
  values: (number | null)[]; // compared to find the best
  shown: string[]; // what the cell displays
};

const fmt = (n: number | null | undefined, digits = 0): string =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : 'n/a';

const secs = (ms: number | null | undefined, digits = 1): string =>
  typeof ms === 'number' && Number.isFinite(ms)
    ? `${(ms / 1000).toFixed(digits)} s`
    : 'n/a';

const isOk = (r: ResultLine) => !r.error;

const buildSummary = (
  runs: Run[],
  judge: Map<string, Judgement> | null,
): SummaryRow[] => {
  // Small helper: one row from a function that returns [value, shownText] per run.
  const row = (
    label: string,
    better: Better,
    cell: (
      run: Run,
      all: ResultLine[],
      ok: ResultLine[],
    ) => [number | null, string],
  ): SummaryRow => {
    const cells = runs.map((run) => {
      const all = [...run.byId.values()];
      return cell(run, all, all.filter(isOk));
    });
    return {
      label,
      better,
      values: cells.map((c) => c[0]),
      shown: cells.map((c) => c[1]),
    };
  };

  const latencies = (ok: ResultLine[]) =>
    ok
      .map((r) => r.latencyMs)
      .filter((x): x is number => typeof x === 'number');

  const rows: SummaryRow[] = [
    row('Fixtures run', 'none', (_r, all) => [all.length, String(all.length)]),
    row('Succeeded', 'higher', (_r, _a, ok) => [ok.length, String(ok.length)]),
    row('Errors', 'lower', (_r, all, ok) => [
      all.length - ok.length,
      String(all.length - ok.length),
    ]),
    row('Mean latency', 'lower', (_r, _a, ok) => {
      const v = mean(latencies(ok));
      return [v, secs(v)];
    }),
    row('Median latency', 'lower', (_r, _a, ok) => {
      const v = percentile(latencies(ok), 50);
      return [v, secs(v)];
    }),
    row('p95 latency', 'lower', (_r, _a, ok) => {
      const v = percentile(latencies(ok), 95);
      return [v, secs(v)];
    }),
    row('Mean sources', 'higher', (_r, _a, ok) => {
      const v = mean(ok.map((r) => r.sourceCount ?? 0));
      return [v, fmt(v, 1)];
    }),
    row('Answers with zero sources', 'lower', (_r, _a, ok) => {
      const n = ok.filter((r) => (r.sourceCount ?? 0) === 0).length;
      const v = pct(n, ok.length);
      return [v, `${fmt(v, 1)}% (${n})`];
    }),
    row('Answers with out-of-range citations', 'lower', (_r, _a, ok) => {
      const n = ok.filter(
        (r) => (r.citations?.outOfRangeCount ?? 0) > 0,
      ).length;
      const v = pct(n, ok.length);
      return [v, `${fmt(v, 1)}% (${n})`];
    }),
    row('Total out-of-range citations', 'lower', (_r, _a, ok) => {
      const v = ok.reduce(
        (sum, r) => sum + (r.citations?.outOfRangeCount ?? 0),
        0,
      );
      return [v, String(v)];
    }),
    row('Mean answer chars', 'none', (_r, _a, ok) => {
      const v = mean(ok.map((r) => r.answerChars ?? (r.answer ?? '').length));
      return [v, fmt(v)];
    }),
    row('Abstained', 'none', (_r, _a, ok) => {
      const v = ok.filter((r) => r.abstained).length;
      return [v, String(v)];
    }),
    // Of the succeeded fixtures that SHOULD abstain, how many did. Compared as
    // a ratio so runs with different error counts stay comparable.
    row('Abstained when expected', 'higher', (_r, _a, ok) => {
      const expected = ok.filter((r) => r.expectAbstain);
      const hit = expected.filter((r) => r.abstained).length;
      return [
        expected.length ? hit / expected.length : null,
        `${hit} / ${expected.length}`,
      ];
    }),
    row('Mean acceptable-domain hits', 'higher', (_r, _a, ok) => {
      const v = mean(ok.map((r) => r.acceptableDomainHits ?? 0));
      return [v, fmt(v, 1)];
    }),
  ];

  if (judge) {
    // Judged rows count only fixtures that have a judge line for that run.
    const judged = (run: Run) =>
      [...run.byId.keys()]
        .map((id) => judge.get(judgeKey(run.label, id)))
        .filter((j): j is Judgement => j !== undefined);

    rows.push(
      row('Mean judged fact score', 'higher', (run) => {
        const js = judged(run);
        const v = mean(js.map((j) => j.factScore));
        return [v, `${fmt(v, 2)} (${js.length} judged)`];
      }),
      row('Judged "unsupported claim present"', 'lower', (run) => {
        const js = judged(run);
        const n = js.filter((j) => j.unsupportedClaims.length > 0).length;
        const v = pct(n, js.length);
        return [v, `${fmt(v, 1)}% (${n})`];
      }),
    );
  }

  return rows;
};

// Indexes of the best value(s) in a row; ties are all bolded. Nothing is bold
// when fewer than two runs have a value, since there is nothing to compare.
const bestIndexes = (row: SummaryRow): Set<number> => {
  const present = row.values
    .map((v, i) => ({ v, i }))
    .filter(
      (x): x is { v: number; i: number } =>
        typeof x.v === 'number' && Number.isFinite(x.v),
    );
  if (row.better === 'none' || present.length < 2) return new Set();
  const target =
    row.better === 'lower'
      ? Math.min(...present.map((x) => x.v))
      : Math.max(...present.map((x) => x.v));
  return new Set(present.filter((x) => x.v === target).map((x) => x.i));
};

// ---------------------------------------------------------------------------
// HTML

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Only http(s) links become clickable, so a source URL like "javascript:..."
// stays plain text.
const safeHref = (url?: string): string | null =>
  url && /^https?:\/\//i.test(url) ? url : null;

const runHeading = (run: Run) =>
  `${escapeHtml(run.label)} <span class="muted">(${escapeHtml(run.modes.join(', ') || 'mode unknown')})</span>`;

const renderSummary = (runs: Run[], rows: SummaryRow[]): string => {
  const head = runs
    .map((r) => `<th scope="col">${runHeading(r)}</th>`)
    .join('');
  const body = rows
    .map((row) => {
      const best = bestIndexes(row);
      const cells = row.shown
        .map((text, i) =>
          best.has(i)
            ? `<td><strong>${escapeHtml(text)}</strong></td>`
            : `<td>${escapeHtml(text)}</td>`,
        )
        .join('');
      return `<tr><th scope="row">${escapeHtml(row.label)}</th>${cells}</tr>`;
    })
    .join('\n');
  return `<div class="scroll"><table>
<thead><tr><th scope="col">Metric</th>${head}</tr></thead>
<tbody>
${body}
</tbody></table></div>`;
};

const renderMatrix = (
  runs: Run[],
  fixtureIds: string[],
  judge: Map<string, Judgement> | null,
): string => {
  const subHeads = ['Latency', 'Sources', 'Out of range', 'Abstained'];
  if (judge) subHeads.push('Judged');
  subHeads.push('Error');
  const span = subHeads.length;

  const groupHead = runs
    .map(
      (r) =>
        `<th scope="colgroup" colspan="${span}" class="group">${runHeading(r)}</th>`,
    )
    .join('');
  // The first sub-heading of each group gets the divider line.
  const subHead = runs
    .map(() =>
      subHeads
        .map(
          (h, k) =>
            `<th scope="col"${k === 0 ? ' class="group"' : ''}>${h}</th>`,
        )
        .join(''),
    )
    .join('');

  const baseline = runs[0];

  const rows = fixtureIds.map((id) => {
    const tags = (
      runs.map((r) => r.byId.get(id)).find((r) => r)?.tags ?? []
    ).join(', ');
    const cells = runs.map((run, runIndex) => {
      const r = run.byId.get(id);
      if (!r) {
        return Array.from(
          { length: span },
          (_x, k) => `<td class="${k === 0 ? 'group ' : ''}muted">n/a</td>`,
        ).join('');
      }
      if (r.error) {
        // Every cell of an errored run is red; the last one carries the message.
        const blanks = Array.from(
          { length: span - 1 },
          (_x, k) => `<td class="${k === 0 ? 'group ' : ''}bad">n/a</td>`,
        ).join('');
        const short =
          r.error.length > 60 ? `${r.error.slice(0, 60)}…` : r.error;
        return `${blanks}<td class="bad" title="${escapeHtml(r.error)}">${escapeHtml(short)}</td>`;
      }

      // Green latency when it is at least 30% faster than the first run.
      const base = runIndex > 0 ? baseline.byId.get(id) : undefined;
      const faster =
        base &&
        !base.error &&
        typeof base.latencyMs === 'number' &&
        typeof r.latencyMs === 'number' &&
        r.latencyMs <= base.latencyMs * 0.7;
      const oor = r.citations?.outOfRangeCount ?? 0;

      const parts = [
        `<td class="group${faster ? ' good' : ''}">${secs(r.latencyMs).replace(' s', '')}</td>`,
        `<td>${r.sourceCount ?? 'n/a'}</td>`,
        `<td class="${oor > 0 ? 'bad' : ''}">${oor}</td>`,
        `<td>${r.abstained ? 'yes' : 'no'}</td>`,
      ];
      if (judge) {
        const j = judge.get(judgeKey(run.label, id));
        parts.push(
          j
            ? `<td>${fmt(j.factScore, 2)}${j.unsupportedClaims.length ? ` <span class="muted">(${j.unsupportedClaims.length} unsupported)</span>` : ''}</td>`
            : '<td class="muted">n/a</td>',
        );
      }
      parts.push('<td></td>');
      return parts.join('');
    });
    return `<tr><th scope="row" class="sticky">${escapeHtml(id)}<div class="muted">${escapeHtml(tags)}</div></th>${cells.join('')}</tr>`;
  });

  return `<p class="muted">Latency in seconds. Red: error or citations past the last source. Green: latency at least 30% lower than ${escapeHtml(baseline.label)}.</p>
<div class="scroll"><table class="matrix">
<thead>
<tr><th scope="col" rowspan="2" class="sticky">Fixture</th>${groupHead}</tr>
<tr>${subHead}</tr>
</thead>
<tbody>
${rows.join('\n')}
</tbody></table></div>`;
};

const PREVIEW_CHARS = 600;

const renderDetail = (
  runs: Run[],
  fixtureIds: string[],
  judge: Map<string, Judgement> | null,
): string =>
  fixtureIds
    .map((id) => {
      const any = runs.map((r) => r.byId.get(id)).find((r) => r);
      const turns = any?.turns ?? [];
      const question = turns.length
        ? turns
            .map((t, i) => (turns.length > 1 ? `Turn ${i + 1}: ${t}` : t))
            .join(' / ')
        : '';

      const panels = runs.map((run) => {
        const r = run.byId.get(id);
        if (!r) {
          return `<section class="panel"><h3>${runHeading(run)}</h3><p class="muted">n/a (not in this run)</p></section>`;
        }
        if (r.error) {
          return `<section class="panel"><h3>${runHeading(run)}</h3><p class="bad">Error: ${escapeHtml(r.error)}</p></section>`;
        }

        const answer = r.answer ?? '';
        const j = judge?.get(judgeKey(run.label, id));
        const facts = r.requiredFacts
          ? `facts ${r.requiredFacts.hits}/${r.requiredFacts.total}`
          : '';
        const meta = [
          secs(r.latencyMs),
          `${r.sourceCount ?? 0} sources`,
          `${r.citations?.outOfRangeCount ?? 0} out of range`,
          r.abstained ? 'abstained' : '',
          facts,
          j ? `judged ${fmt(j.factScore, 2)}` : '',
        ]
          .filter(Boolean)
          .join(' · ');

        const full =
          answer.length > PREVIEW_CHARS
            ? `<details><summary>Full answer (${answer.length} chars)</summary><pre>${escapeHtml(answer)}</pre></details>`
            : '';

        const sources = (r.sources ?? [])
          .map((s) => {
            const href = safeHref(s.metadata?.url);
            const text = escapeHtml(
              s.metadata?.title || s.metadata?.url || '(untitled)',
            );
            return href
              ? `<li><a href="${escapeHtml(href)}">${text}</a></li>`
              : `<li>${text}</li>`;
          })
          .join('');
        const sourceBlock = sources
          ? `<details><summary>Sources (${r.sources?.length ?? 0})</summary><ol class="plain">${sources}</ol></details>`
          : '<p class="muted">No sources.</p>';

        const judgeBlock = j
          ? `<div class="judge">${
              j.unsupportedClaims.length
                ? `<div>Unsupported claims:</div><ul>${j.unsupportedClaims.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
                : ''
            }${j.notes ? `<div class="muted">Judge notes: ${escapeHtml(j.notes)}</div>` : ''}</div>`
          : '';

        return `<section class="panel"><h3>${runHeading(run)}</h3>
<p class="muted">${escapeHtml(meta)}</p>
<p class="answer">${escapeHtml(answer.slice(0, PREVIEW_CHARS))}${answer.length > PREVIEW_CHARS ? '…' : ''}</p>
${full}${sourceBlock}${judgeBlock}</section>`;
      });

      return `<details class="fixture"><summary><strong>${escapeHtml(id)}</strong> ${escapeHtml(question)}</summary>
<div class="panels">${panels.join('\n')}</div></details>`;
    })
    .join('\n');

const renderHtml = (
  runs: Run[],
  judgeFile: string | undefined,
  judge: Map<string, Judgement> | null,
): string => {
  // Union of fixture ids in first-seen order across runs.
  const fixtureIds: string[] = [];
  for (const run of runs) {
    for (const id of run.ids) if (!fixtureIds.includes(id)) fixtureIds.push(id);
  }

  const generated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const runList = runs
    .map(
      (r) =>
        `<li>${runHeading(r)}: ${r.byId.size} fixtures, <code>${escapeHtml(r.file)}</code></li>`,
    )
    .join('');
  const judgeLine = judgeFile
    ? `<p>Judge file: <code>${escapeHtml(judgeFile)}</code> (${judge?.size ?? 0} judgements)</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vane eval comparison: ${escapeHtml(runs.map((r) => r.label).join(' vs '))}</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0 auto; padding: 1rem; max-width: 80rem; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; }
  h3 { font-size: 1rem; margin: 0 0 .25rem; }
  ul.runs { padding-left: 1.25rem; word-break: break-all; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: .4rem .5rem; border-bottom: 1px solid #ddd; }
  thead th { background: #f3f3f3; font-size: .85rem; }
  tbody th { font-weight: 600; }
  .matrix td, .matrix th { white-space: nowrap; }
  .group { border-left: 2px solid #bbb; }
  .sticky { position: sticky; left: 0; background: #fff; z-index: 1; }
  thead .sticky { background: #f3f3f3; }
  td.bad { background: #fdecea; color: #a40000; }
  p.bad { color: #a40000; }
  td.good { background: #e6f4ea; color: #0b6b2b; font-weight: 600; }
  .muted { color: #666; font-size: .8rem; font-weight: normal; }
  details.fixture { border-bottom: 1px solid #ddd; padding: .5rem 0; }
  details.fixture > summary { cursor: pointer; }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; margin-top: .5rem; }
  .panel { border: 1px solid #ddd; border-radius: 6px; padding: .75rem; min-width: 0; }
  .answer { white-space: pre-wrap; word-wrap: break-word; }
  .judge { margin-top: .5rem; font-size: .9rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; background: #f7f7f7; padding: .5rem; }
  ol.plain { padding-left: 1.25rem; word-break: break-all; font-size: .9rem; }
  @media (prefers-color-scheme: dark) {
    body, .sticky { background: #121212; color: #e6e6e6; }
    thead th, thead .sticky { background: #222; }
    th, td, details.fixture, .panel { border-color: #333; }
    .group { border-left-color: #555; }
    .muted { color: #aaa; } pre { background: #1d1d1d; }
    td.bad { background: #3a1d1d; color: #ff8a80; } p.bad { color: #ff8a80; }
    td.good { background: #17351f; color: #8fe0a5; }
    a { color: #8ab4f8; }
  }
</style>
</head>
<body>
<h1>Vane eval comparison</h1>
<p class="muted">Generated ${escapeHtml(generated)}. Baseline for colouring: ${escapeHtml(runs[0].label)}.</p>
<ul class="runs">${runList}</ul>
${judgeLine}
<h2>Summary</h2>
<p class="muted">Bold marks the best value in each row (lower for latency, errors, zero sources and out-of-range citations; higher for the rest). Fixtures run, answer length and abstain count are not ranked. Rates are over succeeded fixtures.</p>
${renderSummary(runs, buildSummary(runs, judge))}
<h2>Per fixture</h2>
${renderMatrix(runs, fixtureIds, judge)}
<h2>Answers side by side</h2>
${renderDetail(runs, fixtureIds, judge)}
</body>
</html>
`;
};

// ---------------------------------------------------------------------------

const main = () => {
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

  const runs = args.runs.map((r) => loadRun(r.label, r.file));
  const judge = args.judge
    ? loadJudge(
        args.judge,
        runs.map((r) => r.label),
      )
    : null;

  const outDir = path.dirname(args.out);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(args.out, renderHtml(runs, args.judge, judge));

  for (const run of runs) {
    const all = [...run.byId.values()];
    const ok = all.filter(isOk);
    console.log(
      `  ${run.label} (${run.modes.join(', ') || 'mode unknown'}): ${all.length} fixtures, ${ok.length} ok, ${all.length - ok.length} errors`,
    );
  }
  console.log(`Wrote ${args.out}`);
};

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
