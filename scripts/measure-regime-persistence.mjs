// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Do the candidate regime axes persist? Feature side only: no labels, no returns, no network.
//
//   node --max-old-space-size=8192 scripts/measure-regime-persistence.mjs <dataDir>
//
// The ruler (regime.ts: regimeRuns / MIN_MEDIAN_RUN_DAYS): the length, in days, of a stretch of consecutive days in the same tercile bin. TWO statistics, always
// printed side by side: the median over stretches (per-stretch) and the median over days (day-weighted). An axis is a regime axis when the DECIDING statistic
// is at least 14 days (a JUDGEMENT value tied to the scale of a fold). The deciding statistic is the day-weighted one IF it passes the goalpost check below,
// else the per-stretch one.
// Pre-registered path (architect ruling, fixed before the day-weighted statistic was measured on anything):
//   0. GOALPOST CHECK: g1 (breadth, the known-bad axis) must sit far below the bar under the day-weighted statistic: at most KNOWN_BAD_MAX_MEDIAN_DAYS (7).
//      If it does not, the new statistic is abandoned and the per-stretch median decides.
//   1. Measure trend (BTC trailing 30-day return) and vol (g2, BTC volatility percentile) with both statistics.
//   2. If trend fails, measure EXACTLY ONE other candidate, once: BTC trailing 90-day return. No other window, no hysteresis, no third candidate.
//   3. If both fail, only vol is kept and the missing directional regime is written into the gate report as an unverified gap (never silently dropped).
// The monthly distribution of the bins is printed as supporting evidence (readable), not as the criterion.
// Trend and vol depend on BTC only, so adding delisted altcoins to the universe cannot change them; g1 does depend on the universe and is not an axis.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBars } from "../lib/structure/bars.ts";
import { buildFeatureVector, FEATURE_IDS } from "../lib/indicators/features/registry.ts";
import { buildCrossSection } from "../lib/indicators/features/context.ts";
import { assertNativeKlines } from "./kline-source.mjs";
import { regimeTerciles, regimeRuns, persistsAsRegime, btcTrailingReturnPct, binOf, MIN_MEDIAN_RUN_DAYS, KNOWN_BAD_MAX_MEDIAN_DAYS } from "../lib/calibration/regime.ts";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: see the header of scripts/measure-regime-persistence.mjs");
const cal = join(dataDir, "calibration");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const symbols = (await readdir(join(cal, "klines", "1h"))).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const universe = [];
let btc = null;
let btc4h = null;
for (const symbol of symbols) {
  const f1 = await readJson(join(cal, "klines", "1h", symbol + ".json"));
  const bars = toBars(f1.rows, "UM", 1, null, f1.end, HOUR).bars;
  universe.push(bars);
  if (symbol === "BTCUSDT") {
    btc = bars;
    btc4h = toBars(assertNativeKlines(await readJson(join(cal, "klines", "4h", symbol + ".json")), "4h", "BTCUSDT 4h").rows, "UM", 1, null, f1.end, 4 * HOUR).bars; // R1
  }
}
if (!btc) throw new Error("BTCUSDT is needed");

// one value per consecutive day at 00:00 UTC (the bar that closes at 23:59:59.999)
const dayCts = btc.filter((b) => (b.t + HOUR) % DAY === 0).map((b) => b.ct);
const series = { g1: [], vol: [], trend: [], trend90: [] };
const gi = FEATURE_IDS.indexOf("g1_breadth_ema60");
const g2i = FEATURE_IDS.indexOf("g2_btc_vol_regime");
const idxOf = new Map(btc.map((b, i) => [b.ct, i]));
for (const ct of dayCts) {
  const trend = btcTrailingReturnPct(btc, ct, 30);
  const i = idxOf.get(ct);
  const cross = buildCrossSection(universe, ct);
  const v = buildFeatureVector(btc, i, { bars4h: btc4h, btcBars: btc, btcLongBars: btc, cross, funding: null, isPerpetual: true });
  series.g1.push({ ct, x: v.values[gi] });
  series.vol.push({ ct, x: v.values[g2i] });
  series.trend.push({ ct, x: trend ?? NaN });
  series.trend90.push({ ct, x: btcTrailingReturnPct(btc, ct, 90) ?? NaN });
}
const days = (s) => s.filter((d) => Number.isFinite(d.x));
console.log(`days with a value: g1 ${days(series.g1).length}, vol(g2) ${days(series.vol).length}, trend ${days(series.trend).length} | first/last day ${new Date(dayCts[0] + 1).toISOString().slice(0, 10)} / ${new Date(dayCts.at(-1) + 1).toISOString().slice(0, 10)}`);

const f3 = (x) => (x === null ? "-" : x.toFixed(3));
function measure(name, s) {
  const d = days(s);
  const cuts = regimeTerciles(d.map((p) => p.x));
  if (!cuts) throw new Error(name + ": too few days for terciles");
  // consecutive-day runs: a day without a value ends a run
  const r = regimeRuns(s.map((p) => p.x), cuts);
  console.log(`\n${name}: ${d.length} days | terciles <= ${f3(cuts.lower)} / >= ${f3(cuts.upper)} | ${r.runs.length} stretches, longest ${Math.max(...r.runs)}`);
  console.log(`  BOTH STATISTICS: per-stretch median ${r.median} days | day-weighted median ${r.dayWeightedMedian} days | mean stretch ${f3(r.mean)}`);
  console.log(`  per bin: low ${r.byBin.low.days} days (median run ${r.byBin.low.median}), mid ${r.byBin.mid.days} (${r.byBin.mid.median}), high ${r.byBin.high.days} (${r.byBin.high.median})`);
  const byM = {};
  for (const p of d) {
    const m = new Date(p.ct + 1).toISOString().slice(0, 7);
    const b = binOf(p.x, cuts);
    const e = (byM[m] ??= { low: 0, mid: 0, high: 0, n: 0 });
    e[b]++;
    e.n++;
  }
  console.log("  share of days per bin by month (low/mid/high, %):");
  for (const [m, e] of Object.entries(byM).sort()) console.log(`    ${m} n=${String(e.n).padEnd(3)} ${[e.low, e.mid, e.high].map((k) => String(Math.round((100 * k) / e.n)).padStart(3)).join(" / ")}`);
  const half = Math.floor(d.length / 2);
  const c1 = regimeTerciles(d.slice(0, half).map((p) => p.x));
  const c2 = regimeTerciles(d.slice(half).map((p) => p.x));
  console.log(`  cutpoints, first half <= ${f3(c1?.lower ?? null)} / >= ${f3(c1?.upper ?? null)}; second half <= ${f3(c2?.lower ?? null)} / >= ${f3(c2?.upper ?? null)}`);
  return { cuts, runs: r };
}

// 0. the ruler on the known-bad axis: under BOTH statistics
const g1 = measure("g1 (market breadth, KNOWN BAD)", series.g1);
const perRunOk = g1.runs.median !== null && g1.runs.median >= 1 && g1.runs.median <= 3 && !persistsAsRegime(g1.runs);
const dayOk = g1.runs.dayWeightedMedian !== null && g1.runs.dayWeightedMedian <= KNOWN_BAD_MAX_MEDIAN_DAYS && !persistsAsRegime(g1.runs, "dayWeighted");
console.log(`\nRULER CHECK on g1: per-stretch median ${g1.runs.median} (expected 1 to 3) -> ${perRunOk ? "OK" : "FAILED"} | day-weighted median ${g1.runs.dayWeightedMedian} (must be <= ${KNOWN_BAD_MAX_MEDIAN_DAYS}) -> ${dayOk ? "OK: the day-weighted statistic keeps the known-bad axis far below the bar" : "FAILED: the day-weighted statistic moves the goalposts and is ABANDONED; the per-stretch median decides"}`);
if (!perRunOk) {
  console.log("The per-stretch ruler itself failed its check: stop and fix the ruler before measuring anything.");
  process.exitCode = 1;
} else {
  const stat = dayOk ? "dayWeighted" : "perRun";
  console.log(`DECIDING STATISTIC: ${stat === "dayWeighted" ? "day-weighted median" : "per-stretch median"} (both are printed everywhere)`);
  const verdict = (name, m) => `${name}: ${persistsAsRegime(m.runs, stat) ? "PASSES" : "FAILS"} (per-stretch ${m.runs.median}, day-weighted ${m.runs.dayWeightedMedian}; bar ${MIN_MEDIAN_RUN_DAYS})`;
  const trend = measure("trend (BTC trailing 30-day return, %)", series.trend);
  const vol = measure("vol (g2, BTC 30-day realised volatility percentile in its own trailing year)", series.vol);
  console.log("\n" + verdict("trend", trend) + "\n" + verdict("vol", vol));
  let axes = { vol, trend: persistsAsRegime(trend.runs, stat) ? trend : null };
  let trendName = "trend (30-day)";
  if (!axes.trend) {
    console.log("\ntrend failed: the ONE permitted second candidate, measured once: BTC trailing 90-day return.");
    const t90 = measure("trend90 (BTC trailing 90-day return, %)", series.trend90);
    console.log(verdict("trend90", t90));
    if (persistsAsRegime(t90.runs, stat)) {
      axes = { vol, trend: t90 };
      trendName = "trend90 (BTC trailing 90-day return)";
    } else console.log("\nBoth directional candidates failed. Only vol is kept; the directional regime coverage is NOT ESTABLISHED and must be recorded as an unverified gap in the gate report.");
  }
  console.log("\nAXES THAT PASS, with the cutpoints over all available days of each axis (what would be frozen) and their provenance:");
  const out = { deciding: stat, vol: { cuts: axes.vol.cuts, stretches: axes.vol.runs.runs.length, perStretchMedian: axes.vol.runs.median, dayWeightedMedian: axes.vol.runs.dayWeightedMedian } };
  out.trend = axes.trend ? { name: trendName, cuts: axes.trend.cuts, stretches: axes.trend.runs.runs.length, perStretchMedian: axes.trend.runs.median, dayWeightedMedian: axes.trend.runs.dayWeightedMedian } : null;
  console.log(JSON.stringify(out, null, 1));
}
console.log("\nTrend and vol use BTC only. g1 counts only coins still trading on 2026-09-21 and is not an axis. 'High' is relative to the whole two-year window, not to any local period.");
