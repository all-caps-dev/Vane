// TypeScript: per-request trace recorder. Writes one JSON line per request to data/traces.
//
// Tracing is observe-only. Nothing in here may throw into the search pipeline:
// every public method swallows its own errors. When the mode is 'off' every
// method returns immediately, so the cost of an unused tracer is a few
// function calls.

import fs from 'node:fs';
import path from 'node:path';

// 'off'  = record nothing
// 'on'   = record timings, queries, URLs, titles, counts, statuses
// 'full' = 'on' plus content (question, passages, answer, chat history)
export type TraceMode = 'off' | 'on' | 'full';

export type TraceSpan = {
  end: (extra?: Record<string, unknown>) => void;
};

type SpanRecord = {
  name: string;
  startMs: number; // milliseconds since the request started
  endMs?: number;
  durationMs?: number;
  attrs: Record<string, unknown>;
};

type EventRecord = {
  name: string;
  atMs: number; // milliseconds since the request started
  data: Record<string, unknown>;
};

// A shared span object for the no-op case, so 'off' allocates nothing.
const NOOP_SPAN: TraceSpan = { end: () => {} };

// The retention sweep runs at most once per trace folder per UTC day.
let lastRetentionSweepKey = '';

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
};

// Last line of defence: masks things that look like credentials before a
// line is written. Provider error messages sometimes echo part of an API key.
// The replacements contain no quotes or backslashes, so the JSON stays valid.
export const redactSecrets = (text: string): string =>
  text
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, 'sk-[redacted]')
    .replace(/\bAIza[0-9A-Za-z_\-]{20,}/g, 'AIza[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/\-]+=*/gi, 'Bearer [redacted]')
    .replace(
      /\b(api[_-]?key|authorization|access[_-]?token|secret)(["':=\s]+)([^"'\s&,}\\]+)/gi,
      '$1$2[redacted]',
    );

// Reads the class name and the `model` field of an LLM or embedding instance.
// It deliberately reads ONLY `config.model` (a model name string) and never
// serialises the config object, which can hold apiKey and baseURL.
export const describeModel = (
  model: unknown,
): { impl: string; key?: string } => {
  try {
    const impl =
      (model as { constructor?: { name?: string } })?.constructor?.name ||
      'unknown';
    const key = (model as { config?: { model?: unknown } })?.config?.model;
    return typeof key === 'string' ? { impl, key } : { impl };
  } catch {
    return { impl: 'unknown' };
  }
};

export class Tracer {
  readonly requestId: string;
  readonly startedAt: number; // epoch milliseconds
  readonly mode: TraceMode;

  private spans: SpanRecord[] = [];
  private events: EventRecord[] = [];
  private errors: string[] = [];
  private summary: Record<string, unknown> = {};
  private finished = false;

  constructor(mode: TraceMode = 'on') {
    this.mode = mode;
    this.startedAt = Date.now();
    // A no-op tracer does not need a real id.
    this.requestId = mode === 'off' ? '' : crypto.randomUUID();
  }

  // A tracer that records nothing and writes nothing.
  static noop(): Tracer {
    return new Tracer('off');
  }

  // Builds a tracer from a mode getter (normally getTraceMode from the config).
  // If reading the mode fails for any reason, tracing is simply off.
  static start(getMode: () => TraceMode): Tracer {
    try {
      return new Tracer(getMode());
    } catch (err) {
      console.error('[trace] could not read trace mode:', errorMessage(err));
      return Tracer.noop();
    }
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  get full(): boolean {
    return this.mode === 'full';
  }

  // Returns the value only in 'full' mode, otherwise undefined.
  // JSON.stringify drops undefined fields, so content simply disappears
  // from the line in 'on' mode. Use it for any user or page text.
  content<T>(value: T): T | undefined {
    return this.mode === 'full' ? value : undefined;
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }

  // Starts a timed span. Call .end() once; later calls are ignored.
  span(name: string, attrs?: Record<string, unknown>): TraceSpan {
    if (this.mode === 'off') return NOOP_SPAN;
    try {
      const record: SpanRecord = {
        name,
        startMs: this.now(),
        attrs: { ...(attrs ?? {}) },
      };
      this.spans.push(record);
      return {
        end: (extra?: Record<string, unknown>) => {
          try {
            if (record.endMs !== undefined) return;
            record.endMs = this.now();
            record.durationMs = record.endMs - record.startMs;
            if (extra) Object.assign(record.attrs, extra);
          } catch {
            /* tracing must never throw */
          }
        },
      };
    } catch {
      return NOOP_SPAN;
    }
  }

  // Records a single timestamped event.
  event(name: string, data: Record<string, unknown> = {}): void {
    if (this.mode === 'off') return;
    try {
      this.events.push({ name, atMs: this.now(), data: { ...data } });
    } catch {
      /* tracing must never throw */
    }
  }

  // Records a caught error message (no stack, no request bodies).
  error(where: string, err: unknown): void {
    if (this.mode === 'off') return;
    try {
      this.errors.push(`${where}: ${errorMessage(err)}`);
    } catch {
      /* tracing must never throw */
    }
  }

  // Adds fields to the summary written by finish(). Later calls win.
  annotate(fields: Record<string, unknown>): void {
    if (this.mode === 'off') return;
    try {
      Object.assign(this.summary, fields);
    } catch {
      /* tracing must never throw */
    }
  }

  // Writes exactly one JSON line for this request. Safe to call more than
  // once: only the first call writes. The returned promise never rejects, so
  // callers can ignore it; tests await it to know the line is on disk.
  finish(summary?: Record<string, unknown>): Promise<void> {
    if (this.mode === 'off' || this.finished) return Promise.resolve();
    this.finished = true;

    try {
      const line = redactSecrets(
        JSON.stringify({
          requestId: this.requestId,
          startedAt: new Date(this.startedAt).toISOString(),
          traceMode: this.mode,
          totalMs: this.now(),
          ...this.summary,
          ...(summary ?? {}),
          errors: this.errors,
          spans: this.spans,
          events: this.events,
        }),
      );

      const dir = traceDir();
      const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
      const file = path.join(dir, `${day}.jsonl`);

      fs.mkdirSync(dir, { recursive: true });

      return new Promise<void>((resolve) => {
        fs.appendFile(file, line + '\n', (err) => {
          if (err) console.error('[trace] could not write trace:', err.message);
          sweepOldTraces(dir, day);
          resolve();
        });
      });
    } catch (err) {
      console.error('[trace] could not build trace line:', errorMessage(err));
      return Promise.resolve();
    }
  }
}

// The folder traces are written to. Read at call time (not import time) so
// DATA_DIR can be changed, which the tests rely on.
export const traceDir = (): string =>
  path.join(process.env.DATA_DIR || process.cwd(), 'data', 'traces');

// Deletes trace files whose date (from the file name) is older than
// VANE_TRACE_RETENTION_DAYS (default 14). Runs at most once a day.
const sweepOldTraces = (dir: string, today: string): void => {
  try {
    const key = `${dir}|${today}`;
    if (lastRetentionSweepKey === key) return;
    lastRetentionSweepKey = key;

    const parsed = parseInt(process.env.VANE_TRACE_RETENTION_DAYS ?? '', 10);
    const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    fs.readdir(dir, (err, files) => {
      if (err) return;
      for (const name of files) {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (!match) continue;
        const fileDay = Date.parse(`${match[1]}T00:00:00Z`);
        if (Number.isFinite(fileDay) && fileDay < cutoff) {
          fs.unlink(path.join(dir, name), (unlinkErr) => {
            if (unlinkErr)
              console.error(
                '[trace] could not delete old trace:',
                unlinkErr.message,
              );
          });
        }
      }
    });
  } catch {
    /* retention is best effort */
  }
};

export default Tracer;
