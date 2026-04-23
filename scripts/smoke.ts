import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type ProxyConfig = {
  listenHost: string;
  listenPort: number;
  aliases: Record<string, { target: string }>;
};

async function main() {
  const configPath = resolve(process.cwd(), 'proxy.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as ProxyConfig;
  const baseUrl = `http://${config.listenHost}:${config.listenPort}`;
  const [firstAlias] = Object.keys(config.aliases);

  if (!firstAlias) {
    throw new Error('No aliases configured in proxy.config.json');
  }

  const healthResponse = await fetch(`${baseUrl}/health`);
  if (!healthResponse.ok) {
    throw new Error(`Health check failed with status ${healthResponse.status}`);
  }

  const tagsResponse = await fetch(`${baseUrl}/api/tags`);
  const tagsJson = (await tagsResponse.json()) as { models?: Array<{ name?: string }> };

  if (!tagsJson.models?.some((model) => model.name === firstAlias)) {
    throw new Error(`Alias ${firstAlias} was not found in /api/tags`);
  }

  const chatResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: firstAlias,
      stream: false,
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content: 'Translate to Chinese: Hello world.',
        },
      ],
    }),
  });

  if (!chatResponse.ok) {
    throw new Error(`Chat request failed with status ${chatResponse.status}`);
  }

  const targetModel = chatResponse.headers.get('x-ollama-proxy-target-model');
  const thinkDisabled = chatResponse.headers.get('x-ollama-proxy-think-disabled');
  const chatJson = await chatResponse.json();

  console.log(JSON.stringify({
    ok: true,
    alias: firstAlias,
    targetModel,
    thinkDisabled,
    response: chatJson,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
