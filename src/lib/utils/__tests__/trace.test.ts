// TypeScript: unit tests for the request tracer (src/lib/trace.ts). Uses a temp DATA_DIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tracer, redactSecrets, traceDir } from '@/lib/trace';

let tempDir = '';
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-trace-test-'));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Reads every JSON line written under the temp trace dir.
const readLines = (): any[] => {
  const dir = traceDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
};

// Records the same small request in any mode.
const recordSample = (tracer: Tracer) => {
  const span = tracer.span('classify', { a: 1 });
  span.end({ skipSearch: false, standaloneFollowUp: tracer.content('Q?') });
  tracer.event('sources', {
    sources: [{ index: 1, url: 'https://example.com', contentChars: 7 }],
    passage: tracer.content('passage'),
  });
  tracer.event('write', { answer: tracer.content('The answer [1].') });
};

describe('Tracer', () => {
  it('noop mode records nothing and never writes', async () => {
    const tracer = Tracer.noop();
    expect(tracer.enabled).toBe(false);
    recordSample(tracer);
    tracer.error('x', new Error('boom'));
    await tracer.finish({ totalMs: 1 });
    expect(fs.existsSync(traceDir())).toBe(false);
  });

  it("'on' mode writes exactly one JSON line with requestId and spans", async () => {
    const tracer = new Tracer('on');
    recordSample(tracer);
    await tracer.finish({ mode: 'speed', sourceCount: 1 });
    await tracer.finish(); // a second finish must not write again

    const lines = readLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.requestId).toBe(tracer.requestId);
    expect(line.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(line.traceMode).toBe('on');
    expect(line.mode).toBe('speed');
    expect(typeof line.totalMs).toBe('number');
    expect(line.spans[0].name).toBe('classify');
    expect(typeof line.spans[0].durationMs).toBe('number');
    expect(line.spans[0].attrs.skipSearch).toBe(false);
    expect(line.events.map((e: any) => e.name)).toEqual(['sources', 'write']);
    expect(line.errors).toEqual([]);
  });

  it("'on' mode leaves out content fields", async () => {
    const tracer = new Tracer('on');
    recordSample(tracer);
    await tracer.finish();

    const line = readLines()[0];
    expect(line.spans[0].attrs).not.toHaveProperty('standaloneFollowUp');
    expect(line.events[0].data).not.toHaveProperty('passage');
    expect(line.events[1].data).not.toHaveProperty('answer');
    expect(line.events[0].data.sources[0].url).toBe('https://example.com');
  });

  it("'full' mode includes content fields", async () => {
    const tracer = new Tracer('full');
    recordSample(tracer);
    await tracer.finish();

    const line = readLines()[0];
    expect(line.traceMode).toBe('full');
    expect(line.spans[0].attrs.standaloneFollowUp).toBe('Q?');
    expect(line.events[0].data.passage).toBe('passage');
    expect(line.events[1].data.answer).toBe('The answer [1].');
  });

  it('records caught errors and redacts key-like strings', async () => {
    const tracer = new Tracer('on');
    tracer.error(
      'llm',
      new Error('401 Incorrect API key: sk-abcdef1234567890'),
    );
    await tracer.finish();

    const raw = fs.readFileSync(
      path.join(traceDir(), fs.readdirSync(traceDir())[0]),
      'utf-8',
    );
    expect(raw).not.toContain('sk-abcdef1234567890');
    expect(readLines()[0].errors).toEqual([
      'llm: 401 Incorrect API key: sk-[redacted]',
    ]);
  });

  it('deletes trace files older than the retention window', async () => {
    const dir = traceDir();
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, '2000-01-01.jsonl');
    fs.writeFileSync(old, '{}\n');

    await new Tracer('on').finish();

    await vi.waitFor(() => expect(fs.existsSync(old)).toBe(false));
  });
});

describe('redactSecrets', () => {
  it('masks bearer tokens and api_key values but keeps JSON valid', () => {
    const input = JSON.stringify({
      msg: 'Authorization: Bearer abc.def-ghi and apiKey=xyz123',
      note: 'secret \\"quoted\\"',
    });
    const out = redactSecrets(input);
    expect(out).not.toContain('abc.def-ghi');
    expect(out).not.toContain('xyz123');
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
