// TypeScript: the per-process embedding pipeline cache is bounded and frees evicted models once idle.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loads: string[] = [];
const disposed: string[] = [];

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async (_task: string, model: string) => {
    loads.push(model);
    const pipe: any = async () => ({ tolist: () => [[1, 0]] });
    pipe.dispose = async () => {
      disposed.push(model);
    };
    return pipe;
  }),
}));

import TransformerEmbedding, {
  loadedModelCount,
  MAX_LOADED_MODELS,
} from '@/lib/models/providers/transformers/transformerEmbedding';

const embed = (model: string) =>
  new TransformerEmbedding({ model }).embedText(['x']);

beforeEach(() => {
  loads.length = 0;
  disposed.length = 0;
});

describe('TransformerEmbedding pipeline cache', () => {
  it('loads a model once across many instances', async () => {
    await embed('cache-a');
    await embed('cache-a');
    await embed('cache-a');
    expect(loads.filter((m) => m === 'cache-a')).toHaveLength(1);
  });

  it('keeps at most MAX_LOADED_MODELS and disposes the least recently used', async () => {
    await embed('lru-1');
    await embed('lru-2');
    await embed('lru-1'); // lru-2 is now the least recently used
    await embed('lru-3');
    await new Promise((r) => setTimeout(r, 0));

    expect(loadedModelCount()).toBeLessThanOrEqual(MAX_LOADED_MODELS);
    expect(disposed).toContain('lru-2');
    expect(disposed).not.toContain('lru-1');
  });

  it('waits for a running embed before disposing an evicted model', async () => {
    let finish!: () => void;
    const { pipeline } = await import('@huggingface/transformers');
    (pipeline as any).mockImplementationOnce(
      async (_t: string, model: string) => {
        const pipe: any = () =>
          new Promise((resolve) => {
            finish = () => resolve({ tolist: () => [[1]] });
          });
        pipe.dispose = async () => {
          disposed.push(model);
        };
        return pipe;
      },
    );

    const slow = embed('busy-1');
    await new Promise((r) => setTimeout(r, 0));
    await embed('busy-2');
    await embed('busy-3'); // evicts busy-1 while it is still embedding
    await new Promise((r) => setTimeout(r, 0));
    expect(disposed).not.toContain('busy-1');

    finish();
    await slow;
    await new Promise((r) => setTimeout(r, 0));
    expect(disposed).toContain('busy-1');
  });
});
