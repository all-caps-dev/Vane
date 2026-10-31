// TypeScript: unit tests for the rerankers with the transformers model mocked (batching, ids, order, timeout, fallback).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tokenizerLoad, modelLoad, modelCall, settings } = vi.hoisted(() => ({
  tokenizerLoad: vi.fn(),
  modelLoad: vi.fn(),
  modelCall: vi.fn(),
  settings: { kind: 'transformers', model: 'test/model-a' },
}));

/* Fake cross-encoder: the "tokenizer" passes the passages through, and the
   "model" scores each passage by the number written in it ("score 7"). */
vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: tokenizerLoad },
  AutoModelForSequenceClassification: { from_pretrained: modelLoad },
}));

vi.mock('@/lib/config/serverRegistry', () => ({
  getRerankerKind: () => settings.kind,
  getRerankerModel: () => settings.model,
}));

import { TransformersReranker } from '@/lib/rerank/transformersReranker';
import EmbeddingReranker from '@/lib/rerank/embeddingReranker';
import {
  getReranker,
  offReranker,
  rerankSafely,
  RerankTimeoutError,
} from '@/lib/rerank';
import { Tracer } from '@/lib/trace';

const scoreOf = (text: string) => Number(/score (-?\d+)/.exec(text)?.[1] ?? 0);

const fakeModel = async (inputs: { pairs: string[] }) => {
  modelCall(inputs.pairs.length);
  return {
    logits: {
      dims: [inputs.pairs.length, 1],
      data: Float32Array.from(inputs.pairs.map(scoreOf)),
    },
  };
};

const passages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    text: `passage score ${(i * 7) % n}`,
  }));

const embedding = {
  // "cat" texts point one way, the rest the other.
  embedText: vi.fn(async (texts: string[]) =>
    texts.map((t) => (t.includes('cat') ? [1, 0] : [0, 1])),
  ),
} as any;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  tokenizerLoad.mockReset();
  modelLoad.mockReset();
  modelCall.mockReset();
  embedding.embedText.mockClear();
  tokenizerLoad.mockResolvedValue(
    (_queries: string[], opts: { text_pair: string[] }) => ({
      pairs: opts.text_pair,
    }),
  );
  modelLoad.mockResolvedValue(fakeModel);
  settings.kind = 'transformers';
});

describe('TransformersReranker', () => {
  it('batches by 16, keeps ids and sorts best first', async () => {
    const reranker = new TransformersReranker('test/batching');
    const input = passages(40);
    const out = await reranker.rerank('q', input);

    expect(modelCall.mock.calls.map((c) => c[0])).toEqual([16, 16, 8]);
    expect(out).toHaveLength(40);
    expect(new Set(out.map((r) => r.id))).toEqual(
      new Set(input.map((p) => p.id)),
    );
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
    // Each id keeps its own score.
    out.forEach((r) => {
      const p = input.find((x) => x.id === r.id)!;
      expect(r.score).toBe(scoreOf(p.text));
    });
  });

  it('loads once, tries q8 first, and applies topK', async () => {
    const reranker = new TransformersReranker('test/load-once');
    await reranker.rerank('q', passages(3));
    const out = await reranker.rerank('q', passages(5), { topK: 2 });

    expect(modelLoad).toHaveBeenCalledTimes(1);
    expect(modelLoad.mock.calls[0][1]).toEqual({ dtype: 'q8' });
    expect(out).toHaveLength(2);
  });

  it('falls back to fp32 when q8 weights do not load', async () => {
    modelLoad
      .mockRejectedValueOnce(new Error('no model_quantized.onnx'))
      .mockResolvedValueOnce(fakeModel);
    const reranker = new TransformersReranker('test/fp32');
    await reranker.rerank('q', passages(2));
    expect(modelLoad.mock.calls.map((c) => c[1])).toEqual([
      { dtype: 'q8' },
      { dtype: 'fp32' },
    ]);
  });

  it('runs one model call at a time', async () => {
    let running = 0;
    let maxRunning = 0;
    modelLoad.mockResolvedValue(async (inputs: { pairs: string[] }) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return fakeModel(inputs);
    });
    const reranker = new TransformersReranker('test/serial');
    await Promise.all([
      reranker.rerank('a', passages(20)),
      reranker.rerank('b', passages(20)),
    ]);
    expect(maxRunning).toBe(1);
  });

  it('rejects with RerankTimeoutError and keeps working afterwards', async () => {
    let slow = true;
    modelLoad.mockResolvedValue(async (inputs: { pairs: string[] }) => {
      if (slow) await new Promise((r) => setTimeout(r, 50));
      return fakeModel(inputs);
    });
    const reranker = new TransformersReranker('test/timeout');
    await expect(
      reranker.rerank('q', passages(3), { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(RerankTimeoutError);

    slow = false;
    await expect(reranker.rerank('q', passages(3))).resolves.toHaveLength(3);
  });

  it('returns [] for no passages without loading the model', async () => {
    const reranker = new TransformersReranker('test/empty');
    expect(await reranker.rerank('q', [])).toEqual([]);
    expect(modelLoad).not.toHaveBeenCalled();
  });
});

describe('EmbeddingReranker and offReranker', () => {
  it('ranks by cosine similarity with one embedText call', async () => {
    const out = await new EmbeddingReranker(embedding).rerank('cat', [
      { id: 'dog', text: 'about dogs' },
      { id: 'cat', text: 'about cat food' },
    ]);
    expect(embedding.embedText).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.id)).toEqual(['cat', 'dog']);
  });

  it('off keeps the given order', async () => {
    const out = await offReranker.rerank('q', passages(3));
    expect(out.map((r) => r.id)).toEqual(['p0', 'p1', 'p2']);
  });
});

describe('getReranker and rerankSafely', () => {
  it('returns the cross-encoder when it loads', async () => {
    settings.model = 'test/ok';
    const reranker = await getReranker(embedding);
    expect(reranker.name).toBe('transformers:test/ok');
  });

  it('falls back to embeddings when the model cannot load', async () => {
    settings.model = 'test/broken';
    tokenizerLoad.mockRejectedValue(new Error('offline'));
    const trace = new Tracer('on');
    const events = vi.spyOn(trace, 'event');

    const reranker = await getReranker(embedding, trace);

    expect(reranker.name).toBe('embedding');
    expect(events).toHaveBeenCalledWith(
      'rerank.fallback',
      expect.objectContaining({ reason: 'offline' }),
    );
  });

  it('follows the config: embedding and off', async () => {
    settings.kind = 'embedding';
    expect((await getReranker(embedding)).name).toBe('embedding');
    settings.kind = 'off';
    expect((await getReranker(embedding)).name).toBe('off');
  });

  it('rerankSafely uses embeddings when the reranker throws', async () => {
    const trace = new Tracer('on');
    const events = vi.spyOn(trace, 'event');
    const broken = {
      name: 'broken',
      rerank: async () => {
        throw new Error('boom');
      },
    };
    const { results, usedReranker } = await rerankSafely(
      broken,
      embedding,
      'cat',
      [
        { id: 'a', text: 'dogs' },
        { id: 'b', text: 'cat' },
      ],
      {},
      trace,
    );
    expect(usedReranker).toBe('embedding');
    expect(results.map((r) => r.id)).toEqual(['b', 'a']);
    expect(events).toHaveBeenCalledWith(
      'rerank.fallback',
      expect.objectContaining({ reason: 'boom', from: 'broken' }),
    );
  });

  it('rerankSafely keeps the input order when everything fails', async () => {
    const failingEmbedding = {
      embedText: async () => {
        throw new Error('no embeddings');
      },
    } as any;
    const broken = {
      name: 'broken',
      rerank: async () => {
        throw new Error('boom');
      },
    };
    const { results, usedReranker } = await rerankSafely(
      broken,
      failingEmbedding,
      'q',
      passages(3),
      {},
    );
    expect(usedReranker).toBe('off');
    expect(results.map((r) => r.id)).toEqual(['p0', 'p1', 'p2']);
  });
});
