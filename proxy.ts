import { env } from "cloudflare:workers";
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, authEnabled, authMisconfigured, cookieValue, isPublicPath, verifySession, type AuthEnv } from "./lib/auth/session";

// Login gate for every page and /api route (see lib/auth/session.ts). No AUTH_USERNAME configured: pass through (local development).
export async function proxy(req: NextRequest) {
  const e = env as unknown as AuthEnv;
  if (!authEnabled(e)) return NextResponse.next();
  const path = req.nextUrl.pathname;
  if (authMisconfigured(e)) return new NextResponse("站点登录配置不完整：需要 AUTH_USERNAME、AUTH_PASSWORD 和至少 16 个字符的 SESSION_SECRET。", { status: 503 });
  if (isPublicPath(path)) return NextResponse.next();
  if (await verifySession(e.SESSION_SECRET, cookieValue(req.headers.get("cookie"), COOKIE_NAME))) return NextResponse.next();
  if (path.startsWith("/api/")) return Response.json({ error: "未登录" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "?next=" + encodeURIComponent(path + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
