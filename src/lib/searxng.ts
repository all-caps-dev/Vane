import { getSearxngURL } from './config/serverRegistry';
import type { Tracer } from './trace';

export interface SearxngSearchOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
  time_range?: 'day' | 'week' | 'month' | 'year';
  safesearch?: 0 | 1 | 2;
}

interface SearxngSearchResult {
  title: string;
  url: string;
  img_src?: string;
  thumbnail_src?: string;
  thumbnail?: string;
  content?: string;
  author?: string;
  iframe_src?: string;
}

/*
  Builds the SearXNG request URL. Arrays are joined with commas; undefined
  and null options are skipped (they used to become the text "undefined").
*/
export const buildSearxngUrl = (
  baseUrl: string,
  query: string,
  opts?: SearxngSearchOptions,
): URL => {
  const url = new URL(`${baseUrl}/search?format=json`);
  url.searchParams.append('q', query);

  if (opts) {
    Object.keys(opts).forEach((key) => {
      const value = opts[key as keyof SearxngSearchOptions];
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        url.searchParams.append(key, value.join(','));
        return;
      }
      url.searchParams.append(key, String(value));
    });
  }

  return url;
};

export const searchSearxng = async (
  query: string,
  opts?: SearxngSearchOptions,
  trace?: Tracer,
) => {
  const searxngURL = getSearxngURL();
  const startedAt = Date.now();

  /* One 'search.query' trace event per call. Never the SearXNG URL itself,
     which may carry credentials. */
  const traceQuery = (data: Record<string, unknown>) =>
    trace?.event('search.query', {
      query,
      engines: opts?.engines,
      categories: opts?.categories,
      durationMs: Date.now() - startedAt,
      ...data,
    });

  const url = buildSearxngUrl(searxngURL, query, opts);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`SearXNG error: ${res.statusText}`);
    }

    const data = await res.json();

    const results: SearxngSearchResult[] = data.results;
    const suggestions: string[] = data.suggestions;

    if (trace?.enabled) {
      traceQuery({
        resultCount: Array.isArray(results) ? results.length : 0,
        emptyContentCount: Array.isArray(results)
          ? results.filter((r) => !r.content).length
          : 0,
      });
    }

    return { results, suggestions };
  } catch (err: any) {
    if (trace?.enabled) {
      traceQuery({
        resultCount: 0,
        error:
          err?.name === 'AbortError'
            ? 'SearXNG search timed out'
            : String(err?.message ?? err),
      });
    }
    if (err.name === 'AbortError') {
      throw new Error('SearXNG search timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};
