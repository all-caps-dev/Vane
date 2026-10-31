import z from 'zod';
import { ClassifierInput, ClassifierOutput } from './types';
import { classifierPrompt } from '@/lib/prompts/search/classifier';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';
import { getInternalThinking } from '@/lib/config/serverRegistry';

export const FRESHNESS_VALUES = [
  'none',
  'recent',
  'current',
  'historical',
] as const;

export const INTENT_VALUES = [
  'fact',
  'howto',
  'comparison',
  'troubleshooting',
  'opinion',
  'news',
  'definition',
  'other',
] as const;

/*
  The classifier's answer. The three M3 fields (freshness, entities, intent)
  use .catch(): a model that leaves one out or writes an unknown value still
  parses, with a neutral fallback, instead of failing the whole request.
  .catch() keeps the field "required" in the JSON schema the model is shown.
*/
export const classifierSchema = z.object({
  classification: z.object({
    skipSearch: z
      .boolean()
      .describe('Indicates whether to skip the search step.'),
    personalSearch: z
      .boolean()
      .describe('Indicates whether to perform a personal search.'),
    academicSearch: z
      .boolean()
      .describe('Indicates whether to perform an academic search.'),
    discussionSearch: z
      .boolean()
      .describe('Indicates whether to perform a discussion search.'),
    showWeatherWidget: z
      .boolean()
      .describe('Indicates whether to show the weather widget.'),
    showStockWidget: z
      .boolean()
      .describe('Indicates whether to show the stock widget.'),
    showCalculationWidget: z
      .boolean()
      .describe('Indicates whether to show the calculation widget.'),
    freshness: z
      .enum(FRESHNESS_VALUES)
      .catch('none')
      .describe('How time-sensitive the answer is.'),
    entities: z
      .array(z.string())
      .catch([])
      .describe(
        'Exact product names, versions, error strings and standards that search queries must keep verbatim.',
      ),
    intent: z
      .enum(INTENT_VALUES)
      .catch('other')
      .describe('What kind of answer the user wants.'),
  }),
  standaloneFollowUp: z
    .string()
    .describe(
      "A self-contained, context-independent reformulation of the user's question.",
    ),
});

export const classify = async (
  input: ClassifierInput,
): Promise<ClassifierOutput> => {
  const output = await input.llm.generateObject<typeof classifierSchema>({
    messages: [
      {
        role: 'system',
        content: classifierPrompt,
      },
      {
        role: 'user',
        content: `<conversation_history>\n${formatChatHistoryAsString(input.chatHistory)}\n</conversation_history>\n<user_query>\n${input.query}\n</user_query>`,
      },
    ],
    schema: classifierSchema,
    // An internal call: may skip the model's thinking step (M4 setting).
    options: { thinking: getInternalThinking() },
  });

  // Drop blank entity strings and repeats; keep the model's order.
  output.classification.entities = [
    ...new Set(
      (output.classification.entities ?? [])
        .map((e) => (typeof e === 'string' ? e.trim() : ''))
        .filter((e) => e.length > 0),
    ),
  ];

  return output;
};
