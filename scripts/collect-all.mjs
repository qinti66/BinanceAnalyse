// One command, run on the server, that does the whole routine collection: live indicators snapshot (universe, ticker/funding/premium snapshot,
// positions history append) + extend the calibration klines (1h, 4h) and funding history for every currently-trading UM USDT perpetual up to now.
//
//   node scripts/collect-all.mjs
//
// This is a THIN ORCHESTRATOR: every safety rule already lives in the scripts it calls and is not touched here.
//   - collect-indicators.mjs: universe, live snapshot, positions T2 store (its own rate limiter, its own 403/418/429 handling).
//   - backfill-klines.mjs (backfillSymbol): resumable "extend the tail" logic, its own rate limiter, 451/418/403 stop the whole run.
//   - backfill-funding.mjs (backfillFundingSymbol): resumable, stops hard on 418/429/403, never retries past a limit.
//   - binance-net.mjs preflight(): direct connection on the server (no HTTPS_PROXY there), the existing route-selection logic covers it.
//
// Manually triggered ONLY. On HTTP 403/418/429/451 from any stage, that stage stops (its own script's existing behaviour) and this orchestrator
// reports it and moves on to the NEXT independent stage rather than aborting everything -- klines failing must not skip the positions store, and
// vice versa -- but it never retries past a block and never falls back to a workaround. No scheduler is invoked from inside this file; a periodic
// trigger, if the user wants one, is a separate cron entry that calls this same command and is documented in scripts/README-collect-all.md.
import "./require-node.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight, createGet, RegionBlockedError } from "./binance-net.mjs";
import { RateLimiter } from "./rate-limit.mjs";
import { backfillSymbol, INTERVAL_MS } from "./backfill-klines.mjs";
import { backfillFundingSymbol, population, RateLimitedError, PACE_MS } from "./backfill-funding.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86400000;
const now = Date.now();
const started = new Date(now).toISOString();
const report = { startedAt: started, stages: {} };

function say(line) {
  console.log(line);
}

// --- Stage 1: live indicators snapshot (universe + ticker/funding/premium + positions T2 store) -------------------------------------------------
say("== stage 1/3: live indicators snapshot (collect-indicators.mjs) ==");
try {
  const out = execFileSync(process.execPath, [join(root, "scripts", "collect-indicators.mjs")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const lines = out.trim().split("\n");
  report.stages.indicators = { ok: true, lastLine: lines[lines.length - 1] };
  say("  ok: " + lines[lines.length - 1]);
} catch (e) {
  report.stages.indicators = { ok: false, error: String(e.stderr || e.message).slice(0, 2000) };
  say("  FAILED (see report): " + String(e.stderr || e.message).split("\n")[0]);
}

// Prediction snapshot (input side only, see log-predictions.mjs) -- logged right after the live snapshot exists, so a stale/missing snapshot never
// gets silently skipped, and a failure here never stops the klines/funding stages below.
if (report.stages.indicators.ok) {
  try {
    const out = execFileSync(process.execPath, [join(root, "scripts", "log-predictions.mjs")], { cwd: root, encoding: "utf8" });
    report.stages.predictions = { ok: true, lastLine: out.trim() };
    say("  " + out.trim());
  } catch (e) {
    report.stages.predictions = { ok: false, error: String(e.stderr || e.message).slice(0, 2000) };
    say("  prediction logging FAILED (non-fatal): " + String(e.stderr || e.message).split("\n")[0]);
  }
} else {
  report.stages.predictions = { ok: false, error: "skipped: live snapshot stage failed" };
}

// --- Stage 2: extend calibration klines (1h, 4h) for every currently TRADING UM USDT perpetual, up to the last closed bar ----------------------
say("\n== stage 2/3: extend calibration klines (1h, 4h) ==");
async function readLatestRaw() {
  const pointer = JSON.parse(await readFile(join(root, "data", "indicators", "latest.json"), "utf8"));
  return JSON.parse(await readFile(join(pointer.path, "raw.json"), "utf8"));
}
let raw = null;
try {
  raw = await readLatestRaw();
} catch (e) {
  say("  cannot read the live snapshot just produced, or an older one: " + e.message);
}
const klineStage = { ok: false, symbols: 0, extended: 0, skipped: 0, failed: [] };
if (raw) {
  const symbols = raw.contracts.filter((c) => c.contract.family === "UM" && c.contract.quoteAsset === "USDT" && c.contract.contractType === "PERPETUAL").map((c) => c.contract.symbol).sort();
  klineStage.symbols = symbols.length;
  try {
    const { routes, report: netReport } = await preflight(["fapi.binance.com"]);
    for (const line of netReport) say("  " + line);
    const get = createGet(routes);
    const limiter = new RateLimiter();
    for (const interval of ["1h", "4h"]) {
      const step = INTERVAL_MS[interval];
      const end = Math.floor(now / step) * step; // last closed bar boundary
      const outDir = join(root, "data", "calibration", "klines", interval);
      await mkdir(outDir, { recursive: true });
      for (const symbol of symbols) {
        const target = join(outDir, symbol + ".json");
        try {
          const r = await backfillSymbol({ get, limiter, target, symbol, interval, start: end - 400 * step, end, limit: 500 });
          if (r.action === "skip") klineStage.skipped++;
          else klineStage.extended++;
        } catch (e) {
          klineStage.failed.push({ symbol, interval, error: String(e.message || e) });
          if (e instanceof RegionBlockedError) throw e; // 451: stop this stage entirely, do not keep hammering other symbols
        }
      }
    }
    klineStage.ok = klineStage.failed.length === 0;
  } catch (e) {
    klineStage.stoppedEarly = String(e.message || e);
    say("  STOPPED: " + klineStage.stoppedEarly);
  }
}
report.stages.klines = klineStage;
say(`  ${klineStage.symbols} symbols, ${klineStage.extended} extended, ${klineStage.skipped} already current, ${klineStage.failed.length} failed`);

// --- Stage 3: extend calibration funding history for the same population, up to now -------------------------------------------------------------
say("\n== stage 3/3: extend calibration funding history ==");
const fundingStage = { ok: false, symbols: 0, extended: 0, skipped: 0, failed: [] };
if (raw) {
  try {
    const symbols = population(raw, now - 30 * DAY, { allListed: true }); // allListed: a symbol too new for the 30-day feature window still gets its funding tracked from day one
    fundingStage.symbols = symbols.length;
    const { routes } = await preflight(["fapi.binance.com"]);
    const get = createGet(routes);
    const outDir = join(root, "data", "calibration", "funding");
    await mkdir(outDir, { recursive: true });
    for (const symbol of symbols) {
      const file = join(outDir, symbol + ".json");
      try {
        const r = await backfillFundingSymbol({ get, file, symbol, start: now - 400 * DAY, end: now, paceMs: PACE_MS });
        if (r.action === "skip") fundingStage.skipped++;
        else fundingStage.extended++;
        await new Promise((res) => setTimeout(res, PACE_MS));
      } catch (e) {
        fundingStage.failed.push({ symbol, error: String(e.message || e) });
        if (e instanceof RateLimitedError) {
          fundingStage.stoppedEarly = e.message;
          say("  STOPPED: " + e.message);
          break;
        }
      }
    }
    fundingStage.ok = fundingStage.failed.length === 0;
  } catch (e) {
    if (e instanceof RegionBlockedError) {
      fundingStage.stoppedEarly = String(e.message);
      say("  STOPPED: " + fundingStage.stoppedEarly);
    } else throw e;
  }
}
report.stages.funding = fundingStage;
say(`  ${fundingStage.symbols} symbols, ${fundingStage.extended} extended, ${fundingStage.skipped} already current, ${fundingStage.failed.length} failed`);

// --- Human-readable summary: what happened, what's stale, when the next run is due at the latest -------------------------------------------------
async function oldestLastFetch() {
  const dir = join(root, "data", "indicators", "positions");
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  let oldest = null;
  for (const f of files) {
    try {
      const store = JSON.parse(await readFile(join(dir, f), "utf8"));
      const t = Number(store.lastFetchedAt);
      if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
    } catch {
      /* skip unreadable store */
    }
  }
  return oldest;
}
// isDue() (positions-store.mjs) refetches a symbol once REFETCH_MS (10 days) has passed since its lastFetchedAt; each fetch covers T2_LIMIT=500
// hourly points (~20.8 days), so as long as this script runs at least once every REFETCH_MS, no gap opens. mustRerunBy is the OLDEST symbol's
// lastFetchedAt + REFETCH_MS, minus a safety margin -- not the 30-day retention itself, which is the hard wall behind that schedule.
const oldestFetch = await oldestLastFetch();
const REFETCH_DAYS = 10;
const MARGIN_DAYS = 3;
const ageDays = oldestFetch != null ? (now - oldestFetch) / DAY : null;
report.completedAt = new Date().toISOString();
report.positions = {
  oldestLastFetchDaysAgo: ageDays,
  mustRerunBy: oldestFetch != null ? new Date(oldestFetch + (REFETCH_DAYS - MARGIN_DAYS) * DAY).toISOString() : "unknown -- no positions store found yet",
};
await writeFile(join(root, "data", "collect-all-last-report.json"), JSON.stringify(report, null, 2));

say("\n================ SUMMARY ================");
say(`started  ${report.startedAt}`);
say(`finished ${report.completedAt}`);
say(`live snapshot:  ${report.stages.indicators.ok ? "ok" : "FAILED -- " + report.stages.indicators.error?.split("\n")[0]}`);
say(`predictions log: ${report.stages.predictions.ok ? "ok -- " + report.stages.predictions.lastLine : "FAILED (non-fatal) -- " + report.stages.predictions.error?.split("\n")[0]}`);
say(`klines:         ${klineStage.symbols} symbols, +${klineStage.extended} extended, ${klineStage.skipped} already current, ${klineStage.failed.length} failed${klineStage.stoppedEarly ? " -- STOPPED: " + klineStage.stoppedEarly : ""}`);
say(`funding:        ${fundingStage.symbols} symbols, +${fundingStage.extended} extended, ${fundingStage.skipped} already current, ${fundingStage.failed.length} failed${fundingStage.stoppedEarly ? " -- STOPPED: " + fundingStage.stoppedEarly : ""}`);
if (ageDays != null) say(`positions history:  oldest symbol's last fetch was ${ageDays.toFixed(1)} days ago (refetch window 10 days) -- run again by ${report.positions.mustRerunBy}`);
else say("positions history:  no store found yet -- this may be the first run");
say(`full report: data/collect-all-last-report.json`);
say("===========================================");

const anyStopped = klineStage.stoppedEarly || fundingStage.stoppedEarly || !report.stages.indicators.ok;
if (anyStopped) process.exitCode = 1;
