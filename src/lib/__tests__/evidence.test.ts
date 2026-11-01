// TypeScript: unit tests for src/lib/evidence.ts (ids, converters, selection, grouping, writer context).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  Evidence,
  chunkIdFor,
  evidenceToChunk,
  formatSourcesForWriter,
  groupBySource,
  pageToEvidence,
  selectEvidence,
  snippetToEvidence,
  sourceCard,
  sourceIdFor,
} from '@/lib/evidence';

// Builds a passage with sensible defaults.
const ev = (sourceId: string, i: number, text: string): Evidence => ({
  sourceId,
  chunkId: `${sourceId}:c${i}`,
  url: `https://${sourceId}.test/`,
  canonicalUrl: `https://${sourceId}.test/`,
  title: sourceId,
  fetchedAt: '2026-10-31T00:00:00.000Z',
  headingPath: [],
  text,
  sourceKind: 'full_page',
  extraction: 'ok',
  queries: ['q'],
});

// Distinct texts that never look like near duplicates of each other.
const words = (n: number) =>
  Array.from({ length: 12 }, (_, k) => `w${n}x${k}`).join(' ');

describe('ids', () => {
  it('sourceIdFor is s + 8 hex of sha1 and stable', () => {
    const url = 'https://example.com/a';
    const expected =
      's' + createHash('sha1').update(url).digest('hex').slice(0, 8);
    expect(sourceIdFor(url)).toBe(expected);
    expect(sourceIdFor(url)).toBe(sourceIdFor(url));
    expect(sourceIdFor(url)).not.toBe(sourceIdFor('https://example.com/b'));
  });

  it('chunkIdFor joins source id and index', () => {
    expect(chunkIdFor('s12345678', 3)).toBe('s12345678:c3');
  });
});

describe('converters', () => {
  it('snippetToEvidence keys on the normalised URL but keeps the original', () => {
    const e = snippetToEvidence(
      {
        title: 'T',
        url: 'http://Example.com/a/?utm_source=x',
        content: 'snippet',
        engines: ['bing'],
        publishedDate: '2026-01-01',
      },
      'my query',
      2,
    );
    expect(e).toMatchObject({
      url: 'http://Example.com/a/?utm_source=x',
      canonicalUrl: 'https://example.com/a',
      sourceId: sourceIdFor('https://example.com/a'),
      text: 'snippet',
      sourceKind: 'search_snippet',
      extraction: 'ok',
      queries: ['my query'],
      engines: ['bing'],
      rank: 2,
      publishedAt: '2026-01-01',
    });
    expect(e.chunkId).toBe(`${e.sourceId}:c0`);
  });

  it('snippetToEvidence falls back to the title when there is no content', () => {
    expect(
      snippetToEvidence({ title: 'Only title', url: 'https://a.test/' }, 'q')
        .text,
    ).toBe('Only title');
  });

  it('pageToEvidence numbers chunks and uses the fallback title', () => {
    const out = pageToEvidence(
      { title: '', fetchedAt: '2026-10-31T01:00:00.000Z' },
      [
        { headingPath: ['A'], text: 'A\none' },
        { headingPath: ['A', 'B'], text: 'A > B\ntwo' },
      ],
      {
        url: 'https://a.test/p',
        extraction: 'thin',
        queries: ['q'],
        fallbackTitle: 'From search',
      },
    );
    expect(out.map((e) => e.chunkId)).toEqual([
      `${out[0].sourceId}:c0`,
      `${out[0].sourceId}:c1`,
    ]);
    expect(out[1]).toMatchObject({
      title: 'From search',
      headingPath: ['A', 'B'],
      sourceKind: 'full_page',
      extraction: 'thin',
      fetchedAt: '2026-10-31T01:00:00.000Z',
    });
  });

  it('evidenceToChunk keeps url and title where the UI reads them', () => {
    const e = { ...ev('sa', 0, 'text'), score: 1.5, rank: 4 };
    const chunk = evidenceToChunk(e);
    expect(chunk.content).toBe('text');
    expect(chunk.metadata).toMatchObject({
      url: e.url,
      title: e.title,
      sourceId: 'sa',
      chunkId: 'sa:c0',
      sourceKind: 'full_page',
      score: 1.5,
      rank: 4,
    });
  });
});

describe('selectEvidence', () => {
  it('caps passages per source and fills the budget best first', () => {
    const ranked = [0, 1, 2, 3, 4, 5].map((i) => ev('sa', i, words(i)));
    ranked.push(ev('sb', 0, words(10)));
    const { selected } = selectEvidence(ranked, {
      budget: 10,
      maxPerSource: 4,
      minSources: 1,
    });
    expect(selected.map((e) => e.chunkId)).toEqual([
      'sa:c0',
      'sa:c1',
      'sa:c2',
      'sa:c3',
      'sb:c0',
    ]);
  });

  it('guarantees minSources distinct sources when they exist', () => {
    const ranked = [
      ...[0, 1, 2, 3].map((i) => ev('sa', i, words(i))),
      ev('sb', 0, words(20)),
      ev('sc', 0, words(30)),
    ];
    const { selected, distinctSources } = selectEvidence(ranked, {
      budget: 3,
      maxPerSource: 4,
      minSources: 3,
    });
    expect(distinctSources).toBe(3);
    // Output keeps the ranked order.
    expect(selected.map((e) => e.chunkId)).toEqual(['sa:c0', 'sb:c0', 'sc:c0']);
  });

  it('drops near duplicates (Jaccard > 0.8) and repeated ids', () => {
    const base = words(1);
    const ranked = [
      ev('sa', 0, base),
      ev('sb', 0, base + ' extra'), // 12 of 13 words shared: duplicate
      ev('sa', 0, words(2)), // same chunkId as the first
      ev('sc', 0, words(3)),
    ];
    const { selected, droppedDuplicates } = selectEvidence(ranked, {
      budget: 10,
    });
    expect(selected.map((e) => e.sourceId)).toEqual(['sa', 'sc']);
    expect(droppedDuplicates).toBe(2);
  });

  it('is deterministic and handles an empty budget', () => {
    const ranked = [0, 1, 2].map((i) => ev(`s${i}`, 0, words(i)));
    expect(selectEvidence(ranked, { budget: 2 })).toEqual(
      selectEvidence(ranked, { budget: 2 }),
    );
    expect(selectEvidence(ranked, { budget: 0 }).selected).toEqual([]);
  });
});

describe('groupBySource and the writer context', () => {
  it('groups passages per source, dedups chunk ids, drops snippets of read pages', () => {
    const page0 = evidenceToChunk({
      ...ev('sa', 0, 'Intro\nfirst'),
      headingPath: ['Intro'],
    });
    const page1 = evidenceToChunk(ev('sa', 1, 'second'));
    const snippetA = evidenceToChunk({
      ...ev('sa', 0, 'snippet a'),
      sourceKind: 'search_snippet',
    });
    const snippetB = evidenceToChunk({
      ...ev('sb', 0, 'snippet "b"'),
      sourceKind: 'search_snippet',
      title: 'B & "co"',
    });
    const upload = {
      content: 'file text',
      metadata: { url: 'file_id://123', title: 'notes.pdf' },
    };

    const groups = groupBySource([
      snippetA,
      page0,
      snippetB,
      page0, // same passage from a second search action
      page1,
      upload,
    ]);

    expect(groups.map((g) => [g.index, g.sourceId, g.kind])).toEqual([
      [1, 'sa', 'full_page'],
      [2, 'sb', 'search_snippet'],
      [3, expect.stringMatching(/^s[0-9a-f]{8}$/), 'upload'],
    ]);
    expect(groups[0].passages.map((p) => p.metadata.chunkId)).toEqual([
      'sa:c0',
      'sa:c1',
    ]);

    const card = sourceCard(groups[0]);
    expect(card.metadata).toMatchObject({
      url: 'https://sa.test/',
      title: 'sa',
      passageCount: 2,
    });

    const context = formatSourcesForWriter(groups);
    expect(context).toContain(
      '<source index=1 url="https://sa.test/" title="sa" kind="full_page">',
    );
    // The heading line is moved into the attribute, not repeated.
    expect(context).toContain(
      '<passage id="sa:c0" heading="Intro">first</passage>',
    );
    expect(context).toContain('<passage id="sa:c1">second</passage>');
    expect(context).toContain('title="B &amp; &quot;co&quot;"');
    expect(context).toContain('kind="search_snippet"');
    expect(context).toContain('index=3 url="file_id://123"');
  });
});

describe('groupBySource bestScore', () => {
  it('attaches the max passage score without changing [N] order or the writer context', () => {
    // Source sa appears first but scores lower than sb.
    const a0 = evidenceToChunk({ ...ev('sa', 0, words(1)), score: 0.2 });
    const a1 = evidenceToChunk({ ...ev('sa', 1, words(2)), score: 0.4 });
    const b0 = evidenceToChunk({ ...ev('sb', 0, words(3)), score: 0.9 });
    const c0 = evidenceToChunk(ev('sc', 0, words(4))); // never reranked

    const groups = groupBySource([a0, b0, a1, c0]);

    // First-appearance order is kept: citations depend on it.
    expect(groups.map((g) => [g.index, g.sourceId])).toEqual([
      [1, 'sa'],
      [2, 'sb'],
      [3, 'sc'],
    ]);
    expect(groups.map((g) => g.bestScore)).toEqual([0.4, 0.9, undefined]);

    // The card carries it; a source with no score gets no key at all.
    expect(sourceCard(groups[0]).metadata.bestScore).toBe(0.4);
    expect('bestScore' in sourceCard(groups[2]).metadata).toBe(false);

    // The writer never sees it.
    expect(formatSourcesForWriter(groups)).not.toContain('bestScore');
  });

  it('scores only the passages kept after snippets of a read page are dropped', () => {
    const snippet = evidenceToChunk({
      ...ev('sa', 0, words(5)),
      sourceKind: 'search_snippet',
      score: 0.99,
    });
    const page = evidenceToChunk({ ...ev('sa', 1, words(6)), score: 0.5 });

    const [group] = groupBySource([snippet, page]);
    expect(group.kind).toBe('full_page');
    expect(group.bestScore).toBe(0.5);
  });
});
