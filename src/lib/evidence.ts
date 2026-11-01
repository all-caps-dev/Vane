// TypeScript: the evidence contract (M2). Passages with stable ids, converters to the UI's Chunk shape, selection, and the writer's source context.

import { createHash } from 'node:crypto';
import { Chunk } from '@/lib/types';
import { normalizeUrl } from '@/lib/utils/normalizeUrl';
import computeJaccardSimilarity from '@/lib/utils/jaccardSim';
import type { SearxngSearchResult } from '@/lib/searxng';
import type { DocumentChunk } from '@/lib/utils/chunkDocument';

/*
  One passage the writer may cite. A source (one page) can have many
  passages; they share sourceId and differ in chunkId.
  - sourceKind says what the text really is: a search engine's excerpt
    (search_snippet), text read from the page (full_page), or an upload.
  - extraction says how reading the page went (always 'ok' for snippets).
  - score comes from the reranker and is only comparable within one rerank.
  - prior is the source prior (sourcePriors.ts) when one was applied.
*/
export type Evidence = {
  sourceId: string;
  chunkId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  fetchedAt: string;
  publishedAt?: string;
  headingPath: string[];
  text: string;
  sourceKind: 'search_snippet' | 'full_page' | 'upload';
  extraction: 'ok' | 'thin' | 'failed';
  score?: number;
  prior?: number;
  queries: string[];
  engines?: string[];
  rank?: number;
};

export type SourceKind = Evidence['sourceKind'];

/* 's' + the first 8 hex characters of sha1(canonicalUrl). The same URL gives
   the same id in every request, so ids can be compared across traces. */
export const sourceIdFor = (canonicalUrl: string): string =>
  's' + createHash('sha1').update(canonicalUrl).digest('hex').slice(0, 8);

export const chunkIdFor = (sourceId: string, index: number): string =>
  `${sourceId}:c${index}`;

// A SearXNG result becomes one search_snippet passage (chunk index 0).
export const snippetToEvidence = (
  result: SearxngSearchResult,
  query: string,
  rank?: number,
): Evidence => {
  const canonicalUrl = normalizeUrl(result.url);
  const sourceId = sourceIdFor(canonicalUrl);
  const engines =
    result.engines ?? (result.engine ? [result.engine] : undefined);

  return {
    sourceId,
    chunkId: chunkIdFor(sourceId, 0),
    url: result.url,
    canonicalUrl,
    title: result.title,
    fetchedAt: new Date().toISOString(),
    publishedAt: result.publishedDate || undefined,
    headingPath: [],
    text: result.content || result.title,
    sourceKind: 'search_snippet',
    extraction: 'ok',
    queries: [query],
    engines,
    rank,
  };
};

// A fetched page's chunks become full_page passages, one per chunk.
export const pageToEvidence = (
  scraped: { title?: string; fetchedAt?: string },
  chunks: DocumentChunk[],
  meta: {
    url: string;
    extraction: Evidence['extraction'];
    queries: string[];
    // Used when the page has no <title>, usually the search result's title.
    fallbackTitle?: string;
    engines?: string[];
    rank?: number;
    publishedAt?: string;
  },
): Evidence[] => {
  const canonicalUrl = normalizeUrl(meta.url);
  const sourceId = sourceIdFor(canonicalUrl);
  const title = scraped.title?.trim() || meta.fallbackTitle || meta.url;
  const fetchedAt = scraped.fetchedAt ?? new Date().toISOString();

  return chunks.map((chunk, index) => ({
    sourceId,
    chunkId: chunkIdFor(sourceId, index),
    url: meta.url,
    canonicalUrl,
    title,
    fetchedAt,
    publishedAt: meta.publishedAt,
    headingPath: chunk.headingPath,
    text: chunk.text,
    sourceKind: 'full_page',
    extraction: meta.extraction,
    queries: [...meta.queries],
    engines: meta.engines,
    rank: meta.rank,
  }));
};

/* A chunk of an uploaded file becomes one upload passage. The source is the
   file (url file_id://<id>); the chunk id uses the chunk's position in the
   file, so the same chunk keeps its id across queries and requests. Upload
   chunks carry no heading path. */
export const uploadToEvidence = (chunk: {
  fileId: string;
  chunkIndex: number;
  title: string;
  text: string;
  queries: string[];
  uploadedAt?: string;
}): Evidence => {
  const url = `file_id://${chunk.fileId}`;
  const sourceId = sourceIdFor(url);

  return {
    sourceId,
    chunkId: chunkIdFor(sourceId, chunk.chunkIndex),
    url,
    canonicalUrl: url,
    title: chunk.title,
    fetchedAt: chunk.uploadedAt ?? new Date().toISOString(),
    headingPath: [],
    text: chunk.text,
    sourceKind: 'upload',
    extraction: 'ok',
    queries: [...chunk.queries],
  };
};

/* Evidence -> the existing Chunk shape. metadata.url and metadata.title are
   what the UI source cards read, so they stay; the rest rides along. */
export const evidenceToChunk = (e: Evidence): Chunk => ({
  content: e.text,
  metadata: {
    url: e.url,
    title: e.title,
    sourceId: e.sourceId,
    chunkId: e.chunkId,
    canonicalUrl: e.canonicalUrl,
    sourceKind: e.sourceKind,
    extraction: e.extraction,
    headingPath: e.headingPath,
    fetchedAt: e.fetchedAt,
    ...(e.publishedAt ? { publishedAt: e.publishedAt } : {}),
    ...(e.score !== undefined ? { score: e.score } : {}),
    queries: e.queries,
    ...(e.engines ? { engines: e.engines } : {}),
    ...(e.rank !== undefined ? { rank: e.rank } : {}),
  },
});

/* ---------- Selection ---------- */

export type SelectOptions = {
  budget: number;
  maxPerSource?: number;
  minSources?: number;
};

export type SelectResult = {
  selected: Evidence[];
  distinctSources: number;
  droppedDuplicates: number;
};

// Above this word-set overlap two passages count as the same text.
const NEAR_DUPLICATE = 0.8;

/*
  Picks up to `budget` passages from evidence that is already sorted best
  first. Rules, applied in this order:
  1. a passage whose text is a near duplicate (Jaccard > 0.8) of one already
     picked is dropped;
  2. the best passage of each of the first `minSources` sources is taken
     first, so the answer has at least that many sources when they exist;
  3. the rest is filled best first, with at most `maxPerSource` passages
     from one source.
  The result keeps the input (score) order. No model calls; deterministic.
*/
export const selectEvidence = (
  ranked: Evidence[],
  opts: SelectOptions,
): SelectResult => {
  const budget = Math.max(0, Math.floor(opts.budget));
  const maxPerSource = Math.max(1, opts.maxPerSource ?? 4);
  const minSources = Math.max(0, opts.minSources ?? 3);

  const picked = new Set<number>(); // indexes into `ranked`
  const perSource = new Map<string, number>();
  const duplicates = new Set<number>();
  const seenIds = new Set<string>();

  // True when passage i repeats one already picked (same id or near text).
  const isDuplicate = (i: number): boolean => {
    if (duplicates.has(i)) return true;
    const e = ranked[i];
    const key = `${e.chunkId}|${e.sourceKind}`;
    let dup = seenIds.has(key);
    if (!dup) {
      for (const j of picked) {
        if (computeJaccardSimilarity(e.text, ranked[j].text) > NEAR_DUPLICATE) {
          dup = true;
          break;
        }
      }
    }
    if (dup) duplicates.add(i);
    return dup;
  };

  const take = (i: number) => {
    const e = ranked[i];
    picked.add(i);
    seenIds.add(`${e.chunkId}|${e.sourceKind}`);
    perSource.set(e.sourceId, (perSource.get(e.sourceId) ?? 0) + 1);
  };

  // Pass 1: the best passage of each new source, up to minSources.
  for (let i = 0; i < ranked.length; i++) {
    if (picked.size >= Math.min(budget, minSources)) break;
    if (perSource.has(ranked[i].sourceId)) continue;
    if (isDuplicate(i)) continue;
    take(i);
  }

  // Pass 2: fill the budget best first, with the per-source cap.
  for (let i = 0; i < ranked.length; i++) {
    if (picked.size >= budget) break;
    if (picked.has(i)) continue;
    if ((perSource.get(ranked[i].sourceId) ?? 0) >= maxPerSource) continue;
    if (isDuplicate(i)) continue;
    take(i);
  }

  const selected = [...picked].sort((a, b) => a - b).map((i) => ranked[i]);

  return {
    selected,
    distinctSources: new Set(selected.map((e) => e.sourceId)).size,
    droppedDuplicates: duplicates.size,
  };
};

/* ---------- Grouping by source (researcher, writer, UI) ---------- */

/* A source with its passages. `index` is the [N] the writer cites and the
   number the UI shows on the source card. */
export type SourceGroup = {
  index: number;
  sourceId: string;
  url: string;
  title: string;
  kind: SourceKind;
  passages: Chunk[];
  /* The highest reranker score among this source's passages, when any
     passage was reranked. A relevance hint for the UI only: it never
     changes `index`, so the [N] numbering stays first-appearance order. */
  bestScore?: number;
};

// Reads the kind of a Chunk. Chunks made before M2 (uploads, scrape_url,
// and the legacy quality path) carry no sourceKind.
const kindOf = (chunk: Chunk): SourceKind => {
  const kind = chunk.metadata?.sourceKind;
  if (kind === 'search_snippet' || kind === 'full_page' || kind === 'upload')
    return kind;
  return String(chunk.metadata?.url ?? '').startsWith('file_id://')
    ? 'upload'
    : 'full_page';
};

// A chunk with no URL is its own source (the old URL dedup never merged them).
const sourceIdOf = (chunk: Chunk): string => {
  if (chunk.metadata?.sourceId) return chunk.metadata.sourceId;
  const url = String(chunk.metadata?.url ?? '');
  return sourceIdFor(url ? normalizeUrl(url) : `no-url:${chunk.content}`);
};

/*
  Groups passages from every search action into sources, in order of first
  appearance. Passages with the same chunkId (and kind) are one passage.
  When a source has page text, its search snippets are dropped: the page
  is the better evidence and the source is shown as full_page.
*/
export const groupBySource = (chunks: Chunk[]): SourceGroup[] => {
  const groups = new Map<string, SourceGroup>();
  const seen = new Set<string>();

  for (const chunk of chunks) {
    if (!chunk?.metadata) continue;
    const sourceId = sourceIdOf(chunk);
    const kind = kindOf(chunk);
    // Older chunks have no chunkId; their text is their identity.
    const key = `${sourceId}|${kind}|${chunk.metadata.chunkId ?? chunk.content}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let group = groups.get(sourceId);
    if (!group) {
      group = {
        index: 0,
        sourceId,
        url: String(chunk.metadata.url ?? ''),
        title: String(chunk.metadata.title ?? ''),
        kind,
        passages: [],
      };
      groups.set(sourceId, group);
    }
    group.passages.push(chunk);
  }

  const result = [...groups.values()];
  result.forEach((group, i) => {
    group.index = i + 1;
    const pages = group.passages.filter((p) => kindOf(p) !== 'search_snippet');
    if (pages.length > 0 && pages.length < group.passages.length) {
      group.passages = pages;
    }
    group.kind = kindOf(group.passages[0]);

    // Max score over the passages kept above (the ones the writer sees).
    const scores = group.passages
      .map((p) => p.metadata?.score)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (scores.length > 0) group.bestScore = Math.max(...scores);
  });

  return result;
};

/* One Chunk per source, for the `source` block (UI cards), the API's
   `sources` and the trace. content joins the passages, as the old URL
   dedup did. */
export const sourceCard = (group: SourceGroup): Chunk => ({
  content: group.passages.map((p) => p.content).join('\n\n'),
  metadata: {
    ...group.passages[0].metadata,
    url: group.url,
    title: group.title,
    sourceId: group.sourceId,
    sourceKind: group.kind,
    passageCount: group.passages.length,
    ...(group.bestScore !== undefined ? { bestScore: group.bestScore } : {}),
  },
});

// Escapes a value for an XML-style attribute in the writer context.
const attr = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ');

/*
  The writer's context: one <source> per source, numbered like the UI, with
  its passages inside, so [N] still means "source N":
    <source index=1 url="..." title="..." kind="full_page">
    <passage id="s1a2b3c4:c2" heading="A > B">text</passage>
    </source>
*/
export const formatSourcesForWriter = (groups: SourceGroup[]): string =>
  groups
    .map((group) => {
      const passages = group.passages
        .map((p, i) => {
          const id = p.metadata?.chunkId ?? chunkIdFor(group.sourceId, i);
          const headingPath: string[] = Array.isArray(p.metadata?.headingPath)
            ? p.metadata.headingPath
            : [];
          const heading = headingPath.join(' > ');
          // The chunk text starts with its heading line; the attribute
          // already carries it, so do not repeat it.
          const text =
            heading && p.content.startsWith(heading + '\n')
              ? p.content.slice(heading.length + 1)
              : p.content;
          const headingAttr = heading ? ` heading="${attr(heading)}"` : '';
          return `<passage id="${attr(id)}"${headingAttr}>${text}</passage>`;
        })
        .join('\n');

      return `<source index=${group.index} url="${attr(group.url)}" title="${attr(group.title)}" kind="${group.kind}">\n${passages}\n</source>`;
    })
    .join('\n');
