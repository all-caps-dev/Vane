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
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: fake.create, parse: fake.parse } };
  },
}));

import OpenAILLM, {
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
