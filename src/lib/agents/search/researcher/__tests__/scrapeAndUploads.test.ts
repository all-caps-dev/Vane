// TypeScript: unit tests for scrape_url and uploads_search on the shared evidence pipeline, and for baseSearch using that same pipeline module.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { scrape, storeQuery, searchSearxng, settings, fakeReranker } =
  vi.hoisted(() => ({
    scrape: vi.fn(),
    storeQuery: vi.fn(),
    searchSearxng: vi.fn(),
    // What the mocked config returns; each test may change it.
    settings: {
      reranker: 'transformers' as 'transformers' | 'embedding' | 'off',
      budget: 16,
    },
    // Scores passages that mention "cat" above the rest; keeps order on ties.
    fakeReranker: {
      name: 'fake',
      rerank: vi.fn(
        async (_q: string, passages: { id: string; text: string }[]) =>
          passages
            .map((p, i) => ({
              id: p.id,
              score: (p.text.includes('cat') ? 100 : 0) - i,
            }))
            .sort((a, b) => b.score - a.score),
      ),
    },
  }));

vi.mock('@/lib/scraper', () => ({
  default: { scrape },
  MIN_TEXT_CHARS: 400,
}));
vi.mock('@/lib/searxng', () => ({ searchSearxng }));
vi.mock('@/lib/uploads/store', () => ({
  default: class {
    query = storeQuery;
  },
}));
// The real registry would read and write data/config.json.
vi.mock('@/lib/config/serverRegistry', () => ({
  getRerankerKind: () => settings.reranker,
  getRerankerModel: () => 'test/model',
  getBalancedReadsPages: () => true,
  getEvidenceBudget: () => settings.budget,
}));
// The configured reranker is the fake; the fallbacks stay real.
vi.mock('@/lib/rerank', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rerank')>()),
  getReranker: vi.fn(async () => fakeReranker),
}));
// Spies around the real pipeline, to see who calls it.
vi.mock('@/lib/evidence/pipeline', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/evidence/pipeline')>();
  return {
    ...actual,
    rerankEvidence: vi.fn(actual.rerankEvidence),
    finishSelection: vi.fn(actual.finishSelection),
  };
});
vi.mock('@huggingface/transformers', () => {
  throw new Error('transformers must not load in these tests');
});

import scrapeURLAction from '@/lib/agents/search/researcher/actions/scrapeURL';
import uploadsSearchAction from '@/lib/agents/search/researcher/actions/uploadsSearch';
import { executeSearch } from '@/lib/agents/search/researcher/actions/search/baseSearch';
import { finishSelection, rerankEvidence } from '@/lib/evidence/pipeline';
import { getReranker } from '@/lib/rerank';
import { sourceIdFor } from '@/lib/evidence';
import { normalizeUrl } from '@/lib/utils/normalizeUrl';
import { Tracer } from '@/lib/trace';
import { ResearchBlock } from '@/lib/types';

// A session whose research block the actions write sub-steps into.
const makeConfig = (opts: { llm?: any; question?: string } = {}) => {
  const trace = new Tracer('on');
  const eventSpy = vi.spyOn(trace, 'event');
  const researchBlock: ResearchBlock = {
    id: 'r',
    type: 'research',
    data: { subSteps: [] },
  };
  const config = {
    llm: opts.llm ?? ({} as any),
    embedding: { embedText: vi.fn() } as any,
    session: {
      trace,
      getBlock: () => researchBlock,
      updateBlock: vi.fn(),
    } as any,
    question: opts.question ?? 'what do cats eat',
    researchBlockId: 'r',
    fileIds: ['f1'],
    mode: 'balanced' as const,
  };
  return { config, researchBlock, eventSpy };
};

// A page with a dog section and a cat section, long enough not to be thin.
const page = `<html><head><title>Pets page</title></head><body><article>
<h2>Dogs</h2><p>${'Dogs like walks in the park every day. '.repeat(30)}</p>
<h2>Cats</h2><p>${'The cat eats fish and dry food twice a day. '.repeat(30)}</p>
</article></body></html>`;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  scrape.mockReset();
  storeQuery.mockReset();
  searchSearxng.mockReset();
  fakeReranker.rerank.mockClear();
  vi.mocked(getReranker).mockClear();
  vi.mocked(rerankEvidence).mockClear();
  vi.mocked(finishSelection).mockClear();
  settings.reranker = 'transformers';
  settings.budget = 16;
});

describe('scrape_url', () => {
  it('chunks the page into full_page evidence, reranks against the question and selects', async () => {
    const url = 'https://pets.test/page?utm_source=x';
    scrape.mockResolvedValue({
      title: 'Pets page',
      content: '',
      html: page,
      text: 'x'.repeat(2000),
      fetchedAt: '2026-11-01T00:00:00.000Z',
    });
    const generateObject = vi.fn();
    const { config, researchBlock, eventSpy } = makeConfig({
      llm: { generateObject },
    });

    const out = await scrapeURLAction.execute({ urls: [url] }, config);
    if (out.type !== 'search_results') throw new Error('wrong output');

    // No per-chunk LLM extraction on the evidence path.
    expect(generateObject).not.toHaveBeenCalled();
    expect(fakeReranker.rerank).toHaveBeenCalledTimes(1);
    expect(fakeReranker.rerank.mock.calls[0][0]).toBe('what do cats eat');
    expect(finishSelection).toHaveBeenCalledTimes(1);

    const sourceId = sourceIdFor(normalizeUrl(url));
    expect(out.results.length).toBeGreaterThan(1);
    out.results.forEach((c) => {
      expect(c.metadata).toMatchObject({
        sourceKind: 'full_page',
        extraction: 'ok',
        sourceId,
        url,
        title: 'Pets page',
      });
      expect(c.metadata.chunkId).toMatch(new RegExp(`^${sourceId}:c\\d+$`));
    });
    // The cat passages ranked first; one page may fill the budget.
    expect(out.results[0].metadata.headingPath).toEqual(['Cats']);

    expect(researchBlock.data.subSteps.map((s) => s.type)).toEqual([
      'reading',
      'ranking',
    ]);
    const names = eventSpy.mock.calls.map((c) => c[0]);
    expect(names).toContain('chunk');
    expect(names).toContain('select');
    expect(names).toContain('evidence');
  });

  it('returns a failed passage, outside the selection, for a page it could not read', async () => {
    scrape.mockImplementation(async (url: string) =>
      url.includes('ok.test')
        ? {
            title: 'Pets page',
            content: '',
            html: page,
            text: 'x'.repeat(2000),
            fetchedAt: '2026-11-01T00:00:00.000Z',
          }
        : {
            title: 'Failed to scrape',
            content: '',
            text: '',
            fetchedAt: '2026-11-01T00:00:00.000Z',
            failed: true,
          },
    );
    const { config } = makeConfig();

    const out = await scrapeURLAction.execute(
      { urls: ['https://ok.test/', 'https://down.test/'] },
      config,
    );
    if (out.type !== 'search_results') throw new Error('wrong output');

    // Only the readable page's passages went to the reranker.
    const reranked = fakeReranker.rerank.mock.calls[0][1];
    expect(reranked.every((p) => !p.text.includes('Could not read'))).toBe(
      true,
    );

    const last = out.results[out.results.length - 1];
    expect(last.metadata).toMatchObject({
      url: 'https://down.test/',
      sourceKind: 'full_page',
      extraction: 'failed',
    });
    expect(last.content).toContain('Could not read https://down.test/');
  });

  it('keeps the LLM extractor path when the reranker is off', async () => {
    settings.reranker = 'off';
    scrape.mockResolvedValue({
      title: 'Long page',
      content: 'word. '.repeat(6000),
      text: 'word. '.repeat(6000),
      fetchedAt: '2026-11-01T00:00:00.000Z',
    });
    const generateObject = vi
      .fn()
      .mockResolvedValue({ extracted_facts: '- a fact' });
    const { config, researchBlock } = makeConfig({ llm: { generateObject } });

    const out = await scrapeURLAction.execute(
      { urls: ['https://long.test/'] },
      config,
    );
    if (out.type !== 'search_results') throw new Error('wrong output');

    expect(generateObject).toHaveBeenCalled();
    expect(getReranker).not.toHaveBeenCalled();
    expect(finishSelection).not.toHaveBeenCalled();
    expect(out.results).toHaveLength(1);
    expect(out.results[0].content).toContain('- a fact');
    expect(researchBlock.data.subSteps.map((s) => s.type)).toEqual(['reading']);
  });
});

describe('uploads_search', () => {
  // A chunk as UploadStore.query returns it.
  const stored = (fileId: string, chunkIndex: number, content: string) => ({
    content,
    metadata: {
      fileName: `${fileId}.pdf`,
      title: `${fileId}.pdf`,
      url: `file_id://${fileId}`,
      fileId,
      chunkIndex,
    },
  });

  it('wraps store chunks as upload evidence, reranks against the question and selects', async () => {
    storeQuery.mockResolvedValue([
      stored('f1', 0, 'Dogs need walks.'),
      stored('f1', 2, 'The cat eats fish.'),
      // The store can return the same chunk for a second query.
      stored('f1', 2, 'The cat eats fish.'),
      stored('f2', 5, 'Budget table for the year.'),
    ]);
    const { config, researchBlock, eventSpy } = makeConfig();

    const out = await uploadsSearchAction.execute(
      { queries: ['cat food', 'pet diet'] },
      config,
    );
    if (out.type !== 'search_results') throw new Error('wrong output');

    // The duplicate chunk was dropped before the rerank.
    expect(fakeReranker.rerank).toHaveBeenCalledTimes(1);
    expect(fakeReranker.rerank.mock.calls[0][0]).toBe('what do cats eat');
    expect(fakeReranker.rerank.mock.calls[0][1]).toHaveLength(3);
    expect(finishSelection).toHaveBeenCalledTimes(1);

    const f1 = sourceIdFor('file_id://f1');
    expect(out.results[0].content).toBe('The cat eats fish.');
    expect(out.results[0].metadata).toMatchObject({
      sourceKind: 'upload',
      extraction: 'ok',
      sourceId: f1,
      chunkId: `${f1}:c2`,
      url: 'file_id://f1',
      title: 'f1.pdf',
      headingPath: [],
      queries: ['cat food', 'pet diet'],
    });
    expect(out.results.map((c) => c.metadata.chunkId)).toEqual([
      `${f1}:c2`,
      `${f1}:c0`,
      `${sourceIdFor('file_id://f2')}:c5`,
    ]);

    expect(researchBlock.data.subSteps.map((s) => s.type)).toEqual([
      'upload_searching',
      'ranking',
      'upload_search_results',
    ]);
    // The UI still gets one card per file.
    const shown = researchBlock.data.subSteps[2];
    expect(
      shown.type === 'upload_search_results' &&
        shown.results.map((c) => c.metadata.url),
    ).toEqual(['file_id://f1', 'file_id://f2']);

    expect(eventSpy.mock.calls.map((c) => c[0])).toContain('select');
  });

  it('lets one file use more than the web per-source cap', async () => {
    storeQuery.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) =>
        stored('f1', i, `Passage ${i} about topic ${i * 7}.`),
      ),
    );
    settings.budget = 8;
    const { config } = makeConfig();

    const out = await uploadsSearchAction.execute({ queries: ['q'] }, config);
    if (out.type !== 'search_results') throw new Error('wrong output');

    expect(out.results).toHaveLength(8);
  });

  it('returns nothing and skips the rerank when the store finds nothing', async () => {
    storeQuery.mockResolvedValue([]);
    const { config } = makeConfig();

    const out = await uploadsSearchAction.execute({ queries: ['q'] }, config);

    expect(out).toEqual({ type: 'search_results', results: [] });
    expect(fakeReranker.rerank).not.toHaveBeenCalled();
  });
});

describe('baseSearch', () => {
  it('ranks and selects through the shared pipeline module', async () => {
    searchSearxng.mockResolvedValue({
      results: [
        { title: 'Dogs', url: 'https://b.test/', content: 'dogs' },
        { title: 'Cats', url: 'https://a.test/', content: 'cat food' },
      ],
      suggestions: [],
    });
    const { config, researchBlock } = makeConfig();

    const out = await executeSearch({
      queries: ['pets'],
      mode: 'speed',
      question: 'cats',
      researchBlock,
      session: config.session,
      llm: config.llm,
      embedding: config.embedding,
    });

    expect(rerankEvidence).toHaveBeenCalledTimes(1);
    expect(finishSelection).toHaveBeenCalledTimes(1);
    expect(out[0].metadata.url).toBe('https://a.test/');
  });
});
