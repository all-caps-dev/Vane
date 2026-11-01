// TypeScript: unit tests for the Researcher loop's budgets and gap rounds. The LLM, actions and gap check are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeAll, runGapCheck } = vi.hoisted(() => ({
  executeAll: vi.fn(),
  runGapCheck: vi.fn(),
}));

vi.mock('@/lib/agents/search/researcher/actions', () => ({
  ActionRegistry: {
    getAvailableActionTools: () => [{ name: 'web_search' }],
    getAvailableActionsDescriptions: () => '',
    executeAll,
  },
}));
vi.mock('@/lib/prompts/search/researcher', () => ({
  getResearcherPrompt: () => 'prompt',
}));
vi.mock('@/lib/config/serverRegistry', () => ({
  getInternalThinking: () => 'default',
}));
vi.mock('@/lib/agents/search/researcher/actions/search/baseSearch', () => ({
  executeSearch: vi.fn(async () => []),
}));
vi.mock('@/lib/agents/search/gapCheck', () => ({ runGapCheck }));

import Researcher from '@/lib/agents/search/researcher';
import { Tracer } from '@/lib/trace';

// One search result on its own page, so every call adds a new source.
let pageCounter = 0;
const newResult = () => {
  pageCounter++;
  return {
    content: `passage ${pageCounter}`,
    metadata: {
      url: `https://p${pageCounter}.test/`,
      title: `Page ${pageCounter}`,
    },
  };
};

// A minimal session: blocks in a map, a real tracer with a spied event().
const fakeSession = () => {
  const blocks = new Map<string, any>();
  const trace = new Tracer('on');
  const eventSpy = vi.spyOn(trace, 'event');
  const session: any = {
    trace,
    emitBlock: (b: any) => blocks.set(b.id, b),
    getBlock: (id: string) => blocks.get(id),
    updateBlock: () => undefined,
  };
  return { session, eventSpy };
};

// An LLM whose every planning turn calls web_search, or done when told.
const fakeLlm = (turn: (i: number) => string) => {
  let i = 0;
  const streamText = vi.fn(() => {
    const name = turn(i);
    const id = `call-${i++}`;
    return (async function* () {
      yield {
        toolCallChunk: [{ id, name, arguments: { queries: [`q ${id}`] } }],
      };
    })();
  });
  return { streamText } as any;
};

const input = (
  mode: 'speed' | 'balanced' | 'quality',
  llm: any,
  sources = ['web'],
) =>
  ({
    chatHistory: [],
    followUp: 'question',
    classification: {
      classification: { skipSearch: false, entities: [] },
      standaloneFollowUp: 'question',
    },
    config: {
      mode,
      llm,
      embedding: {},
      fileIds: [],
      sources,
    },
  }) as any;

const exhaustedBudgets = (eventSpy: ReturnType<typeof vi.spyOn>) =>
  eventSpy.mock.calls
    .filter((c: any[]) => c[0] === 'budget.exhausted')
    .map((c: any[]) => c[1].budget);

beforeEach(() => {
  executeAll.mockReset();
  runGapCheck.mockReset();
  runGapCheck.mockResolvedValue({ ran: false, queriesRun: [], newResults: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Researcher budgets', () => {
  it('stops the loop when maxResearchMs is spent and still runs the gap round', async () => {
    // A clock that moves 100 s per round of actions; quality allows 180 s.
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    executeAll.mockImplementation(async (calls: any[]) => {
      clock += 100_000;
      return calls.map(() => ({
        type: 'search_results',
        results: [newResult()],
      }));
    });
    const llm = fakeLlm(() => 'web_search');
    const { session, eventSpy } = fakeSession();

    const out = await new Researcher().research(session, input('quality', llm));

    // Iteration 1 at 0 s, iteration 2 at 100 s, then 200 s >= 180 s: stop.
    expect(llm.streamText).toHaveBeenCalledTimes(2);
    expect(exhaustedBudgets(eventSpy)).toContain('maxResearchMs');
    expect(runGapCheck).toHaveBeenCalledTimes(1);
    expect(out.sources).toHaveLength(2);
    expect(session.budget).toBeDefined();
  });

  it('stops the loop when the search calls are spent', async () => {
    // Each action takes a search call, as executeSearch does.
    executeAll.mockImplementation(async (calls: any[], cfg: any) =>
      calls.map(() => {
        cfg.session.budget.take('maxSearchCalls');
        return { type: 'search_results', results: [newResult()] };
      }),
    );
    const llm = fakeLlm(() => 'web_search');
    const { session, eventSpy } = fakeSession();

    await new Researcher().research(session, input('balanced', llm));

    // Balanced: 4 search calls, 6 iterations; the loop ends after the 4th.
    expect(llm.streamText).toHaveBeenCalledTimes(4);
    expect(exhaustedBudgets(eventSpy)).toContain('maxSearchCalls');
  });

  it('caps quality at 6 iterations', async () => {
    executeAll.mockImplementation(async (calls: any[]) =>
      calls.map(() => ({ type: 'search_results', results: [] })),
    );
    // Uploads only: no search calls are taken, so only maxIteration stops it.
    const llm = fakeLlm(() => 'uploads_search');
    const { session } = fakeSession();

    await new Researcher().research(session, input('quality', llm, []));

    expect(llm.streamText).toHaveBeenCalledTimes(6);
  });
});

describe('Researcher gap rounds', () => {
  // A gap round that names a gap and brings one new source.
  const gapWithNewSource = async () => ({
    ran: true,
    covered: false,
    notes: {
      gaps: [{ what: 'missing', query: 'q', purpose: 'primary' }],
      conflicts: [],
    },
    queriesRun: [`gap ${pageCounter}`],
    newResults: [newResult()],
  });

  const doneAtOnce = () => fakeLlm(() => 'done');

  it('runs at most twice in quality mode', async () => {
    runGapCheck.mockImplementation(gapWithNewSource);
    const { session } = fakeSession();

    await new Researcher().research(session, input('quality', doneAtOnce()));

    expect(runGapCheck).toHaveBeenCalledTimes(2);
    // The second round sees the first round's query as already run.
    const secondArgs = runGapCheck.mock.calls[1][0];
    expect(
      secondArgs.alreadyRun.some((q: string) => q.startsWith('gap ')),
    ).toBe(true);
    // ...and the sources the first round added.
    expect(secondArgs.sources.length).toBe(
      runGapCheck.mock.calls[0][0].sources.length + 1,
    );
  });

  it('runs once in balanced mode', async () => {
    runGapCheck.mockImplementation(gapWithNewSource);
    const { session } = fakeSession();

    await new Researcher().research(session, input('balanced', doneAtOnce()));

    expect(runGapCheck).toHaveBeenCalledTimes(1);
  });

  it('skips the second quality round when the first found no gaps', async () => {
    runGapCheck.mockResolvedValue({
      ran: true,
      covered: true,
      notes: { gaps: [], conflicts: [] },
      queriesRun: [],
      newResults: [],
    });
    const { session } = fakeSession();

    await new Researcher().research(session, input('quality', doneAtOnce()));

    expect(runGapCheck).toHaveBeenCalledTimes(1);
  });

  it('skips the second quality round when no new sources arrived', async () => {
    runGapCheck.mockResolvedValue({
      ran: true,
      covered: false,
      notes: {
        gaps: [{ what: 'missing', query: 'q', purpose: 'primary' }],
        conflicts: [],
      },
      queriesRun: ['q'],
      newResults: [],
    });
    const { session } = fakeSession();

    await new Researcher().research(session, input('quality', doneAtOnce()));

    expect(runGapCheck).toHaveBeenCalledTimes(1);
  });

  it('gap searches do not take from maxSearchCalls', async () => {
    runGapCheck.mockImplementation(async (args: any) => {
      await args.search({ queries: ['g'] });
      return { ran: false, queriesRun: [], newResults: [] };
    });
    const { executeSearch } =
      await import('@/lib/agents/search/researcher/actions/search/baseSearch');
    const { session } = fakeSession();

    await new Researcher().research(session, input('balanced', doneAtOnce()));

    expect(vi.mocked(executeSearch).mock.calls[0][0]).toMatchObject({
      countsAsSearchCall: false,
    });
  });
});
