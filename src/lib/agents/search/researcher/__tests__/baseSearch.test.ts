// TypeScript: unit tests for executeSearch in speed mode (failing queries, batched embeddings).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchSearxng } = vi.hoisted(() => ({ searchSearxng: vi.fn() }));
vi.mock('@/lib/searxng', () => ({ searchSearxng }));

import { executeSearch } from '@/lib/agents/search/researcher/actions/search/baseSearch';
import { Tracer } from '@/lib/trace';

// Embeds text as a 2D vector: texts containing "cat" point one way, the rest
// the other way, so the 0.5 similarity threshold is easy to reason about.
const embedText = vi.fn(async (texts: string[]) =>
  texts.map((t) => (t.includes('cat') ? [1, 0] : [0, 1])),
);

const run = (queries: string[]) => {
  const trace = new Tracer('on');
  const errorSpy = vi.spyOn(trace, 'error');
  const promise = executeSearch({
    queries,
    mode: 'speed',
    researchBlock: { id: 'r', type: 'research', data: { subSteps: [] } },
    session: { trace, updateBlock: vi.fn() } as any,
    llm: {} as any,
    embedding: { embedText } as any,
  });
  return { promise, errorSpy };
};

beforeEach(() => {
  // The code logs every failed query; keep the test output readable.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  searchSearxng.mockReset();
  embedText.mockClear();
});

describe('executeSearch (speed)', () => {
  it('makes one embedText call per query and keeps the 0.5 threshold', async () => {
    searchSearxng.mockResolvedValue({
      results: [
        { title: 'Cats', url: 'https://a.test/', content: 'about cat food' },
        { title: 'Dogs', url: 'https://b.test/', content: 'about dogs' },
      ],
      suggestions: [],
    });

    const { promise } = run(['cat']);
    const out = await promise;

    expect(embedText).toHaveBeenCalledTimes(1);
    expect(embedText).toHaveBeenCalledWith([
      'cat',
      'about cat food',
      'about dogs',
    ]);
    expect(out.map((c) => c.metadata.url)).toEqual(['https://a.test/']);
  });

  it('keeps going when one query fails', async () => {
    searchSearxng.mockImplementation(async (q: string) => {
      if (q === 'bad') throw new Error('SearXNG error: Bad Gateway');
      return {
        results: [{ title: 'Cats', url: 'https://a.test/', content: 'cat' }],
        suggestions: [],
      };
    });

    const { promise, errorSpy } = run(['bad', 'cat']);
    const out = await promise;

    expect(out).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith('search.query', expect.any(Error));
  });

  it('returns an empty list when every query fails', async () => {
    searchSearxng.mockRejectedValue(new Error('SearXNG search timed out'));
    const { promise } = run(['a', 'b']);
    await expect(promise).resolves.toEqual([]);
  });
});
