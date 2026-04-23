import type { ProxyConfig } from '../config.js';

export type AliasResolution = {
  requestedModel: string;
  upstreamModel: string;
  disableThinking: boolean;
  aliasMatched: boolean;
};

export function resolveAlias(model: string, config: ProxyConfig): AliasResolution {
  const alias = config.aliases[model];

  if (!alias) {
    return {
      requestedModel: model,
      upstreamModel: model,
      disableThinking: false,
      aliasMatched: false,
    };
  }

  return {
    requestedModel: model,
    upstreamModel: alias.target,
    disableThinking: alias.disableThinking,
    aliasMatched: true,
  };
}
