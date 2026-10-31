// TypeScript: the one bounded evidence-gap round after research (M3). One LLM check, at most 2 extra queries, never repeated.
import z from 'zod';
import type BaseLLM from '@/lib/models/base/llm';
import type SessionManager from '@/lib/session';
import type { SearxngSearchOptions } from '@/lib/searxng';
import type { Chunk, ResearchBlock } from '@/lib/types';
import type { SourceGroup } from '@/lib/evidence';
import { gapCheckPrompt } from '@/lib/prompts/search/gapCheck';
import { getInternalThinking } from '@/lib/config/serverRegistry';
import { formatResearchDigest } from './researcher/context';
import {
  QUERY_PURPOSES,
  queryKey,
  timeRangeFor,
} from './researcher/actions/search/queryPlan';
import type {
  ClassifierOutput,
  EvidenceGap,
  EvidenceNotes,
  SearchAgentConfig,
} from './types';

// Skip the gap round when the research loop already took longer than this.
export const GAP_CHECK_BUDGET_MS = 60_000;
// Most gap queries run in the one follow-up search.
export const MAX_GAP_QUERIES = 2;

/* The check's answer. .catch() gives a usable fallback when a model leaves
   a field out, so a sloppy answer is "no gaps" rather than an error. */
export const gapCheckSchema = z.object({
  covered: z.boolean(),
  gaps: z
    .array(
      z.object({
        what: z.string(),
        query: z.string(),
        purpose: z.enum(QUERY_PURPOSES).catch('primary'),
      }),
    )
    .catch([]),
  conflicts: z.array(z.string()).catch([]),
});

export type GapSkipReason = 'mode' | 'time' | 'no_web';

/* Whether the gap round may run: balanced and quality only, web search
   enabled, and the research loop within the time budget. */
export const gapCheckSkipReason = (args: {
  mode: SearchAgentConfig['mode'];
  researchMs: number;
  webEnabled: boolean;
}): GapSkipReason | null => {
  if (args.mode === 'speed') return 'mode';
  if (!args.webEnabled) return 'no_web';
  if (args.researchMs > GAP_CHECK_BUDGET_MS) return 'time';
  return null;
};

/* The gap queries to run: non-blank, not already run this request, no
   repeats, at most MAX_GAP_QUERIES, in the order the check gave them. */
export const pickGapQueries = (
  gaps: EvidenceGap[],
  alreadyRun: string[],
): string[] => {
  const seen = new Set(alreadyRun.map(queryKey));
  const out: string[] = [];
  for (const gap of gaps) {
    const query = (gap.query ?? '').trim();
    const key = queryKey(query);
    if (!query || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
    if (out.length >= MAX_GAP_QUERIES) break;
  }
  return out;
};

// Runs a web search for the given queries and returns its passages. The
// researcher passes executeSearch bound to its session and research block.
export type GapSearch = (args: {
  queries: string[];
  searchConfig?: SearxngSearchOptions;
}) => Promise<Chunk[]>;

export type GapCheckResult = {
  // False when the round was skipped or the check failed.
  ran: boolean;
  skipped?: GapSkipReason;
  covered?: boolean;
  notes?: EvidenceNotes;
  queriesRun: string[];
  newResults: Chunk[];
};

/*
  The gap round:
  1. skip in speed mode, without web search, or after 60 s of research;
  2. ONE generateObject call over the compact digest of the sources;
  3. show a 'gap_check' step;
  4. if gaps were named, run at most 2 of their queries through ONE search
     (which shows its own 'searching' step) and return the new passages.
  Never recurses. A failing check or search is recorded and the request
  carries on with the evidence it already has.
*/
export const runGapCheck = async (args: {
  llm: BaseLLM<any>;
  session: SessionManager;
  researchBlock: ResearchBlock;
  mode: SearchAgentConfig['mode'];
  webEnabled: boolean;
  question: string;
  classification: ClassifierOutput;
  sources: SourceGroup[];
  alreadyRun: string[];
  researchMs: number;
  search: GapSearch;
}): Promise<GapCheckResult> => {
  const trace = args.session.trace;
  const startedAt = Date.now();

  const skipped = gapCheckSkipReason({
    mode: args.mode,
    researchMs: args.researchMs,
    webEnabled: args.webEnabled,
  });
  if (skipped) {
    trace.event('gap', { skipped, researchMs: args.researchMs });
    return { ran: false, skipped, queriesRun: [], newResults: [] };
  }

  const entities = args.classification.classification.entities ?? [];
  let check: z.infer<typeof gapCheckSchema>;

  try {
    // Parsed again here so an odd provider answer fails inside this try.
    const answer = await args.llm.generateObject<typeof gapCheckSchema>({
      schema: gapCheckSchema,
      // An internal call: may skip the model's thinking step (M4 setting).
      options: { thinking: getInternalThinking() },
      messages: [
        { role: 'system', content: gapCheckPrompt },
        {
          role: 'user',
          content: [
            `<question>${args.question}</question>`,
            `<entities>${entities.length > 0 ? entities.map((e) => `"${e}"`).join(', ') : '(none)'}</entities>`,
            `<freshness>${args.classification.classification.freshness ?? 'none'}</freshness>`,
            `<queries_already_run>\n${args.alreadyRun.join('\n') || '(none)'}\n</queries_already_run>`,
            `<evidence_digest>\n${args.sources.length > 0 ? formatResearchDigest(args.sources) : 'No sources were found.'}\n</evidence_digest>`,
          ].join('\n'),
        },
      ],
    });
    check = gapCheckSchema.parse(answer);
  } catch (err) {
    trace.error('gap check', err);
    trace.event('gap', {
      error: true,
      durationMs: Date.now() - startedAt,
    });
    return { ran: false, queriesRun: [], newResults: [] };
  }

  // A check that says "covered" has no gaps, whatever else it sent.
  const gaps: EvidenceGap[] = check.covered
    ? []
    : check.gaps.filter((g) => g && typeof g.what === 'string');
  const conflicts = check.conflicts.filter(
    (c) => typeof c === 'string' && c.trim().length > 0,
  );

  args.researchBlock.data.subSteps.push({
    id: crypto.randomUUID(),
    type: 'gap_check',
    covered: check.covered,
    gaps: gaps.map((g) => g.what),
  });
  args.session.updateBlock(args.researchBlock.id, [
    {
      op: 'replace',
      path: '/data/subSteps',
      value: args.researchBlock.data.subSteps,
    },
  ]);

  const queries = pickGapQueries(gaps, args.alreadyRun);
  let newResults: Chunk[] = [];

  if (queries.length > 0) {
    const timeRange = timeRangeFor(
      args.classification.classification.freshness,
    );
    try {
      newResults = await args.search({
        queries,
        searchConfig: timeRange ? { time_range: timeRange } : undefined,
      });
    } catch (err) {
      trace.error('gap search', err);
    }
  }

  return {
    ran: true,
    covered: check.covered,
    notes: { gaps, conflicts },
    queriesRun: queries,
    newResults,
  };
};

// Escapes text placed inside the writer's <evidence_notes> element.
const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* The writer's <evidence_notes> element, or '' when there is nothing to
   say. The gaps were found BEFORE the one follow-up search, so the writer
   is told to check whether the sources now cover them. */
export const formatEvidenceNotes = (notes?: EvidenceNotes): string => {
  if (!notes || (notes.gaps.length === 0 && notes.conflicts.length === 0))
    return '';
  const gaps = notes.gaps
    .map((g) => `<gap>${escapeText(g.what)}</gap>`)
    .join('\n');
  const conflicts = notes.conflicts
    .map((c) => `<conflict>${escapeText(c)}</conflict>`)
    .join('\n');
  return `<evidence_notes note="From a coverage check of the sources, run before one extra search. A gap may since be filled: check the sources. Not citable.">\n${[gaps, conflicts].filter(Boolean).join('\n')}\n</evidence_notes>`;
};
