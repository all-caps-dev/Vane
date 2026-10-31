// TypeScript: fallback reranker that scores passages by cosine similarity of the request's embedding model.

import BaseEmbedding from '@/lib/models/base/embedding';
import computeSimilarity from '@/lib/utils/computeSimilarity';
import {
  Reranker,
  RerankOptions,
  RerankPassage,
  RerankResult,
  sortAndCut,
  withTimeout,
} from './types';

/* What speed mode did before M2: embed the query and every passage in ONE
   embedText call, then rank by cosine similarity. Used when the
   cross-encoder is not wanted or cannot load. */
class EmbeddingReranker implements Reranker {
  readonly name = 'embedding';

  constructor(private embedding: BaseEmbedding<any>) {}

  async rerank(
    query: string,
    passages: RerankPassage[],
    opts: RerankOptions = {},
  ): Promise<RerankResult[]> {
    if (passages.length === 0) return [];

    const work = async () => {
      // Index 0 is the query; index i + 1 is passage i.
      const vectors = await this.embedding.embedText([
        query,
        ...passages.map((p) => p.text),
      ]);
      if (vectors.length !== passages.length + 1) {
        throw new Error(
          `embedText returned ${vectors.length} vectors for ${passages.length + 1} texts`,
        );
      }
      const results = passages.map((p, i) => ({
        id: p.id,
        score: computeSimilarity(vectors[0], vectors[i + 1]),
      }));
      return sortAndCut(results, opts.topK);
    };

    return withTimeout(work(), opts.timeoutMs);
  }
}

export default EmbeddingReranker;
