// TypeScript: unit tests for the HTTP-first fetch path in src/lib/scraper.ts. DNS, fetch and playwright are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns', () => ({
  default: { promises: { lookup } },
  promises: { lookup },
}));

// The browser must never start in these tests: make launching it fail.
vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      throw new Error('no browser in tests');
    },
  },
}));

import Scraper, { httpFetch, MIN_TEXT_CHARS } from '@/lib/scraper';
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
