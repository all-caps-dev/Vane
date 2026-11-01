// TypeScript: unit tests for ActionRegistry.executeAll (call order and failure isolation).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';
import ActionRegistry from '@/lib/agents/search/researcher/actions/registry';
import { Tracer } from '@/lib/trace';

// A fake action that answers after `delayMs`, or throws when asked to.
const fakeAction = (name: string, delayMs: number, fail = false) => ({
  name,
  schema: z.object({}),
  getToolDescription: () => name,
  getDescription: () => name,
  enabled: () => true,
  execute: async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    if (fail) throw new Error(`${name} broke`);
    return {
      type: 'search_results' as const,
      results: [{ content: name, metadata: { url: `https://${name}.test/` } }],
    };
  },
});

ActionRegistry.register(fakeAction('slow_test', 30));
ActionRegistry.register(fakeAction('fast_test', 1));
ActionRegistry.register(fakeAction('broken_test', 5, true));

const config = () => {
  const trace = new Tracer('on');
  const error = vi.spyOn(trace, 'error');
  return {
    error,
    config: {
      llm: {} as any,
      embedding: {} as any,
      session: { trace } as any,
      researchBlockId: 'r',
      fileIds: [],
      mode: 'speed' as const,
    },
  };
};

// The registry logs every failed action; keep the test output readable.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

const call = (name: string) => ({ id: `id-${name}`, name, arguments: {} });

describe('ActionRegistry.executeAll', () => {
  it('returns results in call order, not completion order', async () => {
    const { config: c } = config();
    const out = await ActionRegistry.executeAll(
      [call('slow_test'), call('fast_test')],
      c,
    );
    expect(out.map((o: any) => o.results[0].content)).toEqual([
      'slow_test',
      'fast_test',
    ]);
  });

  it('turns a failing action into an empty result and records it', async () => {
    const { config: c, error } = config();
    const out = await ActionRegistry.executeAll(
      [call('slow_test'), call('broken_test'), call('fast_test')],
      c,
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ type: 'search_results', results: [] });
    expect((out[2] as any).results[0].content).toBe('fast_test');
    expect(error).toHaveBeenCalledWith('action broken_test', expect.any(Error));
  });

  it('treats an unknown action like a failing one', async () => {
    const { config: c } = config();
    const out = await ActionRegistry.executeAll([call('no_such_action')], c);
    expect(out).toEqual([{ type: 'search_results', results: [] }]);
  });
});
