import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type AliasConfig = {
  target: string;
  disableThinking: boolean;
};

export type ProxyConfig = {
  upstreamBaseUrl: string;
  listenHost: string;
  listenPort: number;
  logLevel: 'off' | 'debug';
  aliases: Record<string, AliasConfig>;
};

const DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'proxy.config.json');

function ensureString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${name} in config`);
  }

  return value;
}

function ensurePort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('Invalid listenPort in config');
  }

  return value;
}

function parseAliases(value: unknown): Record<string, AliasConfig> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const aliases: Record<string, AliasConfig> = {};

  for (const [alias, rawAliasConfig] of Object.entries(value)) {
    if (!rawAliasConfig || typeof rawAliasConfig !== 'object') {
      throw new Error(`Invalid alias config for ${alias}`);
    }

    const target = ensureString((rawAliasConfig as Record<string, unknown>).target, `aliases.${alias}.target`);
    const disableThinking = Boolean((rawAliasConfig as Record<string, unknown>).disableThinking);

    aliases[alias] = {
      target,
      disableThinking,
    };
  }

  return aliases;
}

export function getRepoRoot(): string {
  return process.cwd();
}

export function getConfigPath(): string {
  return process.env.OLLAMA_NOTHINK_CONFIG
    ? resolve(process.cwd(), process.env.OLLAMA_NOTHINK_CONFIG)
    : DEFAULT_CONFIG_PATH;
}

export function loadConfig(): ProxyConfig {
  const filePath = getConfigPath();
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;

  return {
    upstreamBaseUrl: ensureString(raw.upstreamBaseUrl, 'upstreamBaseUrl').replace(/\/+$/, ''),
    listenHost: ensureString(raw.listenHost, 'listenHost'),
    listenPort: ensurePort(raw.listenPort),
    logLevel: raw.logLevel === 'debug' ? 'debug' : 'off',
    aliases: parseAliases(raw.aliases),
  };
}
