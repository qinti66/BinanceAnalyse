// Backfill funding-rate history from /fapi/v1/fundingRate into data/calibration/funding/<SYMBOL>.json (git-ignored).
//
//   node scripts/backfill-funding.mjs <raw-snapshot.json> <startISO> <endISO> [--limit-symbols N]
//
// Population: UM USDT perpetuals in the snapshot that were listed at least 30 days before <startISO>, so the trailing 30-day window
// exists from the first evaluation point. Resumable: a symbol whose file already exists is skipped.
//
// Boundaries (see scripts/binance-net.mjs): the route is chosen by the preflight and printed; HTTP 451 stops the run at once and is never
// routed around; HTTP 418/429/403 stops the run (limits and the web firewall are obeyed, not worked around) and the partial progress is kept.
// Observed 2026-09-20: one HTTP 403 (an HTML firewall page) after ~126 symbols at 800 ms pacing; the next requests were fine. The pace was
// then halved. If a 403 happens again, stop for good and report instead of resuming.
import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight, createGet, RegionBlockedError } from "./binance-net.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const PAGE = 1000;
/** fundingRate shares a 500 requests / 5 min / IP budget. 1500 ms between requests is 200 per 5 min, well inside it (was 800 ms until a 403). */
export const PACE_MS = 1500;

export class RateLimitedError extends Error {
  constructor(status, retryAfter) {
    super(`HTTP ${status} (${status === 403 ? "web firewall limit" : "rate limit"}). Stopping; not retrying past it.${retryAfter ? " Retry-After " + retryAfter + "s." : ""}`);
    this.name = "RateLimitedError";
    this.status = status;
  }
}

/**
 * All settlements of `symbol` in [start, end), oldest first, paginated by startTime. `get` is a createGet-style function and `sleep`
 * is injectable. Throws RateLimitedError on 418/429 (no retry) and Error on any other non-200.
 */
export async function fetchFundingRange(get, symbol, start, end, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = PACE_MS } = {}) {
  const rows = [];
  let cursor = start;
  for (let page = 0; page < 200; page++) {
    const r = await get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${end - 1}&limit=${PAGE}`);
    if (r.status === 418 || r.status === 429 || r.status === 403) throw new RateLimitedError(r.status, r.headers["retry-after"]);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${symbol}: ${r.text.slice(0, 120)}`);
    const batch = r.json();
    if (!Array.isArray(batch)) throw new Error("unexpected response for " + symbol);
    for (const x of batch) rows.push({ time: Number(x.fundingTime), rate: Number(x.fundingRate) });
    if (batch.length < PAGE) break;
    const next = Number(batch[batch.length - 1].fundingTime) + 1;
    if (!(next > cursor)) throw new Error("pagination did not advance for " + symbol);
    cursor = next;
    await sleep(paceMs);
  }
  const seen = new Set();
  return rows.filter((x) => Number.isFinite(x.time) && Number.isFinite(x.rate) && (seen.has(x.time) ? false : seen.add(x.time))).sort((a, b) => a.time - b.time);
}

export function population(raw, start) {
  return raw.contracts
    .filter((c) => c.contract.family === "UM" && c.contract.quoteAsset === "USDT" && c.contract.contractType === "PERPETUAL" && c.contract.onboardDate < start - 30 * DAY)
    .map((c) => c.contract.symbol)
    .sort();
}

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  const [, , rawPath, startIso, endIso, ...rest] = process.argv;
  if (!rawPath || !startIso || !endIso) throw new Error("usage: node scripts/backfill-funding.mjs <raw.json> <startISO> <endISO> [--limit-symbols N]");
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const limitIdx = rest.indexOf("--limit-symbols");
  const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1]) : Infinity;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(root, "data", "calibration", "funding");
  await mkdir(outDir, { recursive: true });
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  const symbols = population(raw, start).slice(0, limit);

  const { routes, report } = await preflight(["fapi.binance.com"]);
  for (const line of report) console.log(line);
  const get = createGet(routes);

  let done = 0;
  let skipped = 0;
  let requests = 0;
  const started = Date.now();
  console.log(`funding backfill: ${symbols.length} symbols, ${startIso} -> ${endIso}, pacing ${PACE_MS}ms`);
  for (const symbol of symbols) {
    const file = join(outDir, symbol + ".json");
    if (await exists(file)) {
      skipped++;
      continue;
    }
    const counting = async (url) => {
      requests++;
      return get(url);
    };
    const rows = await fetchFundingRange(counting, symbol, start, end);
    await writeFile(file, JSON.stringify({ symbol, start, end, source: "fapi/v1/fundingRate", rows }));
    done++;
    await new Promise((r) => setTimeout(r, PACE_MS));
    if (done % 25 === 0) console.log(`  ${done + skipped}/${symbols.length} symbols, ${requests} requests, ${Math.round((Date.now() - started) / 1000)}s`);
  }
  console.log(`done: ${done} fetched, ${skipped} already present, ${requests} requests in ${Math.round((Date.now() - started) / 1000)}s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    if (e instanceof RegionBlockedError) console.error("STOPPED: " + e.message);
    else if (e instanceof RateLimitedError) console.error("STOPPED: " + e.message + " Partial progress is kept; rerun later to resume.");
    else console.error("FAILED: " + (e.report ? e.report.join("\n") : e.message));
    process.exitCode = 1;
  });
}
