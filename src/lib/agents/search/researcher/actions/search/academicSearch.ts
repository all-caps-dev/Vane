import z from 'zod';
import { ResearchAction } from '../../../types';
import { ResearchBlock } from '@/lib/types';
import { executeSearch } from './baseSearch';

const schema = z.object({
  queries: z
    .array(z.string())
    .describe(
      'One to three academic search queries. Use one query for a simple question.',
    ),
});

// M3 query rules, the same as web search's (without purposes).
const academicSearchDescription = `
Use this tool to search scholarly articles, papers and research studies (arXiv, Google Scholar, PubMed).
- A simple question needs ONE query. Use two or three only when the question has separate parts, one query per part.
- Keep the entities listed in the user message exactly as written: names, versions, gene or drug names, standard identifiers. Do not round, expand or "fix" them.
- Add a year only when the freshness in the user message is "recent" or "current".
- Never repeat a query listed under "Queries already run" in the user message.
- Write queries as a researcher would type them into a scholarly search engine: the key terms, not a full sentence.

Examples:
- "What does the evidence say about intermittent fasting and HbA1c?" -> ["intermittent fasting HbA1c randomized trial"]
- "How do transformers and state space models compare on long-context benchmarks?" -> ["transformer long-context benchmark", "state space model long-context benchmark"]

If this tool is present and no other tools are more relevant, you MUST use this tool to get the needed academic information.
`;

const academicSearchAction: ResearchAction<typeof schema> = {
  name: 'academic_search',
  schema: schema,
  getDescription: () => academicSearchDescription,
  getToolDescription: () =>
    'Search scholarly articles, papers and research studies. One query for a simple question; two or three only when the question has separate parts. Keep names, versions and identifiers verbatim; never repeat a query already run.',
  enabled: (config) =>
    config.sources.includes('academic') &&
    config.classification.classification.skipSearch === false &&
    config.classification.classification.academicSearch === true,
  execute: async (input, additionalConfig) => {
    input.queries = (
      Array.isArray(input.queries) ? input.queries : [input.queries]
    ).slice(0, 3);

    const researchBlock = additionalConfig.session.getBlock(
      additionalConfig.researchBlockId,
    ) as ResearchBlock | undefined;

    if (!researchBlock) throw new Error('Failed to retrieve research block');

    const results = await executeSearch({
      llm: additionalConfig.llm,
      embedding: additionalConfig.embedding,
      mode: additionalConfig.mode,
      queries: input.queries,
      researchBlock: researchBlock,
      session: additionalConfig.session,
      question: additionalConfig.question,
      searchConfig: {
        engines: ['arxiv', 'google scholar', 'pubmed'],
      },
    });

    return {
      type: 'search_results',
      results: results,
    };
  },
};

export default academicSearchAction;
