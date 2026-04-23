import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';

import { loadConfig } from './config.js';
import { resolveAlias } from './lib/aliases.js';
import { buildTagsWithAliases, fetchUpstreamTags, fetchUpstreamVersion } from './lib/ollama.js';
import {
  type StreamDebugStats,
  toOllamaChatRequest,
  toOpenAINonStreamResponse,
  writeOpenAIStream,
} from './lib/openai.js';
import { byteLength, cleanUndefined, toErrorMessage } from './lib/utils.js';

type RequestMeta = {
  requestId?: string;
  requestedModel?: string;
  targetModel?: string;
  thinkDisabled?: boolean;
  stream?: boolean;
  messageCount?: number;
  inputChars?: number;
  requestBytes?: number;
  upstreamStatus?: number;
  upstreamHeadersMs?: number;
  upstreamBodyMs?: number;
  firstChunkMs?: number;
  streamChunkCount?: number;
  responseChars?: number;
  promptEvalCount?: number;
  evalCount?: number;
  totalDurationNs?: number;
  loadDurationNs?: number;
  doneReason?: string;
  note?: string;
};

type AppVariables = {
  requestMeta: RequestMeta;
};

const config = loadConfig();
const proxyApiKey = process.env.PROXY_API_KEY;

// 日志开关：只有 logLevel 为 'debug' 时才输出日志
function log(...args: unknown[]) {
  if (config.logLevel === 'debug') {
    console.log(...args);
  }
}
let requestCounter = 0;

const app = new Hono<{ Variables: AppVariables }>();

function jsonError(
  _c: Context,
  status: number,
  message: string,
  shape: 'ollama' | 'openai' = 'ollama',
) {
  const payload = shape === 'openai'
    ? {
        error: {
          message,
          type: 'invalid_request_error',
        },
      }
    : { error: message };

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function jsonStatus(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function applyDebugHeaders(headers: Headers, requestedModel: string, targetModel: string, noThink: boolean) {
  headers.set('x-ollama-proxy-model', requestedModel);
  headers.set('x-ollama-proxy-target-model', targetModel);
  headers.set('x-ollama-proxy-think-disabled', String(noThink));
}

function createUpstreamHeaders(c: Context): Headers {
  const headers = new Headers();

  const contentType = c.req.header('content-type');
  const accept = c.req.header('accept');

  if (contentType) {
    headers.set('content-type', contentType);
  }

  if (accept) {
    headers.set('accept', accept);
  }

  return headers;
}

function setRequestMeta(c: Context<{ Variables: AppVariables }>, meta: Partial<RequestMeta>) {
  const currentMeta = c.get('requestMeta') ?? {};
  c.set('requestMeta', {
    ...currentMeta,
    ...meta,
  });
}

function summarizeOllamaMessages(messages: unknown): { messageCount: number; inputChars: number } {
  if (!Array.isArray(messages)) {
    return { messageCount: 0, inputChars: 0 };
  }

  let inputChars = 0;

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      inputChars += content.length;
    }
  }

  return {
    messageCount: messages.length,
    inputChars,
  };
}

function summarizeOpenAIRequestBody(body: Record<string, unknown>): Pick<
  RequestMeta,
  'stream' | 'messageCount' | 'inputChars' | 'requestBytes'
> {
  const { messageCount, inputChars } = summarizeOllamaMessages(body.messages);

  return {
    stream: Boolean(body.stream),
    messageCount,
    inputChars,
    requestBytes: byteLength(JSON.stringify(body)),
  };
}

function nsToMs(value?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Math.round(value / 1_000_000);
}

function logDetailed(event: string, meta: RequestMeta) {
  const fields = [
    '[proxy-detail]',
    `event=${event}`,
    `request_id=${JSON.stringify(meta.requestId ?? '-')}`,
    `requested_model=${JSON.stringify(meta.requestedModel ?? '-')}`,
    `target_model=${JSON.stringify(meta.targetModel ?? '-')}`,
    `stream=${meta.stream === undefined ? '-' : String(meta.stream)}`,
    `message_count=${meta.messageCount ?? '-'}`,
    `input_chars=${meta.inputChars ?? '-'}`,
    `request_bytes=${meta.requestBytes ?? '-'}`,
    `upstream_status=${meta.upstreamStatus ?? '-'}`,
    `upstream_headers_ms=${meta.upstreamHeadersMs ?? '-'}`,
    `upstream_body_ms=${meta.upstreamBodyMs ?? '-'}`,
    `first_chunk_ms=${meta.firstChunkMs ?? '-'}`,
    `stream_chunks=${meta.streamChunkCount ?? '-'}`,
    `response_chars=${meta.responseChars ?? '-'}`,
    `prompt_eval_count=${meta.promptEvalCount ?? '-'}`,
    `eval_count=${meta.evalCount ?? '-'}`,
    `load_ms=${nsToMs(meta.loadDurationNs) ?? '-'}`,
    `total_eval_ms=${nsToMs(meta.totalDurationNs) ?? '-'}`,
    `done_reason=${JSON.stringify(meta.doneReason ?? '-')}`,
  ];

  log(fields.join(' '));
}

async function proxyOllamaRequest(c: Context, path: '/api/chat' | '/api/generate') {
  const rawBody = await c.req.json();

  if (!rawBody || typeof rawBody !== 'object') {
    return jsonError(c, 400, 'Request body must be a JSON object');
  }

  const body = rawBody as Record<string, unknown>;
  const model = body.model;

  if (typeof model !== 'string' || !model) {
    return jsonError(c, 400, 'model is required');
  }

  const resolution = resolveAlias(model, config);
  setRequestMeta(c, {
    requestedModel: resolution.requestedModel,
    targetModel: resolution.upstreamModel,
    thinkDisabled: resolution.disableThinking,
    ...summarizeOpenAIRequestBody(body),
  });

  const upstreamBody = cleanUndefined({
    ...body,
    model: resolution.upstreamModel,
    think: resolution.disableThinking ? false : body.think,
  });

  let upstreamResponse: Response;
  const upstreamStartedAt = Date.now();

  try {
    upstreamResponse = await fetch(`${config.upstreamBaseUrl}${path}`, {
      method: 'POST',
      headers: createUpstreamHeaders(c),
      body: JSON.stringify(upstreamBody),
    });
  } catch (error) {
    return jsonError(c, 503, `Upstream unavailable: ${toErrorMessage(error)}`);
  }

  setRequestMeta(c, {
    upstreamStatus: upstreamResponse.status,
    upstreamHeadersMs: Date.now() - upstreamStartedAt,
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  applyDebugHeaders(
    responseHeaders,
    resolution.requestedModel,
    resolution.upstreamModel,
    resolution.disableThinking,
  );

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

app.use('*', async (c, next) => {
  const startedAt = Date.now();
  requestCounter += 1;
  c.set('requestMeta', {
    requestId: `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`,
  });

  await next();

  const durationMs = Date.now() - startedAt;
  const meta = c.get('requestMeta') ?? {};
  const requestedModel = meta.requestedModel ?? '-';
  const targetModel = meta.targetModel ?? '-';
  const thinkDisabled = meta.thinkDisabled === undefined ? '-' : String(meta.thinkDisabled);
  const note = meta.note ? ` note=${JSON.stringify(meta.note)}` : '';
  const userAgent = JSON.stringify(c.req.header('user-agent') ?? '-');
  const requestId = JSON.stringify(meta.requestId ?? '-');

  log(
    [
      '[proxy]',
      `request_id=${requestId}`,
      `method=${c.req.method}`,
      `path=${c.req.path}`,
      `status=${c.res.status}`,
      `duration_ms=${durationMs}`,
      `requested_model=${JSON.stringify(requestedModel)}`,
      `target_model=${JSON.stringify(targetModel)}`,
      `think_disabled=${thinkDisabled}`,
      `user_agent=${userAgent}${note}`,
    ].join(' '),
  );
});

app.get('/health', async (c) => {
  setRequestMeta(c, { note: 'healthcheck' });
  try {
    const upstreamVersion = await fetchUpstreamVersion(config);
    return c.json({
      ok: true,
      upstreamReachable: true,
      upstreamVersion,
      aliases: config.aliases,
    });
  } catch (error) {
    return jsonStatus(503, {
      ok: false,
      upstreamReachable: false,
      error: toErrorMessage(error),
      aliases: config.aliases,
    });
  }
});

app.get('/api/version', async (c) => {
  setRequestMeta(c, { note: 'version' });
  try {
    const upstreamVersion = await fetchUpstreamVersion(config);
    return c.json({
      proxy: {
        name: 'ollama-nothink-proxy',
        version: '0.1.0',
      },
      upstream: upstreamVersion,
    });
  } catch (error) {
    return jsonError(c, 503, `Upstream unavailable: ${toErrorMessage(error)}`);
  }
});

app.get('/api/tags', async (c) => {
  setRequestMeta(c, { note: 'tags' });
  try {
    const upstreamTags = await fetchUpstreamTags(config);
    return c.json(buildTagsWithAliases(upstreamTags, config));
  } catch (error) {
    return jsonError(c, 503, `Upstream unavailable: ${toErrorMessage(error)}`);
  }
});

app.post('/api/chat', (c) => proxyOllamaRequest(c, '/api/chat'));
app.post('/api/generate', (c) => proxyOllamaRequest(c, '/api/generate'));

app.use('/v1/*', async (c, next) => {
  if (!proxyApiKey) {
    return next();
  }

  const authHeader = c.req.header('authorization');

  if (authHeader !== `Bearer ${proxyApiKey}`) {
    return jsonError(c, 401, 'Invalid API key', 'openai');
  }

  return next();
});

app.get('/v1/models', async (c) => {
  setRequestMeta(c, { note: 'openai_models' });
  try {
    const upstreamTags = await fetchUpstreamTags(config);
    const merged = buildTagsWithAliases(upstreamTags, config);

    return c.json({
      object: 'list',
      data: (merged.models ?? []).map((model) => ({
        id: model.name,
        object: 'model',
        created: 0,
        owned_by: config.aliases[model.name] ? 'ollama-nothink-proxy' : 'ollama',
      })),
    });
  } catch (error) {
    return jsonError(c, 503, `Upstream unavailable: ${toErrorMessage(error)}`, 'openai');
  }
});

app.post('/v1/chat/completions', async (c) => {
  const rawBody = await c.req.json();

  if (!rawBody || typeof rawBody !== 'object') {
    return jsonError(c, 400, 'Request body must be a JSON object', 'openai');
  }

  const body = rawBody as Record<string, unknown>;

  if (typeof body.model !== 'string' || !body.model) {
    return jsonError(c, 400, 'model is required', 'openai');
  }

  const resolution = resolveAlias(body.model, config);
  setRequestMeta(c, {
    requestedModel: resolution.requestedModel,
    targetModel: resolution.upstreamModel,
    thinkDisabled: resolution.disableThinking || body.think === false || body.reasoning_effort === 'none',
    ...summarizeOpenAIRequestBody(body),
  });

  const upstreamRequest = toOllamaChatRequest(
    body as Parameters<typeof toOllamaChatRequest>[0],
    resolution,
  );

  let upstreamResponse: Response;
  const upstreamStartedAt = Date.now();

  try {
    upstreamResponse = await fetch(`${config.upstreamBaseUrl}/api/chat`, {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        accept: body.stream ? 'text/event-stream' : 'application/json',
      }),
      body: JSON.stringify(upstreamRequest),
    });
  } catch (error) {
    return jsonError(c, 503, `Upstream unavailable: ${toErrorMessage(error)}`, 'openai');
  }

  setRequestMeta(c, {
    upstreamStatus: upstreamResponse.status,
    upstreamHeadersMs: Date.now() - upstreamStartedAt,
  });

  if (!upstreamResponse.ok) {
    const upstreamText = await upstreamResponse.text();
    return jsonError(
      c,
      upstreamResponse.status,
      upstreamText || `Upstream returned ${upstreamResponse.status}`,
      'openai',
    );
  }

  if (body.stream) {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const streamStats: StreamDebugStats = {
      chunkCount: 0,
      contentChars: 0,
    };
    const streamStartedAt = Date.now();

    void writeOpenAIStream(upstreamResponse, resolution.requestedModel, writer, streamStats)
      .catch(async (error) => {
        const encoder = new TextEncoder();
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              error: {
                message: toErrorMessage(error),
                type: 'server_error',
              },
            })}\n\n`,
          ),
        );
      })
      .finally(async () => {
        const meta = {
          ...(c.get('requestMeta') ?? {}),
          upstreamBodyMs: Date.now() - streamStartedAt,
          firstChunkMs: streamStats.firstChunkMs,
          streamChunkCount: streamStats.chunkCount,
          responseChars: streamStats.contentChars,
          promptEvalCount: streamStats.promptEvalCount,
          evalCount: streamStats.evalCount,
          totalDurationNs: streamStats.totalDurationNs,
          loadDurationNs: streamStats.loadDurationNs,
          doneReason: streamStats.doneReason,
        };
        c.set('requestMeta', meta);
        logDetailed('stream_complete', meta);
        await writer.close();
      });

    const headers = new Headers({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    applyDebugHeaders(
      headers,
      resolution.requestedModel,
      resolution.upstreamModel,
      resolution.disableThinking,
    );

    return new Response(stream.readable, {
      status: 200,
      headers,
    });
  }

  const upstreamJson = (await upstreamResponse.json()) as Record<string, unknown>;
  const upstreamBodyMs = Date.now() - upstreamStartedAt;
  const openAIResponse = toOpenAINonStreamResponse(
    upstreamJson as Parameters<typeof toOpenAINonStreamResponse>[0],
    resolution.requestedModel,
  );
  const responseContent = ((openAIResponse.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content) ?? '';
  const detailedMeta = {
    ...(c.get('requestMeta') ?? {}),
    upstreamBodyMs,
    responseChars: responseContent.length,
    promptEvalCount: typeof upstreamJson.prompt_eval_count === 'number' ? upstreamJson.prompt_eval_count : undefined,
    evalCount: typeof upstreamJson.eval_count === 'number' ? upstreamJson.eval_count : undefined,
    totalDurationNs: typeof upstreamJson.total_duration === 'number' ? upstreamJson.total_duration : undefined,
    loadDurationNs: typeof upstreamJson.load_duration === 'number' ? upstreamJson.load_duration : undefined,
    doneReason: typeof upstreamJson.done_reason === 'string' ? upstreamJson.done_reason : undefined,
  };
  c.set('requestMeta', detailedMeta);
  logDetailed('completion', detailedMeta);

  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
  });

  applyDebugHeaders(
    headers,
    resolution.requestedModel,
    resolution.upstreamModel,
    resolution.disableThinking,
  );

  return new Response(JSON.stringify(openAIResponse), {
    status: 200,
    headers,
  });
});

app.notFound((c) => jsonError(c, 404, 'Not found'));

app.onError((error, c) => {
  console.error(error);
  return jsonError(c, 500, toErrorMessage(error));
});

serve(
  {
    fetch: app.fetch,
    hostname: config.listenHost,
    port: config.listenPort,
  },
  (info) => {
    console.log(
      `ollama-nothink-proxy listening on http://${info.address}:${info.port} -> ${config.upstreamBaseUrl}`,
    );
  },
);
