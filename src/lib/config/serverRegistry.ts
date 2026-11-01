import configManager from './index';
import { ConfigModelProvider } from './types';

export const getConfiguredModelProviders = (): ConfigModelProvider[] => {
  return configManager.getConfig('modelProviders', []);
};

export const getConfiguredModelProviderById = (
  id: string,
): ConfigModelProvider | undefined => {
  return getConfiguredModelProviders().find((p) => p.id === id) ?? undefined;
};

export const getSearxngURL = () =>
  configManager.getConfig('search.searxngURL', '');

/* Trace mode for request tracing (see src/lib/trace.ts).
   'off' unless the "Trace logging" switch is on; 'full' when it is on and
   VANE_TRACE=full, which adds content (question, passages, answer). */
export const getTraceMode = (): 'off' | 'on' | 'full' => {
  const enabled = configManager.getConfig('search.traceEnabled', false);
  if (enabled !== true && enabled !== 'true') return 'off';
  return process.env.VANE_TRACE?.trim().toLowerCase() === 'full'
    ? 'full'
    : 'on';
};

/* ---------- Evidence and reranking (M2) ---------- */

export type RerankerKind = 'transformers' | 'embedding' | 'off';

export const DEFAULT_RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
/* 16 was the first guess (M2). 12 gives the writer a shorter context; the
   UI shows 8 source cards either way. */
export const DEFAULT_EVIDENCE_BUDGET = 12;
// Experimental: weight of the source prior (sourcePriors.ts); 0 disables.
export const DEFAULT_SOURCE_PRIOR_WEIGHT = 0.5;

// Which reranker to use; anything unknown means the default cross-encoder.
export const getRerankerKind = (): RerankerKind => {
  const value = String(configManager.getConfig('search.reranker', ''))
    .trim()
    .toLowerCase();
  return value === 'embedding' || value === 'off' ? value : 'transformers';
};

export const getRerankerModel = (): string =>
  String(configManager.getConfig('search.rerankerModel', '')).trim() ||
  DEFAULT_RERANKER_MODEL;

// On unless explicitly switched off.
export const getBalancedReadsPages = (): boolean => {
  const value = configManager.getConfig('search.balancedReadsPages', true);
  return !(value === false || value === 'false');
};

// Passages per search, a whole number from 1 to 64; bad input means 12.
export const getEvidenceBudget = (): number => {
  const parsed = parseInt(
    String(configManager.getConfig('search.evidenceBudget', '')),
    10,
  );
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_EVIDENCE_BUDGET;
  return Math.min(parsed, 64);
};

/* "Prefer first-party sources" (experimental): how much the source prior
   adds to a min-max scaled rerank score. A number from 0 to 2; 0 turns
   priors (and the official_docs query variant) off; bad input means 0.5. */
export const getSourcePriorWeight = (): number => {
  const raw = String(
    configManager.getConfig('search.sourcePriorWeight', ''),
  ).trim();
  const parsed = parseFloat(raw);
  if (raw === '' || !Number.isFinite(parsed) || parsed < 0)
    return DEFAULT_SOURCE_PRIOR_WEIGHT;
  return Math.min(parsed, 2);
};

/* ---------- Model thinking (M4) ---------- */

export type InternalThinking = 'default' | 'off';

/* Whether internal calls (classifier, research planner, gap check, widgets)
   ask the server to skip thinking. Anything but 'off' means 'default', so
   nothing extra is sent to a server that may reject it. */
export const getInternalThinking = (): InternalThinking =>
  String(configManager.getConfig('search.internalThinking', ''))
    .trim()
    .toLowerCase() === 'off'
    ? 'off'
    : 'default';

/* ---------- Search while classifying (Fleet #346) ---------- */

// On unless explicitly switched off.
export const getPrefetchSearch = (): boolean => {
  const value = configManager.getConfig('search.prefetchSearch', true);
  return !(value === false || value === 'false');
};

/* ---------- Internal model (Fleet #346) ---------- */

// The raw setting: 'same' (or empty) for the chat model, else providerId:key.
// Parsed and validated by loadInternalModel (models/internalModel.ts).
export const getInternalModelSetting = (): string =>
  String(configManager.getConfig('search.internalModel', '') ?? '').trim();
