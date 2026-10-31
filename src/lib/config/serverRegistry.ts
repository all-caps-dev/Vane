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
