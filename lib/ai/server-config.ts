import { env } from "cloudflare:workers";
import { DEFAULT_MODEL, DEFAULT_ANTHROPIC_BASE, type AiModelConfig } from "./providers";

/** 服务端环境变量里的默认模型配置（本地开发在 .dev.vars 里配置 ANTHROPIC_API_KEY / ANTHROPIC_MODEL）；没配置返回 null。 */
export function serverConfig(): AiModelConfig | null {
  const e = env as Record<string, string | undefined>;
  if (!e.ANTHROPIC_API_KEY) return null;
  return { id: "server", name: "服务端环境变量", protocol: "anthropic", baseUrl: DEFAULT_ANTHROPIC_BASE, model: e.ANTHROPIC_MODEL || DEFAULT_MODEL, apiKey: e.ANTHROPIC_API_KEY };
}
