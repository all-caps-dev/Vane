// TypeScript: unit tests for executeSearch (M2 evidence pipeline): snippets, reranking, page reading, legacy path.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchSearxng, scrape, settings } = vi.hoisted(() => ({
  searchSearxng: vi.fn(),
  scrape: vi.fn(),
  // What the mocked config returns; each test may change it.
  settings: {
    reranker: 'embedding' as 'transformers' | 'embedding' | 'off',
    balancedReadsPages: true,
    budget: 16,
    priorWeight: 0.5,
  },
}));

vi.mock('@/lib/searxng', () => ({ searchSearxng }));
vi.mock('@/lib/scraper', () => ({
  default: { scrape },
  MIN_TEXT_CHARS: 400,
}));
// The real registry would read and write data/config.json.
vi.mock('@/lib/config/serverRegistry', () => ({
  getRerankerKind: () => settings.reranker,
  getRerankerModel: () => 'test/model',
  getBalancedReadsPages: () => settings.balancedReadsPages,
  getEvidenceBudget: () => settings.budget,
  getSourcePriorWeight: () => settings.priorWeight,
}));
// The cross-encoder must never load in these tests.
vi.mock('@huggingface/transformers', () => {
  throw new Error('transformers must not load in baseSearch tests');
});

import { executeSearch } from '@/lib/agents/search/researcher/actions/search/baseSearch';
import { Tracer } from '@/lib/trace';
import { RequestBudget } from '@/lib/agents/search/budgets';
import { ResearchBlock } from '@/lib/types';

// Embeds text as a 2D vector: texts mentioning "cat" point one way, the
// rest the other way, so the ranking is easy to predict.
const embedText = vi.fn(async (texts: string[]) =>
  texts.map((t) => (t.includes('cat') ? [1, 0] : [0, 1])),
);

const run = (
  queries: string[],
  opts: {
    mode?: 'speed' | 'balanced' | 'quality';
    question?: string;
    llm?: any;
    budget?: RequestBudget;
    countsAsSearchCall?: boolean;
    sourceContext?: { entities: string[]; intent: string };
    prefetch?: any;
  } = {},
) => {
  const trace = new Tracer('on');
  const errorSpy = vi.spyOn(trace, 'error');
  const eventSpy = vi.spyOn(trace, 'event');
  const researchBlock: ResearchBlock = {
    id: 'r',
    type: 'research',
    data: { subSteps: [] },
  };
  const promise = executeSearch({
    queries,
    mode: opts.mode ?? 'speed',
    question: opts.question,
    researchBlock,
    session: { trace, updateBlock: vi.fn(), budget: opts.budget } as any,
    llm: opts.llm ?? ({} as any),
    embedding: { embedText } as any,
    countsAsSearchCall: opts.countsAsSearchCall,
    sourceContext: opts.sourceContext,
    prefetch: opts.prefetch,
  });
  return { promise, errorSpy, eventSpy, researchBlock };
};

const results = (...rows: [string, string, string][]) => ({
  results: rows.map(([title, url, content]) => ({ title, url, content })),
  suggestions: [],
});

// A page long enough not to be "thin".
const page = (topic: string) =>
  `<html><head><title>${topic} page</title></head><body><article><h2>${topic} facts</h2><p>${`The ${topic} sentence has useful detail. `.repeat(20)}</p></article></body></html>`;

beforeEach(() => {
  // The code logs every failed query; keep the test output readable.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  searchSearxng.mockReset();
  scrape.mockReset();
  embedText.mockClear();
  settings.reranker = 'embedding';
  settings.balancedReadsPages = true;
  settings.budget = 16;
  settings.priorWeight = 0.5;
});

describe('executeSearch (speed)', () => {
  it('shows a ranking step with the real selection counts (M3)', async () => {
    searchSearxng.mockResolvedValue(
      results(
        ['Dogs', 'https://b.test/', 'about dogs'],
        ['Cats', 'https://a.test/', 'about cat food'],
      ),
    );
    settings.budget = 1;

    const { promise, researchBlock } = run(['pets'], { question: 'cats' });
    await promise;

    expect(researchBlock.data.subSteps.map((s) => s.type)).toEqual([
      'searching',
      'search_results',
      'ranking',
    ]);
    expect(researchBlock.data.subSteps[2]).toMatchObject({
      candidates: 2,
      selected: 1,
      sources: 1,
    });
  });

  it('ranks snippets with one embedText call against the question', async () => {
    searchSearxng.mockResolvedValue(
      results(
        ['Dogs', 'https://b.test/', 'about dogs'],
        ['Cats', 'https://a.test/', 'about cat food'],
      ),
    );

    const out = await run(['pets'], { question: 'what do cats eat' }).promise;

    expect(embedText).toHaveBeenCalledTimes(1);
    expect(embedText).toHaveBeenCalledWith([
      'what do cats eat',
      'Dogs\nabout dogs',
      'Cats\nabout cat food',
    ]);
    // No similarity threshold any more: both come back, best first.
    expect(out.map((c) => c.metadata.url)).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
    expect(out[0].metadata).toMatchObject({
      sourceKind: 'search_snippet',
      title: 'Cats',
      queries: ['pets'],
    });
    expect(out[0].metadata.chunkId).toMatch(/^s[0-9a-f]{8}:c0$/);
    expect(scrape).not.toHaveBeenCalled();
  });

  it('merges the same URL from two queries into one snippet', async () => {
    searchSearxng.mockImplementation(async (q: string) =>
      results(['Cats', `https://a.test/x?utm_source=${q}`, 'cat']),
    );

    const out = await run(['one', 'two']).promise;

    expect(out).toHaveLength(1);
    expect(out[0].metadata.queries).toEqual(['one', 'two']);
  });

  it('keeps going when one query fails', async () => {
    searchSearxng.mockImplementation(async (q: string) => {
      if (q === 'bad') throw new Error('SearXNG error: Bad Gateway');
      return results(['Cats', 'https://a.test/', 'cat']);
    });

    const { promise, errorSpy } = run(['bad', 'cat']);
    const out = await promise;

    expect(out).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith('search.query', expect.any(Error));
  });

  it('returns an empty list when every query fails', async () => {
    searchSearxng.mockRejectedValue(new Error('SearXNG search timed out'));
    await expect(run(['a', 'b']).promise).resolves.toEqual([]);
  });

  it('keeps the search engine order when the reranker is off', async () => {
    settings.reranker = 'off';
    searchSearxng.mockResolvedValue(
      results(
        ['Dogs', 'https://b.test/', 'dogs'],
        ['Cats', 'https://a.test/', 'cat'],
      ),
    );

    const out = await run(['cat']).promise;

    expect(embedText).not.toHaveBeenCalled();
    expect(out.map((c) => c.metadata.url)).toEqual([
      'https://b.test/',
      'https://a.test/',
    ]);
  });
});

describe('executeSearch (source priors)', () => {
  // Two equally relevant cat pages, the blog first in engine order.
  const twoCats = () =>
    searchSearxng.mockResolvedValue(
      results(
        ['Cats blog', 'https://blog.test/cats', 'about cat food'],
        ['Cats docs', 'https://www.catco.com/docs/food', 'about cat food x'],
        ['Dogs', 'https://dogs.test/', 'about dogs'],
      ),
    );
  const sourceContext = { entities: ['CatCo'], intent: 'fact' };

  it('puts the first-party page first on a tie and traces it', async () => {
    twoCats();
    const { promise, eventSpy } = run(['cat food'], {
      question: 'cats',
      sourceContext,
    });
    const out = await promise;

    expect(out[0].metadata.url).toBe('https://www.catco.com/docs/food');
    expect(eventSpy).toHaveBeenCalledWith(
      'rerank.prior',
      expect.objectContaining({ stage: 'snippets', weight: 0.5, boosted: 1 }),
    );
  });

  it('weight 0 keeps the reranker order', async () => {
    settings.priorWeight = 0;
    twoCats();
    const { promise, eventSpy } = run(['cat food'], {
      question: 'cats',
      sourceContext,
    });
    const out = await promise;

    expect(out.map((c) => c.metadata.url)).toEqual([
      'https://blog.test/cats',
      'https://www.catco.com/docs/food',
      'https://dogs.test/',
    ]);
    expect(eventSpy).not.toHaveBeenCalledWith(
      'rerank.prior',
      expect.anything(),
    );
  });

  it('does nothing without a source context (academic, discussions)', async () => {
    twoCats();
    const out = await run(['cat food'], { question: 'cats' }).promise;
    expect(out[0].metadata.url).toBe('https://blog.test/cats');
  });
});

describe('executeSearch (balanced)', () => {
  it('reads the top pages, chunks them, and keeps snippets of failed reads', async () => {
    searchSearxng.mockResolvedValue(
      results(
        ['Cats', 'https://a.test/', 'cat snippet'],
        ['Dogs', 'https://b.test/', 'dog snippet'],
      ),
    );
    scrape.mockImplementation(async (url: string) =>
      url.includes('a.test')
        ? {
            title: 'Cat page',
            content: '',
            html: page('cat'),
            text: 'x'.repeat(800),
            fetchedAt: '2026-10-31T00:00:00.000Z',
          }
        : {
            title: 'Failed to scrape',
            content: '',
            text: '',
            fetchedAt: '2026-10-31T00:00:00.000Z',
            failed: true,
          },
    );

    const { promise, researchBlock, eventSpy } = run(['cat'], {
      mode: 'balanced',
    });
    const out = await promise;

    expect(scrape).toHaveBeenCalledTimes(2);

    const pagePassages = out.filter(
      (c) => c.metadata.sourceKind === 'full_page',
    );
    expect(pagePassages.length).toBeGreaterThan(0);
    expect(pagePassages[0].metadata).toMatchObject({
      url: 'https://a.test/',
      title: 'Cat page',
      extraction: 'ok',
      headingPath: ['cat facts'],
    });

    // The failed page is still there, honestly labelled as a snippet.
    const failed = out.find((c) => c.metadata.url === 'https://b.test/');
    expect(failed?.metadata).toMatchObject({
      sourceKind: 'search_snippet',
      extraction: 'failed',
    });
    expect(failed?.content).toBe('dog snippet');

    // The UI's reading step lists only the page that was actually read.
    const reading = researchBlock.data.subSteps.find(
      (s) => s.type === 'reading',
    );
    expect(reading && reading.type === 'reading' && reading.reading).toEqual([
      { content: '', metadata: { url: 'https://a.test/', title: 'Cat page' } },
    ]);

    const names = eventSpy.mock.calls.map((c) => c[0]);
    expect(names).toContain('select');
    expect(names).toContain('evidence');
  });

  it('does not fetch pages when balancedReadsPages is off', async () => {
    settings.balancedReadsPages = false;
    searchSearxng.mockResolvedValue(
      results(['Cats', 'https://a.test/', 'cat']),
    );

    const out = await run(['cat'], { mode: 'balanced' }).promise;

    expect(scrape).not.toHaveBeenCalled();
    expect(out[0].metadata.sourceKind).toBe('search_snippet');
  });
});

describe('executeSearch (quality, reranker off)', () => {
  it('uses the legacy LLM picker and extractor', async () => {
    settings.reranker = 'off';
    searchSearxng.mockResolvedValue(
      results(['Cats', 'https://a.test/', 'cat']),
    );
    scrape.mockResolvedValue({
      title: 'Cat page',
      content: 'cat page text',
      text: 'cat page text',
      fetchedAt: '2026-10-31T00:00:00.000Z',
    });
    const generateObject = vi
      .fn()
      .mockResolvedValueOnce({ picked_indices: [0] })
      .mockResolvedValueOnce({ extracted_facts: '- cats eat fish' });

    const out = await run(['cat'], {
      mode: 'quality',
      llm: { generateObject },
    }).promise;

    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain('cats eat fish');
    expect(out[0].metadata.url).toBe('https://a.test/');
  });
});

describe('executeSearch (request budget)', () => {
  const budgetOf = (maxSearchCalls: number, maxFetches: number) =>
    new RequestBudget({
      maxSearchCalls,
      maxFetches,
      maxBrowserFetches: 1,
      maxResearchMs: 60_000,
    });

  it('returns nothing once the search calls are spent, except for the gap round', async () => {
    searchSearxng.mockResolvedValue(
      results(['Cats', 'https://a.test/', 'cat']),
    );
    const budget = budgetOf(1, 0);

    expect(await run(['one'], { budget }).promise).toHaveLength(1);
    const refused = run(['two'], { budget });
    expect(await refused.promise).toEqual([]);
    expect(refused.researchBlock.data.subSteps).toEqual([]);
    expect(searchSearxng).toHaveBeenCalledTimes(1);
    expect(budget.isExhausted('maxSearchCalls')).toBe(true);

    // Gap searches have their own cap and still run.
    const gap = run(['three'], { budget, countsAsSearchCall: false });
    expect(await gap.promise).toHaveLength(1);
  });

  it('reads no pages when the fetch budget is spent and keeps the snippets', async () => {
    searchSearxng.mockResolvedValue(
      results(
        ['Cats', 'https://a.test/', 'cat snippet'],
        ['Dogs', 'https://b.test/', 'dog snippet'],
      ),
    );
    const budget = budgetOf(4, 0);

    const out = await run(['cat'], { mode: 'quality', budget }).promise;

    expect(scrape).not.toHaveBeenCalled();
    expect(out.every((c) => c.metadata.sourceKind === 'search_snippet')).toBe(
      true,
    );
    expect(budget.isExhausted('maxFetches')).toBe(true);
  });

  it('keeps a page the budget stopped mid-search as a plain snippet', async () => {
    searchSearxng.mockResolvedValue(
      results(
        ['Cats', 'https://a.test/', 'cat snippet'],
        ['Dogs', 'https://b.test/', 'dog snippet'],
      ),
    );
    scrape.mockImplementation(async (url: string) =>
      url.includes('a.test')
        ? {
            title: 'Cat page',
            content: '',
            html: page('cat'),
            text: 'x'.repeat(800),
            fetchedAt: '2026-10-31T00:00:00.000Z',
          }
        : {
            title: 'Failed to scrape',
            content: '',
            text: '',
            fetchedAt: '2026-10-31T00:00:00.000Z',
            failed: true,
            budgetExhausted: true,
          },
    );

    const out = await run(['cat'], {
      mode: 'balanced',
      budget: budgetOf(4, 1),
    }).promise;

    const dog = out.find((c) => c.metadata.url === 'https://b.test/');
    expect(dog?.metadata).toMatchObject({
      sourceKind: 'search_snippet',
      extraction: 'ok',
    });
    // The scraper got the request budget to take from.
    expect(scrape.mock.calls[0][2]).toBeInstanceOf(RequestBudget);
  });
});

describe('executeSearch with a prefetched query (Fleet #346)', () => {
  const makePrefetch = async (query: string, response: unknown) => {
    const { Prefetch } = await import('@/lib/agents/search/prefetch');
    return new Prefetch(
      query,
      new Tracer('off'),
      vi.fn(async () => response as any),
    );
  };

  it('replaces the matching planned query and shows the normal steps', async () => {
    const prefetch = await makePrefetch(
      'Cat food',
      results(['Cats', 'https://a.test/', 'about cat food']),
    );
    searchSearxng.mockResolvedValue(
      results(['Dogs', 'https://b.test/', 'about dogs']),
    );

    const { promise, researchBlock } = run(['dog food', 'cat food'], {
      question: 'cats',
      prefetch,
    });
    const out = await promise;

    // Only the non-matching query went to SearXNG.
    expect(searchSearxng).toHaveBeenCalledTimes(1);
    expect(searchSearxng.mock.calls[0][0]).toBe('dog food');
    expect(out.map((c) => c.metadata.url).sort()).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
    expect(researchBlock.data.subSteps[0]).toMatchObject({
      type: 'searching',
      searching: ['dog food', 'cat food'],
    });
  });

  it('merges a non-matching prefetch as one extra query', async () => {
    const prefetch = await makePrefetch(
      'what should my cat eat',
      results(
        ['Extra', 'https://extra.test/', 'cat diet'],
        ['Cats again', 'https://a.test/', 'about cat food'],
      ),
    );
    searchSearxng.mockResolvedValue(
      results(['Cats', 'https://a.test/', 'about cat food']),
    );

    const { promise, researchBlock } = run(['cat food'], { prefetch });
    const out = await promise;

    // The planned query still runs; the prefetch adds its results.
    expect(searchSearxng).toHaveBeenCalledTimes(1);
    expect(searchSearxng.mock.calls[0][0]).toBe('cat food');
    // a.test came from both and is one source (normalised-URL dedup).
    expect(out.map((c) => c.metadata.url).sort()).toEqual([
      'https://a.test/',
      'https://extra.test/',
    ]);
    expect(researchBlock.data.subSteps[0]).toMatchObject({
      type: 'searching',
      searching: ['cat food', 'what should my cat eat'],
    });
    expect(prefetch.isDecided).toBe(true);
  });

  it('keeps a time-ranged planned query and adds the prefetch', async () => {
    const prefetch = await makePrefetch(
      'cat food',
      results(['Old', 'https://old.test/', 'cat food from years ago']),
    );
    searchSearxng.mockResolvedValue(
      results(['New', 'https://new.test/', 'cat food this month']),
    );

    const researchBlock: any = {
      id: 'r',
      type: 'research',
      data: { subSteps: [] },
    };
    const out = await executeSearch({
      queries: ['cat food'],
      mode: 'speed',
      researchBlock,
      session: { trace: new Tracer('off'), updateBlock: vi.fn() } as any,
      llm: {} as any,
      embedding: { embedText } as any,
      searchConfig: { time_range: 'month' },
      prefetch,
    });

    expect(searchSearxng).toHaveBeenCalledWith(
      'cat food',
      { time_range: 'month' },
      expect.anything(),
    );
    expect(out.map((c) => c.metadata.url).sort()).toEqual([
      'https://new.test/',
      'https://old.test/',
    ]);
  });

  it('runs the planned queries alone when the prefetch failed', async () => {
    const { Prefetch } = await import('@/lib/agents/search/prefetch');
    const prefetch = new Prefetch(
      'what should my cat eat',
      new Tracer('off'),
      vi.fn(async () => {
        throw new Error('SearXNG search timed out');
      }),
    );
    searchSearxng.mockResolvedValue(
      results(['Cats', 'https://a.test/', 'about cat food']),
    );

    const { promise } = run(['cat food'], { prefetch });
    const out = await promise;

    expect(searchSearxng).toHaveBeenCalledTimes(1);
    expect(out.map((c) => c.metadata.url)).toEqual(['https://a.test/']);
  });
});

describe('executeSearch: the prefetch counts against the query cap', () => {
  it('trims three planned queries to two when the prefetch is merged as extra', async () => {
    const { Prefetch } = await import('@/lib/agents/search/prefetch');
    const prefetch = new Prefetch(
      'what should my cat eat',
      new Tracer('off'),
      vi.fn(async () => results(['Extra', 'https://extra.test/', 'cat diet'])),
    );
    searchSearxng.mockResolvedValue(
      results(['Cats', 'https://a.test/', 'about cat food']),
    );

    const { promise, researchBlock } = run(['one', 'two', 'three'], {
      prefetch,
    });
    await promise;

    // Two planned queries went to SearXNG; the third was dropped.
    expect(searchSearxng).toHaveBeenCalledTimes(2);
    expect(searchSearxng.mock.calls.map((c) => c[0])).toEqual(['one', 'two']);
    expect(researchBlock.data.subSteps[0]).toMatchObject({
      type: 'searching',
      searching: ['one', 'two', 'what should my cat eat'],
    });
  });
});
