// Class shares of the triple-barrier direction labels on an OLD window (calibration-log-v1.md T7/T8).
// Descriptive only: no model, no features. The rule for k: no class under 15% or over 60%.
//
// usage: node scripts/measure-label-distribution.mjs <klines.json> <raw-snapshot.json>
//   <raw-snapshot.json>: a raw snapshot (data/indicators/<id>/raw.json), used ONLY for each coin's CURRENT spread. Historical spreads
//   are not available, so the current spread stands in for the whole window. That proxy is OPTIMISTIC (past liquidity was usually worse).
import { readFile } from "node:fs/promises";
import { toBars } from "../lib/structure/bars.ts";
import { atrSeries } from "../lib/structure/atr.ts";
import { tripleBarrier, roundTripCost, labelDistribution, kDiagnosis, labelK, LABEL_K_BASE, SLIPPAGE_ROUND_TRIP_ASSUMED, SLIPPAGE_SENSITIVITY_ROUND_TRIP, LABEL_HORIZONS_BARS } from "../lib/indicators/labels.ts";

const HOUR = 3600000;
const STEP = 6;
const FIRST = 14;
const [, , klinesPath, rawPath] = process.argv;
if (!klinesPath || !rawPath) throw new Error("usage: node scripts/measure-label-distribution.mjs <klines.json> <raw.json>");
const data = JSON.parse(await readFile(klinesPath, "utf8"));
const raw = JSON.parse(await readFile(rawPath, "utf8"));
const spreadBps = {};
for (const c of raw.contracts) {
  const bid = Number(c.book?.bidPrice), ask = Number(c.book?.askPrice);
  if (bid > 0 && ask >= bid) spreadBps[c.contract.symbol] = ((ask - bid) / ((ask + bid) / 2)) * 10000;
}
const perCoin = Object.entries(data.klines).map(([symbol, klines]) => {
  const { bars } = toBars(klines, "UM", 1, null, data.end, HOUR);
  return { symbol, bars, atr: atrSeries(bars, 14), spread: spreadBps[symbol] ?? null };
});
const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
function run(h, k, slip) {
  const labels = [];
  let ambiguous = 0;
  for (const c of perCoin) {
    const cost = roundTripCost({ spreadBps: c.spread, slippagePct: slip });
    for (let t = FIRST; t + h < c.bars.length; t += STEP) {
      const r = tripleBarrier(c.bars, t, c.atr, { horizonBars: h, k, cost });
      labels.push(r.label);
      if (r.ambiguous) ambiguous++;
    }
  }
  const d = labelDistribution(labels);
  return { d, diag: kDiagnosis(d), ambiguous: ambiguous / Math.max(1, d.n) };
}
const row = (k, r) => console.log(k.toFixed(3).padStart(6), String(r.d.n).padStart(6), pct(r.d.shares.down), pct(r.d.shares.flat), pct(r.d.shares.up), pct(r.ambiguous).padStart(9), "  ", r.diag.ok ? "ok" : r.diag.offenders.map((o) => `${o.label} ${o.problem}`).join(", "));
console.log("coins with a current spread:", perCoin.filter((c) => c.spread !== null).length, "/", perCoin.length);
console.log(`\nFROZEN RULE  k_h = ${LABEL_K_BASE} x sqrt(h/4); slippage sensitivity (round trip): ${SLIPPAGE_SENSITIVITY_ROUND_TRIP.join(", ")}; assumed ${SLIPPAGE_ROUND_TRIP_ASSUMED}`);
for (const h of LABEL_HORIZONS_BARS) {
  for (const slip of SLIPPAGE_SENSITIVITY_ROUND_TRIP) {
    console.log(`\nhorizon ${h}h  k=${labelK(h).toFixed(3)}  slippage round-trip ${slip}${slip === SLIPPAGE_ROUND_TRIP_ASSUMED ? "  (assumed)" : ""}`);
    console.log("     k      n     down    flat      up   sameBar   verdict");
    row(labelK(h), run(h, labelK(h), slip));
  }
}
console.log("\nREFERENCE SWEEP at the assumed slippage (not a search; for the record)");
for (const h of LABEL_HORIZONS_BARS) {
  console.log(`\nhorizon ${h}h`);
  console.log("     k      n     down    flat      up   sameBar   verdict");
  for (const k of [0.5, 1, 1.5, 2, 2.5, 3, 4]) row(k, run(h, k, SLIPPAGE_ROUND_TRIP_ASSUMED));
}
