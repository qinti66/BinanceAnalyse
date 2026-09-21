// Site login: one account configured in the server environment (.dev.vars), a signed session cookie, no database.
// Enforced only when AUTH_USERNAME is set: local development without it is unchanged. scripts/start.mjs refuses to listen on a non-loopback
// address unless the login is configured, so a public listener is never unauthenticated by accident.

export const COOKIE_NAME = "ar_session";
export const SESSION_TTL_MS = 7 * 86400000;

export interface AuthEnv {
  AUTH_USERNAME?: string;
  AUTH_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export const authEnabled = (e: AuthEnv) => Boolean(e.AUTH_USERNAME);
/** Enabled but unusable (a missing password, or a secret shorter than 16 chars): every request is refused rather than let through. */
export const authMisconfigured = (e: AuthEnv) => authEnabled(e) && (!e.AUTH_PASSWORD || !e.SESSION_SECRET || e.SESSION_SECRET.length < 16);

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string comparison (both sides are hashed first, so the length of the secret is not leaked either). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function checkCredentials(e: AuthEnv, username: string, password: string): Promise<boolean> {
  if (!authEnabled(e) || authMisconfigured(e)) return false;
  // Evaluate both, so a wrong username and a wrong password take the same time.
  const [u, p] = await Promise.all([safeEqual(username, e.AUTH_USERNAME!), safeEqual(password, e.AUTH_PASSWORD!)]);
  return u && p;
}

export async function signSession(secret: string, now = Date.now()): Promise<string> {
  const exp = String(now + SESSION_TTL_MS);
  return exp + "." + (await hmac(secret, exp));
}

export async function verifySession(secret: string | undefined, token: string | undefined | null, now = Date.now()): Promise<boolean> {
  if (!secret || secret.length < 16 || !token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) <= now) return false;
  return safeEqual(token.slice(dot + 1), await hmac(secret, exp));
}

export function cookieValue(header: string | null, name = COOKIE_NAME): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Paths reachable without a session: the login page and its endpoint, plus the static assets the login page needs. */
export const isPublicPath = (path: string) => path === "/login" || path === "/api/login" || path === "/favicon.svg" || path.startsWith("/_next/") || path.startsWith("/assets/");

/** Only same-site relative targets after login; anything else (including //host) falls back to "/". */
export const safeNext = (next: string | null | undefined) => (next && /^\/(?![/\\])/.test(next) ? next : "/");
