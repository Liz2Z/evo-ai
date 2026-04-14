// Auto-generated
import { Settings } from "./core";
import { configSchema } from "./schemas";

export type { Config } from "./schemas";
export * from "./core";
export * from "./errors";
export * from "./models";
export * from "./schemas";

const manager = new Settings("evo-ai", configSchema);
manager.load();

/**
 * 全局 settings accessor，通过 Proxy 延迟读取
 * 用法: settings.provider.apiKey.get(), settings.maxConcurrency.set(5)
 */
export const settings = manager.getAccessor();
