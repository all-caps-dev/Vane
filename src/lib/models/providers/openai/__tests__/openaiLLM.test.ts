// TypeScript: unit tests for the OpenAI provider's opt-in "thinking off" body field (M4).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';

// Fake chat.completions.create/parse. vi.hoisted makes them exist before the
// hoisted vi.mock factory below runs.
const fake = vi.hoisted(() => ({
  create: vi.fn(),
  parse: vi.fn(),
}));

// Replace the openai client class so no request leaves the test.
// The error classes connectionRetry.ts checks against are stubbed too.
vi.mock('openai', () => ({
  APIConnectionError: class extends Error {},
  APIConnectionTimeoutError: class extends Error {},
  default: class {
    chat = { completions: { create: fake.create, parse: fake.parse } };
  },
}));

import OpenAILLM, {
  isStructuredOutputUnsupported,
  thinkingBody,
} from '@/lib/models/providers/openai/openaiLLM';

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

// A one-chunk stream, the shape create() returns when stream is true.
async function* oneChunk() {
  yield { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] };
}

// The params object the last create/parse call received.
const lastParams = (fn: typeof fake.create) => fn.mock.lastCall?.[0];

beforeEach(() => {
  fake.create.mockReset();
  fake.parse.mockReset();
});

describe('thinkingBody', () => {
  it('adds the field only for off', () => {
    expect(thinkingBody({ thinking: 'off' })).toEqual({
      chat_template_kwargs: { thinking: false },
    });
    expect(thinkingBody({ thinking: 'default' })).toEqual({});
    expect(thinkingBody({})).toEqual({});
    expect(thinkingBody(undefined)).toEqual({});
  });
});

describe('OpenAILLM thinking option', () => {
  for (const thinking of ['off', 'default', undefined] as const) {
    const expectField = thinking === 'off';

    it(`generateText, thinking=${thinking}`, async () => {
      fake.create.mockResolvedValue(reply);
      await llm.generateText({ messages, options: { thinking } });
      const params = lastParams(fake.create);
      if (expectField)
        expect(params.chat_template_kwargs).toEqual({ thinking: false });
      else expect(params).not.toHaveProperty('chat_template_kwargs');
    });

    it(`streamText, thinking=${thinking}`, async () => {
      fake.create.mockResolvedValue(oneChunk());
      for await (const _ of llm.streamText({ messages, options: { thinking } }))
        void _;
      const params = lastParams(fake.create);
      expect(params.stream).toBe(true);
      if (expectField)
        expect(params.chat_template_kwargs).toEqual({ thinking: false });
      else expect(params).not.toHaveProperty('chat_template_kwargs');
    });

    it(`generateObject, thinking=${thinking}`, async () => {
      fake.parse.mockResolvedValue(reply);
      const out = await llm.generateObject<{ ok: boolean }>({
        schema: z.object({ ok: z.boolean() }),
        messages,
        options: { thinking },
      });
      expect(out).toEqual({ ok: true });
      const params = lastParams(fake.parse);
      if (expectField)
        expect(params.chat_template_kwargs).toEqual({ thinking: false });
      else expect(params).not.toHaveProperty('chat_template_kwargs');
    });
  }
});

describe('generateObject on a server without response_format', () => {
  // The 400 TensorFold's DeepSeek V4.1 engine sends for response_format.
  const unsupported = Object.assign(
    new Error(
      '400 structured output (response_format and the guided_* fields) is not supported by this engine yet',
    ),
    { status: 400 },
  );
  const schema = z.object({ ok: z.boolean() });

  it('puts the schema in the prompt, then skips response_format next time', async () => {
    // A server of its own, so the module-level memory starts empty.
    const local = new OpenAILLM({
      apiKey: 'test',
      model: 'no-structured',
      baseURL: 'http://tensorfold.test/v1',
    });
    fake.parse.mockRejectedValue(unsupported);
    fake.create.mockResolvedValue({
      choices: [{ message: { content: 'Sure: {"ok": true}' } }],
    });
    const system = { role: 'system' as const, content: 'Be brief.' };

    const first = await local.generateObject<{ ok: boolean }>({
      schema,
      messages: [system, ...messages],
      options: { thinking: 'off' },
    });
    expect(first).toEqual({ ok: true });
    expect(fake.parse).toHaveBeenCalledTimes(1);

    const params = lastParams(fake.create);
    expect(params).not.toHaveProperty('response_format');
    expect(params.chat_template_kwargs).toEqual({ thinking: false });
    // The instruction joins the existing system message; no second one.
    expect(params.messages).toHaveLength(2);
    expect(params.messages[0].content).toMatch(
      /^Be brief\.\n\nReply with only a JSON object/,
    );
    expect(params.messages[0].content).toContain('"ok"');

    // Second call: straight to the prompt, no rejected request first.
    await local.generateObject({ schema, messages });
    expect(fake.parse).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(lastParams(fake.create).messages[0].role).toBe('system');
  });

  it('throws other 400s as they are', async () => {
    const local = new OpenAILLM({
      apiKey: 'test',
      model: 'other-400',
      baseURL: 'http://other.test/v1',
    });
    const bad = Object.assign(new Error('400 max_tokens too large'), {
      status: 400,
    });
    fake.parse.mockRejectedValue(bad);
    await expect(local.generateObject({ schema, messages })).rejects.toBe(bad);
    expect(fake.create).not.toHaveBeenCalled();
  });
});

describe('isStructuredOutputUnsupported', () => {
  it('matches 400s about structured output only', () => {
    const e = (status: number, message: string) =>
      Object.assign(new Error(message), { status });
    expect(
      isStructuredOutputUnsupported(e(400, 'response_format is not supported')),
    ).toBe(true);
    expect(
      isStructuredOutputUnsupported(e(400, 'json_schema unsupported')),
    ).toBe(true);
    expect(
      isStructuredOutputUnsupported(e(500, 'response_format crashed')),
    ).toBe(false);
    expect(isStructuredOutputUnsupported(e(400, 'bad temperature'))).toBe(
      false,
    );
    expect(isStructuredOutputUnsupported(null)).toBe(false);
  });
});
