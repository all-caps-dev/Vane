// TypeScript: unit tests for src/lib/sourcePriors.ts (prior values, reordering, domain guess).
import { describe, expect, it } from 'vitest';
import type { Evidence } from '@/lib/evidence';
import { selectEvidence } from '@/lib/evidence';
import {
  applySourcePriors,
  entityNames,
  registrableLabel,
  sourcePrior,
  vendorDomainGuess,
} from '@/lib/sourcePriors';

const prior = (url: string, entities: string[] = [], intent = 'fact') =>
  sourcePrior({ url }, { entities, intent });

describe('sourcePrior', () => {
  it.each([
    // Standards bodies and registries: 0.8.
    ['https://www.w3.org/TR/WCAG22/', ['WCAG 2.2'], 0.8],
    ['https://www.access-board.gov/ict/', ['Section 508'], 0.8],
    ['https://www.npmjs.com/package/@anthropic-ai/claude-code', [], 0.8],
    ['https://pypi.org/project/requests/', [], 0.8],
    ['https://github.com/ggml-org/llama.cpp/releases/tag/b5000', [], 0.8],
    // Vendor by registrable domain, not subdomain: 0.8.
    ['https://www.proxmox.com/en/news/press-releases', ['Proxmox VE 9'], 0.8],
    ['https://forums.truenas.com/t/25-04', ['TrueNAS Community Edition'], 0.8],
    [
      'https://www.home-assistant.io/integrations/zha/',
      ['Home Assistant'],
      0.8,
    ],
    ['https://github.com/ggml-org/llama.cpp', ['llama.cpp'], 0.8],
    // Vendor docs: 1.0.
    ['https://docs.nvidia.com/dgx/dgx-spark/', ['NVIDIA DGX Spark'], 1],
    // Docs host or path without a vendor match: 0.6.
    ['https://docs.searxng.org/dev/search_api.html', [], 0.6],
    ['https://example.readthedocs.io/en/latest/', [], 0.6],
    ['https://developer.mozilla.org/en-US/docs/Web/ARIA', [], 0.6],
    // Neutral: 0.25.
    ['https://proxmox.rdem-systems.com/en/blog/x', ['Proxmox VE 9'], 0.25],
    ['https://www.wcag.com/resource/what-is-wcag/', ['WCAG 2.2'], 0.25],
    ['https://github.com/someone/notes', [], 0.25],
    ['https://example.com/blog', ['Proxmox VE 9'], 0.25],
    // Aggregators and trackers: 0.
    ['https://medium.com/@x/proxmox-9', ['Proxmox VE 9'], 0],
    ['https://someone.medium.com/post', [], 0],
    ['https://dev.to/x/aria-combobox', [], 0],
    ['https://www.linkedin.com/pulse/x', [], 0],
    ['https://www.pinterest.co.uk/pin/1', [], 0],
    ['https://retroaitracker.com/claude-code', ['Claude Code'], 0],
    ['https://releasebot.io/updates/anthropic', [], 0],
    ['https://deepwiki.com/ggml-org/llama.cpp', ['llama.cpp'], 0],
  ])('%s -> %s', (url, entities, expected) => {
    expect(prior(url, entities as string[])).toBe(expected);
  });

  it('gives no first-party bonus to opinion questions, keeps the penalty', () => {
    expect(prior('https://www.proxmox.com/', ['Proxmox VE'], 'opinion')).toBe(
      0.25,
    );
    expect(prior('https://medium.com/x', [], 'opinion')).toBe(0);
  });

  it('is neutral for a URL it cannot parse', () => {
    expect(prior('not a url')).toBe(0.25);
  });
});

describe('helpers', () => {
  it('registrableLabel ignores subdomains and two-part suffixes', () => {
    expect(registrableLabel('forums.truenas.com')).toBe('truenas');
    expect(registrableLabel('www.haisoft.co.uk')).toBe('haisoft');
    expect(registrableLabel('localhost')).toBe('localhost');
  });

  it('entityNames skips generic words and standard names, joins runs', () => {
    const names = entityNames('Claude Code');
    expect(names).toContain('claude');
    expect(names).toContain('claudecode');
    expect(names).not.toContain('code');
    expect(entityNames('WCAG 2.2')).not.toContain('wcag');
  });

  it('vendorDomainGuess maps standards to their body, else word.com', () => {
    expect(vendorDomainGuess(['WCAG 2.2'])).toBe('w3.org');
    expect(vendorDomainGuess(['Section 508'])).toBe('section508.gov');
    expect(vendorDomainGuess(['Proxmox VE 9'])).toBe('proxmox.com');
    expect(vendorDomainGuess(['9.0', 'TrueNAS'])).toBe('truenas.com');
    expect(vendorDomainGuess(['2.1'])).toBeUndefined();
    expect(vendorDomainGuess([])).toBeUndefined();
  });
});

// Builds one passage per source with a given reranker score.
const ev = (id: string, url: string, score: number): Evidence => ({
  sourceId: id,
  chunkId: `${id}:c0`,
  url,
  canonicalUrl: url,
  title: id,
  fetchedAt: '2026-11-01T00:00:00.000Z',
  headingPath: [],
  text: `distinct text for ${id} ${'w'.repeat(id.length)}`,
  sourceKind: 'search_snippet',
  extraction: 'ok',
  queries: ['q'],
  score,
});

const ctx = { entities: ['TrueNAS'], intent: 'fact' };

// Reranker order: two blogs just above the vendor page, a tracker last.
const ranked = [
  ev('blog1', 'https://blog-one.example/truenas', 10),
  ev('blog2', 'https://blog-two.example/truenas', 9.8),
  ev('vendor', 'https://www.truenas.com/docs/scale/', 9.5),
  ev('med', 'https://medium.com/@x/truenas', 9.9),
  ev('other', 'https://other.example/', 2),
];

describe('applySourcePriors', () => {
  it('weight 0 leaves the order and objects unchanged', () => {
    expect(applySourcePriors(ranked, ctx, 0)).toBe(ranked);
  });

  it('lifts a close vendor page and drops an aggregator', () => {
    const out = applySourcePriors(ranked, ctx, 0.5).map((e) => e.sourceId);
    expect(out[0]).toBe('vendor');
    expect(out.indexOf('med')).toBeGreaterThan(out.indexOf('blog2'));
    // A far weaker page is not rescued by a neutral prior.
    expect(out[out.length - 1]).toBe('other');
  });

  it('keeps the raw score and records the prior', () => {
    const vendor = applySourcePriors(ranked, ctx, 0.5)[0];
    expect(vendor.score).toBe(9.5);
    expect(vendor.prior).toBe(1);
  });

  it('scales within one list, so the score unit does not matter', () => {
    const logits = applySourcePriors(ranked, ctx, 0.5).map((e) => e.sourceId);
    const cosine = applySourcePriors(
      ranked.map((e) => ({ ...e, score: (e.score ?? 0) / 100 })),
      ctx,
      0.5,
    ).map((e) => e.sourceId);
    expect(cosine).toEqual(logits);
  });

  it('feeds selection: with a budget of 2 the vendor page is kept', () => {
    const plain = selectEvidence(ranked, { budget: 2, minSources: 2 });
    expect(plain.selected.map((e) => e.sourceId)).not.toContain('vendor');
    const withPrior = selectEvidence(applySourcePriors(ranked, ctx, 0.5), {
      budget: 2,
      minSources: 2,
    });
    expect(withPrior.selected.map((e) => e.sourceId)).toContain('vendor');
  });
});
