// TypeScript: unit tests for the one bounded evidence-gap round (M3) with a mocked LLM and search.
import { describe, expect, it, vi } from 'vitest';

// The real registry would read and write data/config.json.
vi.mock('@/lib/config/serverRegistry', () => ({
  getInternalThinking: () => 'default',
}));
import {
  formatEvidenceNotes,
  GAP_CHECK_BUDGET_MS,
  gapCheckSchema,
  pickGapQueries,
  runGapCheck,
} from '@/lib/agents/search/gapCheck';
import { Tracer } from '@/lib/trace';
import type { ResearchBlock } from '@/lib/types';
import type { ClassifierOutput } from '@/lib/agents/search/types';

const classification: ClassifierOutput = {
  classification: {
    skipSearch: false,
    personalSearch: false,
    academicSearch: false,
    discussionSearch: false,
    showWeatherWidget: false,
    showStockWidget: false,
    showCalculationWidget: false,
    freshness: 'current',
    entities: ['Proxmox VE 12'],
    intent: 'fact',
  },
  standaloneFollowUp: 'What are the features of Proxmox VE 12?',
};

// Runs the gap round with a fake LLM answer and a fake search.
const setup = (
  answer: unknown,
  opts: {
    mode?: 'speed' | 'balanced' | 'quality';
    researchMs?: number;
    alreadyRun?: string[];
    webEnabled?: boolean;
  } = {},
) => {
  const trace = new Tracer('on');
  const eventSpy = vi.spyOn(trace, 'event');
  const llm = { generateObject: vi.fn(async () => answer) };
  const search = vi.fn(async (_args: { queries: string[] }) => [
    { content: 'new', metadata: { url: 'https://new.test/' } },
  ]);
  const researchBlock: ResearchBlock = {
    id: 'r',
    type: 'research',
    data: { subSteps: [] },
  };
  const promise = runGapCheck({
    llm: llm as any,
    session: { trace, updateBlock: vi.fn() } as any,
    researchBlock,
    mode: opts.mode ?? 'balanced',
    webEnabled: opts.webEnabled ?? true,
    question: classification.standaloneFollowUp,
    classification,
    sources: [],
    alreadyRun: opts.alreadyRun ?? [],
    researchMs: opts.researchMs ?? 1000,
    search,
  });
  return { promise, llm, search, researchBlock, eventSpy };
};

describe('runGapCheck', () => {
  it('covered: makes one check and no search', async () => {
    const { promise, llm, search, researchBlock } = setup({
      covered: true,
      gaps: [{ what: 'ignored', query: 'ignored', purpose: 'primary' }],
      conflicts: [],
    });
    const out = await promise;
    expect(llm.generateObject).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ran: true, covered: true, queriesRun: [] });
    expect(out.notes?.gaps).toEqual([]);
    expect(researchBlock.data.subSteps).toEqual([
      expect.objectContaining({ type: 'gap_check', covered: true, gaps: [] }),
    ]);
  });

  it('gaps: runs at most 2 queries in one search, skipping ones already run', async () => {
    const { promise, search, researchBlock } = setup(
      {
        covered: false,
        gaps: [
          {
            what: 'release notes',
            query: 'Proxmox VE 12 release notes',
            purpose: 'official_docs',
          },
          { what: 'dup', query: 'proxmox ve 12  ROADMAP', purpose: 'recent' },
          {
            what: 'existence',
            query: 'Proxmox VE 12 announcement',
            purpose: 'recent',
          },
          {
            what: 'issues',
            query: 'Proxmox VE 12 known issues',
            purpose: 'issues',
          },
        ],
        conflicts: ['[1] says 2026, [2] says 2027'],
      },
      { alreadyRun: ['Proxmox VE 12 roadmap'] },
    );
    const out = await promise;
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toEqual({
      queries: ['Proxmox VE 12 release notes', 'Proxmox VE 12 announcement'],
      // freshness 'current' narrows to the last month
      searchConfig: { time_range: 'month' },
    });
    expect(out.queriesRun).toHaveLength(2);
    expect(out.newResults).toHaveLength(1);
    expect(out.notes?.gaps).toHaveLength(4);
    expect(out.notes?.conflicts).toEqual(['[1] says 2026, [2] says 2027']);
    const step = researchBlock.data.subSteps[0];
    expect(step.type).toBe('gap_check');
    if (step.type === 'gap_check') expect(step.gaps).toHaveLength(4);
  });

  it('over time: skipped without calling the LLM', async () => {
    const { promise, llm, search, researchBlock, eventSpy } = setup(
      { covered: false, gaps: [], conflicts: [] },
      { researchMs: GAP_CHECK_BUDGET_MS + 1 },
    );
    const out = await promise;
    expect(out).toMatchObject({ ran: false, skipped: 'time' });
    expect(llm.generateObject).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(researchBlock.data.subSteps).toEqual([]);
    expect(eventSpy).toHaveBeenCalledWith(
      'gap',
      expect.objectContaining({ skipped: 'time' }),
    );
  });

  it('speed mode and web off: skipped', async () => {
    const speed = setup({ covered: true }, { mode: 'speed' });
    expect(await speed.promise).toMatchObject({ ran: false, skipped: 'mode' });
    expect(speed.llm.generateObject).not.toHaveBeenCalled();

    const noWeb = setup({ covered: true }, { webEnabled: false });
    expect(await noWeb.promise).toMatchObject({
      ran: false,
      skipped: 'no_web',
    });
  });

  it('a failing check is recorded and the request carries on', async () => {
    // An answer that does not fit the schema counts as a failed check.
    const { promise, search, researchBlock } = setup(undefined);
    const out = await promise;
    expect(out).toMatchObject({ ran: false, queriesRun: [], newResults: [] });
    expect(search).not.toHaveBeenCalled();
    expect(researchBlock.data.subSteps).toEqual([]);
  });
});

describe('gap helpers', () => {
  it('gapCheckSchema falls back when fields are missing', () => {
    expect(gapCheckSchema.parse({ covered: true })).toEqual({
      covered: true,
      gaps: [],
      conflicts: [],
    });
  });

  it('pickGapQueries drops blanks and repeats', () => {
    expect(
      pickGapQueries(
        [
          { what: 'a', query: ' ', purpose: 'primary' },
          { what: 'b', query: 'B', purpose: 'primary' },
          { what: 'c', query: 'b', purpose: 'primary' },
        ],
        [],
      ),
    ).toEqual(['B']);
  });

  it('formatEvidenceNotes escapes text and is empty with nothing to say', () => {
    expect(formatEvidenceNotes(undefined)).toBe('');
    expect(formatEvidenceNotes({ gaps: [], conflicts: [] })).toBe('');
    const out = formatEvidenceNotes({
      gaps: [{ what: 'no <source> for X', query: 'x', purpose: 'primary' }],
      conflicts: ['[1] vs [2]'],
    });
    expect(out).toContain('<gap>no &lt;source&gt; for X</gap>');
    expect(out).toContain('<conflict>[1] vs [2]</conflict>');
    expect(out.startsWith('<evidence_notes')).toBe(true);
  });
});
