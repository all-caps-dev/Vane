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
}));
// The cross-encoder must never load in these tests.
vi.mock('@huggingface/transformers', () => {
  throw new Error('transformers must not load in baseSearch tests');
});

import { executeSearch } from '@/lib/agents/search/researcher/actions/search/baseSearch';
import { Tracer } from '@/lib/trace';
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
    session: { trace, updateBlock: vi.fn() } as any,
    llm: opts.llm ?? ({} as any),
    embedding: { embedText } as any,
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
});

describe('executeSearch (speed)', () => {
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
