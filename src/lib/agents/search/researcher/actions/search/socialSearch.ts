import z from 'zod';
import { ResearchAction } from '../../../types';
import { ResearchBlock } from '@/lib/types';
import { executeSearch } from './baseSearch';

const schema = z.object({
  queries: z
    .array(z.string())
    .describe(
      'One to three discussion search queries. Use one query for a simple question.',
    ),
});

// M3 query rules, the same as web search's (without purposes).
const socialSearchDescription = `
Use this tool to search discussions (Reddit threads and posts) for first-hand experience, opinions and known problems.
- A simple question needs ONE query. Use two or three only when the question has separate parts, one query per part.
- Keep the entities listed in the user message exactly as written: product names, version numbers, error strings. Do not round, expand or "fix" them.
- Add a year only when the freshness in the user message is "recent" or "current".
- Never repeat a query listed under "Queries already run" in the user message.
- Write queries as a person would type them into a forum search: the key terms, not a full sentence.

Examples:
- "Do people regret buying the Framework Laptop 16?" -> ["Framework Laptop 16 regret"]
- "What do owners say about the Steam Deck OLED battery and screen?" -> ["Steam Deck OLED battery life", "Steam Deck OLED screen"]

If this tool is present and no other tools are more relevant, you MUST use this tool to get the needed social media information.
`;

const socialSearchAction: ResearchAction<typeof schema> = {
  name: 'social_search',
  schema: schema,
  getDescription: () => socialSearchDescription,
  getToolDescription: () =>
    'Search discussions (Reddit) for first-hand experience and opinions. One query for a simple question; two or three only when the question has separate parts. Keep names, versions and error strings verbatim; never repeat a query already run.',
  enabled: (config) =>
    config.sources.includes('discussions') &&
    config.classification.classification.skipSearch === false &&
    config.classification.classification.discussionSearch === true,
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
        engines: ['reddit'],
      },
    });

    return {
      type: 'search_results',
      results: results,
    };
  },
};

export default socialSearchAction;
