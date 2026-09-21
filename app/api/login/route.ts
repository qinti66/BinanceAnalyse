import { env } from "cloudflare:workers";
import { COOKIE_NAME, SESSION_TTL_MS, authMisconfigured, checkCredentials, safeNext, signSession, type AuthEnv } from "../../../lib/auth/session";

// Failed attempts per client address, kept in this isolate's memory: 5 failures lock that address for 15 minutes. Best effort (a restart clears it).
const failures = new Map<string, { n: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60000;

export async function POST(req: Request) {
  const e = env as unknown as AuthEnv;
  if (!e.AUTH_USERNAME || authMisconfigured(e)) return Response.json({ error: "站点登录未配置" }, { status: 503 });
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.n >= MAX_FAILURES && f.until > now) return Response.json({ error: "尝试次数过多，请 15 分钟后再试" }, { status: 429 });
  let body: { username?: unknown; password?: unknown; next?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "请求格式不对" }, { status: 400 });
  }
  const ok = typeof body.username === "string" && typeof body.password === "string" && (await checkCredentials(e, body.username, body.password));
  if (!ok) {
    const n = (f && f.until > now ? f.n : 0) + 1;
    failures.set(ip, { n, until: now + LOCK_MS });
    return Response.json({ error: "用户名或密码不对" }, { status: 401 });
  }
  failures.delete(ip);
  const token = await signSession(e.SESSION_SECRET!);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true, next: safeNext(typeof body.next === "string" ? body.next : null) }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}` },
  });
}
