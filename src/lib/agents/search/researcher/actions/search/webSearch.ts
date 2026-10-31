import z from 'zod';
import { ResearchAction } from '../../../types';
import { ResearchBlock } from '@/lib/types';
import { executeSearch } from './baseSearch';
import {
  MAX_QUERIES_PER_CALL,
  normalizePlannedQueries,
  plannedQuerySchema,
  timeRangeFor,
} from './queryPlan';

/* M3: each query carries the purpose it serves (see queryPlan.ts). The
   older plain-string shape is still accepted at execute time. */
export const webSearchSchema = z.object({
  type: z.literal('web_search'),
  queries: z
    .array(plannedQuerySchema)
    .describe(
      'One to three search queries, each with the purpose it serves. Use one query for a simple fact.',
    ),
});

// Planning rules shared by every mode.
const planningRules = `
How to plan queries (each query is { "query": "...", "purpose": "..." }):
- A simple fact needs ONE query. Use two or three only for a multipart or comparison question, and give each a different purpose.
- Purposes: "primary" (the direct answer), "official_docs" (the vendor, project or standards body), "issues" (bug trackers, known problems, error reports), "independent" (third-party reviews, tests, benchmarks), "recent" (news and recent changes), "comparison_side" (one side of a comparison; use one per side).
- Keep the entities listed in the user message exactly as written: product names, version numbers, error strings and standard identifiers. Do not round, expand or "fix" them.
- Add a year to a query only when the freshness in the user message is "recent" or "current".
- Never repeat a query listed under "Queries already run" in the user message; if you need more, search for what is still missing.
- Write queries as a person would type them into a search engine: the key terms, not a full sentence and not a list of SEO keywords.

Examples:
- "Which success criteria were added in WCAG 2.2?" -> [{ "query": "WCAG 2.2 new success criteria", "purpose": "primary" }]
- "Is Bun faster than Node for HTTP servers?" -> [{ "query": "Bun HTTP server benchmark", "purpose": "comparison_side" }, { "query": "Node.js HTTP server benchmark vs Bun", "purpose": "comparison_side" }, { "query": "Bun vs Node HTTP performance independent test", "purpose": "independent" }]
- "Docker says ERR_SSL_PROTOCOL_ERROR after the update" -> [{ "query": "Docker \\"ERR_SSL_PROTOCOL_ERROR\\" after update", "purpose": "issues" }, { "query": "Docker release notes TLS change", "purpose": "official_docs" }]
`;

const speedModePrompt = `
Use this tool to search the web. You are in speed mode: you can call this tool only ONCE, so plan the queries that answer the question in one go.
${planningRules}
If this tool is present and no other tools are more relevant, you MUST use this tool to get the needed information.
`;

const balancedModePrompt = `
Use this tool to search the web. You can call it more than once: after the first results, search again only for what is still missing.
${planningRules}
If this tool is present and no other tools are more relevant, you MUST use this tool to get the needed information.
`;

const qualityModePrompt = `
Use this tool to search the web. You can call it several times. Each later call should target what earlier results did not cover (official documentation, known issues, independent sources, recent changes) rather than rephrasing the same search.
${planningRules}
If this tool is present and no other tools are more relevant, you MUST use this tool to get the needed information.
`;

const webSearchAction: ResearchAction<typeof webSearchSchema> = {
  name: 'web_search',
  schema: webSearchSchema,
  getToolDescription: () =>
    `Search the web. Takes "queries": up to ${MAX_QUERIES_PER_CALL} objects { query, purpose }. One query for a simple fact; two or three, each with a different purpose, for multipart or comparison questions. Keep product names, versions and error strings verbatim.`,
  getDescription: (config) => {
    switch (config.mode) {
      case 'balanced':
        return balancedModePrompt;
      case 'quality':
        return qualityModePrompt;
      case 'speed':
      default:
        return speedModePrompt;
    }
  },
  enabled: (config) =>
    config.sources.includes('web') &&
    config.classification.classification.skipSearch === false,
  execute: async (input, additionalConfig) => {
    const planned = normalizePlannedQueries(input.queries);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    ) as ResearchBlock | undefined;

    if (!researchBlock) throw new Error('Failed to retrieve research block');

    // Narrow the search to the last year or month when the answer is
    // time-sensitive (classifier freshness).
    const timeRange = timeRangeFor(
      additionalConfig.classification?.classification.freshness,
    );

    additionalConfig.session.trace.event('search.plan', {
      queries: planned,
      timeRange,
    });

    const results = await executeSearch({
      llm: additionalConfig.llm,
      embedding: additionalConfig.embedding,
      mode: additionalConfig.mode,
      queries: planned.map((q) => q.query),
      researchBlock: researchBlock,
      session: additionalConfig.session,
      question: additionalConfig.question,
      searchConfig: timeRange ? { time_range: timeRange } : undefined,
    });

    return {
      type: 'search_results',
      results: results,
    };
  },
};

export default webSearchAction;
