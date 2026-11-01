// TypeScript: unit tests for the HTTP-first fetch path in src/lib/scraper.ts. DNS, fetch and playwright are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns', () => ({
  default: { promises: { lookup } },
  promises: { lookup },
}));

// The browser must never start in these tests: make launching it fail.
// The spy counts how often the fallback was attempted.
const { launch } = vi.hoisted(() => ({
  launch: vi.fn(async () => {
    throw new Error('no browser in tests');
  }),
}));
vi.mock('playwright', () => ({ chromium: { launch } }));

// A stand-in undici Agent that records the options it was built with, so the
// tests can call the pinned lookup the real Agent would use to connect.
const agents = vi.hoisted(() => [] as { options: any; destroyed: boolean }[]);
vi.mock('undici', () => ({
  Agent: class {
    record: { options: any; destroyed: boolean };
    constructor(options: any) {
      this.record = { options, destroyed: false };
      agents.push(this.record);
    }
    async destroy() {
      this.record.destroyed = true;
    }
  },
}));

import Scraper, {
  HostVerdictCache,
  httpFetch,
  isDownloadUrl,
  MIN_TEXT_CHARS,
  pinnedLookup,
  SUBRESOURCE_DNS_TTL_MS,
  subresourceBlockReason,
} from '@/lib/scraper';
import { RequestBudget } from '@/lib/agents/search/budgets';
import { BlockedUrlError } from '@/lib/utils/safeUrl';

const fetchMock = vi.fn();

// Builds a fetch Response.
const reply = (
  body: string,
  status = 200,
  headers: Record<string, string> = { 'content-type': 'text/html' },
) =>
  new Response(status >= 300 && status < 400 ? null : body, {
    status,
    headers,
  });

const article = (chars: number) =>
  `<html><head><title>T</title></head><body><article><p>${'word '.repeat(
    Math.ceil(chars / 5),
  )}</p></article></body></html>`;

// A tracer stand-in that keeps the events it is given.
const fakeTrace = () => {
  const events: { name: string; data: any }[] = [];
  return {
    events,
    tracer: {
      enabled: true,
      event: (name: string, data: any) => events.push({ name, data }),
    } as any,
  };
};

beforeEach(() => {
  lookup.mockReset();
  lookup.mockImplementation(async (host: string) =>
    host === 'evil.test'
      ? [{ address: '10.0.0.1', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
  );
  fetchMock.mockReset();
  agents.length = 0;
  launch.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('httpFetch', () => {
  it('follows a public redirect and returns the body', async () => {
    fetchMock
      .mockResolvedValueOnce(reply('', 301, { location: '/final' }))
      .mockResolvedValueOnce(reply('<p>hi</p>'));

    const res = await httpFetch('https://site.test/start');
    expect(res).toMatchObject({
      ok: true,
      status: 200,
      finalUrl: 'https://site.test/final',
      body: '<p>hi</p>',
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses a redirect to a private host', async () => {
    fetchMock.mockResolvedValueOnce(
      reply('', 302, { location: 'http://169.254.169.254/latest/' }),
    );
    await expect(httpFetch('https://site.test/')).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a host that resolves privately', async () => {
    fetchMock.mockResolvedValueOnce(
      reply('', 302, { location: 'https://evil.test/' }),
    );
    await expect(httpFetch('https://site.test/')).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('stops after 5 redirects', async () => {
    fetchMock.mockImplementation(async () =>
      reply('', 302, { location: '/again' }),
    );
    const res = await httpFetch('https://site.test/');
    expect(res).toMatchObject({ ok: false, reason: 'redirects' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('reports a bad status and a wrong content type', async () => {
    fetchMock.mockResolvedValueOnce(reply('nope', 403));
    expect(await httpFetch('https://site.test/')).toMatchObject({
      ok: false,
      status: 403,
      reason: 'status 403',
    });

    fetchMock.mockResolvedValueOnce(
      reply('%PDF', 200, { 'content-type': 'application/pdf' }),
    );
    expect(await httpFetch('https://site.test/')).toMatchObject({
      ok: false,
      reason: 'content-type',
    });
  });

  it('caps the body at 2 MB', async () => {
    fetchMock.mockResolvedValueOnce(reply('a'.repeat(3 * 1024 * 1024)));
    const res = await httpFetch('https://site.test/');
    expect(res.ok && res.body.length).toBe(2 * 1024 * 1024);
  });
});

describe('Scraper.scrape', () => {
  it('uses HTTP alone when the page has enough text', async () => {
    fetchMock.mockResolvedValueOnce(reply(article(MIN_TEXT_CHARS * 2)));
    const { tracer, events } = fakeTrace();

    const res = await Scraper.scrape('https://site.test/a', tracer);

    expect(res.title).toBe('T');
    expect(res.content).toContain('word word');
    expect(events[0]).toMatchObject({
      name: 'fetch',
      data: { method: 'http', httpStatus: 200, outcome: 'ok' },
    });
  });

  it('returns the failed shape for a blocked URL and never fetches', async () => {
    const { tracer, events } = fakeTrace();

    const res = await Scraper.scrape('http://localhost:3000/', tracer);

    expect(res.title).toBe('Failed to scrape');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events[0].data).toMatchObject({
      outcome: 'blocked',
      blocked: true,
      reason: 'localhost',
    });
  });

  it('falls back to the browser on thin pages and keeps the HTTP text if it fails', async () => {
    fetchMock.mockResolvedValueOnce(reply(article(100)));
    const { tracer, events } = fakeTrace();

    const res = await Scraper.scrape('https://site.test/thin', tracer);

    expect(res.title).toBe('T');
    expect(events[0].data).toMatchObject({
      method: 'http',
      fallbackReason: 'thin',
      browserError: 'no browser in tests',
    });
  });

  it('reports the HTTP failure reason when the browser also fails', async () => {
    fetchMock.mockResolvedValueOnce(reply('nope', 403));
    const { tracer, events } = fakeTrace();

    const res = await Scraper.scrape('https://site.test/x', tracer);

    expect(res.title).toBe('Failed to scrape');
    expect(events[0].data).toMatchObject({
      method: 'browser',
      httpStatus: 403,
      fallbackReason: 'status 403',
      outcome: 'error',
    });
  });
});

// Calls a dns.lookup-style function and returns what it answered.
const callLookup = (
  lookupFn: any,
  host: string,
  options: Record<string, unknown>,
): Promise<{ err: any; address: any; family?: number }> =>
  new Promise((resolve) =>
    lookupFn(host, options, (err: any, address: any, family?: number) =>
      resolve({ err, address, family }),
    ),
  );

describe('DNS rebinding pin', () => {
  it('connects each hop to the addresses the guard approved', async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply('', 301, { location: 'https://other.test/final' }),
      )
      .mockResolvedValueOnce(reply('<p>hi</p>'));

    const res = await httpFetch('https://site.test/start');
    expect(res.ok).toBe(true);

    // One DNS lookup per hop, by the guard; fetch never resolves on its own.
    expect(lookup).toHaveBeenCalledTimes(2);
    // Each fetch got its own pinned dispatcher, and both were closed.
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined();
    expect(fetchMock.mock.calls[1][1].dispatcher).toBeDefined();
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.destroyed)).toBe(true);

    // The second Agent's lookup answers for other.test with the approved IP.
    const pinned = agents[1].options.connect.lookup;
    expect(await callLookup(pinned, 'other.test', { all: true })).toEqual({
      err: null,
      address: [{ address: '93.184.216.34', family: 4 }],
      family: undefined,
    });
    expect(await callLookup(pinned, 'other.test', {})).toMatchObject({
      err: null,
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('keeps the original host name in the URL (Host header and SNI)', async () => {
    fetchMock.mockResolvedValueOnce(reply('<p>hi</p>'));
    await httpFetch('https://site.test/a');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://site.test/a');
  });

  it('refuses any other host name and an unapproved family', async () => {
    const lookupFn = pinnedLookup('site.test', [
      { address: '93.184.216.34', family: 4 },
    ]);
    const other = await callLookup(lookupFn, 'evil.test', {});
    expect(other.err?.code).toBe('ENOTFOUND');

    const v6 = await callLookup(lookupFn, 'site.test', { family: 6 });
    expect(v6.err?.code).toBe('ENOTFOUND');

    // Case and a trailing dot do not matter.
    const same = await callLookup(lookupFn, 'SITE.test.', {});
    expect(same).toMatchObject({ err: null, address: '93.184.216.34' });
  });
});

describe('subresourceBlockReason', () => {
  it('blocks literal private hosts without DNS', async () => {
    const cache: HostVerdictCache = new Map();
    expect(
      await subresourceBlockReason('http://127.0.0.1/x.png', cache),
    ).toEqual({ blocked: true, reason: 'private address' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('blocks a host that resolves privately', async () => {
    const cache: HostVerdictCache = new Map();
    expect(
      await subresourceBlockReason('https://evil.test/a.js', cache),
    ).toEqual({ blocked: true, reason: 'resolves to a private address' });
  });

  it('looks each host up once per 60 s', async () => {
    const cache: HostVerdictCache = new Map();
    const t0 = 1_000_000;

    // Two images and a script from one host: one lookup between them.
    await Promise.all([
      subresourceBlockReason('https://cdn.test/a.png', cache, t0),
      subresourceBlockReason('https://cdn.test/b.png', cache, t0),
      subresourceBlockReason('https://CDN.test/c.js', cache, t0 + 1000),
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);

    // After the TTL the host is looked up again.
    expect(
      await subresourceBlockReason(
        'https://cdn.test/d.png',
        cache,
        t0 + SUBRESOURCE_DNS_TTL_MS + 1,
      ),
    ).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('aborts quietly (not a guard block) when the name does not resolve', async () => {
    lookup.mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    const cache: HostVerdictCache = new Map();
    expect(
      await subresourceBlockReason('https://gone.test/a.png', cache),
    ).toEqual({ blocked: false, reason: 'dns error' });
  });
});

describe('Scraper.scrape articleHtml', () => {
  it('returns the Readability article HTML next to the raw html', async () => {
    const page = article(MIN_TEXT_CHARS * 2);
    fetchMock.mockResolvedValueOnce(reply(page));

    const res = await Scraper.scrape('https://site.test/a');

    expect(res.html).toBe(page);
    expect(res.articleHtml).toContain('word word');
    expect(res.articleHtml).not.toContain('<title>');
  });

  it('leaves articleHtml undefined for text/plain', async () => {
    fetchMock.mockResolvedValueOnce(
      reply('plain '.repeat(200), 200, { 'content-type': 'text/plain' }),
    );
    const res = await Scraper.scrape('https://site.test/a.txt');
    expect(res.html).toBeUndefined();
    expect(res.articleHtml).toBeUndefined();
  });
});

describe('Scraper.scrape: downloads and budgets', () => {
  const budgetOf = (maxFetches: number, maxBrowserFetches: number) =>
    new RequestBudget({
      maxFetches,
      maxBrowserFetches,
      maxSearchCalls: 1,
      maxResearchMs: 60_000,
    });

  it('recognises download URLs', () => {
    expect(isDownloadUrl('https://site.test/paper.PDF')).toBe(true);
    expect(isDownloadUrl('https://site.test/a.zip?x=1')).toBe(true);
    expect(isDownloadUrl('https://site.test/article')).toBe(false);
    expect(isDownloadUrl('https://site.test/page.html')).toBe(false);
    expect(isDownloadUrl('not a url')).toBe(false);
  });

  it('never sends a PDF content type to the browser', async () => {
    fetchMock.mockResolvedValueOnce(
      reply('%PDF-1.7', 200, { 'content-type': 'application/pdf' }),
    );
    const { tracer, events } = fakeTrace();

    const res = await Scraper.scrape('https://site.test/doc', tracer);

    expect(res.failed).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(events[0].data).toMatchObject({
      method: 'http',
      outcome: 'error',
      fallbackReason: 'content-type',
      browserSkipped: 'content-type',
      contentType: 'application/pdf',
    });
  });

  it('never sends a .pdf URL to the browser, even when HTTP fails otherwise', async () => {
    fetchMock.mockResolvedValueOnce(reply('nope', 403));
    const { tracer, events } = fakeTrace();

    const res = await Scraper.scrape('https://site.test/report.pdf', tracer);

    expect(res.failed).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(events[0].data).toMatchObject({ browserSkipped: 'download' });
  });

  it('skips the browser once the browser budget is spent and keeps thin text', async () => {
    const budget = budgetOf(5, 1);
    fetchMock.mockImplementation(async () => reply(article(100)));
    const { tracer, events } = fakeTrace();

    await Scraper.scrape('https://site.test/one', tracer, budget);
    expect(launch).toHaveBeenCalledTimes(1);

    const res = await Scraper.scrape('https://site.test/two', tracer, budget);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(res.failed).toBeUndefined();
    expect(res.title).toBe('T');
    expect(events[1].data).toMatchObject({
      method: 'http',
      outcome: 'ok',
      browserSkipped: 'budget',
    });
    expect(budget.isExhausted('maxBrowserFetches')).toBe(true);
  });

  it('fetches nothing once the fetch budget is spent', async () => {
    const budget = budgetOf(1, 1);
    fetchMock.mockImplementation(async () =>
      reply(article(MIN_TEXT_CHARS * 2)),
    );

    await Scraper.scrape('https://site.test/a', undefined, budget);
    const res = await Scraper.scrape('https://site.test/b', undefined, budget);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ failed: true, budgetExhausted: true });
  });
});
