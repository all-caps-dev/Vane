import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Mutex } from 'async-mutex';
import net from 'node:net';
import { Agent } from 'undici';
import type { Tracer } from './trace';
import type { RequestBudget } from './agents/search/budgets';
import {
  ApprovedAddress,
  assertPublicHttpUrl,
  blockedHostReason,
  BlockedUrlError,
  resolvePublicHttpUrl,
} from './utils/safeUrl';
import { liftWrappedHeadings } from './utils/chunkDocument';

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

// File types the browser would download rather than render (Playwright
// fails with "Download is starting"). Never sent to the browser fallback.
const DOWNLOAD_EXTENSIONS = new Set(
  (
    'pdf doc docx xls xlsx ppt pptx odt ods odp rtf epub csv ' +
    'zip gz tgz tar bz2 xz 7z rar exe msi dmg pkg deb rpm apk iso img bin ' +
    'mp3 mp4 m4a mov avi mkv webm wav flac ogg ' +
    'png jpg jpeg gif webp svg tif tiff bmp ico'
  ).split(' '),
);

// True when the URL's path ends in a download extension such as .pdf.
export const isDownloadUrl = (url: string): boolean => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const ext = /\.([a-z0-9]{1,5})$/.exec(path)?.[1];
    return ext !== undefined && DOWNLOAD_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
};

export type HttpFetchResult =
  | {
      ok: true;
      status: number;
      finalUrl: string;
      contentType: string;
      body: string;
    }
  | { ok: false; status?: number; reason: string; contentType?: string };

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
  DNS rebinding pin. The guard resolves a host name and checks the
  addresses; if fetch then resolved the name again, a hostile DNS server
  could answer "public" the first time and "127.0.0.1" the second. So each
  request gets its own undici Agent whose `lookup` hands back only the
  addresses the guard approved. The URL keeps the original host name, so the
  Host header and TLS SNI (and the certificate check) are unchanged.

  undici is the HTTP client inside Node's own fetch; the npm copy is already
  installed (jsdom depends on it) and its Agent works as fetch's dispatcher.
*/

// The callback shape of dns.lookup (TypeScript: a function type alias).
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | ApprovedAddress[],
  family?: number,
) => void;

// Lowercase, no trailing dot, no IPv6 brackets: how host names are compared.
const cleanHost = (h: string) =>
  h
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

/*
  A dns.lookup replacement that answers only for `hostname`, and only with
  the approved addresses. Node calls it as lookup(host, options, callback);
  options.all asks for an array (used by Happy Eyeballs), options.family
  may ask for IPv4 or IPv6 only.
*/
export const pinnedLookup =
  (hostname: string, approved: ApprovedAddress[]) =>
  (
    host: string,
    options: { all?: boolean; family?: number | string } | LookupCallback,
    maybeCallback?: LookupCallback,
  ): void => {
    // lookup(host, callback) is also a legal call shape.
    const callback =
      typeof options === 'function'
        ? options
        : (maybeCallback as LookupCallback);
    const opts = typeof options === 'function' ? {} : (options ?? {});

    const fail = (message: string) => {
      const err: NodeJS.ErrnoException = new Error(message);
      err.code = 'ENOTFOUND';
      callback(err, '');
    };

    if (cleanHost(host) !== cleanHost(hostname)) {
      return fail(`pinned lookup refuses ${host} (pinned to ${hostname})`);
    }

    const family =
      opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : opts.family;
    const matches =
      family === 4 || family === 6
        ? approved.filter((a) => a.family === family)
        : approved;
    if (matches.length === 0) return fail(`no approved address for ${host}`);

    if (opts.all) callback(null, matches);
    else callback(null, matches[0].address, matches[0].family);
  };

// One Agent per request hop, pinned to the addresses the guard approved.
export const createPinnedDispatcher = (
  hostname: string,
  approved: ApprovedAddress[],
): Agent =>
  new Agent({
    // The cast: undici types `lookup` as Node's overloaded LookupFunction.
    connect: { lookup: pinnedLookup(hostname, approved) as any },
  });

/*
  Plain HTTP fetch with the SSRF guard on every hop. Never sends cookies.
  Throws BlockedUrlError when the URL or a redirect target is refused;
  every other failure comes back as { ok: false, reason }.
*/
export const httpFetch = async (url: string): Promise<HttpFetchResult> => {
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  let { url: current, addresses } = await resolvePublicHttpUrl(url);
  // Every Agent made below, closed in `finally` so no socket stays open.
  const dispatchers: Agent[] = [];

  try {
    for (let hop = 0; ; hop++) {
      const dispatcher = createPinnedDispatcher(current.hostname, addresses);
      dispatchers.push(dispatcher);

      const res = await fetch(current, {
        redirect: 'manual',
        signal,
        credentials: 'omit',
        // Not in the standard RequestInit type; Node's fetch accepts it.
        ...({ dispatcher } as {}),
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
        // The next hop is pinned to its own freshly approved addresses.
        ({ url: current, addresses } = await resolvePublicHttpUrl(
          new URL(location, current).toString(),
        ));
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
        return {
          ok: false,
          status: res.status,
          reason: 'content-type',
          contentType: contentType.split(';')[0].trim().toLowerCase(),
        };
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
  } finally {
    // The body has been read or cancelled by now; free the sockets.
    for (const d of dispatchers) d.destroy().catch(() => undefined);
  }
};

/*
  Readability over an HTML string. JSDOM runs no scripts and loads nothing.
  articleHtml is Readability's article as HTML (headings, code and tables
  intact), handed to chunkDocument so it does not parse the page a second
  time. Undefined when Readability found no article text. Wrapped headings
  are lifted first, exactly as chunkDocument does, so sections survive.
*/
const extractReadable = (
  html: string,
  url: string,
): { title: string; text: string; articleHtml?: string } => {
  const dom = new JSDOM(html, { url });
  liftWrappedHeadings(dom.window.document);
  const article = new Readability(dom.window.document).parse();
  const title = dom.window.document.title || article?.title || '';
  const text = article?.textContent?.trim() ?? '';
  return {
    title,
    text,
    articleHtml: text && article?.content ? article.content : undefined,
  };
};

// The content string callers have always received.
const formatContent = (title: string, url: string, text: string) => `
        # ${title ?? 'No title'} - ${url}
        ${text || 'No content available'}
        `;

/* What Scraper.scrape returns. `content` and `title` are what callers have
   always used. M2 adds:
   - html: the raw HTML that produced the text (the HTTP body or the browser's
     rendered page), so the evidence pipeline can chunk it by section.
     Undefined for text/plain pages and failed fetches.
   - articleHtml: Readability's article as HTML, from the same parse that
     produced `text`; chunkDocument uses it instead of parsing `html` again.
     Undefined when there is no html or Readability found no article.
   - text: the readable plain text (no "# title - url" header line).
   - fetchedAt: when the fetch finished, as a UTC ISO string.
   - failed: true when nothing could be read (blocked, error, timeout).
   - budgetExhausted: true when the request's fetch budget was spent, so
     nothing was fetched (failed is true as well). */
export type ScrapeResult = {
  content: string;
  title: string;
  html?: string;
  articleHtml?: string;
  text: string;
  fetchedAt: string;
  failed?: boolean;
  budgetExhausted?: boolean;
};

const failedResult = (url: string): ScrapeResult => ({
  title: 'Failed to scrape',
  content: `# ${url}\n\nError scraping content.`,
  text: '',
  fetchedAt: new Date().toISOString(),
  failed: true,
});

/*
  Browser subresource guard. A page can load hundreds of images and scripts,
  so the DNS answer for each host name is cached for 60 s per page. The
  promise itself is cached, so twenty images from one CDN share one lookup.
  The browser still resolves the name again when it connects (Playwright
  offers no way to pin it), so this narrows DNS rebinding for subresources
  rather than closing it; the HTTP path above is the pinned one.
*/
export const SUBRESOURCE_DNS_TTL_MS = 60_000;

// null: allowed. blocked true: refused by the guard (goes in the trace).
// blocked false: the name did not resolve; aborted quietly (fail closed).
export type SubresourceVerdict = { blocked: boolean; reason: string } | null;

// TypeScript: a Map from host name to its cached verdict and expiry time.
export type HostVerdictCache = Map<
  string,
  { expiresAt: number; verdict: Promise<SubresourceVerdict> }
>;

export const subresourceBlockReason = async (
  requestUrl: string,
  cache: HostVerdictCache,
  now: number = Date.now(),
): Promise<SubresourceVerdict> => {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }

  // 1. The cheap literal check (localhost, private suffixes, private IPs).
  const literal = blockedHostReason(parsed.hostname);
  if (literal) return { blocked: true, reason: literal };

  // 2. DNS, only for http(s) names (an IP literal already passed step 1).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = cleanHost(parsed.hostname);
  if (net.isIP(host)) return null;

  const cached = cache.get(host);
  if (cached && cached.expiresAt > now) return cached.verdict;

  const verdict = assertPublicHttpUrl(`${parsed.protocol}//${host}/`).then(
    (): SubresourceVerdict => null,
    (err): SubresourceVerdict =>
      err instanceof BlockedUrlError
        ? { blocked: true, reason: err.reason }
        : { blocked: false, reason: 'dns error' },
  );
  cache.set(host, { expiresAt: now + SUBRESOURCE_DNS_TTL_MS, verdict });
  return verdict;
};

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
    Other requests (images, scripts, XHR) get the cheap literal check, then
    a DNS check cached per host name for this page (subresourceBlockReason).
  */
  private static async guardRoute(
    route: any,
    onBlocked: (reason: string) => void,
    hostCache: HostVerdictCache,
  ) {
    const request = route.request();
    const requestUrl: string = request.url();

    try {
      if (request.resourceType() !== 'document') {
        const verdict = await subresourceBlockReason(requestUrl, hostCache);
        if (!verdict) return route.continue();
        if (verdict.blocked) onBlocked(verdict.reason);
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
  ): Promise<{
    title: string;
    text: string;
    html: string;
    articleHtml?: string;
  }> {
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
      // Subresource DNS answers, for this page only (one context, one page).
      const hostCache: HostVerdictCache = new Map();

      // Context level so popups are guarded too.
      await context.route('**/*', (route: any) =>
        this.guardRoute(route, onBlocked, hostCache),
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
      const { text, articleHtml } = extractReadable(html, url);
      const title = await page.title();

      return { title, text, html, articleHtml };
    } finally {
      this.userCount--;

      await context.close().catch(() => undefined);

      if (this.userCount === 0) {
        this.scheduleIdleKill();
      }
    }
  }

  /* budget: the request's RequestBudget. Each call takes one fetch; the
     browser fallback also takes one browser fetch. Without a budget nothing
     is limited (scrape_url and other callers). */
  static async scrape(
    url: string,
    trace?: Tracer,
    budget?: RequestBudget,
  ): Promise<ScrapeResult> {
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

    // 0. Fetch budget: when spent, fetch nothing.
    if (budget && !budget.take('maxFetches')) {
      traceFetch({ outcome: 'skipped', reason: 'budget', contentChars: 0 });
      return { ...failedResult(url), budgetExhausted: true };
    }

    let httpStatus: number | undefined;
    let fallbackReason: string | undefined;
    let httpContentType: string | undefined;
    // Kept so a thin HTTP result can still be used if the browser fails.
    let thin:
      | { title: string; text: string; html?: string; articleHtml?: string }
      | undefined;

    // 1. Plain HTTP.
    try {
      const res = await httpFetch(url);
      httpStatus = res.status;

      if (res.ok) {
        // html stays undefined for text/plain, so callers chunk it as text.
        const page: {
          title: string;
          text: string;
          html?: string;
          articleHtml?: string;
        } = res.contentType.toLowerCase().startsWith('text/plain')
          ? { title: url, text: res.body.trim() }
          : { ...extractReadable(res.body, res.finalUrl), html: res.body };

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
            html: page.html,
            articleHtml: page.articleHtml,
            text: page.text,
            fetchedAt: new Date().toISOString(),
          };
        }

        thin = page;
        fallbackReason = 'thin';
      } else {
        fallbackReason = res.reason;
        httpContentType = res.contentType;
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

    // 2. Browser, only because HTTP failed or was thin, and never for a
    //    download (a PDF or any other non-page type) or once the request's
    //    browser budget is spent. Then the thin HTTP text, if any, is used.
    const browserSkipped =
      fallbackReason === 'content-type'
        ? 'content-type'
        : isDownloadUrl(url)
          ? 'download'
          : budget && !budget.take('maxBrowserFetches')
            ? 'budget'
            : undefined;

    if (browserSkipped) {
      const skipData = { browserSkipped, httpStatus, fallbackReason };
      if (thin && thin.text) {
        traceFetch({
          title: thin.title,
          method: 'http',
          outcome: 'ok',
          contentChars: thin.text.length,
          ...skipData,
        });
        return {
          content: formatContent(thin.title, url, thin.text),
          title: thin.title,
          html: thin.html,
          text: thin.text,
          fetchedAt: new Date().toISOString(),
        };
      }
      traceFetch({
        method: 'http',
        outcome: 'error',
        contentChars: 0,
        ...(httpContentType ? { contentType: httpContentType } : {}),
        ...skipData,
      });
      return failedResult(url);
    }

    // The URL already passed assertPublicHttpUrl inside httpFetch.
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
        html: best.html,
        articleHtml: best.articleHtml,
        text: best.text,
        fetchedAt: new Date().toISOString(),
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
          html: thin.html,
          articleHtml: thin.articleHtml,
          text: thin.text,
          fetchedAt: new Date().toISOString(),
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
