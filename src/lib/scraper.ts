import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Mutex } from 'async-mutex';
import type { Tracer } from './trace';
import {
  assertPublicHttpUrl,
  blockedHostReason,
  BlockedUrlError,
} from './utils/safeUrl';

/* Fetching strategy (M1): plain HTTP first, the headless browser only when
   HTTP fails or returns too little text. Every URL, including every redirect
   hop, must pass the private-address guard in utils/safeUrl.ts. */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const HTTP_TIMEOUT_MS = 10000;
const HTTP_MAX_REDIRECTS = 5;
const HTTP_MAX_BYTES = 2 * 1024 * 1024;
// Below this many characters of readable text the page is "thin" and the
// browser gets a try (it can run the page's JavaScript).
export const MIN_TEXT_CHARS = 400;

const ACCEPTED_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export type HttpFetchResult =
  | {
      ok: true;
      status: number;
      finalUrl: string;
      contentType: string;
      body: string;
    }
  | { ok: false; status?: number; reason: string };

// True when the Content-Type header names a type we can read as a page.
export const isAcceptedContentType = (header: string | null): boolean => {
  const type = (header ?? '').split(';')[0].trim().toLowerCase();
  return ACCEPTED_TYPES.includes(type);
};

// Reads a response body but stops after maxBytes. Returns the bytes read.
const readCapped = async (
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> => {
  if (!res.body) return new Uint8Array(0);

  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;

  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  // Stop the download if we hit the cap before the end.
  await reader.cancel().catch(() => undefined);

  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const part of parts) {
    const room = out.byteLength - offset;
    if (room <= 0) break;
    out.set(part.subarray(0, room), offset);
    offset += Math.min(part.byteLength, room);
  }
  return out;
};

// Decodes bytes with the charset from Content-Type, falling back to UTF-8.
const decodeBody = (bytes: Uint8Array, contentType: string): string => {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
};

/*
  Plain HTTP fetch with the SSRF guard on every hop. Never sends cookies.
  Throws BlockedUrlError when the URL or a redirect target is refused;
  every other failure comes back as { ok: false, reason }.
*/
export const httpFetch = async (url: string): Promise<HttpFetchResult> => {
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  let current = await assertPublicHttpUrl(url);

  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        redirect: 'manual',
        signal,
        credentials: 'omit',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= HTTP_MAX_REDIRECTS) {
          return { ok: false, status: res.status, reason: 'redirects' };
        }
        // Re-check every hop: a public page may redirect to a private one.
        current = await assertPublicHttpUrl(
          new URL(location, current).toString(),
        );
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          status: res.status,
          reason: `status ${res.status}`,
        };
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!isAcceptedContentType(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, reason: 'content-type' };
      }

      const bytes = await readCapped(res, HTTP_MAX_BYTES);
      return {
        ok: true,
        status: res.status,
        finalUrl: current.toString(),
        contentType,
        body: decodeBody(bytes, contentType),
      };
    }
  } catch (err: any) {
    if (err instanceof BlockedUrlError) throw err;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: `error ${err?.message ?? String(err)}` };
  }
};

// Readability over an HTML string. JSDOM runs no scripts and loads nothing.
const extractReadable = (
  html: string,
  url: string,
): { title: string; text: string } => {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const title = dom.window.document.title || article?.title || '';
  return { title, text: article?.textContent?.trim() ?? '' };
};

// The content string callers have always received.
const formatContent = (title: string, url: string, text: string) => `
        # ${title ?? 'No title'} - ${url}
        ${text || 'No content available'}
        `;

const failedResult = (url: string) => ({
  title: 'Failed to scrape',
  content: `# ${url}\n\nError scraping content.`,
});

class Scraper {
  private static browser: any | undefined;
  private static IDLE_KILL_TIMEOUT = 30000;
  private static NAVIGATION_TIMEOUT = 20000;
  private static idleTimeout: NodeJS.Timeout | undefined;
  private static browserMutex = new Mutex();
  private static userCount = 0;

  private static async initBrowser() {
    await this.browserMutex.runExclusive(async () => {
      if (!this.browser) {
        const { chromium } = await import('playwright');
        this.browser = await chromium.launch({
          headless: true,
          channel: 'chromium-headless-shell',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
          ],
        });
      }

      if (this.idleTimeout) clearTimeout(this.idleTimeout);
    });
  }

  private static scheduleIdleKill() {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);

    this.idleTimeout = setTimeout(async () => {
      await this.browserMutex.runExclusive(async () => {
        if (this.browser && this.userCount === 0) {
          {
            await this.browser.close();
            this.browser = undefined;
          }
        }
      });
    }, this.IDLE_KILL_TIMEOUT);
  }

  /*
    Guards every request the page makes. Documents (the page and iframes,
    including each redirect hop) get the full DNS check; their redirects are
    fetched with maxRedirects 0 so each Location is checked before the browser
    follows it (page.route alone only sees the first URL of a redirect chain).
    Other requests (images, scripts, XHR) get the cheap no-DNS check.
  */
  private static async guardRoute(
    route: any,
    onBlocked: (reason: string) => void,
  ) {
    const request = route.request();
    const requestUrl: string = request.url();

    try {
      if (request.resourceType() !== 'document') {
        let host = '';
        try {
          host = new URL(requestUrl).hostname;
        } catch {
          return route.continue();
        }
        const reason = blockedHostReason(host);
        if (!reason) return route.continue();
        onBlocked(reason);
        return route.abort('blockedbyclient');
      }

      await assertPublicHttpUrl(requestUrl);

      const response = await route.fetch({ maxRedirects: 0 });
      const status: number = response.status();
      const location: string | undefined = response.headers()['location'];

      if (status >= 300 && status < 400 && location) {
        await assertPublicHttpUrl(new URL(location, requestUrl).toString());
      }

      return route.fulfill({ response });
    } catch (err) {
      if (err instanceof BlockedUrlError) onBlocked(err.reason);
      return route.abort('blockedbyclient').catch(() => undefined);
    }
  }

  // The original Playwright path. Throws on navigation errors.
  private static async browserFetch(
    url: string,
    onBlocked: (reason: string) => void,
  ): Promise<{ title: string; text: string }> {
    await this.initBrowser();

    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      userAgent: USER_AGENT,
      // Service workers could answer requests without passing the route guard.
      serviceWorkers: 'block',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.userCount++;

    try {
      // Context level so popups are guarded too.
      await context.route('**/*', (route: any) =>
        this.guardRoute(route, onBlocked),
      );

      const page = await context.newPage();

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.NAVIGATION_TIMEOUT,
      });

      await page
        .waitForLoadState('load', { timeout: 5000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const html = await page.content();
      const { text } = extractReadable(html, url);
      const title = await page.title();

      return { title, text };
    } finally {
      this.userCount--;

      await context.close().catch(() => undefined);

      if (this.userCount === 0) {
        this.scheduleIdleKill();
      }
    }
  }

  static async scrape(
    url: string,
    trace?: Tracer,
  ): Promise<{ content: string; title: string }> {
    const startedAt = Date.now();

    /* One 'fetch' trace event per scrape. outcome is 'ok', 'empty' (no
       readable text), 'blocked' (refused by the guard) or 'error'. */
    const traceFetch = (data: Record<string, unknown>) => {
      if (trace?.enabled) {
        trace.event('fetch', {
          url,
          durationMs: Date.now() - startedAt,
          ...data,
        });
      }
    };

    let httpStatus: number | undefined;
    let fallbackReason: string | undefined;
    // Kept so a thin HTTP result can still be used if the browser fails.
    let thin: { title: string; text: string } | undefined;

    // 1. Plain HTTP.
    try {
      const res = await httpFetch(url);
      httpStatus = res.status;

      if (res.ok) {
        const page = res.contentType.toLowerCase().startsWith('text/plain')
          ? { title: url, text: res.body.trim() }
          : extractReadable(res.body, res.finalUrl);

        if (page.text.length >= MIN_TEXT_CHARS) {
          traceFetch({
            title: page.title,
            method: 'http',
            httpStatus,
            outcome: 'ok',
            contentChars: page.text.length,
          });
          return {
            content: formatContent(page.title, url, page.text),
            title: page.title,
          };
        }

        thin = page;
        fallbackReason = 'thin';
      } else {
        fallbackReason = res.reason;
      }
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        console.log(`Blocked scraping ${url}: ${err.reason}`);
        traceFetch({
          method: 'http',
          outcome: 'blocked',
          blocked: true,
          reason: err.reason,
          contentChars: 0,
        });
        return failedResult(url);
      }

      // DNS failure or similar before any request was made.
      console.log(`Error scraping ${url}:`, err);
      traceFetch({
        method: 'http',
        outcome: 'error',
        contentChars: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      return failedResult(url);
    }

    // 2. Browser, only because HTTP failed or was thin. The URL already
    //    passed assertPublicHttpUrl inside httpFetch.
    // The first request the in-browser guard refused, if any (for the trace).
    let browserBlocked: { blocked: true; reason: string } | undefined;
    const onBlocked = (reason: string) => {
      browserBlocked ??= { blocked: true, reason };
    };

    try {
      const page = await this.browserFetch(url, onBlocked);

      // Prefer whichever of the two found more text.
      const best =
        thin && thin.text.length > page.text.length
          ? { ...thin, method: 'http' }
          : { ...page, method: 'browser' };

      traceFetch({
        title: best.title,
        method: best.method,
        httpStatus,
        fallbackReason,
        outcome: best.text ? 'ok' : 'empty',
        contentChars: best.text.length,
        ...browserBlocked,
      });

      return {
        content: formatContent(best.title, url, best.text),
        title: best.title,
      };
    } catch (err) {
      console.log(`Error scraping ${url}:`, err);

      const error = err instanceof Error ? err.message : String(err);

      if (thin && thin.text) {
        traceFetch({
          title: thin.title,
          method: 'http',
          httpStatus,
          fallbackReason,
          outcome: 'ok',
          contentChars: thin.text.length,
          browserError: error,
          ...browserBlocked,
        });
        return {
          content: formatContent(thin.title, url, thin.text),
          title: thin.title,
        };
      }

      traceFetch({
        method: 'browser',
        httpStatus,
        fallbackReason,
        outcome: browserBlocked ? 'blocked' : 'error',
        contentChars: 0,
        error,
        ...browserBlocked,
      });

      return failedResult(url);
    }
  }
}

export default Scraper;
