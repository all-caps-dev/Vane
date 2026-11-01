// TypeScript: unit tests for the background reranker warm-up (src/lib/rerank/warmup.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ kind: 'transformers', load: vi.fn() }));

vi.mock('@/lib/config/serverRegistry', () => ({
  getRerankerKind: () => cfg.kind,
  getRerankerModel: () => 'test/model',
}));
vi.mock('@/lib/rerank/transformersReranker', () => ({
  getTransformersReranker: () => ({ load: cfg.load }),
}));

import { warmUpReranker } from '@/lib/rerank/warmup';

beforeEach(() => {
  cfg.kind = 'transformers';
  cfg.load.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('warmUpReranker', () => {
  it('loads the cross-encoder and logs once when ready', async () => {
    cfg.load.mockResolvedValue({ dtype: 'q8' });
    await warmUpReranker();
    expect(cfg.load).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.log).mock.calls[0][0]).toMatch(
      /Reranker test\/model \(q8\) ready/,
    );
  });

  it('logs a failed load and never throws', async () => {
    cfg.load.mockRejectedValue(new Error('no network'));
    await expect(warmUpReranker()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toMatch(/no network/);
  });

  it('does nothing for the embedding or off reranker', async () => {
    for (const kind of ['embedding', 'off']) {
      cfg.kind = kind;
      await warmUpReranker();
    }
    expect(cfg.load).not.toHaveBeenCalled();
  });

  it('returns before the model has loaded', () => {
    // A load that never finishes: the call must still return at once.
    cfg.load.mockReturnValue(new Promise(() => undefined));
    expect(warmUpReranker()).toBeInstanceOf(Promise);
    expect(console.log).not.toHaveBeenCalled();
  });
});
