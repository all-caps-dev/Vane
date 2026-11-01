// TypeScript: the reranker interface shared by every reranker implementation.

export type RerankPassage = { id: string; text: string };

export type RerankResult = { id: string; score: number };

export type RerankOptions = {
  // Return only the best topK results (default: all).
  topK?: number;
  // Give up after this many milliseconds (default: no limit). A timed out
  // rerank rejects with RerankTimeoutError.
  timeoutMs?: number;
};

/*
  Scores passages against a query. Results are sorted best first and keep
  the ids they were given. Scores are model-specific: a cross-encoder gives
  logits, the embedding reranker gives cosine similarity, so never compare
  scores from two different rerankers.
*/
export interface Reranker {
  name: string;
  rerank(
    query: string,
    passages: RerankPassage[],
    opts?: RerankOptions,
  ): Promise<RerankResult[]>;
}

export class RerankTimeoutError extends Error {
  constructor(ms: number) {
    super(`rerank timed out after ${ms}ms`);
    this.name = 'RerankTimeoutError';
  }
}

// Sorts results best first (stable for equal scores) and applies topK.
export const sortAndCut = (
  results: RerankResult[],
  topK?: number,
): RerankResult[] => {
  const sorted = results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map(({ r }) => r);
  return topK !== undefined && topK >= 0 ? sorted.slice(0, topK) : sorted;
};

// Rejects with RerankTimeoutError when `promise` takes longer than `ms`.
export const withTimeout = <T>(
  promise: Promise<T>,
  ms: number | undefined,
): Promise<T> => {
  if (!ms || ms <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RerankTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
