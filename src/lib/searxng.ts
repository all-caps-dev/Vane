import { getSearxngURL } from './config/serverRegistry';
import type { Tracer } from './trace';

export interface SearxngSearchOptions {
  categories?: string[];
  engines?: string[];
  language?: string;
  pageno?: number;
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

  const url = new URL(`${searxngURL}/search?format=json`);
  url.searchParams.append('q', query);

  if (opts) {
    Object.keys(opts).forEach((key) => {
      const value = opts[key as keyof SearxngSearchOptions];
      if (Array.isArray(value)) {
        url.searchParams.append(key, value.join(','));
        return;
      }
      url.searchParams.append(key, value as string);
    });
  }

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
