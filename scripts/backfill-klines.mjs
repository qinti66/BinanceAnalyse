// Backfill klines from /fapi/v1/klines into data/calibration/klines/<interval>/<SYMBOL>.json (git-ignored), by startTime pagination.
//
//   node scripts/backfill-klines.mjs <SYMBOL[,SYMBOL...]> <interval> <startISO> <endISO> [--limit N]
//
// Rows keep Binance's 12 raw columns so they go through the same `toBars` as live data. Each request is charged to the umMarket family by
// its klines weight (limit <= 100: 1, <= 500: 2, <= 1000: 5, above: 10) and the server-reported X-MBX-USED-WEIGHT-1M feeds back into the
// limiter. Boundaries (scripts/binance-net.mjs, scripts/rate-limit.mjs): HTTP 451 stops the run and is never routed around; 429 waits out
// Retry-After and retries a few times; 418 and 403 (web application firewall) abort; nothing works around a limit.
import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight, createGet, RegionBlockedError } from "./binance-net.mjs";
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
    const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${end - 1}&limit=${limit}`;
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

async function main() {
  const [, , symbolsArg, interval, startIso, endIso, ...rest] = process.argv;
  if (!symbolsArg || !interval || !startIso || !endIso) throw new Error("usage: node scripts/backfill-klines.mjs <SYMBOL[,..]> <interval> <startISO> <endISO> [--limit N]");
  const li = rest.indexOf("--limit");
  const limit = li >= 0 ? Number(rest[li + 1]) : DEFAULT_LIMIT;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(root, "data", "calibration", "klines", interval);
  await mkdir(outDir, { recursive: true });
  const { routes, report } = await preflight(["fapi.binance.com"]);
  for (const line of report) console.log(line);
  const get = createGet(routes);
  const limiter = new RateLimiter();
  for (const symbol of symbolsArg.split(",")) {
    const t0 = Date.now();
    const { rows, gaps, requests } = await fetchKlinesRange(get, limiter, symbol, interval, start, end, { limit });
    await writeFile(join(outDir, symbol + ".json"), JSON.stringify({ symbol, interval, start, end, source: "fapi/v1/klines", rows }));
    console.log(`${symbol} ${interval}: ${rows.length} bars, ${requests} requests (limit ${limit}, weight ${klinesWeight(limit)} each), ${gaps.length} gaps, ${Date.now() - t0}ms`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    if (e instanceof RegionBlockedError) console.error("STOPPED: " + e.message);
    else if (e instanceof RateLimitAbort) console.error("ABORTED: " + e.message);
    else console.error("FAILED: " + (e.report ? e.report.join("\n") : e.message));
    process.exitCode = 1;
  });
}
