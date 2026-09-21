// Download monthly files from Binance's official public archive (data.binance.vision), verify each against its published SHA256, and merge
// them into one JSON per symbol. The archive is static files, not the API: it does not spend API request budget and is not behind the API's firewall.
//
//   node scripts/fetch-archive.mjs klines      <outDir> <SYM[,SYM..]> <1h|4h|...> <YYYY-MM> <YYYY-MM>
//   node scripts/fetch-archive.mjs fundingRate <outDir> <SYM[,SYM..]> <YYYY-MM> <YYYY-MM>
//
// AUTHORISATION: every batch of downloads needs the user's explicit approval in the session that runs it. This script never decides what to
// download; it does exactly what its arguments say. Approved batch (2026-09-21): the 20 W1 coins' 4h (2025-06..11) and 1h (2025-08), BTCUSDT 1h
// (2024-08..2025-11), and a single fundingRate file to see whether the archive offers one.
//
// Extraction: Windows uses C:/Windows/System32/tar.exe (bsdtar; the Git-Bash GNU tar reads "C:" as a remote host and cannot do zip). Linux/macOS: GNU tar
// cannot extract zip either, so `unzip` is tried first, then `bsdtar`; if neither is installed the run fails with a message saying so.
import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = "https://data.binance.vision/data/futures/um/monthly";
export const EXTRACTORS =
  process.platform === "win32"
    ? [["C:/Windows/System32/tar.exe", ["-xf"]]]
    : [["unzip", ["-oq"]], ["bsdtar", ["-xf"]]];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** ["2025-06", ..., "2025-11"] for from = "2025-06", to = "2025-11" (inclusive). */
export function months(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  if (![fy, fm, ty, tm].every(Number.isInteger) || fm < 1 || fm > 12 || tm < 1 || tm > 12) throw new Error("bad month range " + from + ".." + to);
  const out = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) out.push(`${y}-${String(m).padStart(2, "0")}`);
  return out;
}

/** Kline CSV -> raw 12-column rows. Skips a header row; requires 13-digit millisecond open times. */
export function parseKlinesCsv(csv) {
  const rows = [];
  for (const line of csv.split(/\r?\n/)) {
    const f = line.split(",");
    if (f.length < 11 || !/^\d{13}$/.test(f[0])) continue;
    rows.push([Number(f[0]), f[1], f[2], f[3], f[4], f[5], Number(f[6]), f[7], Number(f[8]), f[9], f[10], f[11] ?? "0"]);
  }
  return rows;
}

/** fundingRate CSV (calc_time, funding_interval_hours, last_funding_rate) -> [{time, rate, intervalHours}]. */
export function parseFundingCsv(csv) {
  const rows = [];
  for (const line of csv.split(/\r?\n/)) {
    const f = line.split(",");
    if (f.length < 3 || !/^\d{13}$/.test(f[0])) continue;
    rows.push({ time: Number(f[0]), intervalHours: Number(f[1]), rate: Number(f[2]) });
  }
  return rows;
}

/** The archive publishes "<sha256>  <file name>". */
export function checksumMatches(buf, checksumText) {
  const want = String(checksumText).trim().split(/\s+/)[0]?.toLowerCase();
  return !!want && createHash("sha256").update(buf).digest("hex") === want;
}

async function fetchVerified(url, paceMs) {
  await wait(paceMs);
  const [z, c] = await Promise.all([fetch(url, { signal: AbortSignal.timeout(30000) }), fetch(url + ".CHECKSUM", { signal: AbortSignal.timeout(30000) })]);
  if (z.status === 404) return { status: "missing", buf: null };
  if (!z.ok || !c.ok) return { status: "http " + z.status + "/" + c.status, buf: null };
  const buf = Buffer.from(await z.arrayBuffer());
  return checksumMatches(buf, await c.text()) ? { status: "ok", buf } : { status: "CHECKSUM MISMATCH", buf: null };
}

async function unzipCsv(buf, dir, name) {
  await writeFile(join(dir, name + ".zip"), buf);
  let last = null;
  for (const [cmd, args] of EXTRACTORS) {
    try {
      execFileSync(cmd, [...args, name + ".zip"], { cwd: dir, stdio: "pipe" });
      last = null;
      break;
    } catch (e) {
      last = e;
    }
  }
  if (last) {
    const missing = last.code === "ENOENT";
    throw new Error(
      missing && process.platform !== "win32"
        ? "需要 unzip 或 bsdtar 来解压归档文件。Ubuntu/Debian 执行：sudo apt install unzip（RHEL/CentOS：sudo yum install unzip）。"
        : "解压 " + name + ".zip 失败（已尝试 " + EXTRACTORS.map(([c]) => c).join("、") + "）：" + last.message,
    );
  }
  return readFile(join(dir, name + ".csv"), "utf8");
}

async function main() {
  const [, , kind, outDir, symbolsArg, ...rest] = process.argv;
  if (!["klines", "fundingRate"].includes(kind) || !outDir || !symbolsArg) throw new Error("usage: see the header of scripts/fetch-archive.mjs");
  const [interval, from, to] = kind === "klines" ? rest : [null, ...rest];
  const ms = months(from, to);
  await mkdir(outDir, { recursive: true });
  let bytes = 0;
  const problems = [];
  for (const symbol of symbolsArg.split(",")) {
    const rows = [];
    for (const month of ms) {
      const name = kind === "klines" ? `${symbol}-${interval}-${month}` : `${symbol}-fundingRate-${month}`;
      const url = kind === "klines" ? `${BASE}/klines/${symbol}/${interval}/${name}.zip` : `${BASE}/fundingRate/${symbol}/${name}.zip`;
      const r = await fetchVerified(url, 150);
      if (r.status !== "ok") {
        problems.push(`${name}: ${r.status}`);
        continue;
      }
      bytes += r.buf.length;
      const csv = await unzipCsv(r.buf, outDir, name);
      rows.push(...(kind === "klines" ? parseKlinesCsv(csv) : parseFundingCsv(csv)));
    }
    rows.sort((a, b) => (kind === "klines" ? a[0] - b[0] : a.time - b.time));
    const file = join(outDir, kind === "klines" ? `${symbol}-${interval}.json` : `${symbol}-fundingRate.json`);
    await writeFile(file, JSON.stringify({ symbol, kind, interval, from, to, source: "data.binance.vision futures/um monthly, sha256-verified", rows }));
    console.log(`${symbol} ${kind}${interval ? " " + interval : ""}: ${rows.length} rows from ${ms.length} month(s)`);
  }
  console.log(`downloaded ${(bytes / 1e6).toFixed(2)} MB; problems: ${problems.length ? problems.join(" | ") : "none"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("FAILED: " + e.message);
    process.exitCode = 1;
  });
}
