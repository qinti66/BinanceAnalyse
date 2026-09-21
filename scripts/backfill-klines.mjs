// Backfill klines from /fapi/v1/klines into data/calibration/klines/<interval>/<SYMBOL>.json (git-ignored), by startTime pagination.
//
//   node scripts/backfill-klines.mjs <SYMBOL[,SYMBOL...]|@symbols-file> <interval> <startISO> <endISO> [--limit N]
//
// "@file" reads the symbols from a file (scripts/list-symbols.mjs writes data/calibration/symbols.txt). Resumable: a symbol whose file already
// exists for the same interval and start that already reaches the end is skipped, so a run stopped by a limit or the firewall can be started again
// with the same command. Moving <endISO> forward fetches only the new tail of each file (see backfill-range.mjs), not everything again.
// <endISO> must sit on a bar boundary (e.g. 00:00 for 4h), so the last bar is a closed candle.
//
// Rows keep Binance's 12 raw columns so they go through the same `toBars` as live data. Each request is charged to the umMarket family by
// its klines weight (limit <= 100: 1, <= 500: 2, <= 1000: 5, above: 10) and the server-reported X-MBX-USED-WEIGHT-1M feeds back into the
// limiter. Boundaries (scripts/binance-net.mjs, scripts/rate-limit.mjs): HTTP 451 stops the run and is never routed around; 429 waits out
// Retry-After and retries a few times; 418 and 403 (web application firewall) abort; nothing works around a limit.
import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight, createGet, RegionBlockedError } from "./binance-net.mjs";
import { readSymbolsArg } from "./symbols.mjs";
import { planRange, mergeRows, gapsOf, endIsAligned } from "./backfill-range.mjs";
import { RateLimiter, RateLimitAbort, klinesWeight } from "./rate-limit.mjs";

export const INTERVAL_MS = { "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const MAX_429_RETRIES = 3;
/**
 * limit 500 is request weight 2, limit 1500 is weight 10: per bar, 500 costs 0.004 and 1500 costs 0.0067, so 500 is the default for deep backfills.
 * Unknown: whether Binance's web firewall counts requests or traffic. If a firewall 403 recurs once collection resumes, the FIRST variable to try
 * is --limit 1500 (fewer requests); record the outcome either way.
 */
export const DEFAULT_LIMIT = 500;

/**
 * All klines of `symbol` with openTime in [start, end), oldest first. `get` is a createGet-style function. Returns { rows, gaps, requests }
 * where `gaps` lists any place consecutive openTimes are not exactly one interval apart (a hole in the exchange's own data, reported, never filled).
 */
export async function fetchKlinesRange(get, limiter, symbol, interval, start, end, { limit = DEFAULT_LIMIT, base = "https://fapi.binance.com" } = {}) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error("unsupported interval " + interval);
  if (!(limit >= 1 && limit <= 1500)) throw new Error("limit must be 1..1500");
  const rows = [];
  let cursor = start;
  let requests = 0;
  for (let page = 0; page < 10000 && cursor < end; page++) {
    const url = `${base}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${end - 1}&limit=${limit}`;
    let r;
    for (let attempt = 0; ; attempt++) {
      await limiter.acquire("umMarket", klinesWeight(limit));
      r = await get(url);
      requests++;
      if (r.status !== 429) break;
      limiter.onStatus(429, r.headers["retry-after"]);
      if (attempt >= MAX_429_RETRIES) throw new Error(`HTTP 429 after ${MAX_429_RETRIES} retries for ${symbol}`);
    }
    if (r.status === 418 || r.status === 403) limiter.onStatus(r.status);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${symbol}: ${r.text.slice(0, 120)}`);
    const used = Number(r.headers["x-mbx-used-weight-1m"]);
    if (Number.isFinite(used)) limiter.feedback("umMarket", used);
    const batch = r.json();
    if (!Array.isArray(batch)) throw new Error("unexpected response for " + symbol);
    rows.push(...batch);
    if (batch.length < limit) break;
    const next = Number(batch[batch.length - 1][0]) + step;
    if (!(next > cursor)) throw new Error("pagination did not advance for " + symbol);
    cursor = next;
  }
  const seen = new Set();
  const out = rows.filter((k) => Number(k[0]) >= start && Number(k[0]) < end && (seen.has(k[0]) ? false : seen.add(k[0]))).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  for (let i = 1; i < out.length; i++) if (out[i][0] - out[i - 1][0] !== step) gaps.push({ after: out[i - 1][0], next: out[i][0] });
  return { rows: out, gaps, requests };
}

async function readExisting(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** True when the file already covers the request (same start and interval, reaches the end, has bars). */
export async function alreadyDone(path, interval, start, end) {
  return planRange(await readExisting(path), { interval, start, end }).action === "skip";
}

/** One symbol: skip, fetch everything, or fetch only the tail and merge it into the existing file. Returns { action, rows, gaps, requests, added }. */
export async function backfillSymbol({ get, limiter, target, symbol, interval, start, end, limit }) {
  const existing = await readExisting(target);
  const plan = planRange(existing, { interval, start, end });
  if (plan.action === "skip") return { action: "skip" };
  const fetched = await fetchKlinesRange(get, limiter, symbol, interval, plan.action === "extend" ? plan.from : start, end, { limit });
  const rows = plan.action === "extend" ? mergeRows(existing.rows, fetched.rows, (r) => r[0]) : fetched.rows;
  await writeFile(target + ".tmp", JSON.stringify({ symbol, interval, start, end, source: "fapi/v1/klines", rows }));
  await rename(target + ".tmp", target);
  return { action: plan.action, rows, gaps: gapsOf(rows, INTERVAL_MS[interval]), requests: fetched.requests, added: fetched.rows.length };
}

async function main() {
  const [, , symbolsArg, interval, startIso, endIso, ...rest] = process.argv;
  if (!symbolsArg || !interval || !startIso || !endIso) throw new Error("usage: node scripts/backfill-klines.mjs <SYMBOL[,..]> <interval> <startISO> <endISO> [--limit N]");
  const li = rest.indexOf("--limit");
  const limit = li >= 0 ? Number(rest[li + 1]) : DEFAULT_LIMIT;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!INTERVAL_MS[interval]) throw new Error("unsupported interval " + interval);
  if (!Number.isFinite(start) || !endIsAligned(end, INTERVAL_MS[interval]) || !endIsAligned(start, INTERVAL_MS[interval]) || !(end > start) || end > Date.now()) {
    throw new Error("<startISO> and <endISO> must be valid, start < end <= now, and both on a " + interval + " bar boundary (the last bar must be a closed candle)");
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(root, "data", "calibration", "klines", interval);
  await mkdir(outDir, { recursive: true });
  const { routes, report } = await preflight(["fapi.binance.com"]);
  for (const line of report) console.log(line);
  const get = createGet(routes);
  const limiter = new RateLimiter();
  const symbols = await readSymbolsArg(symbolsArg);
  let skipped = 0;
  for (const symbol of symbols) {
    const t0 = Date.now();
    const r = await backfillSymbol({ get, limiter, target: join(outDir, symbol + ".json"), symbol, interval, start, end, limit });
    if (r.action === "skip") {
      skipped++;
      continue;
    }
    console.log(`${symbol} ${interval}: ${r.action === "extend" ? "+" + r.added + " new, " : ""}${r.rows.length} bars, ${r.requests} requests (limit ${limit}, weight ${klinesWeight(limit)} each), ${r.gaps.length} gaps, ${Date.now() - t0}ms`);
  }
  console.log(`done: ${symbols.length - skipped} fetched, ${skipped} already present (skipped)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    if (e instanceof RegionBlockedError) console.error("STOPPED: " + e.message);
    else if (e instanceof RateLimitAbort) console.error("ABORTED: " + e.message);
    else console.error("FAILED: " + (e.report ? e.report.join("\n") : e.message));
    process.exitCode = 1;
  });
}
