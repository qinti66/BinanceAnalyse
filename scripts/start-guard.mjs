// Pure helpers for scripts/start.mjs: which listen address is allowed with which .dev.vars.

export const isLoopback = (host) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/** Parse KEY=VALUE lines (comments and blank lines skipped, optional surrounding quotes removed). */
export function parseVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Why this host/vars combination must not start, or null when it is fine. */
export function refusal(host, vars) {
  if (isLoopback(host)) return null;
  const missing = ["AUTH_USERNAME", "AUTH_PASSWORD", "SESSION_SECRET"].filter((k) => !vars[k]);
  if (missing.length) return `HOST=${host} 会对外监听，但 .dev.vars 缺少 ${missing.join("、")}。API 路由没有别的保护，未配置站点登录时不允许对外监听。`;
  if (vars.SESSION_SECRET.length < 16) return "SESSION_SECRET 至少 16 个字符（建议 32 个以上的随机字符）。";
  return null;
}

export function validPort(port) {
  return /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}
