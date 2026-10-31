// TypeScript: unit tests for normalizeUrl (src/lib/utils/normalizeUrl.ts).
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '@/lib/utils/normalizeUrl';

describe('normalizeUrl', () => {
  it('strips tracking params', () => {
    expect(
      normalizeUrl(
        'https://example.com/a?utm_source=x&utm_Medium=y&fbclid=1&gclid=2&msclkid=3&mc_cid=4&mc_eid=5&ref_src=6&igshid=7&_ga=8&yclid=9',
      ),
    ).toBe('https://example.com/a');
  });

  it('keeps meaningful params in their original order and encoding', () => {
    expect(
      normalizeUrl('https://example.com/s?q=a%20b&utm_source=x&page=2&id=7'),
    ).toBe('https://example.com/s?q=a%20b&page=2&id=7');
  });

  it('drops ref only when it has a value', () => {
    expect(normalizeUrl('https://example.com/a?ref=hn&x=1')).toBe(
      'https://example.com/a?x=1',
    );
    expect(normalizeUrl('https://example.com/a?ref=')).toBe(
      'https://example.com/a?ref=',
    );
  });

  it('removes a trailing slash except for the bare root', () => {
    expect(normalizeUrl('https://example.com/docs/')).toBe(
      'https://example.com/docs',
    );
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('gives http and https the same key', () => {
    expect(normalizeUrl('http://example.com/a')).toBe(
      normalizeUrl('https://example.com/a'),
    );
    expect(normalizeUrl('http://example.com/a')).toBe('https://example.com/a');
  });

  it('lowercases scheme and host and drops default ports', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/Path')).toBe(
      'https://example.com/Path',
    );
    expect(normalizeUrl('http://example.com:80/a')).toBe(
      'https://example.com/a',
    );
    expect(normalizeUrl('https://example.com:8443/a')).toBe(
      'https://example.com:8443/a',
    );
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/a?x=1#section-2')).toBe(
      'https://example.com/a?x=1',
    );
  });

  it('returns invalid input unchanged', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
    expect(normalizeUrl('')).toBe('');
  });
});
