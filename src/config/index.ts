import type { Config } from '../types';
import { getGlobalConfigPath, getLocalConfigPath } from '../runtime/paths';

export const DEFAULT_CONFIG: Config = {
  heartbeatInterval: 30000,
  maxConcurrency: 3,
  maxRetryAttempts: 3,
  worktreesDir: '.worktrees',
  developBranch: 'main',
  models: {
    lite: 'haiku',
    pro: 'sonnet',
    max: 'opus',
  },
  provider: {},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) {
    return base;
  }
  if (override === null) {
    return override as T;
  }
  if (Array.isArray(base)) {
    return (Array.isArray(override) ? override : base) as T;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      result[key] = key in result
        ? deepMerge(result[key], value)
        : value;
    }
    return result as T;
  }
  return override as T;
}

async function readConfigFile(path: string): Promise<Partial<Config> | undefined> {
  try {
    const content = await Bun.file(path).text();
    return JSON.parse(content) as Partial<Config>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid config JSON: ${path}`);
    }
    return undefined;
  }
}

export async function loadResolvedConfigFromPaths(paths?: {
  globalConfigPath?: string;
  localConfigPath?: string;
}): Promise<Config> {
  const globalConfig = await readConfigFile(paths?.globalConfigPath || getGlobalConfigPath());
  const localConfig = await readConfigFile(paths?.localConfigPath || getLocalConfigPath());
  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), localConfig);
}

export async function loadResolvedConfig(): Promise<Config> {
  return loadResolvedConfigFromPaths();
}

export function resolveStartupMission(savedMission?: string, cliMission?: string): string {
  const mission = cliMission?.trim() || savedMission?.trim() || '';
  if (!mission) {
    throw new Error('Mission is required. Please specify it with --mission.');
  }
  return mission;
}

export function getProviderSdkEnv(config: Pick<Config, 'provider'>): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: config.provider.apiKey,
    ANTHROPIC_BASE_URL: config.provider.baseUrl,
  };
}
