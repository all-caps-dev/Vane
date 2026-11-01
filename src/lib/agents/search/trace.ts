// TypeScript: tracing helpers shared by the two search agents (index.ts and api.ts). Observe-only.

import SessionManager from '@/lib/session';
import { Tracer, TraceSpan, describeModel } from '@/lib/trace';
import { getTraceMode } from '@/lib/config/serverRegistry';
import { scanCitations } from '@/lib/utils/citations';
import { getTokenCount } from '@/lib/utils/splitText';
import { Chunk } from '@/lib/types';
import { SearchAgentInput } from './types';

// Creates the request's tracer, attaches it to the session, and records the
// request settings. Question text and chat history are kept only in 'full'.
export const startRequestTrace = (
  session: SessionManager,
  input: SearchAgentInput,
  agent: 'chat' | 'api',
): Tracer => {
  const tracer = Tracer.start(getTraceMode);
  session.trace = tracer;

  if (tracer.enabled) {
    try {
      tracer.annotate({ agent, mode: input.config.mode });
      tracer.event('request', {
        agent,
        mode: input.config.mode,
        sources: input.config.sources,
        fileCount: input.config.fileIds.length,
        historyMessages: input.chatHistory.length,
        questionChars: input.followUp.length,
        chatModel: describeModel(input.config.llm),
        // Serves the classifier, planner, gap check and widgets.
        internalModel: describeModel(
          input.config.internalLlm ?? input.config.llm,
        ),
        internalModelSource: input.config.internalLlm ? 'internal' : 'chat',
        embeddingModel: describeModel(input.config.embedding),
        question: tracer.content(input.followUp),
        chatHistory: tracer.content(input.chatHistory),
      });
      // A configured internal model that could not be used (the chat
      // model served instead). The setting text is a providerId:key.
      if (input.config.internalModelFallback) {
        tracer.event('internalModel.fallback', {
          ...input.config.internalModelFallback,
        });
      }
    } catch (err) {
      tracer.error('trace.request', err);
    }
  }

  return tracer;
};

// Records the final list of sources handed to the writer, numbered from 1
// the same way the writer prompt numbers them. Passage text only in 'full'.
export const traceSources = (tracer: Tracer, findings: Chunk[]): void => {
  if (!tracer.enabled) return;
  try {
    tracer.event('sources', {
      sources: findings.map((f, i) => ({
        index: i + 1,
        url: f.metadata?.url,
        title: f.metadata?.title,
        contentChars: f.content?.length ?? 0,
        content: tracer.content(f.content),
      })),
    });
    tracer.annotate({ sourceCount: findings.length });
  } catch (err) {
    tracer.error('trace.sources', err);
  }
};

// Closes the 'write' span and records citation stats for the final answer.
// The answer itself is read, never changed; its text is kept only in 'full'.
export const traceAnswer = (
  tracer: Tracer,
  writeSpan: TraceSpan,
  info: {
    answer: string;
    writeStartedAt: number;
    timeToFirstChunkMs?: number;
    sourceCount: number;
  },
): void => {
  if (!tracer.enabled) return;
  try {
    writeSpan.end({
      timeToFirstChunkMs: info.timeToFirstChunkMs,
      totalMs: Date.now() - info.writeStartedAt,
      answerChars: info.answer.length,
      answerTokens: getTokenCount(info.answer),
      answer: tracer.content(info.answer),
    });

    const stats = scanCitations(info.answer, info.sourceCount);
    tracer.event('citations', stats);
    tracer.annotate({
      sourceCount: info.sourceCount,
      citations: {
        count: stats.citationCount,
        unique: stats.uniqueCitations.length,
        maxIndex: stats.maxIndex,
        outOfRangeCount: stats.outOfRangeCount,
      },
    });
  } catch (err) {
    tracer.error('trace.answer', err);
  }
};
