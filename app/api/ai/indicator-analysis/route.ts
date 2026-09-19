import { complete, parseConfig, AiError, type AiModelConfig } from "../../../../lib/ai/providers";
import { serverConfig } from "../../../../lib/ai/server-config";
import { buildMessages, type IndicatorAiPayload } from "../../../../lib/ai/indicator-analysis";

// 只处理"指标"模块的 AI 解读请求。请求体：{ payload, config? }。
// payload 就是页面上已经展示给用户的那份指标数据；config 是页面上"AI 模型设置"里选中的模型（密钥来自用户自己的浏览器），
// 没传 config 时才回退到服务端环境变量 ANTHROPIC_API_KEY（本地开发用 .dev.vars）。
// 密钥不会被记录，也不会出现在响应里。
const bad = (reason: string, status = 400) => Response.json({ error: reason }, { status });

export async function POST(req: Request) {
  let body: { payload?: Partial<IndicatorAiPayload>; config?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return bad("请求体不是合法 JSON");
  }
  const p = body?.payload;
  if (!p || typeof p.token !== "string" || !p.token || !p.priceChange || !p.oi || !p.direction) return bad("请求体格式不正确：缺少 payload 必需字段");
  let cfg: AiModelConfig | null;
  try {
    cfg = body.config ? parseConfig(body.config) : serverConfig();
  } catch (e) {
    return bad((e as Error).message);
  }
  if (!cfg) return bad("还没有可用的大模型：请在页面「AI 模型设置」里添加一个，或在服务端 .dev.vars 配置 ANTHROPIC_API_KEY。", 503);
  const { system, user } = buildMessages(p as IndicatorAiPayload);
  try {
    const text = await complete(cfg, { system, user });
    return Response.json({ analysis: text, model: cfg.model, modelName: cfg.name, generatedAt: new Date().toISOString() });
  } catch (e) {
    const status = e instanceof AiError && e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    return bad("AI 解读请求失败：" + (e as Error).message, status);
  }
}
