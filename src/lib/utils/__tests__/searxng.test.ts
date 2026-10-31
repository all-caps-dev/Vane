// TypeScript: unit tests for the SearXNG URL builder (src/lib/searxng.ts).
import { describe, expect, it, vi } from 'vitest';

// The config module reads files on import; the builder does not need it.
vi.mock('@/lib/config/serverRegistry', () => ({ getSearxngURL: () => '' }));

import { buildSearxngUrl } from '@/lib/searxng';

describe('buildSearxngUrl', () => {
  it('adds format and query', () => {
    const url = buildSearxngUrl('http://searx.test', 'hello world');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('q')).toBe('hello world');
  });

  it('joins arrays with commas and keeps numbers', () => {
    const url = buildSearxngUrl('http://searx.test', 'q', {
      engines: ['bing', 'google'],
      categories: ['news'],
      pageno: 2,
      time_range: 'week',
      language: 'en',
      safesearch: 0,
    });
    expect(url.searchParams.get('engines')).toBe('bing,google');
    expect(url.searchParams.get('categories')).toBe('news');
    expect(url.searchParams.get('pageno')).toBe('2');
    expect(url.searchParams.get('time_range')).toBe('week');
    expect(url.searchParams.get('language')).toBe('en');
    expect(url.searchParams.get('safesearch')).toBe('0');
  });

  it('skips undefined options instead of sending "undefined"', () => {
    const url = buildSearxngUrl('http://searx.test', 'q', {
      engines: undefined,
      language: undefined,
      time_range: undefined,
    });
    expect(url.search).not.toContain('undefined');
    expect([...url.searchParams.keys()]).toEqual(['format', 'q']);
  });
});
