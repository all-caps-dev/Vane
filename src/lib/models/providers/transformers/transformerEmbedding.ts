import { Chunk } from '@/lib/types';
import BaseEmbedding from '../../base/embedding';
import { FeatureExtractionPipeline } from '@huggingface/transformers';

type TransformerConfig = {
  model: string;
};

/* One pipeline per model for the whole process. A TransformerEmbedding is
   created for every request (ModelRegistry.loadEmbeddingModel), and before
   this cache each instance loaded its own ONNX session (about 90 MB for
   MiniLM) that was never freed: 30 requests took the server to 3.7 GB and
   the OOM killer. */
const pipelines = new Map<string, Promise<FeatureExtractionPipeline>>();

class TransformerEmbedding extends BaseEmbedding<TransformerConfig> {
  constructor(protected config: TransformerConfig) {
    super(config);
  }

  async embedText(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    return this.embed(chunks.map((c) => c.content));
  }

  private async embed(texts: string[]) {
    let pipelinePromise = pipelines.get(this.config.model);

    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        const result = await pipeline('feature-extraction', this.config.model, {
          dtype: 'fp32',
        });
        return result as FeatureExtractionPipeline;
      })();
      pipelines.set(this.config.model, pipelinePromise);
      // A failed load is forgotten so the next request can try again.
      pipelinePromise.catch(() => pipelines.delete(this.config.model));
    }

    const pipe = await pipelinePromise;
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    return output.tolist() as number[][];
  }
}

export default TransformerEmbedding;
