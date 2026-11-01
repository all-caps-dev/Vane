import {
  ActionOutput,
  EvidenceNotes,
  ResearcherInput,
  ResearcherOutput,
} from '../types';
import { ActionRegistry } from './actions';
import { getResearcherPrompt } from '@/lib/prompts/search/researcher';
import SessionManager from '@/lib/session';
import { getInternalThinking } from '@/lib/config/serverRegistry';
import {
  Chunk,
  Message,
  ReasoningResearchBlock,
  ResearchBlock,
} from '@/lib/types';
import { ToolCall } from '@/lib/models/types';
import { groupBySource, sourceCard, SourceGroup } from '@/lib/evidence';
import { buildResearcherUserMessage, formatResearchDigest } from './context';
import { queryKey, queryTexts } from './actions/search/queryPlan';
import { executeSearch } from './actions/search/baseSearch';
import { runGapCheck } from '../gapCheck';

/*
  What the researcher LLM gets back for one tool call (M3): a compact digest
  for search results, numbered with the source numbers the writer will use,
  instead of every passage. Other actions (reasoning, done) are tiny and
  stay as JSON.
*/
const toolResultContent = (
  action: ActionOutput,
  allResults: Chunk[],
): string => {
  if (action.type !== 'search_results') return JSON.stringify(action);
  if (action.results.length === 0)
    return 'No results.\nselected 0 passages from 0 sources';

  // Number each source as the final source list will: by first appearance
  // across every search so far (groupBySource over all results).
  const globalIndex = new Map(
    groupBySource(allResults).map((g) => [g.sourceId, g.index]),
  );
  const groups: SourceGroup[] = groupBySource(action.results).map((g) => ({
    ...g,
    index: globalIndex.get(g.sourceId) ?? g.index,
  }));
  return formatResearchDigest(groups);
};

class Researcher {
  async research(
    session: SessionManager,
    input: ResearcherInput,
  ): Promise<ResearcherOutput> {
    let actionOutput: ActionOutput[] = [];
    let maxIteration =
      input.config.mode === 'speed'
        ? 2
        : input.config.mode === 'balanced'
          ? 6
          : 25;

    const availableTools = ActionRegistry.getAvailableActionTools({
      classification: input.classification,
      fileIds: input.config.fileIds,
      mode: input.config.mode,
      sources: input.config.sources,
    });

    const availableActionsDescription =
      ActionRegistry.getAvailableActionsDescriptions({
        classification: input.classification,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
        sources: input.config.sources,
      });

    /* Per-request tracer; a no-op unless tracing is on. */
    const trace = session.trace;
    const researchSpan = trace.span('research', {
      maxIteration,
      tools: availableTools.map((t) => t.name),
    });
    let iterationsRun = 0;
    const researchStartedAt = Date.now();
    // Every query run this request, in order, without repeats (M3). Shown
    // to the researcher each iteration and to the gap check.
    const queriesRun: string[] = [];
    const rememberQueries = (queries: string[]) => {
      for (const q of queries) {
        if (!queriesRun.some((r) => queryKey(r) === queryKey(q)))
          queriesRun.push(q);
      }
    };

    const researchBlockId = crypto.randomUUID();

    session.emitBlock({
      id: researchBlockId,
      type: 'research',
      data: {
        subSteps: [],
      },
    });

    // The first message is the user message; it is rebuilt every iteration
    // so its list of queries already run is current.
    const userMessage = (): Message => ({
      role: 'user',
      content: buildResearcherUserMessage({
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: input.classification,
        queriesRun,
      }),
    });

    const agentMessageHistory: Message[] = [userMessage()];

    for (let i = 0; i < maxIteration; i++) {
      agentMessageHistory[0] = userMessage();

      const researcherPrompt = getResearcherPrompt(
        availableActionsDescription,
        input.config.mode,
        i,
        maxIteration,
        input.config.fileIds,
      );

      iterationsRun = i + 1;
      const llmStartedAt = Date.now();

      const actionStream = input.config.llm.streamText({
        messages: [
          {
            role: 'system',
            content: researcherPrompt,
          },
          ...agentMessageHistory,
        ],
        tools: availableTools,
        // The tool-calling planner is internal; the writer's call is not touched.
        options: { thinking: getInternalThinking() },
      });

      const block = session.getBlock(researchBlockId);

      let reasoningEmitted = false;
      let reasoningId = crypto.randomUUID();

      let finalToolCalls: ToolCall[] = [];

      for await (const partialRes of actionStream) {
        if (partialRes.toolCallChunk.length > 0) {
          partialRes.toolCallChunk.forEach((tc) => {
            if (
              tc.name === '__reasoning_preamble' &&
              tc.arguments['plan'] &&
              !reasoningEmitted &&
              block &&
              block.type === 'research'
            ) {
              reasoningEmitted = true;

              block.data.subSteps.push({
                id: reasoningId,
                type: 'reasoning',
                reasoning: tc.arguments['plan'],
              });

              session.updateBlock(researchBlockId, [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: block.data.subSteps,
                },
              ]);
            } else if (
              tc.name === '__reasoning_preamble' &&
              tc.arguments['plan'] &&
              reasoningEmitted &&
              block &&
              block.type === 'research'
            ) {
              const subStepIndex = block.data.subSteps.findIndex(
                (step: any) => step.id === reasoningId,
              );

              if (subStepIndex !== -1) {
                const subStep = block.data.subSteps[
                  subStepIndex
                ] as ReasoningResearchBlock;
                subStep.reasoning = tc.arguments['plan'];
                session.updateBlock(researchBlockId, [
                  {
                    op: 'replace',
                    path: '/data/subSteps',
                    value: block.data.subSteps,
                  },
                ]);
              }
            }

            const existingIndex = finalToolCalls.findIndex(
              (ftc) => ftc.id === tc.id,
            );

            if (existingIndex !== -1) {
              finalToolCalls[existingIndex].arguments = tc.arguments;
            } else {
              finalToolCalls.push(tc);
            }
          });
        }
      }

      trace.event('research.iteration', {
        iteration: i,
        tools: finalToolCalls.map((tc) => tc.name),
        llmMs: Date.now() - llmStartedAt,
      });

      if (finalToolCalls.length === 0) {
        break;
      }

      if (finalToolCalls[finalToolCalls.length - 1].name === 'done') {
        break;
      }

      agentMessageHistory.push({
        role: 'assistant',
        content: '',
        tool_calls: finalToolCalls,
      });

      const actionsStartedAt = Date.now();

      const actionResults = await ActionRegistry.executeAll(finalToolCalls, {
        llm: input.config.llm,
        embedding: input.config.embedding,
        session: session,
        researchBlockId: researchBlockId,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
        question: input.classification.standaloneFollowUp || input.followUp,
        classification: input.classification,
      });

      actionOutput.push(...actionResults);
      finalToolCalls.forEach((tc) => rememberQueries(queryTexts(tc.arguments)));

      trace.event('research.actions', {
        iteration: i,
        durationMs: Date.now() - actionsStartedAt,
        outputCount: actionResults.length,
      });

      // Compact digests, not passages, so the researcher's context does not
      // grow by whole passages every iteration (M3).
      const allResults = actionOutput
        .filter((a) => a.type === 'search_results')
        .flatMap((a) => a.results);

      actionResults.forEach((action, i) => {
        agentMessageHistory.push({
          role: 'tool',
          id: finalToolCalls[i].id,
          name: finalToolCalls[i].name,
          content: toolResultContent(action, allResults),
        });
      });
    }

    const loopMs = Date.now() - researchStartedAt;
    const collectResults = () =>
      actionOutput
        .filter((a) => a.type === 'search_results')
        .flatMap((a) => a.results);

    /* ---- One bounded evidence-gap round (M3, balanced and quality) ---- */

    let evidenceNotes: EvidenceNotes | undefined;
    const researchBlock = session.getBlock(researchBlockId) as
      | ResearchBlock
      | undefined;

    if (researchBlock && researchBlock.type === 'research') {
      const question =
        input.classification.standaloneFollowUp || input.followUp;
      const sourcesBefore = groupBySource(collectResults());

      const gap = await runGapCheck({
        llm: input.config.llm,
        session,
        researchBlock,
        mode: input.config.mode,
        webEnabled:
          input.config.sources.includes('web') &&
          !input.classification.classification.skipSearch,
        question,
        classification: input.classification,
        sources: sourcesBefore,
        alreadyRun: queriesRun,
        researchMs: loopMs,
        // The same search path as web_search, on the same research block,
        // so the UI shows the 'searching' step.
        search: ({ queries, searchConfig }) =>
          executeSearch({
            llm: input.config.llm,
            embedding: input.config.embedding,
            mode: input.config.mode,
            queries,
            researchBlock,
            session,
            question,
            searchConfig,
          }),
      });

      if (gap.ran) {
        if (gap.newResults.length > 0) {
          actionOutput.push({
            type: 'search_results',
            results: gap.newResults,
          });
        }
        rememberQueries(gap.queriesRun);
        evidenceNotes = gap.notes;

        trace.event('gap', {
          covered: gap.covered,
          gapCount: gap.notes?.gaps.length ?? 0,
          conflictCount: gap.notes?.conflicts.length ?? 0,
          queriesRun: gap.queriesRun,
          newSources:
            groupBySource(collectResults()).length - sourcesBefore.length,
          durationMs: Date.now() - researchStartedAt - loopMs,
        });
      }
    }

    const searchResults = collectResults();

    /* Group passages into sources (evidence.ts). The same chunkId from two
       search actions is one passage; different chunks of one page stay
       separate passages under one source. Sources are keyed by normalised
       URL (no tracking params or fragment, http = https, no trailing
       slash); metadata.url keeps the original link for display. */
    const sources = groupBySource(searchResults);
    const sourceCards = sources.map(sourceCard);

    trace.event('dedup', {
      stage: 'source',
      before: searchResults.length,
      passages: sources.reduce((n, s) => n + s.passages.length, 0),
      after: sources.length,
    });

    researchSpan.end({
      iterations: iterationsRun,
      findingsCount: actionOutput.length,
      sourceCount: sources.length,
      // The loop alone, without the gap round (the gap budget uses this).
      loopMs,
      queriesRun: queriesRun.length,
    });

    /* One entry per source, so the UI cards show pages, not passages. */
    session.emitBlock({
      id: crypto.randomUUID(),
      type: 'source',
      data: sourceCards,
    });

    return {
      findings: actionOutput,
      searchFindings: sourceCards,
      sources,
      ...(evidenceNotes ? { evidenceNotes } : {}),
    };
  }
}

export default Researcher;
