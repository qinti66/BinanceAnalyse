import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// Serve data/export/ for download, protected by a token (see scripts/export-server.mjs). Manual start, stop it (Ctrl+C) when the download is done.
//
//   EXPORT_TOKEN=<random, >=16 chars> HOST=0.0.0.0 PORT=8086 node scripts/serve-export.mjs
//
// EXPORT_TOKEN may also be set in .dev.vars. The port must be opened in the cloud firewall by the operator; nothing here opens it.
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createExportServer, MIN_TOKEN_LENGTH } from "./export-server.mjs";
import { parseVars, validPort } from "./start-guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devVars = join(root, ".dev.vars");
const token = process.env.EXPORT_TOKEN || (existsSync(devVars) ? parseVars(readFileSync(devVars, "utf8")).EXPORT_TOKEN : "");
const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || "8086";
if (!token || token.length < MIN_TOKEN_LENGTH) {
  console.error(`需要 EXPORT_TOKEN（至少 ${MIN_TOKEN_LENGTH} 个字符的随机值，不要用站点登录密码）。生成：node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`);
  process.exit(1);
}
if (!validPort(port)) {
  console.error("PORT 必须是 1-65535 的整数，当前：" + port);
  process.exit(1);
}
const dir = join(root, "data", "export");
await mkdir(dir, { recursive: true });
createExportServer({ dir, token }).listen(Number(port), host, () => {
  console.log(`下载服务：http://${host}:${port}/  （用户名 export，密码为 EXPORT_TOKEN；目录 ${dir}；下载完成后 Ctrl+C 停止）`);
});
