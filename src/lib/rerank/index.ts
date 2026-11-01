// TypeScript: picks the configured reranker and falls back to embedding similarity when it cannot run.

import BaseEmbedding from '@/lib/models/base/embedding';
import type { Tracer } from '@/lib/trace';
import { getRerankerKind, getRerankerModel } from '@/lib/config/serverRegistry';
import EmbeddingReranker from './embeddingReranker';
import { getTransformersReranker } from './transformersReranker';
import {
  Reranker,
  RerankOptions,
  RerankPassage,
  RerankResult,
  sortAndCut,
} from './types';

export * from './types';
export { EmbeddingReranker };

/* 'off': keeps the order it was given (search engine rank). Scores are just
   descending positions so callers can still sort and cut. */
export const offReranker: Reranker = {
  name: 'off',
  rerank: async (_query, passages, opts) =>
    sortAndCut(
      passages.map((p, i) => ({ id: p.id, score: passages.length - i })),
      opts?.topK,
    ),
};

const reasonOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/*
  Returns the reranker the config asks for. For the cross-encoder the model
  is loaded here (once per process); if loading fails the embedding reranker
  is returned instead and a 'rerank.fallback' trace event says why.
*/
export const getReranker = async (
  embedding: BaseEmbedding<any>,
  trace?: Tracer,
): Promise<Reranker> => {
  const kind = getRerankerKind();

  if (kind === 'off') return offReranker;
  if (kind === 'embedding') return new EmbeddingReranker(embedding);

  const model = getRerankerModel();
  try {
    const reranker = getTransformersReranker(model);
    await reranker.load();
    return reranker;
  } catch (err) {
    console.log(`Reranker ${model} could not load, using embeddings:`, err);
    trace?.event('rerank.fallback', {
      reason: reasonOf(err),
      from: `transformers:${model}`,
      to: 'embedding',
    });
    return new EmbeddingReranker(embedding);
  }
};

/*
  Runs a rerank that cannot fail: if the reranker throws or times out, the
  embedding reranker is tried; if that fails too, the input order is kept.
  Every fallback is recorded as a 'rerank.fallback' trace event.
  Returns the results and the name of the reranker that produced them.
*/
export const rerankSafely = async (
  reranker: Reranker,
  embedding: BaseEmbedding<any>,
  query: string,
  passages: RerankPassage[],
  opts: RerankOptions,
  trace?: Tracer,
): Promise<{ results: RerankResult[]; usedReranker: string }> => {
  try {
    return {
      results: await reranker.rerank(query, passages, opts),
      usedReranker: reranker.name,
    };
  } catch (err) {
    trace?.event('rerank.fallback', {
      reason: reasonOf(err),
      from: reranker.name,
      to: reranker.name === 'embedding' ? 'off' : 'embedding',
    });
  }

  if (reranker.name !== 'embedding') {
    try {
      const fallback = new EmbeddingReranker(embedding);
      return {
        results: await fallback.rerank(query, passages, opts),
        usedReranker: fallback.name,
      };
    } catch (err) {
      trace?.event('rerank.fallback', {
        reason: reasonOf(err),
        from: 'embedding',
        to: 'off',
      });
    }
  }

  return {
    results: await offReranker.rerank(query, passages, opts),
    usedReranker: offReranker.name,
  };
};
