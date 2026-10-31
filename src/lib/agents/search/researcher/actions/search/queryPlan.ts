// TypeScript: purpose-tagged web queries (M3). Schema, cleanup of what the model sent, and the SearXNG time range for a freshness.
import z from 'zod';
import type { SearxngSearchOptions } from '@/lib/searxng';
import type { Freshness } from '../../../types';

/* Why a query is run. Each query in one web_search call should aim at a
   different purpose, so the results do not all say the same thing. */
export const QUERY_PURPOSES = [
  'primary',
  'official_docs',
  'issues',
  'independent',
  'recent',
  'comparison_side',
] as const;

export type QueryPurpose = (typeof QUERY_PURPOSES)[number];

export type PlannedQuery = { query: string; purpose: QueryPurpose };

// Most queries one web_search call runs.
export const MAX_QUERIES_PER_CALL = 3;

export const plannedQuerySchema = z.object({
  query: z
    .string()
    .describe(
      'The search query. Keep product names, versions and error strings exactly as the user wrote them.',
    ),
  purpose: z
    .enum(QUERY_PURPOSES)
    .describe(
      'primary = the direct answer; official_docs = the vendor or standards body; issues = bug trackers, known problems; independent = third-party reviews or tests; recent = news or changes; comparison_side = one side of a comparison.',
    ),
});

const isPurpose = (value: unknown): value is QueryPurpose =>
  typeof value === 'string' &&
  (QUERY_PURPOSES as readonly string[]).includes(value);

/*
  Tool-call arguments are not validated against the schema, and models do
  not always follow it. This accepts what models actually send:
  - [{ query, purpose }]  (the schema)
  - ["text", ...]         (the pre-M3 shape)
  - one string or one object instead of an array
  Unknown purposes become 'primary'; blank and repeated queries (ignoring
  case and spacing) are dropped; at most `max` are kept.
*/
export const normalizePlannedQueries = (
  raw: unknown,
  max: number = MAX_QUERIES_PER_CALL,
): PlannedQuery[] => {
  const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: PlannedQuery[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    let query = '';
    let purpose: QueryPurpose = 'primary';

    if (typeof item === 'string') {
      query = item;
    } else if (item && typeof item === 'object') {
      const obj = item as { query?: unknown; purpose?: unknown };
      if (typeof obj.query === 'string') query = obj.query;
      if (isPurpose(obj.purpose)) purpose = obj.purpose;
    }

    query = query.trim();
    const key = queryKey(query);
    if (!query || seen.has(key)) continue;
    seen.add(key);
    out.push({ query, purpose });
    if (out.length >= max) break;
  }

  return out;
};

// The comparison key for "the same query": lower case, single spaces.
export const queryKey = (query: string): string =>
  query.trim().toLowerCase().replace(/\s+/g, ' ');

// The plain query strings in any search tool's arguments (web, academic,
// social, uploads), in whichever shape the model sent them.
export const queryTexts = (args: unknown): string[] => {
  if (!args || typeof args !== 'object') return [];
  const queries = (args as { queries?: unknown }).queries;
  return normalizePlannedQueries(queries, Infinity).map((q) => q.query);
};

/* SearXNG's time_range for the classifier's freshness: the last year for
   'recent', the last month for 'current', no limit otherwise. */
export const timeRangeFor = (
  freshness: Freshness | undefined,
): SearxngSearchOptions['time_range'] => {
  if (freshness === 'recent') return 'year';
  if (freshness === 'current') return 'month';
  return undefined;
};
