// TypeScript: unit tests for purpose-tagged web_search queries (M3): schema, cleanup of model output, time range.
import { describe, expect, it, vi } from 'vitest';

// webSearch.ts imports the search pipeline; keep its config and the
// cross-encoder out of this test.
vi.mock('@/lib/config/serverRegistry', () => ({
  getRerankerKind: () => 'embedding',
  getRerankerModel: () => 'test/model',
  getBalancedReadsPages: () => true,
  getEvidenceBudget: () => 16,
  getSourcePriorWeight: () => 0.5,
}));
vi.mock('@huggingface/transformers', () => {
  throw new Error('transformers must not load in queryPlan tests');
});

import {
  addOfficialDocsVariant,
  normalizePlannedQueries,
  queryTexts,
  timeRangeFor,
} from '@/lib/agents/search/researcher/actions/search/queryPlan';
import webSearchAction, {
  webSearchSchema,
} from '@/lib/agents/search/researcher/actions/search/webSearch';

describe('webSearchSchema', () => {
  it('accepts queries with a purpose', () => {
    const out = webSearchSchema.parse({
      type: 'web_search',
      queries: [
        { query: 'WCAG 2.2 new success criteria', purpose: 'primary' },
        { query: 'WCAG 2.2 W3C recommendation', purpose: 'official_docs' },
      ],
    });
    expect(out.queries[1].purpose).toBe('official_docs');
  });

  it('rejects an unknown purpose and plain strings', () => {
    expect(() =>
      webSearchSchema.parse({
        type: 'web_search',
        queries: [{ query: 'x', purpose: 'seo' }],
      }),
    ).toThrow();
    expect(() =>
      webSearchSchema.parse({ type: 'web_search', queries: ['x'] }),
    ).toThrow();
  });

  it('describes purpose-driven planning in every mode', () => {
    for (const mode of ['speed', 'balanced', 'quality'] as const) {
      const d = webSearchAction.getDescription({ mode });
      expect(d).toContain('ONE query');
      expect(d).toContain('Queries already run');
      expect(d).not.toContain('utilize all 3');
    }
    expect(webSearchAction.getDescription({ mode: 'speed' })).toContain(
      'only ONCE',
    );
  });
});

describe('normalizePlannedQueries', () => {
  it('keeps objects and defaults a bad purpose to primary', () => {
    expect(
      normalizePlannedQueries([
        { query: ' Unraid license tiers ', purpose: 'official_docs' },
        { query: 'Unraid pricing', purpose: 'nonsense' },
      ]),
    ).toEqual([
      { query: 'Unraid license tiers', purpose: 'official_docs' },
      { query: 'Unraid pricing', purpose: 'primary' },
    ]);
  });

  it('accepts the pre-M3 string shape and a single value', () => {
    expect(normalizePlannedQueries(['a', 'b'])).toEqual([
      { query: 'a', purpose: 'primary' },
      { query: 'b', purpose: 'primary' },
    ]);
    expect(normalizePlannedQueries('solo')).toEqual([
      { query: 'solo', purpose: 'primary' },
    ]);
    expect(normalizePlannedQueries(undefined)).toEqual([]);
  });

  it('drops blanks and repeats, and caps at 3', () => {
    const out = normalizePlannedQueries([
      'One',
      'one ',
      '',
      { query: '  ' },
      'two',
      'three',
      'four',
    ]);
    expect(out.map((q) => q.query)).toEqual(['One', 'two', 'three']);
  });

  it('queryTexts reads any search tool arguments', () => {
    expect(
      queryTexts({ queries: [{ query: 'a', purpose: 'issues' }, 'b'] }),
    ).toEqual(['a', 'b']);
    expect(queryTexts({ urls: ['https://x.test/'] })).toEqual([]);
    expect(queryTexts(undefined)).toEqual([]);
  });
});

describe('timeRangeFor', () => {
  it('maps freshness to a SearXNG time range', () => {
    expect(timeRangeFor('recent')).toBe('year');
    expect(timeRangeFor('current')).toBe('month');
    expect(timeRangeFor('none')).toBeUndefined();
    expect(timeRangeFor('historical')).toBeUndefined();
    expect(timeRangeFor(undefined)).toBeUndefined();
  });
});

describe('addOfficialDocsVariant', () => {
  const docs = {
    query: 'Proxmox VE 9 release notes',
    purpose: 'official_docs' as const,
  };
  const primary = { query: 'Proxmox VE 9 Debian', purpose: 'primary' as const };

  it('adds the domain as a plain word, never site:', () => {
    const { queries, variant } = addOfficialDocsVariant(
      [primary, docs],
      'proxmox.com',
    );
    expect(queries).toHaveLength(3);
    expect(queries[2]).toEqual({
      query: 'Proxmox VE 9 release notes proxmox.com',
      purpose: 'official_docs',
    });
    expect(queries[2].query).not.toContain('site:');
    expect(variant).toMatchObject({ from: docs.query, domain: 'proxmox.com' });
  });

  it('keeps the per-call cap and never drops a planned query', () => {
    const planned = [primary, docs, { query: 'x', purpose: 'issues' as const }];
    const { queries, variant } = addOfficialDocsVariant(planned, 'proxmox.com');
    expect(queries).toBe(planned);
    expect(variant?.skipped).toBe('cap');
  });

  it('skips without an official_docs query, a domain, or when named', () => {
    expect(addOfficialDocsVariant([primary], 'proxmox.com').variant).toBe(
      undefined,
    );
    expect(addOfficialDocsVariant([docs], undefined).variant?.skipped).toBe(
      'no_domain',
    );
    const named = {
      query: 'release notes proxmox.com',
      purpose: 'official_docs' as const,
    };
    expect(
      addOfficialDocsVariant([named], 'proxmox.com').variant?.skipped,
    ).toBe('already_named');
  });
});
