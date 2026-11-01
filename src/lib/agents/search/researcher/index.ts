import {
  ActionOutput,
  EvidenceNotes,
  internalLlmOf,
  ResearcherInput,
  ResearcherOutput,
} from '../types';
import { describeModel } from '@/lib/trace';
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
import { MAX_GAP_ROUNDS, MAX_ITERATIONS, RequestBudget } from '../budgets';

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
    const maxIteration = MAX_ITERATIONS[input.config.mode] ?? 2;

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
    /* Per-request budgets (budgets.ts), on the session next to the tracer
       so executeSearch and the scraper take from the same counters. */
    const budget = RequestBudget.forMode(input.config.mode, trace);
    session.budget = budget;
    // The tool-calling planner and the gap check use the internal model;
    // the searches themselves (and the legacy picker) keep the chat model.
    const plannerLlm = internalLlmOf(input.config);
    const researchSpan = trace.span('research', {
      model: describeModel(plannerLlm),
      maxIteration,
      tools: availableTools.map((t) => t.name),
      budget: budget.limits,
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

    // Why the loop ended early because of a budget, if it did.
    let stoppedBy: 'maxResearchMs' | 'maxSearchCalls' | undefined;

    for (let i = 0; i < maxIteration; i++) {
      // Out of research time: go to the gap round and the writer with what
      // has been found so far.
      if (budget.timeExceeded()) {
        stoppedBy = 'maxResearchMs';
        budget.markExhausted('maxResearchMs');
        break;
      }

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

      const actionStream = plannerLlm.streamText({
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
        prefetch: input.prefetch,
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

      // Every search call is spent: another planning turn could not search.
      if (budget.remaining('maxSearchCalls') === 0) {
        stoppedBy = 'maxSearchCalls';
        budget.markExhausted('maxSearchCalls');
        break;
      }
    }

    const loopMs = Date.now() - researchStartedAt;
    // The loop never ran a web_search: the prefetched result goes unused.
    input.prefetch?.discard('no_web_search');
    const collectResults = () =>
      actionOutput
        .filter((a) => a.type === 'search_results')
        .flatMap((a) => a.results);

    /* ---- Bounded evidence-gap rounds (M3): one in balanced, at most two
       in quality. The second runs only when the first named gaps, its
       search brought new sources, and research time is left. Gap searches
       do not take from maxSearchCalls but do take from the fetch budgets. */

    let evidenceNotes: EvidenceNotes | undefined;
    const researchBlock = session.getBlock(researchBlockId) as
      | ResearchBlock
      | undefined;
    const maxGapRounds = MAX_GAP_ROUNDS[input.config.mode] ?? 1;

    if (researchBlock && researchBlock.type === 'research') {
      const question =
        input.classification.standaloneFollowUp || input.followUp;

      for (let round = 1; round <= Math.max(1, maxGapRounds); round++) {
        const sourcesBefore = groupBySource(collectResults());
        const roundStartedAt = Date.now();

        const gap = await runGapCheck({
          llm: plannerLlm,
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
              countsAsSearchCall: false,
              // Gap queries are web searches: the same source priors apply.
              sourceContext: {
                entities: input.classification.classification.entities ?? [],
                intent: input.classification.classification.intent ?? 'other',
              },
            }),
        });

        if (!gap.ran) break;

        if (gap.newResults.length > 0) {
          actionOutput.push({
            type: 'search_results',
            results: gap.newResults,
          });
        }
        rememberQueries(gap.queriesRun);
        // The latest round saw every source so far, so its notes win.
        evidenceNotes = gap.notes;

        const newSources =
          groupBySource(collectResults()).length - sourcesBefore.length;

        trace.event('gap', {
          round,
          covered: gap.covered,
          gapCount: gap.notes?.gaps.length ?? 0,
          conflictCount: gap.notes?.conflicts.length ?? 0,
          queriesRun: gap.queriesRun,
          newSources,
          durationMs: Date.now() - roundStartedAt,
        });

        const foundGaps = (gap.notes?.gaps.length ?? 0) > 0;
        if (!foundGaps || newSources <= 0 || budget.timeExceeded()) break;
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
      stoppedBy,
      budgetUsed: budget.usage(),
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
