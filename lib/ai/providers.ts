// 大模型调用层：支持 Anthropic 原生接口和 OpenAI 兼容接口（DeepSeek、本地 Ollama 等），直接用 fetch，不引入 SDK。
// 仅供服务端（API 路由）使用。密钥不会写日志、不会出现在返回给客户端的任何内容里（错误信息会先做脱敏）。
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com";
export type Protocol = "anthropic" | "openai";

export interface AiModelConfig {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class AiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AiError";
    this.status = status;
  }
}

/** 校验并规范化 baseUrl：必须是 https；http 只允许本机（方便连本地 Ollama 之类）；不允许 URL 里带账号密码。 */
export function checkBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AiError("接口地址格式不正确：" + raw);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new AiError("接口地址必须是 https；只有 localhost/127.0.0.1 允许使用 http。");
  if (u.username || u.password) throw new AiError("接口地址里不要带账号密码，密钥请填在密钥栏。");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

const redact = (text: string, key: string) => (key ? text.split(key).join("***") : text);

async function errorDetail(res: Response, key: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    const msg = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? "");
    return redact(String(msg).slice(0, 300), key);
  } catch {
    return "";
  }
}

/** 网络层失败（连不上、超时、DNS）统一转成可读的中文错误；运行时抛的底层错误信息不透明，也可能带上不该展示的细节。 */
async function send(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    const name = (e as Error)?.name;
    const host = new URL(url).host;
    if (name === "TimeoutError" || name === "AbortError") throw new AiError("请求 " + host + " 超时（45秒无响应）");
    throw new AiError("无法连接到 " + host + "，请检查接口地址是否正确、服务是否已启动、网络是否可达。");
  }
}

export interface CompleteInput {
  system: string;
  user: string;
  maxTokens?: number;
}

/** 调用模型并返回纯文本。网络/HTTP 错误直接抛出，不静默、不编造回退内容。fetchImpl 仅用于单测注入。 */
export async function complete(cfg: AiModelConfig, input: CompleteInput, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!cfg.apiKey && cfg.protocol === "anthropic") throw new AiError("缺少 API Key");
  if (!cfg.model.trim()) throw new AiError("缺少模型名称");
  const base = checkBaseUrl(cfg.baseUrl);
  const maxTokens = input.maxTokens ?? 800;
  if (cfg.protocol === "anthropic") {
    const res = await send(fetchImpl, base + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model, system: input.system, max_tokens: maxTokens, messages: [{ role: "user", content: input.user }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const d = await errorDetail(res, cfg.apiKey);
      throw new AiError("HTTP " + res.status + (d ? "：" + d : ""), res.status);
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
    if (!text) throw new AiError("模型返回了空内容");
    return text;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = "Bearer " + cfg.apiKey; // 本地模型（如 Ollama）可以不需要密钥
  const res = await send(fetchImpl, base + "/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const d = await errorDetail(res, cfg.apiKey);
    throw new AiError("HTTP " + res.status + (d ? "：" + d : ""), res.status);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new AiError("模型返回了空内容");
  return text;
}

/** 校验客户端传来的配置结构，返回规范化后的配置；不合格抛 AiError（不含密钥内容）。 */
export function parseConfig(raw: unknown): AiModelConfig {
  const c = raw as Partial<AiModelConfig> | null;
  if (!c || typeof c !== "object") throw new AiError("缺少模型配置");
  if (c.protocol !== "anthropic" && c.protocol !== "openai") throw new AiError("协议只能是 anthropic 或 openai");
  if (typeof c.baseUrl !== "string" || typeof c.model !== "string" || typeof c.apiKey !== "string") throw new AiError("接口地址、模型名称、密钥必须是字符串");
  return { id: String(c.id ?? ""), name: String(c.name ?? ""), protocol: c.protocol, baseUrl: c.baseUrl, model: c.model.trim(), apiKey: c.apiKey.trim() };
}
