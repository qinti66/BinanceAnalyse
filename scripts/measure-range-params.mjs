// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Feature-side measurement of range detection on an OLD window (calibration-log-v1.md, T1).
// Touches no labels, no returns, no future outcomes. Reproduces the numbers behind the frozen STRUCTURE_PARAMS.
//
// usage: node scripts/measure-range-params.mjs <klines.json> [out.json]
//
// <klines.json>: { start, end, klines: { SYMBOL: [[openTime,o,h,l,c,vol,closeTime,qv,trades,tb,tbq,ignore], ...] } }
// with 1h rows in Binance klines column order (UM). See the calibration log for the exact source and coin list.
import { readFile, writeFile } from "node:fs/promises";
import { toBars } from "../lib/structure/bars.ts";
import { zigzag } from "../lib/structure/swings.ts";
import { detectRangeDetailed } from "../lib/structure/ranges.ts";

const HOUR = 3600000;
const LOOKBACK = 168;
const STEP = 6;
const MULTS = [1.5, 2, 3];
const TOLS = [0.3, 0.5, 1.0];
const CAPS = [8, 12, 15, 20, 25, 40, Infinity];
const CONTS = [0, 0.5, 0.6, 0.7, 0.8];
const MIN_TOUCHES = [2, 3]; // detection needs >= 2 by definition; >= 3 is a filter on the chosen boundaries

const [, , input, output] = process.argv;
if (!input) throw new Error("usage: node scripts/measure-range-params.mjs <klines.json> [out.json]");
const data = JSON.parse(await readFile(input, "utf8"));

const quantile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3);
};
const dist = (values) => ({ n: values.length, p10: quantile(values, 0.1), p25: quantile(values, 0.25), p50: quantile(values, 0.5), p75: quantile(values, 0.75), p90: quantile(values, 0.9) });
const share = (count, total) => +(count / Math.max(1, total)).toFixed(4);

const results = {};
for (const mult of MULTS) {
  for (const tol of TOLS) {
    const points = [];
    for (const [symbol, klines] of Object.entries(data.klines)) {
      const { bars } = toBars(klines, "UM", 1, null, data.end, HOUR);
      if (bars.length < LOOKBACK + 30) continue;
      const swings = zigzag(bars, { mode: "atr", mult, atrPeriod: 14 });
      for (let i = LOOKBACK + 14; i < bars.length; i += STEP) {
        const month = new Date(bars[i].t).getUTCMonth() + 1;
        // No height cap here: the distribution must not be truncated by the cut it is meant to inform.
        const d = detectRangeDetailed(bars, swings, { atIndex: i, lookback: LOOKBACK, minSwings: 4, tolAtr: tol, minTouches: 2, maxHeightAtr: Infinity, atrPeriod: 14 });
        if (!d.range) {
          points.push({ symbol, month, state: d.state, reason: String(d.reason).replace(/\d+/g, "N") });
          continue;
        }
        const m = d.range.meta;
        points.push({ symbol, month, state: "range", heightAtr: m.heightAtr, containment: m.containment, topTouches: m.topTouches, bottomTouches: m.bottomTouches, swingCount: m.swingCount });
      }
    }
    const ranges = points.filter((p) => p.state === "range");
    const states = {};
    const reasons = {};
    for (const p of points) {
      states[p.state] = (states[p.state] || 0) + 1;
      if (p.state !== "range") reasons[p.state + ": " + p.reason] = (reasons[p.state + ": " + p.reason] || 0) + 1;
    }
    const curve = [];
    for (const cap of CAPS) for (const containment of CONTS) for (const minTouches of MIN_TOUCHES) {
      const pass = ranges.filter((p) => p.heightAtr <= cap && p.containment >= containment && p.topTouches >= minTouches && p.bottomTouches >= minTouches).length;
      curve.push({ cap, containment, minTouches, coverage: share(pass, points.length) });
    }
    const byMonth = {};
    for (const p of points) {
      const cell = (byMonth[p.month] ||= { n: 0, hasRange: 0 });
      cell.n++;
      if (p.state === "range" && p.heightAtr <= 25) cell.hasRange++;
    }
    const perCoin = {};
    for (const p of points) (perCoin[p.symbol] ||= []).push(p);
    results[`mult=${mult},tol=${tol}`] = {
      points: points.length,
      stateShare: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, share(v, points.length)])),
      reasons,
      heightAtr: dist(ranges.map((p) => p.heightAtr)),
      containment: dist(ranges.map((p) => p.containment)),
      topTouches: dist(ranges.map((p) => p.topTouches)),
      bottomTouches: dist(ranges.map((p) => p.bottomTouches)),
      swingCount: dist(ranges.map((p) => p.swingCount)),
      perCoinHasRange: dist(Object.values(perCoin).map((a) => a.filter((p) => p.state === "range").length / a.length)),
      hasRangeByMonth: Object.fromEntries(Object.entries(byMonth).map(([m, v]) => [m, share(v.hasRange, v.n)])),
      curve,
    };
  }
}

const at = (config, cap, containment, minTouches) => results[config].curve.find((c) => c.cap === cap && c.containment === containment && c.minTouches === minTouches).coverage;
const primary = results["mult=2,tol=0.5"];
if (output) await writeFile(output, JSON.stringify({ window: [data.start, data.end], lookback: LOOKBACK, step: STEP, coins: Object.keys(data.klines), results }, null, 1));

console.log("PRIMARY mult=2 tol=0.5: state share", JSON.stringify(primary.stateShare), "reasons", JSON.stringify(primary.reasons));
console.log("heightAtr", JSON.stringify(primary.heightAtr));
console.log("containment", JSON.stringify(primary.containment));
console.log("swingCount", JSON.stringify(primary.swingCount));
console.log("has_range by month (cap 25, touches>=2):", JSON.stringify(primary.hasRangeByMonth));
console.log("\nhas_range coverage (touches>=2 each side), rows = height cap, cols = containment >=", CONTS.join(" "));
for (const cap of CAPS) console.log(" cap", String(cap).padEnd(9), CONTS.map((c) => String(at("mult=2,tol=0.5", cap, c, 2)).padEnd(8)).join(""));
console.log("\nhas_range coverage at cap 25, containment >= 0 (rows: mult; cols: tol", TOLS.join(" "), ")");
for (const mult of MULTS) console.log(" mult", mult, TOLS.map((t) => at(`mult=${mult},tol=${t}`, 25, 0, 2)).join("  "));
