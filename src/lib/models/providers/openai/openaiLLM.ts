import OpenAI from 'openai';
import BaseLLM from '../../base/llm';
import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod';
import {
  GenerateObjectInput,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  ToolCall,
} from '../../types';
import { parse } from 'partial-json';
import z from 'zod';
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from 'openai/resources/index.mjs';
import { Message } from '@/lib/types';
import { repairJson } from '@toolsycc/json-repair';
import { retryOnceOnConnectionError } from './connectionRetry';

/*
  Extra request-body fields that turn the model's thinking off, or {} when
  thinking is left alone. Servers such as vLLM, SGLang and TensorFold read
  chat_template_kwargs.thinking for DeepSeek V4. Real OpenAI rejects unknown
  body fields, so nothing is added unless the caller asked for 'off'.
*/
export const thinkingBody = (
  options?: GenerateOptions,
): { chat_template_kwargs?: { thinking: boolean } } =>
  options?.thinking === 'off'
    ? { chat_template_kwargs: { thinking: false } }
    : {};

/*
  True when the server answered 400 because it does not support
  response_format (structured output). TensorFold's DeepSeek V4.1 engine says
  "structured output (response_format and the guided_* fields) is not
  supported by this engine yet"; vLLM-style servers name response_format or
  json_schema.
*/
export const isStructuredOutputUnsupported = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string } | null;
  return (
    e?.status === 400 &&
    /structured output|response_format|guided_|json_schema/i.test(
      e.message ?? '',
    )
  );
};

/*
  Servers (baseURL + model) known to reject response_format. A new OpenAILLM
  is made for every request, so this lives at module level: only the first
  request after a restart pays for the rejected call.
*/
const noStructuredOutput = new Set<string>();

/*
  The messages with an instruction to answer in JSON matching `schema`, for
  servers without response_format. The instruction joins the first system
  message (chat templates such as DeepSeek's expect one system message, at
  the start), or becomes that message when there is none.
*/
export const withSchemaInstruction = (
  messages: ChatCompletionMessageParam[],
  schema: z.ZodTypeAny,
): ChatCompletionMessageParam[] => {
  const instruction =
    'Reply with only a JSON object that matches this JSON Schema. No prose, no code fence.\n' +
    JSON.stringify(z.toJSONSchema(schema));
  const [first, ...rest] = messages;

  if (first?.role === 'system' && typeof first.content === 'string') {
    return [
      { role: 'system', content: `${first.content}\n\n${instruction}` },
      ...rest,
    ];
  }
  return [{ role: 'system', content: instruction }, ...messages];
};

type OpenAIConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
  options?: GenerateOptions;
};

class OpenAILLM extends BaseLLM<OpenAIConfig> {
  openAIClient: OpenAI;

  constructor(protected config: OpenAIConfig) {
    super(config);

    this.openAIClient = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL || 'https://api.openai.com/v1',
    });
  }

  convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.id,
          content: msg.content,
        } as ChatCompletionToolMessageParam;
      } else if (msg.role === 'assistant') {
        return {
          role: 'assistant',
          content: msg.content,
          ...(msg.tool_calls &&
            msg.tool_calls.length > 0 && {
              tool_calls: msg.tool_calls?.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })),
            }),
        } as ChatCompletionAssistantMessageParam;
      }

      return msg;
    });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    // One retry if the server could not be reached (see connectionRetry.ts).
    const response = await retryOnceOnConnectionError(
      () =>
        this.openAIClient.chat.completions.create({
          model: this.config.model,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          messages: this.convertToOpenAIMessages(input.messages),
          temperature:
            input.options?.temperature ??
            this.config.options?.temperature ??
            1.0,
          top_p: input.options?.topP ?? this.config.options?.topP,
          max_completion_tokens:
            input.options?.maxTokens ?? this.config.options?.maxTokens,
          stop:
            input.options?.stopSequences ?? this.config.options?.stopSequences,
          frequency_penalty:
            input.options?.frequencyPenalty ??
            this.config.options?.frequencyPenalty,
          presence_penalty:
            input.options?.presencePenalty ??
            this.config.options?.presencePenalty,
          // The SDK types do not know this key; the cast lets it through to the body.
          ...(thinkingBody(input.options) as {}),
        }),
      'OpenAI generateText',
    );

    if (response.choices && response.choices.length > 0) {
      return {
        content: response.choices[0].message.content!,
        toolCalls:
          response.choices[0].message.tool_calls
            ?.map((tc) => {
              if (tc.type === 'function') {
                return {
                  name: tc.function.name,
                  id: tc.id,
                  arguments: JSON.parse(tc.function.arguments),
                };
              }
            })
            .filter((tc) => tc !== undefined) || [],
        additionalInfo: {
          finishReason: response.choices[0].finish_reason,
        },
      };
    }

    throw new Error('No response from OpenAI');
  }

  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    const openaiTools: ChatCompletionTool[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const stream = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: this.convertToOpenAIMessages(input.messages),
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      // The SDK types do not know this key; the cast lets it through to the body.
      ...(thinkingBody(input.options) as {}),
      stream: true,
    });

    let recievedToolCalls: { name: string; id: string; arguments: string }[] =
      [];

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const toolCalls = chunk.choices[0].delta.tool_calls;
        yield {
          contentChunk: chunk.choices[0].delta.content || '',
          toolCallChunk:
            toolCalls?.map((tc) => {
              if (!recievedToolCalls[tc.index]) {
                const call = {
                  name: tc.function?.name!,
                  id: tc.id!,
                  arguments: tc.function?.arguments || '',
                };
                recievedToolCalls.push(call);
                return { ...call, arguments: parse(call.arguments || '{}') };
              } else {
                const existingCall = recievedToolCalls[tc.index];
                existingCall.arguments += tc.function?.arguments || '';
                return {
                  ...existingCall,
                  arguments: parse(existingCall.arguments),
                };
              }
            }) || [],
          done: chunk.choices[0].finish_reason !== null,
          additionalInfo: {
            finishReason: chunk.choices[0].finish_reason,
          },
        };
      }
    }
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const serverKey = `${this.config.baseURL ?? ''}|${this.config.model}`;
    const messages = this.convertToOpenAIMessages(input.messages);

    // The sampling fields shared by both request shapes below.
    const params = {
      model: this.config.model,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      // The SDK types do not know this key; the cast lets it through to the body.
      ...(thinkingBody(input.options) as {}),
    };

    /* Without response_format: the schema goes into the prompt instead, and
       repairJson below pulls the object out of the reply. Same model, same
       settings; only the request shape changes. */
    const promptForJson = () =>
      retryOnceOnConnectionError(
        () =>
          this.openAIClient.chat.completions.create({
            ...params,
            messages: withSchemaInstruction(messages, input.schema),
          }),
        'OpenAI generateObject (schema in prompt)',
      );

    let response;
    if (noStructuredOutput.has(serverKey)) {
      response = await promptForJson();
    } else {
      try {
        // One retry if the server could not be reached (see connectionRetry.ts).
        response = await retryOnceOnConnectionError(
          () =>
            this.openAIClient.chat.completions.parse({
              ...params,
              messages,
              response_format: zodResponseFormat(input.schema, 'object'),
            }),
          'OpenAI generateObject',
        );
      } catch (err) {
        if (!isStructuredOutputUnsupported(err)) throw err;
        noStructuredOutput.add(serverKey);
        console.warn(
          `OpenAI generateObject: ${this.config.model} at ${this.config.baseURL} rejects response_format; putting the schema in the prompt from now on`,
        );
        response = await promptForJson();
      }
    }

    if (response.choices && response.choices.length > 0) {
      try {
        return input.schema.parse(
          JSON.parse(
            repairJson(response.choices[0].message.content!, {
              extractJson: true,
            }) as string,
          ),
        ) as T;
      } catch (err) {
        throw new Error(`Error parsing response from OpenAI: ${err}`);
      }
    }

    throw new Error('No response from OpenAI');
  }

  async *streamObject<T>(input: GenerateObjectInput): AsyncGenerator<T> {
    let recievedObj: string = '';

    const stream = this.openAIClient.responses.stream({
      model: this.config.model,
      input: input.messages,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      text: {
        format: zodTextFormat(input.schema, 'object'),
      },
    });

    for await (const chunk of stream) {
      if (chunk.type === 'response.output_text.delta' && chunk.delta) {
        recievedObj += chunk.delta;

        try {
          yield parse(recievedObj) as T;
        } catch (err) {
          console.log('Error parsing partial object from OpenAI:', err);
          yield {} as T;
        }
      } else if (chunk.type === 'response.output_text.done' && chunk.text) {
        try {
          yield parse(chunk.text) as T;
        } catch (err) {
          throw new Error(`Error parsing response from OpenAI: ${err}`);
        }
      }
    }
  }
}

export default OpenAILLM;
