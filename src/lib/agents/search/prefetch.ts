// TypeScript: start the first web search while the classifier is still answering (Fleet #346 item 1).
//
// The classifier takes about 1.2 s and every search used to wait for it. When
// a cheap, deterministic check says the question will almost certainly be
// searched, one SearXNG query for the raw question runs in parallel with the
// classifier. The researcher's first web_search always uses that result:
// in place of a planned query that is the raw question (same queryKey, no
// time range), or else as one extra query next to the planned ones. It is
// dropped only when the classifier skips search, when the query failed, or
// when research ends without a web_search. A dropped prefetch never reaches
// the UI.
import { searchSearxng } from '@/lib/searxng';
import type { SearxngSearchOptions } from '@/lib/searxng';
import type { Tracer } from '@/lib/trace';
import type { ChatTurnMessage } from '@/lib/types';
import { queryKey } from './researcher/actions/search/queryPlan';
import type { SearchSources } from './types';

export type SearxngResponse = Awaited<ReturnType<typeof searchSearxng>>;

// Fewer words than this is usually small talk or a fragment.
export const MIN_PREFETCH_WORDS = 4;

// Messages that open with a greeting or thanks.
const GREETING_RE =
  /^(hi|hello|hey|hiya|howdy|yo|greetings|good (morning|afternoon|evening|night)|thanks|thank you|thank u|thx|ty|cheers|much appreciated|appreciate it)\b/i;

// The user said not to search.
const NO_SEARCH_RE =
  /\bfrom memory\b|\bwithout (searching|search|looking it up)\b|\b(don['’]?t|do not) (search|look it up|look up)\b|\bno search\b/i;

// Requests to work on text the user supplied. "summarize" only counts when it
// points at supplied text, since "summarize the history of Rome" searches.
const REWRITE_RE =
  /^(please\s+)?(rewrite|rephrase|reword|paraphrase|translate|proofread|polish|shorten|fix the grammar|correct the grammar|(summari[sz]e|tl;?dr) (this|that|it|the following|the above|my|these))\b/i;

/*
  Whether to start a search before the classifier answers. True only when
  web is an enabled source and the message has at least 4 words, is not a
  greeting or thanks, does not ask to skip search, and does not start with a
  rewriting verb. `history` is accepted so the rule can grow to look at the
  conversation; today the message alone decides.
*/
export const shouldPrefetch = (
  followUp: string,
  history: ChatTurnMessage[],
  sources: SearchSources[],
): boolean => {
  void history;
  if (!sources.includes('web')) return false;
  const text = (followUp ?? '').trim();
  if (text.split(/\s+/).filter(Boolean).length < MIN_PREFETCH_WORDS)
    return false;
  if (GREETING_RE.test(text)) return false;
  if (NO_SEARCH_RE.test(text)) return false;
  if (REWRITE_RE.test(text)) return false;
  return true;
};

/* Why a prefetch was not used. */
export type PrefetchDiscardReason =
  | 'skip_search' // the classifier skipped search
  | 'no_web_search' // research finished without a web_search call
  | 'failed'; // the SearXNG query itself failed

/* How the first web_search uses the prefetch. */
export type PrefetchUse =
  | { mode: 'replace'; index: number } // stands in for planned query `index`
  | { mode: 'extra' }; // merged as one more query

/*
  The reuse decision, pure so it can be tested. A planned query equal to the
  raw question (queryKey) is replaced by the prefetch, unless the call asks
  for SearXNG options (a time range) the prefetch ran without: then every
  planned query runs as planned and the prefetch is merged as an extra
  query, as for any call with no matching query.
*/
export const prefetchDecision = (
  prefetchQuery: string,
  plannedQueries: string[],
  searchConfig?: SearxngSearchOptions,
): PrefetchUse => {
  const hasOptions =
    !!searchConfig &&
    Object.values(searchConfig).some((v) => v !== undefined && v !== null);
  if (hasOptions) return { mode: 'extra' };
  const key = queryKey(prefetchQuery);
  const index = plannedQueries.findIndex((q) => queryKey(q) === key);
  return index === -1 ? { mode: 'extra' } : { mode: 'replace', index };
};

/* What claim() hands the first web_search. `result` resolves to null when
   the prefetched query failed. */
export type PrefetchClaim = PrefetchUse & {
  query: string;
  result: Promise<SearxngResponse | null>;
};

/*
  One prefetched query. It is decided once (claimed or discarded), so only
  the researcher's first web_search can use it and each prefetch records
  exactly one outcome on the trace.
*/
export class Prefetch {
  readonly query: string;
  readonly startedAt: number;
  private settledAt?: number;
  private readonly result: Promise<SearxngResponse | null>;
  private decided = false;

  constructor(
    query: string,
    private readonly trace: Tracer,
    search: (q: string) => Promise<SearxngResponse> = (q) =>
      searchSearxng(q, {}, trace),
  ) {
    this.query = query;
    this.startedAt = Date.now();
    trace.event('prefetch', {
      status: 'started',
      query: trace.content(query),
    });
    // Never rejects, so an unused prefetch cannot cause an unhandled rejection.
    this.result = search(query)
      .catch((err) => {
        trace.error('prefetch', err);
        return null;
      })
      .finally(() => {
        this.settledAt = Date.now();
      });
  }

  get isDecided(): boolean {
    return this.decided;
  }

  /* Drops the prefetch (once); later calls are ignored. */
  discard(reason: PrefetchDiscardReason): void {
    if (this.decided) return;
    this.decided = true;
    this.trace.event('prefetch', {
      status: 'discarded',
      reason,
      ranMs: (this.settledAt ?? Date.now()) - this.startedAt,
    });
  }

  /*
    Called synchronously when the first web_search starts, with its planned
    queries. Returns how to use the prefetch, or null once it was decided.
    The outcome is traced when the prefetched result arrives.
  */
  claim(
    plannedQueries: string[],
    searchConfig?: SearxngSearchOptions,
  ): PrefetchClaim | null {
    if (this.decided) return null;
    this.decided = true;
    const use = prefetchDecision(this.query, plannedQueries, searchConfig);
    const claimedAt = Date.now();

    const result = this.result.then((res) => {
      if (!res) {
        this.trace.event('prefetch', { status: 'discarded', reason: 'failed' });
        return null;
      }
      // The part of the query that ran before the researcher asked for it:
      // all of it if it had finished, the elapsed part if not.
      const savedMs =
        Math.min(this.settledAt ?? claimedAt, claimedAt) - this.startedAt;
      this.trace.event('prefetch', {
        status:
          use.mode === 'replace' ? 'reused_as_replacement' : 'reused_as_extra',
        savedMsEstimate: Math.max(0, savedMs),
        waitedMs: Date.now() - claimedAt,
      });
      return res;
    });

    return { ...use, query: this.query, result };
  }
}

/* Starts a prefetch when the switch is on and shouldPrefetch agrees. */
export const maybeStartPrefetch = (args: {
  enabled: boolean;
  followUp: string;
  history: ChatTurnMessage[];
  sources: SearchSources[];
  trace: Tracer;
}): Prefetch | undefined => {
  if (!args.enabled) return undefined;
  if (!shouldPrefetch(args.followUp, args.history, args.sources))
    return undefined;
  return new Prefetch(args.followUp.trim(), args.trace);
};
