// TypeScript: the optional second ("internal") chat model for the classifier, research planner, coverage check and widgets (Fleet #346 item 3).
//
// The setting is a string `providerId:key` (Settings > Search > Internal
// model, or VANE_INTERNAL_MODEL). 'same' or empty means "use the chat model".
// Provider ids are UUIDs, so the first ':' splits the two; model keys may
// contain ':' themselves (Ollama's "llama3:8b").
import type BaseLLM from './base/llm';
import type { MinimalProvider, ModelWithProvider } from './types';

// The setting's value for "Same as chat model".
export const SAME_AS_CHAT = 'same';

/* Parses `providerId:key`. Returns null for "same as chat" and 'invalid'
   for anything that is not two non-empty parts. */
export const parseModelRef = (
  value: unknown,
): ModelWithProvider | null | 'invalid' => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.toLowerCase() === SAME_AS_CHAT) return null;
  const at = text.indexOf(':');
  if (at <= 0 || at === text.length - 1) return 'invalid';
  return { providerId: text.slice(0, at), key: text.slice(at + 1) };
};

export const formatModelRef = (ref: ModelWithProvider): string =>
  `${ref.providerId}:${ref.key}`;

// Why the chat model serves the internal calls although a model was set.
export type InternalModelFallback = {
  requested: string;
  reason: 'invalid' | 'load_failed';
  error?: string;
};

export type InternalModelResult = {
  // The loaded internal model, or undefined when the chat model serves.
  llm?: BaseLLM<any>;
  fallback?: InternalModelFallback;
};

/*
  Loads the internal model once for a request. Never throws: a bad setting
  or a failed load returns the fallback (and logs one line), and the caller
  uses the chat model. A setting equal to the chat model loads nothing.
*/
export const loadInternalModel = async (args: {
  setting: unknown;
  chatModel: ModelWithProvider;
  registry: { loadChatModel: (providerId: string, key: string) => any };
}): Promise<InternalModelResult> => {
  const ref = parseModelRef(args.setting);
  if (ref === null) return {};

  const requested = String(args.setting).trim();
  if (ref === 'invalid') {
    console.log(
      `[internal model] "${requested}" is not providerId:key; using the chat model.`,
    );
    return { fallback: { requested, reason: 'invalid' } };
  }

  if (
    ref.providerId === args.chatModel.providerId &&
    ref.key === args.chatModel.key
  )
    return {};

  try {
    const llm = (await args.registry.loadChatModel(
      ref.providerId,
      ref.key,
    )) as BaseLLM<any>;
    return { llm };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(
      `[internal model] could not load ${requested}: ${error}; using the chat model.`,
    );
    return { fallback: { requested, reason: 'load_failed', error } };
  }
};

/*
  The options of the Settings select: "Same as chat model", then every chat
  model of every provider as `providerId:key`. A saved value that is no
  longer listed stays selectable, marked unavailable, so the select shows
  what is actually stored.
*/
export const internalModelOptions = (
  providers: MinimalProvider[],
  current?: unknown,
): { name: string; value: string }[] => {
  const options = [{ name: 'Same as chat model', value: SAME_AS_CHAT }];
  for (const p of providers) {
    for (const m of p.chatModels) {
      // getActiveProviders reports a provider that failed as a fake 'error' model.
      if (m.key === 'error') continue;
      options.push({
        name: `${p.name} - ${m.name}`,
        value: formatModelRef({ providerId: p.id, key: m.key }),
      });
    }
  }
  const saved = typeof current === 'string' ? current.trim() : '';
  if (saved && !options.some((o) => o.value === saved)) {
    options.push({ name: `${saved} (not available)`, value: saved });
  }
  return options;
};
