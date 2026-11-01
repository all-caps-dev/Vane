import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import { getTokenCount } from '@/lib/utils/splitText';
import { Tracer, redactSecrets } from '@/lib/trace';
import { startRequestTrace, traceAnswer, traceSources } from './trace';

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
    const classifySpan = tracer.span('classify');

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    classifySpan.end({
      ...classification.classification,
      standaloneFollowUp: tracer.content(classification.standaloneFollowUp),
    });

    const widgetSpan = tracer.span('widgets');

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
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
      });
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

    const finalContext =
      searchResults?.searchFindings
        .map(
          (f, index) =>
            `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
        )
        .join('\n') || '';

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

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
