import { complete, parseConfig } from "../../../../lib/ai/providers";
import { serverConfig } from "../../../../lib/ai/server-config";

// 连通性测试：向选中的模型发一条极小的请求（只让它回复 OK），返回是否成功和耗时。
// 不带 config 时测试服务端环境变量里的配置。密钥不会被记录或回显。
export async function POST(req: Request) {
  let body: { config?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body means: test the server-side config */
  }
  let cfg;
  try {
    cfg = body?.config ? parseConfig(body.config) : serverConfig();
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
  if (!cfg) return Response.json({ ok: false, error: "没有可测试的配置：请先填写模型信息，或配置服务端 ANTHROPIC_API_KEY。" }, { status: 400 });
  const started = Date.now();
  try {
    const reply = await complete(cfg, { system: "你是连通性测试助手。", user: "请只回复两个字母：OK", maxTokens: 20 });
    return Response.json({ ok: true, latencyMs: Date.now() - started, model: cfg.model, reply: reply.slice(0, 60) });
  } catch (e) {
    // 测试失败是"正常的测试结果"，用 200 返回，让页面能直接展示失败原因。
    return Response.json({ ok: false, latencyMs: Date.now() - started, error: (e as Error).message });
  }
}
