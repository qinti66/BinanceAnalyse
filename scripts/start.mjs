import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// Start the built site (dist/) with wrangler. Listen address and port come from HOST and PORT (default 127.0.0.1:8787, i.e. local only).
//
//   HOST=0.0.0.0 PORT=8085 npm start
//
// A non-loopback HOST is refused unless the site login is configured in .dev.vars (AUTH_USERNAME, AUTH_PASSWORD, SESSION_SECRET >= 16 chars): the API
// routes have no other protection, so a public listener must never start without it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopback, parseVars, refusal, validPort } from "./start-guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || "8787";
if (!validPort(port)) {
  console.error("PORT 必须是 1-65535 的整数，当前：" + port);
  process.exit(1);
}
const devVarsPath = join(root, ".dev.vars");
const vars = existsSync(devVarsPath) ? parseVars(readFileSync(devVarsPath, "utf8")) : {};
const why = refusal(host, vars);
if (why) {
  console.error(why);
  process.exit(1);
}
// wrangler reads .dev.vars from the directory of --config (dist/server), not from the project root, so the root file (the single source of truth)
// is copied there with owner-only permissions. dist/ is git-ignored.
if (existsSync(devVarsPath)) {
  mkdirSync(join(root, "dist", "server"), { recursive: true });
  writeFileSync(join(root, "dist", "server", ".dev.vars"), readFileSync(devVarsPath), { mode: 0o600 });
}
const args = [
  "--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "dev",
  "--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state",
  "--ip", host, "--port", port, "--inspector-port", "0",
];
const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// Fail closed, checked for real: a listener that is not loopback must actually turn an anonymous page request into a redirect to /login. If the
// worker did not pick up the login variables (the gate would be off), stop it instead of leaving the site open.
if (!isLoopback(host) || process.env.START_VERIFY_LOGIN === "1") {
  const probeUrl = "http://127.0.0.1:" + port + "/indicators";
  const deadline = Date.now() + 120000;
  let verdict = null;
  while (Date.now() < deadline && verdict === null) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await fetch(probeUrl, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      verdict = r.status >= 300 && r.status < 400 && (r.headers.get("location") ?? "").includes("/login");
    } catch {
      /* not listening yet */
    }
  }
  if (verdict !== true) {
    console.error(verdict === false ? "站点登录没有生效（匿名请求没有被重定向到 /login）。为避免对外裸奔，已停止服务。" : "等待服务就绪超时，无法确认站点登录已生效，已停止服务。");
    child.kill("SIGTERM");
    setTimeout(() => process.exit(1), 3000);
  } else {
    console.log("站点登录已确认生效（匿名请求被重定向到 /login）。");
  }
}
