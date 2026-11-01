import { internalLlmOf, ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import { getTokenCount } from '@/lib/utils/splitText';
import { Tracer, describeModel, redactSecrets } from '@/lib/trace';
import { startRequestTrace, traceAnswer, traceSources } from './trace';
import { formatSourcesForWriter } from '@/lib/evidence';
import { formatEvidenceNotes } from './gapCheck';
import { maybeStartPrefetch } from './prefetch';
import { getPrefetchSearch } from '@/lib/config/serverRegistry';

class APISearchAgent {
  /* Wraps the pipeline so the request trace is always finished, even when
     the pipeline throws. The error is re-thrown unchanged. */
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const tracer = startRequestTrace(session, input, 'api');

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

    // The classifier, planner, gap check and widgets use the internal
    // model when one is loaded; the writer always uses the chat model.
    const internalLlm = internalLlmOf(input.config);
    const internalModel = describeModel(internalLlm);

    const classifySpan = tracer.span('classify', { model: internalModel });

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: internalLlm,
    });

    /* Every classification field, including the M3 freshness, intent and
       entities (entities are recorded like search queries, in 'on' mode). */
    classifySpan.end({
      ...classification.classification,
      entityCount: classification.classification.entities.length,
      standaloneFollowUp: tracer.content(classification.standaloneFollowUp),
    });

    const widgetSpan = tracer.span('widgets', { model: internalModel });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: internalLlm,
    })
      .then((widgetOutputs) => {
        widgetSpan.end({
          count: widgetOutputs.length,
          types: widgetOutputs.map((o) => o.type),
        });
        return widgetOutputs;
      })
      .catch((err) => {
        console.error(`Error executing widgets: ${err}`);
        widgetSpan.end({ count: 0, error: String(err) });
        tracer.error('widgets', err);
        return [];
      });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      /* The researcher runs on its own session (as before); it shares this
         request's tracer so its spans land in the same trace line. */
      const researchSession = SessionManager.createSession();
      researchSession.trace = tracer;
      searchPromise = researcher.research(researchSession, {
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

    if (searchResults) {
      session.emit('data', {
        type: 'searchResults',
        data: searchResults.searchFindings,
      });
    }

    traceSources(tracer, searchResults?.searchFindings ?? []);

    session.emit('data', {
      type: 'researchComplete',
    });

    /* One <source index=N> per source with its <passage>s inside, so [N]
       keeps meaning "source N" (evidence.ts). */
    const finalContext = searchResults
      ? formatSourcesForWriter(searchResults.sources)
      : '';

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
      model: describeModel(input.config.llm),
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

    for await (const chunk of answerStream) {
      /* Trace only: copy the streamed text; the stream itself is untouched. */
      if (tracer.enabled) {
        timeToFirstChunkMs ??= Date.now() - writeStartedAt;
        answerText += chunk.contentChunk ?? '';
      }

      session.emit('data', {
        type: 'response',
        data: chunk.contentChunk,
      });
    }

    traceAnswer(tracer, writeSpan, {
      answer: answerText,
      writeStartedAt,
      timeToFirstChunkMs,
      sourceCount: searchResults?.searchFindings.length ?? 0,
    });

    session.emit('end', {});
  }
}

export default APISearchAgent;
