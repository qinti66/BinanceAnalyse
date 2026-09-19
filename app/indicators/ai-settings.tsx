"use client";
import { useState } from "react";
import { Bot, Check, Trash2, Zap } from "lucide-react";
import type { AiModelConfig, Protocol } from "@/lib/ai/providers";
import { maskKey, writeAiStore, type AiStoreState } from "@/lib/ai/config-store";

type TestResult = { ok: boolean; latencyMs?: number; model?: string; reply?: string; error?: string };
const PRESETS: Record<string, { label: string; protocol: Protocol; baseUrl: string; model: string }> = {
  anthropic: { label: "Anthropic（Claude）", protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" },
  openai: { label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "" },
  deepseek: { label: "DeepSeek（OpenAI 兼容）", protocol: "openai", baseUrl: "https://api.deepseek.com", model: "" },
  ollama: { label: "本地 Ollama（OpenAI 兼容）", protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "" },
  custom: { label: "自定义（OpenAI 兼容）", protocol: "openai", baseUrl: "", model: "" },
};
const uid = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function testConfig(cfg: AiModelConfig | null): Promise<TestResult> {
  try {
    const r = await fetch("/api/ai/test-connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg ? { config: cfg } : {}), signal: AbortSignal.timeout(60000) });
    return (await r.json()) as TestResult;
  } catch (e) {
    return { ok: false, error: "请求本机服务失败：" + (e as Error).message };
  }
}

export function AiModelSettings({ state }: { state: AiStoreState }) {
  const [preset, setPreset] = useState("anthropic");
  const [draft, setDraft] = useState({ name: "", baseUrl: PRESETS.anthropic.baseUrl, model: PRESETS.anthropic.model, apiKey: "" });
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});
  const [note, setNote] = useState("");
  const p = PRESETS[preset];
  const draftReady = draft.baseUrl.trim() && draft.model.trim() && (draft.apiKey.trim() || preset === "ollama");

  function pick(v: string) {
    setPreset(v);
    setDraft((d) => ({ ...d, baseUrl: PRESETS[v].baseUrl, model: PRESETS[v].model }));
  }
  const draftConfig = (): AiModelConfig => ({ id: uid(), name: draft.name.trim() || p.label + " · " + draft.model.trim(), protocol: p.protocol, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKey: draft.apiKey.trim() });
  function save(next: AiStoreState) {
    if (!writeAiStore(next)) setNote("浏览器不允许保存设置，本次改动未保存。");
  }
  function add() {
    const cfg = draftConfig();
    save({ configs: [...state.configs, cfg], activeId: state.activeId ?? cfg.id });
    setDraft((d) => ({ ...d, name: "", apiKey: "" }));
    setNote("已添加「" + cfg.name + "」，可以点“测试连通”确认。");
  }
  async function run(key: string, cfg: AiModelConfig | null) {
    setTests((t) => ({ ...t, [key]: "running" }));
    const res = await testConfig(cfg);
    setTests((t) => ({ ...t, [key]: res }));
  }
  const show = (t?: TestResult | "running") => (t === "running" ? <span className="sq-muted">测试中…</span> : t ? (t.ok ? <span className="sq-up">连通 ✓ {t.latencyMs}ms · 回复：{t.reply}</span> : <span className="sq-down">失败：{t.error}</span>) : null);

  return (
    <section className="sq-card sq-detail im-ai" aria-label="AI 模型设置">
      <div className="sq-row">
        <div>
          <span className="sq-kicker">AI 模型设置</span>
          <h2>
            <Bot size={18} style={{ display: "inline", marginRight: 6 }} />
            添加并测试大模型
          </h2>
        </div>
        <button className="sq-button" onClick={() => run("server", null)} disabled={tests.server === "running"}>
          <Zap size={15} />
          测试服务端默认配置
        </button>
      </div>
      <p className="sq-note">支持 Anthropic 和 OpenAI 兼容接口（DeepSeek、本地 Ollama 等）。密钥只保存在你这个浏览器里（localStorage，明文），点击“AI 解读”时经本机服务转发给模型厂商，不写日志、不写文件、不回显。不要在公共电脑上保存密钥。{show(tests.server) && <> 服务端默认配置：{show(tests.server)}</>}</p>
      {state.configs.length > 0 && (
        <div className="sq-scroll">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>协议 / 接口地址</th>
                <th>模型</th>
                <th>密钥</th>
                <th>连通测试</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {state.configs.map((c) => (
                <tr key={c.id} className={state.activeId === c.id ? "sq-selected" : ""}>
                  <td>
                    {c.name}
                    {state.activeId === c.id && <small className="sq-up">当前使用</small>}
                  </td>
                  <td>
                    {c.protocol === "anthropic" ? "Anthropic" : "OpenAI 兼容"}
                    <small>{c.baseUrl}</small>
                  </td>
                  <td>{c.model}</td>
                  <td>{c.apiKey ? maskKey(c.apiKey) : "未填（本地模型可不填）"}</td>
                  <td style={{ whiteSpace: "normal", maxWidth: 320 }}>{show(tests[c.id]) ?? <span className="sq-muted">尚未测试</span>}</td>
                  <td>
                    <div className="cp-marks">
                      <button className="sq-button" disabled={tests[c.id] === "running"} onClick={() => run(c.id, c)}>
                        测试连通
                      </button>
                      <button className="sq-button" disabled={state.activeId === c.id} onClick={() => save({ ...state, activeId: c.id })}>
                        <Check size={14} />
                        设为当前
                      </button>
                      <button
                        className="sq-button"
                        aria-label={"删除 " + c.name}
                        onClick={() => {
                          const configs = state.configs.filter((x) => x.id !== c.id);
                          save({ configs, activeId: state.activeId === c.id ? (configs[0]?.id ?? null) : state.activeId });
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="cp-tageditor" style={{ alignItems: "end" }}>
        <label className="sq-field">
          <span>类型</span>
          <select className="sq-select" aria-label="模型类型" value={preset} onChange={(e) => pick(e.target.value)}>
            {Object.entries(PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sq-field">
          <span>接口地址</span>
          <input aria-label="接口地址" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://…" />
        </label>
        <label className="sq-field">
          <span>模型名称</span>
          <input aria-label="模型名称" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="例如 claude-sonnet-5" />
        </label>
        <label className="sq-field">
          <span>API Key</span>
          <input aria-label="API Key" type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder={preset === "ollama" ? "本地模型可不填" : "sk-…"} />
        </label>
        <label className="sq-field">
          <span>名称（可选）</span>
          <input aria-label="名称" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="自己认得出来就行" />
        </label>
        <button className="sq-button" disabled={!draftReady || tests.draft === "running"} onClick={() => run("draft", draftConfig())}>
          先测试
        </button>
        <button className="sq-button sq-primary" disabled={!draftReady} onClick={add}>
          添加
        </button>
      </div>
      {(show(tests.draft) || note) && (
        <p className="sq-note">
          {show(tests.draft)} {note}
        </p>
      )}
    </section>
  );
}
