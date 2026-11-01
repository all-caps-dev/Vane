import z from 'zod';
import BaseLLM from '../../models/base/llm';
import BaseEmbedding from '@/lib/models/base/embedding';
import SessionManager from '@/lib/session';
import { ChatTurnMessage, Chunk } from '@/lib/types';
import type { SourceGroup } from '@/lib/evidence';
import type { Prefetch } from './prefetch';
import type { InternalModelFallback } from '@/lib/models/internalModel';

export type SearchSources = 'web' | 'discussions' | 'academic';

export type SearchAgentConfig = {
  sources: SearchSources[];
  fileIds: string[];
  llm: BaseLLM<any>;
  embedding: BaseEmbedding<any>;
  mode: 'speed' | 'balanced' | 'quality';
  systemInstructions: string;
  // The optional second model for internal calls (classifier, researcher
  // planner, gap check, widgets). Unset means the chat model serves them.
  internalLlm?: BaseLLM<any>;
  // Set when an internal model was configured but could not be used.
  internalModelFallback?: InternalModelFallback;
};

// The model for internal calls: the internal model when loaded, else the chat model.
export const internalLlmOf = (config: SearchAgentConfig): BaseLLM<any> =>
  config.internalLlm ?? config.llm;

export type SearchAgentInput = {
  chatHistory: ChatTurnMessage[];
  followUp: string;
  config: SearchAgentConfig;
  chatId: string;
  messageId: string;
};

export type WidgetInput = {
  chatHistory: ChatTurnMessage[];
  followUp: string;
  classification: ClassifierOutput;
  llm: BaseLLM<any>;
};

export type Widget = {
  type: string;
  shouldExecute: (classification: ClassifierOutput) => boolean;
  execute: (input: WidgetInput) => Promise<WidgetOutput | void>;
};

export type WidgetOutput = {
  type: string;
  llmContext: string;
  data: any;
};

export type ClassifierInput = {
  llm: BaseLLM<any>;
  enabledSources: SearchSources[];
  query: string;
  chatHistory: ChatTurnMessage[];
};

// How time-sensitive the answer is (M3). 'recent' and 'current' narrow the
// web search with SearXNG's time_range and allow a year in queries.
export type Freshness = 'none' | 'recent' | 'current' | 'historical';

// What kind of answer the user wants (M3).
export type QueryIntent =
  | 'fact'
  | 'howto'
  | 'comparison'
  | 'troubleshooting'
  | 'opinion'
  | 'news'
  | 'definition'
  | 'other';

export type ClassifierOutput = {
  classification: {
    skipSearch: boolean;
    personalSearch: boolean;
    academicSearch: boolean;
    discussionSearch: boolean;
    showWeatherWidget: boolean;
    showStockWidget: boolean;
    showCalculationWidget: boolean;
    freshness: Freshness;
    // Product names, versions, error strings and standards that search
    // queries must keep exactly as written.
    entities: string[];
    intent: QueryIntent;
  };
  standaloneFollowUp: string;
};

export type AdditionalConfig = {
  llm: BaseLLM<any>;
  embedding: BaseEmbedding<any>;
  session: SessionManager;
  // The classifier's standalone question; search actions rank passages
  // against it (M2).
  question?: string;
  // The classifier's output; web search reads freshness from it (M3).
  classification?: ClassifierOutput;
  // The search started while the classifier ran; the first web_search may
  // reuse it (prefetch.ts).
  prefetch?: Prefetch;
};

export type ResearcherInput = {
  chatHistory: ChatTurnMessage[];
  followUp: string;
  classification: ClassifierOutput;
  config: SearchAgentConfig;
  // The search started while the classifier ran (prefetch.ts).
  prefetch?: Prefetch;
};

export type ResearcherOutput = {
  findings: ActionOutput[];
  // One entry per SOURCE (page), numbered from 1 in this order: what the UI
  // source cards, the API's `sources` and the [N] citations refer to.
  searchFindings: Chunk[];
  // The same sources with their passages, for the writer context (M2).
  sources: SourceGroup[];
  // What the evidence-gap round found (M3). Only set when that round ran
  // (balanced and quality); the writer gets it as <evidence_notes>.
  evidenceNotes?: EvidenceNotes;
};

// One missing piece of evidence named by the gap round (M3).
export type EvidenceGap = {
  what: string;
  query: string;
  purpose: string;
};

export type EvidenceNotes = {
  gaps: EvidenceGap[];
  conflicts: string[];
};

export type SearchActionOutput = {
  type: 'search_results';
  results: Chunk[];
};

export type DoneActionOutput = {
  type: 'done';
};

export type ReasoningResearchAction = {
  type: 'reasoning';
  reasoning: string;
};

export type ActionOutput =
  | SearchActionOutput
  | DoneActionOutput
  | ReasoningResearchAction;

export interface ResearchAction<
  TSchema extends z.ZodObject<any> = z.ZodObject<any>,
> {
  name: string;
  schema: z.ZodObject<any>;
  getToolDescription: (config: { mode: SearchAgentConfig['mode'] }) => string;
  getDescription: (config: { mode: SearchAgentConfig['mode'] }) => string;
  enabled: (config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }) => boolean;
  execute: (
    params: z.infer<TSchema>,
    additionalConfig: AdditionalConfig & {
      researchBlockId: string;
      fileIds: string[];
      mode: SearchAgentConfig['mode'];
    },
  ) => Promise<ActionOutput>;
}
