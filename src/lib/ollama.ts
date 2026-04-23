import type { ProxyConfig } from '../config.js';

export type UpstreamTag = {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: Record<string, unknown>;
};

export type UpstreamTagsResponse = {
  models?: UpstreamTag[];
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(3000),
  });

  if (!response.ok) {
    throw new Error(`Upstream request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchUpstreamVersion(config: ProxyConfig): Promise<unknown> {
  return getJson(`${config.upstreamBaseUrl}/api/version`);
}

export async function fetchUpstreamTags(config: ProxyConfig): Promise<UpstreamTagsResponse> {
  return getJson<UpstreamTagsResponse>(`${config.upstreamBaseUrl}/api/tags`);
}

export function buildTagsWithAliases(
  upstreamTags: UpstreamTagsResponse,
  config: ProxyConfig,
): UpstreamTagsResponse {
  const baseModels = upstreamTags.models ?? [];
  const aliasModels = Object.entries(config.aliases).map(([aliasName, aliasConfig]) => {
    const target = baseModels.find(
      (item) => item.name === aliasConfig.target || item.model === aliasConfig.target,
    );

    return {
      ...target,
      name: aliasName,
      model: aliasName,
      details: {
        ...(target?.details ?? {}),
        parent_model: aliasConfig.target,
        proxy_disable_thinking: aliasConfig.disableThinking,
      },
    };
  });

  return {
    ...upstreamTags,
    models: [...baseModels, ...aliasModels],
  };
}
