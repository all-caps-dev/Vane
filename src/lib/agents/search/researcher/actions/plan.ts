import z from 'zod';
import { ResearchAction } from '../../types';

const schema = z.object({
  plan: z
    .string()
    .describe(
      'A concise natural-language plan in one short paragraph. Open with a short intent phrase (e.g., "Okay, the user wants to...", "Searching for...", "Looking into...") and lay out the steps you will take.',
    ),
});

const actionDescription = `
Use this tool FIRST on every turn to state your plan in natural language before any other action. Keep it short, action-focused, and tailored to the current query.
Make sure to not include reference to any tools or actions you might take, just the plan itself. The user isn't aware about tools, but they love to see your thought process.

Here are some examples of good plans:
<examples>
- "Okay, the user wants to know which success criteria WCAG 2.2 added. I will look up the official list from the W3C." -> "The W3C page lists the new criteria, which is enough to answer directly."
- "The user is asking whether a Mediterranean diet lowers blood pressure. I will look for clinical trials and reviews that measured it." -> "I found a meta-analysis with the measured change; I will check for a recent trial before answering, and say so if the evidence is mixed."
</examples>

YOU CAN NEVER CALL ANY OTHER TOOL BEFORE CALLING THIS ONE FIRST, IF YOU DO, THAT CALL WOULD BE IGNORED.
`;

const planAction: ResearchAction<typeof schema> = {
  name: '__reasoning_preamble',
  schema: schema,
  getToolDescription: () =>
    'Use this FIRST on every turn to state your plan in natural language before any other action. Keep it short, action-focused, and tailored to the current query.',
  getDescription: () => actionDescription,
  enabled: (config) => config.mode !== 'speed',
  execute: async (input, _) => {
    return {
      type: 'reasoning',
      reasoning: input.plan,
    };
  },
};

export default planAction;
