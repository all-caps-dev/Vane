import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { TextBlock } from '@/lib/types';
import { getTokenCount } from '@/lib/utils/splitText';
import { sanitizeCitations } from '@/lib/utils/sanitizeCitations';
import { Tracer, redactSecrets } from '@/lib/trace';
import { startRequestTrace, traceAnswer, traceSources } from './trace';
import { formatSourcesForWriter } from '@/lib/evidence';
import { formatEvidenceNotes } from './gapCheck';
import { maybeStartPrefetch } from './prefetch';
import { getPrefetchSearch } from '@/lib/config/serverRegistry';

class SearchAgent {
  /* Wraps the pipeline so the request trace is always finished, even when
     the pipeline throws. The error is re-thrown unchanged. */
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const tracer = startRequestTrace(session, input, 'chat');

    try {
      await this.runSearch(session, input, tracer);
    } catch (err) {
      tracer.error('searchAsync', err);
      /* Tell the route so it can close the stream (it used to hang). The
         route forwards { data } to the client, so mask anything key-like. */
      session.emit('error', {
        data: redactSecrets(err instanceof Error ? err.message : String(err)),
      });
      throw err;
    } finally {
      void tracer.finish();
    }
  }

  private async runSearch(
    session: SessionManager,
    input: SearchAgentInput,
    tracer: Tracer,
  ) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.followUp,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

    // One SearXNG query for the raw question, run while the classifier
    // answers (prefetch.ts). Undefined when the switch is off or the
    // question looks like it will not be searched.
    const prefetch = maybeStartPrefetch({
      enabled: getPrefetchSearch(),
      followUp: input.followUp,
      history: input.chatHistory,
      sources: input.config.sources,
      trace: tracer,
    });

    const classifySpan = tracer.span('classify');

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    /* Every classification field, including the M3 freshness, intent and
       entities (entities are recorded like search queries, in 'on' mode). */
    classifySpan.end({
      ...classification.classification,
      entityCount: classification.classification.entities.length,
      standaloneFollowUp: tracer.content(classification.standaloneFollowUp),
    });

    const widgetSpan = tracer.span('widgets');

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).then((widgetOutputs) => {
      widgetSpan.end({
        count: widgetOutputs.length,
        types: widgetOutputs.map((o) => o.type),
      });

      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
        prefetch,
      });
    } else {
      prefetch?.discard('skip_search');
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    traceSources(tracer, searchResults?.searchFindings ?? []);

    session.emit('data', {
      type: 'researchComplete',
    });

    let finalContext =
      '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      /* One <source index=N> per source with its <passage>s inside, so [N]
         keeps meaning "source N" (evidence.ts). */
      finalContext = formatSourcesForWriter(searchResults.sources);
    }

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    /* What the gap round found missing or contradictory (M3); '' when the
       round did not run or found nothing. */
    const evidenceNotes = formatEvidenceNotes(searchResults?.evidenceNotes);

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>${evidenceNotes ? `\n${evidenceNotes}` : ''}\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
    );

    const writeStartedAt = Date.now();
    const writeSpan = tracer.span('write', {
      writerPromptTokens: tracer.enabled
        ? getTokenCount(writerPrompt)
        : undefined,
    });
    let answerText = '';
    let timeToFirstChunkMs: number | undefined;

    const answerStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
    });

    let responseBlockId = '';

    for await (const chunk of answerStream) {
      /* Trace only: copy the streamed text; the stream itself is untouched. */
      if (tracer.enabled) {
        timeToFirstChunkMs ??= Date.now() - writeStartedAt;
        answerText += chunk.contentChunk ?? '';
      }

      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
      } else {
        const block = session.getBlock(responseBlockId) as TextBlock | null;

        if (!block) {
          continue;
        }

        block.data += chunk.contentChunk;

        session.updateBlock(block.id, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      }
    }

    const sourceCount = searchResults?.searchFindings.length ?? 0;

    /* Trace the answer as the model wrote it, so citation stats still show
       how often the model cites a source that does not exist. */
    traceAnswer(tracer, writeSpan, {
      answer: answerText,
      writeStartedAt,
      timeToFirstChunkMs,
      sourceCount,
    });

    /* Remove [n] markers that point past the last source, with one final
       patch, before 'end' so the UI and the stored blocks get clean text. */
    const responseBlock = responseBlockId
      ? (session.getBlock(responseBlockId) as TextBlock | undefined)
      : undefined;

    if (responseBlock) {
      const { text, removed } = sanitizeCitations(
        responseBlock.data,
        sourceCount,
      );

      if (removed.length > 0) {
        session.updateBlock(responseBlockId, [
          { op: 'replace', path: '/data', value: text },
        ]);
        tracer.event('citations.removed', { removed, sourceCount });
        tracer.annotate({ citationsRemoved: removed.length });
      }
    }

    session.emit('end', {});

    await db
      .update(messages)
      .set({
        status: 'completed',
        responseBlocks: session.getAllBlocks(),
      })
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      )
      .execute();
  }
}

export default SearchAgent;
