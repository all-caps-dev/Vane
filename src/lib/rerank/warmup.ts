// TypeScript: loads the cross-encoder reranker in the background at server start, so the first search does not wait for it.

import { getRerankerKind, getRerankerModel } from '@/lib/config/serverRegistry';
import { getTransformersReranker } from './transformersReranker';

/*
  Called once from src/instrumentation.ts (Node runtime only). When the
  configured reranker is 'transformers', starts loading the model (download
  on first run, then ONNX init) and returns at once. Logs one line when the
  model is ready or failed. Never throws and never blocks startup: a failed
  warm-up only means the first search tries the load again, as before.
  Returns the load promise (already handled) so tests can wait on it.
*/
export const warmUpReranker = (): Promise<void> => {
  try {
    if (getRerankerKind() !== 'transformers') return Promise.resolve();

    const model = getRerankerModel();
    const startedAt = Date.now();

    return getTransformersReranker(model)
      .load()
      .then(
        (loaded) => {
          console.log(
            `Reranker ${model} (${loaded.dtype}) ready in ${Date.now() - startedAt} ms`,
          );
        },
        (err) => {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`Reranker ${model} warm-up failed: ${reason}`);
        },
      );
  } catch (err) {
    // Reading the config failed; leave it to the first search.
    console.warn('Reranker warm-up skipped:', err);
    return Promise.resolve();
  }
};
