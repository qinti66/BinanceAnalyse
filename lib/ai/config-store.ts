// 浏览器端的"已添加大模型"列表，存 localStorage（只在你自己的浏览器里，不上传、不写文件）。
// 注意：localStorage 里的密钥是明文，同一浏览器里的其它脚本理论上能读到——本工具只在本机使用，这是可接受的取舍；
// 不要在公共电脑上保存密钥。用 useSyncExternalStore 读取，getSnapshot 在值不变时返回同一引用。
import type { AiModelConfig } from "./providers";

export const AI_STORE_KEY = "alpha-ai-models-v1";
export interface AiStoreState {
  configs: AiModelConfig[];
  activeId: string | null;
}
export const EMPTY_AI_STATE: AiStoreState = { configs: [], activeId: null };

const listeners = new Set<() => void>();
let cache: { raw: string; value: AiStoreState } | null = null;

export function parseStore(raw: string): AiStoreState {
  try {
    const s = JSON.parse(raw) as Partial<AiStoreState>;
    const configs = (Array.isArray(s.configs) ? s.configs : []).filter(
      (c): c is AiModelConfig => !!c && typeof c.id === "string" && (c.protocol === "anthropic" || c.protocol === "openai") && typeof c.baseUrl === "string" && typeof c.model === "string" && typeof c.apiKey === "string" && typeof c.name === "string"
    );
    const activeId = typeof s.activeId === "string" && configs.some((c) => c.id === s.activeId) ? s.activeId : (configs[0]?.id ?? null);
    return { configs, activeId };
  } catch {
    return EMPTY_AI_STATE;
  }
}

export function readAiStore(): AiStoreState {
  let raw = "";
  try {
    raw = localStorage.getItem(AI_STORE_KEY) ?? "";
  } catch {
    return EMPTY_AI_STATE;
  }
  if (!raw) return EMPTY_AI_STATE;
  if (cache && cache.raw === raw) return cache.value;
  const value = parseStore(raw);
  cache = { raw, value };
  return value;
}

export function writeAiStore(next: AiStoreState): boolean {
  try {
    localStorage.setItem(AI_STORE_KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  listeners.forEach((l) => l());
  return true;
}

export function subscribeAiStore(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export const activeConfig = (s: AiStoreState): AiModelConfig | null => s.configs.find((c) => c.id === s.activeId) ?? null;
export const maskKey = (k: string) => (k.length <= 8 ? "已填写" : k.slice(0, 4) + "…" + k.slice(-4));
