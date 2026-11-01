// TypeScript: unit tests for the optional internal model (Fleet #346 item 3) with a mocked model registry.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  internalModelOptions,
  loadInternalModel,
  parseModelRef,
} from '@/lib/models/internalModel';
import { internalLlmOf } from '@/lib/agents/search/types';

const chatModel = { providerId: 'p-chat', key: 'big-model' };

// A registry whose loadChatModel returns a fake model per key, or throws.
const mockRegistry = (fail?: string) => ({
  loadChatModel: vi.fn(async (providerId: string, key: string) => {
    if (fail) throw new Error(fail);
    return { config: { model: key }, providerId };
  }),
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('parseModelRef', () => {
  it('reads providerId:key and keeps colons in the key', () => {
    expect(parseModelRef('p1:gpt-x')).toEqual({
      providerId: 'p1',
      key: 'gpt-x',
    });
    expect(parseModelRef(' p2:llama3:8b ')).toEqual({
      providerId: 'p2',
      key: 'llama3:8b',
    });
  });

  it('treats same, empty and missing as the chat model', () => {
    expect(parseModelRef('same')).toBeNull();
    expect(parseModelRef('SAME')).toBeNull();
    expect(parseModelRef('')).toBeNull();
    expect(parseModelRef(undefined)).toBeNull();
  });

  it('rejects malformed values', () => {
    expect(parseModelRef('no-colon')).toBe('invalid');
    expect(parseModelRef(':key')).toBe('invalid');
    expect(parseModelRef('provider:')).toBe('invalid');
  });
});

describe('loadInternalModel', () => {
  it('loads nothing when the setting is the chat model', async () => {
    const registry = mockRegistry();
    await expect(
      loadInternalModel({ setting: 'same', chatModel, registry }),
    ).resolves.toEqual({});
    await expect(
      loadInternalModel({ setting: 'p-chat:big-model', chatModel, registry }),
    ).resolves.toEqual({});
    expect(registry.loadChatModel).not.toHaveBeenCalled();
  });

  it('loads the configured model once', async () => {
    const registry = mockRegistry();
    const out = await loadInternalModel({
      setting: 'p-small:flash',
      chatModel,
      registry,
    });
    expect(registry.loadChatModel).toHaveBeenCalledTimes(1);
    expect(registry.loadChatModel).toHaveBeenCalledWith('p-small', 'flash');
    expect(out.llm).toMatchObject({ config: { model: 'flash' } });
    expect(out.fallback).toBeUndefined();
  });

  it('falls back to the chat model with one log line when loading fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const registry = mockRegistry('Invalid provider id');
    const out = await loadInternalModel({
      setting: 'gone:flash',
      chatModel,
      registry,
    });
    expect(out.llm).toBeUndefined();
    expect(out.fallback).toEqual({
      requested: 'gone:flash',
      reason: 'load_failed',
      error: 'Invalid provider id',
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('falls back on a malformed setting without calling the registry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const registry = mockRegistry();
    const out = await loadInternalModel({
      setting: 'flash',
      chatModel,
      registry,
    });
    expect(out).toEqual({
      fallback: { requested: 'flash', reason: 'invalid' },
    });
    expect(registry.loadChatModel).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('internalLlmOf', () => {
  const chat = { name: 'chat' } as any;
  const small = { name: 'small' } as any;
  const config = {
    sources: [],
    fileIds: [],
    llm: chat,
    embedding: {} as any,
    mode: 'speed' as const,
    systemInstructions: '',
  };

  it('uses the internal model when one is loaded, else the chat model', () => {
    expect(internalLlmOf(config)).toBe(chat);
    expect(internalLlmOf({ ...config, internalLlm: small })).toBe(small);
  });
});

describe('internalModelOptions', () => {
  const providers = [
    {
      id: 'p1',
      name: 'OpenAI',
      chatModels: [
        { key: 'gpt-a', name: 'GPT A' },
        { key: 'gpt-b', name: 'GPT B' },
      ],
      embeddingModels: [{ key: 'emb', name: 'Emb' }],
    },
    {
      id: 'p2',
      name: 'Broken',
      chatModels: [{ key: 'error', name: 'connection refused' }],
      embeddingModels: [],
    },
  ];

  it('lists same-as-chat first, then every chat model as providerId:key', () => {
    expect(internalModelOptions(providers, 'same')).toEqual([
      { name: 'Same as chat model', value: 'same' },
      { name: 'OpenAI - GPT A', value: 'p1:gpt-a' },
      { name: 'OpenAI - GPT B', value: 'p1:gpt-b' },
    ]);
  });

  it('keeps a saved model that is no longer listed', () => {
    const options = internalModelOptions(providers, 'p9:old');
    expect(options.at(-1)).toEqual({
      name: 'p9:old (not available)',
      value: 'p9:old',
    });
  });
});
