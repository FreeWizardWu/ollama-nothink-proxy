import type { AliasResolution } from './aliases.js';
import { cleanUndefined, makeChatId, unixTimestampSeconds } from './utils.js';

type OpenAIMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

type OpenAIChatRequest = {
  model: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  top_k?: number;
  think?: boolean;
  reasoning_effort?: string;
  response_format?: { type?: string };
  tools?: unknown;
  tool_choice?: unknown;
  options?: Record<string, unknown>;
};

type OllamaChatMessage = {
  role: string;
  content: string;
};

type OllamaChatRequest = {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  think?: boolean;
  format?: string;
  tools?: unknown;
  options?: Record<string, unknown>;
};

type OllamaChatResponse = {
  model?: string;
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
  };
};

export type StreamDebugStats = {
  chunkCount: number;
  contentChars: number;
  firstChunkMs?: number;
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptEvalCount?: number;
  evalCount?: number;
  doneReason?: string;
};

function normalizeMessageContent(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => part?.type === 'text' || (part?.type === undefined && typeof part?.text === 'string'))
    .map((part) => part?.text ?? '')
    .join('');
}

export function toOllamaChatRequest(
  requestBody: OpenAIChatRequest,
  resolution: AliasResolution,
): OllamaChatRequest {
  const clientRequestedNoThink =
    requestBody.think === false || requestBody.reasoning_effort === 'none';

  const shouldDisableThinking = resolution.disableThinking || clientRequestedNoThink;

  const options = cleanUndefined({
    ...(requestBody.options ?? {}),
    num_predict: requestBody.max_tokens,
    temperature: requestBody.temperature,
    top_p: requestBody.top_p,
    top_k: requestBody.top_k,
    stop: requestBody.stop,
    seed: requestBody.seed,
  });

  return cleanUndefined({
    model: resolution.upstreamModel,
    messages: (requestBody.messages ?? []).map((message) => ({
      role: message.role ?? 'user',
      content: normalizeMessageContent(message.content),
    })),
    stream: Boolean(requestBody.stream),
    think: shouldDisableThinking ? false : undefined,
    format: requestBody.response_format?.type === 'json_object' ? 'json' : undefined,
    tools: requestBody.tools,
    options,
  });
}

export function toOpenAINonStreamResponse(
  upstream: OllamaChatResponse,
  requestedModel: string,
): Record<string, unknown> {
  const promptTokens = upstream.prompt_eval_count ?? 0;
  const completionTokens = upstream.eval_count ?? 0;

  return {
    id: makeChatId(),
    object: 'chat.completion',
    created: unixTimestampSeconds(),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: upstream.message?.role ?? 'assistant',
          content: upstream.message?.content ?? '',
        },
        finish_reason: upstream.done_reason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function toSseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function writeOpenAIStream(
  upstreamResponse: Response,
  requestedModel: string,
  writable: WritableStreamDefaultWriter<Uint8Array>,
  stats?: StreamDebugStats,
): Promise<void> {
  if (!upstreamResponse.body) {
    throw new Error('Upstream response body is empty');
  }

  const encoder = new TextEncoder();
  const reader = upstreamResponse.body.getReader();
  const chatId = makeChatId();
  const created = unixTimestampSeconds();

  await writable.write(
    encoder.encode(
      toSseEvent({
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '',
            },
            finish_reason: null,
          },
        ],
      }),
    ),
  );

  const decoder = new TextDecoder();
  let buffer = '';
  const startedAt = Date.now();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      const chunk = JSON.parse(trimmed) as OllamaChatResponse;
      const content = chunk.message?.content ?? '';
      stats && (stats.chunkCount += 1);

      if (content) {
        if (stats && stats.firstChunkMs === undefined) {
          stats.firstChunkMs = Date.now() - startedAt;
        }

        if (stats) {
          stats.contentChars += content.length;
        }

        await writable.write(
          encoder.encode(
            toSseEvent({
              id: chatId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    content,
                  },
                  finish_reason: null,
                },
              ],
            }),
          ),
        );
      }

      if (chunk.done) {
        if (stats) {
          stats.totalDurationNs = chunk.total_duration;
          stats.loadDurationNs = chunk.load_duration;
          stats.promptEvalCount = chunk.prompt_eval_count;
          stats.evalCount = chunk.eval_count;
          stats.doneReason = chunk.done_reason ?? 'stop';
        }

        await writable.write(
          encoder.encode(
            toSseEvent({
              id: chatId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: chunk.done_reason ?? 'stop',
                },
              ],
            }),
          ),
        );
      }
    }
  }

  if (buffer.trim()) {
    const finalChunk = JSON.parse(buffer.trim()) as OllamaChatResponse;

    if (finalChunk.done) {
      if (stats) {
        stats.chunkCount += 1;
        stats.totalDurationNs = finalChunk.total_duration;
        stats.loadDurationNs = finalChunk.load_duration;
        stats.promptEvalCount = finalChunk.prompt_eval_count;
        stats.evalCount = finalChunk.eval_count;
        stats.doneReason = finalChunk.done_reason ?? 'stop';
      }

      await writable.write(
        encoder.encode(
          toSseEvent({
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: finalChunk.done_reason ?? 'stop',
              },
            ],
          }),
        ),
      );
    }
  }

  await writable.write(encoder.encode('data: [DONE]\n\n'));
}
