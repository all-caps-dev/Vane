// TypeScript: the uploads_search action. Finds passages in the user's uploaded files and puts them through the same rerank-and-select path as web pages (M2 evidence).
import z from 'zod';
import { ResearchAction } from '../../types';
import UploadStore from '@/lib/uploads/store';
import { Chunk } from '@/lib/types';
import { Evidence, uploadToEvidence } from '@/lib/evidence';
import {
  budgetFor,
  finishSelection,
  MAX_PER_SOURCE,
  PASSAGE_RERANK_TIMEOUT_MS,
  rerankEvidence,
} from '@/lib/evidence/pipeline';
import { getReranker } from '@/lib/rerank';
import { getEvidenceBudget } from '@/lib/config/serverRegistry';

// How many chunks the embedding search hands to the reranker. More than the
// budget, so the reranker has something to choose from.
const CANDIDATES = 30;

const schema = z.object({
  queries: z
    .array(z.string())
    .describe(
      'One to three queries to search the uploaded files with. Use one query for a simple question.',
    ),
});

// Query rules shared with academic and discussion search (M3).
const queryRules = `One query is enough for a simple question. Use two or three only when the question has separate parts, one query per part. Keep names, versions, error strings and identifiers exactly as the user wrote them, and never repeat a query that was already run.`;

const uploadsSearchAction: ResearchAction<typeof schema> = {
  name: 'uploads_search',
  enabled: (config) =>
    (config.classification.classification.personalSearch &&
      config.fileIds.length > 0) ||
    config.fileIds.length > 0,
  schema,
  getToolDescription: () =>
    `Search the user's uploaded files. ${queryRules} Use this every time it is present and the question is about the uploaded files.`,
  getDescription: () => `
  Use this tool to search the user's uploaded files when the answer may be in their documents. You will have to use this every single time if this is present and relevant.
  ${queryRules}
  Always ensure that the queries you use are directly relevant to the user's request and pertain to the content of their uploaded files.

  For example, if the user says "What does my lease say about subletting?", call this tool with one query: "subletting". If the user says "Compare the notice period and the deposit terms in my contract", use two queries: "notice period" and "deposit terms".
  Never use this tool to search the web or for information that is not contained within the user's uploaded files.
  `,
  execute: async (input, additionalConfig) => {
    input.queries = input.queries.slice(0, 3);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    );
    const research =
      researchBlock && researchBlock.type === 'research'
        ? researchBlock
        : undefined;

    const pushSubSteps = () => {
      if (!research) return;
      additionalConfig.session.updateBlock(additionalConfig.researchBlockId, [
        {
          op: 'replace',
          path: '/data/subSteps',
          value: research.data.subSteps,
        },
      ]);
    };

    if (research) {
      research.data.subSteps.push({
        id: crypto.randomUUID(),
        type: 'upload_searching',
        queries: input.queries,
      });
      pushSubSteps();
    }

    /* Per-request tracer; a no-op unless tracing is on. */
    const trace = additionalConfig.session.trace;

    const uploadStore = new UploadStore({
      embeddingModel: additionalConfig.embedding,
      fileIds: additionalConfig.fileIds,
    });

    // The store already ranked these by embedding similarity (fused over
    // the queries); each becomes one upload passage.
    const found = await uploadStore.query(input.queries, CANDIDATES);

    const pool: Evidence[] = [];
    const seen = new Set<string>();
    found.forEach((chunk, i) => {
      const meta = chunk.metadata ?? {};
      const fileId = String(
        meta.fileId ?? String(meta.url ?? '').replace(/^file_id:\/\//, ''),
      );
      const evidence = uploadToEvidence({
        fileId,
        // Older store records have no index; their position keeps ids unique.
        chunkIndex: typeof meta.chunkIndex === 'number' ? meta.chunkIndex : i,
        title: String(meta.title ?? meta.fileName ?? fileId),
        text: chunk.content,
        queries: input.queries,
        uploadedAt: meta.uploadedAt,
      });
      // The store can return the same chunk once per query.
      if (seen.has(evidence.chunkId)) return;
      seen.add(evidence.chunkId);
      pool.push(evidence);
    });

    let results: Chunk[] = [];

    if (pool.length > 0) {
      const reranker = await getReranker(additionalConfig.embedding, trace);
      const question =
        additionalConfig.question?.trim() || input.queries.join(' ');

      const ranked = await rerankEvidence({
        stage: 'uploads',
        items: pool,
        reranker,
        question,
        timeoutMs: PASSAGE_RERANK_TIMEOUT_MS,
        embedding: additionalConfig.embedding,
        trace,
      });

      const budget = budgetFor(additionalConfig.mode, getEvidenceBudget());
      const files = new Set(pool.map((e) => e.sourceId)).size;

      // The web cap of 4 passages per source would leave a single uploaded
      // file at 4 passages; share the budget between the files instead.
      results = finishSelection(
        ranked,
        budget,
        trace,
        (stats) => {
          if (!research) return;
          research.data.subSteps.push({
            id: crypto.randomUUID(),
            type: 'ranking',
            ...stats,
          });
          pushSubSteps();
        },
        {
          maxPerSource: Math.max(MAX_PER_SOURCE, Math.ceil(budget / files)),
        },
      );
    }

    if (research) {
      // The UI lists one card per file, with that file's kept passages.
      const perFile = new Map<string, Chunk>();
      results.forEach((chunk) => {
        const existing = perFile.get(chunk.metadata.url);
        if (existing) existing.content += `\n\n${chunk.content}`;
        else perFile.set(chunk.metadata.url, { ...chunk });
      });

      research.data.subSteps.push({
        id: crypto.randomUUID(),
        type: 'upload_search_results',
        results: [...perFile.values()],
      });
      pushSubSteps();
    }

    return {
      type: 'search_results',
      results,
    };
  },
};

export default uploadsSearchAction;
