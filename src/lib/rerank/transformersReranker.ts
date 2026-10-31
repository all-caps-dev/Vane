// TypeScript: in-process cross-encoder reranker on @huggingface/transformers (ONNX, CPU).

import {
  Reranker,
  RerankOptions,
  RerankPassage,
  RerankResult,
  RerankTimeoutError,
  sortAndCut,
  withTimeout,
} from './types';

export const BATCH_SIZE = 16;
export const MAX_LENGTH = 512;
// After a failed load, wait this long before trying to load again.
const RETRY_AFTER_MS = 5 * 60 * 1000;

type Loaded = { tokenizer: any; model: any; dtype: string };

/*
  Scores (query, passage) pairs with a cross-encoder such as
  Xenova/ms-marco-MiniLM-L-6-v2. The model is loaded lazily, once, the same
  way transformerEmbedding.ts loads its pipeline. Model calls run one at a
  time (a promise chain), so a 2-core box is never asked to run two
  inferences at once; other requests wait their turn.
*/
export class TransformersReranker implements Reranker {
  readonly name: string;
  private loading: Promise<Loaded> | null = null;
  private failedAt = 0;
  // The tail of the one-at-a-time queue.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly model: string,
    // Tried in order: q8 (model_quantized.onnx) is ~4x smaller and faster,
    // fp32 (model.onnx) is the fallback for models without q8 weights.
    private dtypes: string[] = ['q8', 'fp32'],
  ) {
    this.name = `transformers:${model}`;
  }

  // Loads tokenizer and model once. Rejects if neither dtype loads; a
  // failed load is retried at most every five minutes.
  load(): Promise<Loaded> {
    if (this.loading && this.failedAt === 0) return this.loading;
    if (this.loading && Date.now() - this.failedAt < RETRY_AFTER_MS)
      return this.loading;

    this.failedAt = 0;
    this.loading = (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification } =
        await import('@huggingface/transformers');
      const tokenizer = await AutoTokenizer.from_pretrained(this.model);

      let lastError: unknown;
      for (const dtype of this.dtypes) {
        try {
          const model =
            await AutoModelForSequenceClassification.from_pretrained(
              this.model,
              { dtype: dtype as any },
            );
          return { tokenizer, model, dtype };
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError ?? new Error(`could not load ${this.model}`);
    })();

    this.loading.catch(() => {
      this.failedAt = Date.now();
    });
    return this.loading;
  }

  async rerank(
    query: string,
    passages: RerankPassage[],
    opts: RerankOptions = {},
  ): Promise<RerankResult[]> {
    if (passages.length === 0) return [];

    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;

    const work = async (): Promise<RerankResult[]> => {
      const { tokenizer, model } = await this.load();

      // Similar lengths in one batch means less padding, so less work.
      const order = passages
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p.text.length - b.p.text.length);

      const scores = new Array<number>(passages.length);

      for (let start = 0; start < order.length; start += BATCH_SIZE) {
        // Stop early once the caller has given up, so the CPU is freed.
        if (Date.now() > deadline)
          throw new RerankTimeoutError(opts.timeoutMs ?? 0);

        const batch = order.slice(start, start + BATCH_SIZE);
        const inputs = tokenizer(
          batch.map(() => query),
          {
            text_pair: batch.map((b) => b.p.text),
            padding: true,
            truncation: true,
            max_length: MAX_LENGTH,
          },
        );
        const { logits } = await model(inputs);

        // logits is [batch, classes]. One class: that logit is the score.
        // Two or more: use the last (the "relevant" class).
        const classes: number = logits.dims?.[1] ?? 1;
        const data = logits.data as ArrayLike<number>;
        batch.forEach((b, row) => {
          scores[b.i] = Number(data[row * classes + (classes - 1)]);
        });
      }

      return sortAndCut(
        passages.map((p, i) => ({ id: p.id, score: scores[i] })),
        opts.topK,
      );
    };

    // Join the queue: run after whatever is already running.
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);

    return withTimeout(run, opts.timeoutMs);
  }
}

// One instance per model key, so each model is loaded once per process.
const instances = new Map<string, TransformersReranker>();

export const getTransformersReranker = (
  model: string,
): TransformersReranker => {
  let instance = instances.get(model);
  if (!instance) {
    instance = new TransformersReranker(model);
    instances.set(model, instance);
  }
  return instance;
};

export default TransformersReranker;
