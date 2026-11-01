// TypeScript: the shared rerank-and-select steps of the evidence pipeline, used by web, academic and social search, scrape_url and uploads_search.
import BaseEmbedding from '@/lib/models/base/embedding';
import type { Tracer } from '@/lib/trace';
import { Chunk } from '@/lib/types';
import { Evidence, evidenceToChunk, selectEvidence } from '@/lib/evidence';
import { Reranker, rerankSafely } from '@/lib/rerank';

// Passages per source and the number of distinct sources to aim for.
export const MAX_PER_SOURCE = 4;
export const MIN_SOURCES = 3;
// Rerank time limits; on timeout the embedding reranker is used instead.
export const SNIPPET_RERANK_TIMEOUT_MS = 10000;
export const PASSAGE_RERANK_TIMEOUT_MS = 30000;

/*
  Reranks evidence against the question and returns it best first with
  `score` set. Never throws: rerankSafely falls back to embeddings, then to
  the given order. Records the 'rerank' span.
*/
export const rerankEvidence = async (args: {
  stage: string;
  items: Evidence[];
  reranker: Reranker;
  question: string;
  timeoutMs: number;
  embedding: BaseEmbedding<any>;
  trace: Tracer;
}): Promise<Evidence[]> => {
  const { items, trace } = args;
  const span = trace.span('rerank', {
    stage: args.stage,
    reranker: args.reranker.name,
    candidates: items.length,
    topK: items.length,
  });
  const startedAt = Date.now();

  // The title gives the model context the passage itself may lack.
  const passages = items.map((e, i) => ({
    id: String(i),
    text: e.title ? `${e.title}\n${e.text}` : e.text,
  }));

  const { results, usedReranker } = await rerankSafely(
    args.reranker,
    args.embedding,
    args.question,
    passages,
    { timeoutMs: args.timeoutMs },
    trace,
  );

  span.end({ durationMs: Date.now() - startedAt, usedReranker });

  const ranked: Evidence[] = [];
  const seen = new Set<number>();
  for (const r of results) {
    const i = Number(r.id);
    if (!items[i] || seen.has(i)) continue;
    seen.add(i);
    ranked.push({ ...items[i], score: r.score });
  }
  // Defensive: anything the reranker did not return goes last, in order.
  items.forEach((e, i) => {
    if (!seen.has(i)) ranked.push(e);
  });
  return ranked;
};

// What a selection did, for the UI's 'ranking' step (M3).
export type SelectionStats = {
  candidates: number;
  selected: number;
  sources: number;
};

/*
  Applies the evidence budget, records 'select' and 'evidence' trace
  events, reports the counts, and converts the result to the Chunk shape
  callers expect. `limits` overrides the per-source cap and the minimum
  number of sources (scrape_url lets one page fill the budget).
*/
export const finishSelection = (
  ranked: Evidence[],
  budget: number,
  trace: Tracer,
  report: (stats: SelectionStats) => void,
  limits: { maxPerSource?: number; minSources?: number } = {},
): Chunk[] => {
  const { selected, distinctSources, droppedDuplicates } = selectEvidence(
    ranked,
    {
      budget,
      maxPerSource: limits.maxPerSource ?? MAX_PER_SOURCE,
      minSources: limits.minSources ?? MIN_SOURCES,
    },
  );

  report({
    candidates: ranked.length,
    selected: selected.length,
    sources: distinctSources,
  });

  trace.event('select', {
    budget,
    candidates: ranked.length,
    selected: selected.length,
    distinctSources,
    droppedDuplicates,
  });
  trace.event('evidence', {
    items: selected.map((e) => ({
      id: e.chunkId,
      sourceKind: e.sourceKind,
      extraction: e.extraction,
      score: e.score,
    })),
  });

  return selected.map(evidenceToChunk);
};

// The evidence budget for a mode: quality gets 1.5x the configured budget.
export const budgetFor = (
  mode: 'speed' | 'balanced' | 'quality',
  baseBudget: number,
): number => (mode === 'quality' ? Math.round(baseBudget * 1.5) : baseBudget);
