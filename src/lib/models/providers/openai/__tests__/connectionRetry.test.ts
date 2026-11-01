// TypeScript: unit tests for the one-retry-on-connection-error rule in the OpenAI provider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';

const fake = vi.hoisted(() => ({
  create: vi.fn(),
  parse: vi.fn(),
}));

// Keep the real error classes (APIConnectionError...) and replace only the
// client, so no request leaves the test.
vi.mock('openai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('openai')>()),
  default: class {
    chat = { completions: { create: fake.create, parse: fake.parse } };
  },
}));

import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import OpenAILLM from '@/lib/models/providers/openai/openaiLLM';
import {
  CONNECTION_RETRY_DELAY_MS,
  isConnectionError,
} from '@/lib/models/providers/openai/connectionRetry';

const llm = new OpenAILLM({ apiKey: 'test', model: 'test-model' });
const messages = [{ role: 'user' as const, content: 'hi' }];
const reply = {
  choices: [
    {
      message: { content: '{"ok":true}', tool_calls: [] },
      finish_reason: 'stop',
    },
  ],
};
const schema = z.object({ ok: z.boolean() });

// What the SDK throws when the server refuses the connection.
const refused = () =>
  new APIConnectionError({
    cause: Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
        code: 'ECONNREFUSED',
      }),
    }),
  });

beforeEach(() => {
  fake.create.mockReset();
  fake.parse.mockReset();
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isConnectionError', () => {
  it('matches the SDK class and the socket messages in the cause chain', () => {
    expect(isConnectionError(refused())).toBe(true);
    expect(isConnectionError(new TypeError('fetch failed'))).toBe(true);
    expect(
      isConnectionError(
        new Error('wrapped', { cause: new Error('other side closed') }),
      ),
    ).toBe(true);
  });

  it('does not match a timeout, an HTTP error or a parse error', () => {
    expect(isConnectionError(new APIConnectionTimeoutError())).toBe(false);
    expect(isConnectionError(new Error('400 bad request'))).toBe(false);
    expect(isConnectionError(new SyntaxError('Unexpected token'))).toBe(false);
  });
});

describe('OpenAILLM retry on connection error', () => {
  it('generateObject: fails once, waits 2.5 s, succeeds', async () => {
    fake.parse.mockRejectedValueOnce(refused()).mockResolvedValueOnce(reply);

    const result = llm.generateObject<typeof schema>({ messages, schema });
    // Nothing is retried before the wait is over.
    await vi.advanceTimersByTimeAsync(CONNECTION_RETRY_DELAY_MS - 1);
    expect(fake.parse).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ ok: true });
    expect(fake.parse).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('generateText: fails once, then succeeds', async () => {
    fake.create.mockRejectedValueOnce(refused()).mockResolvedValueOnce(reply);

    const result = llm.generateText({ messages });
    await vi.advanceTimersByTimeAsync(CONNECTION_RETRY_DELAY_MS);

    await expect(result).resolves.toMatchObject({ content: '{"ok":true}' });
    expect(fake.create).toHaveBeenCalledTimes(2);
  });

  it('throws when the retry fails too (exactly two calls)', async () => {
    fake.parse.mockRejectedValue(refused());

    const result = llm.generateObject({ messages, schema });
    // Attach the expectation first so the rejection is never unhandled.
    const check = expect(result).rejects.toBeInstanceOf(APIConnectionError);
    await vi.advanceTimersByTimeAsync(CONNECTION_RETRY_DELAY_MS * 3);
    await check;
    expect(fake.parse).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    fake.create.mockRejectedValue(new Error('400 bad request'));
    await expect(llm.generateText({ messages })).rejects.toThrow('400');
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it('does not retry streamText', async () => {
    fake.create.mockRejectedValue(refused());
    const stream = llm.streamText({ messages });
    await expect(stream.next()).rejects.toBeInstanceOf(APIConnectionError);
    expect(fake.create).toHaveBeenCalledTimes(1);
  });
});
