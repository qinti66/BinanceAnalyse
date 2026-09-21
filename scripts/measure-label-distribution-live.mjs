// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Class shares of the triple-barrier direction labels on the FULL downloaded universe, at the FROZEN k rule. Descriptive only: no model, no features,
// no network. It does NOT re-freeze k: the frozen thing is the METHOD (k_h = LABEL_K_BASE x sqrt(h/4), the 15% to 60% class-share rule of kDiagnosis),
// and the delisted contracts are not in this data. Delisting biases the labels toward "down", so the shares here are those of SURVIVING contracts only.
// When the delisted contracts are added, the same method is run again and its values replace these directly.
//
//   node scripts/measure-label-distribution-live.mjs <dataDir>
//     <dataDir>  calibration/klines/1h/<SYMBOL>.json for every coin, and indicators/<run>/raw.json (only for each coin's CURRENT spread)
//
// Spread: only today's is known; it stands in for the whole history, which is OPTIMISTIC (past liquidity was usually worse), as in the W1 measurement.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBars } from "../lib/structure/bars.ts";
import { atrSeries } from "../lib/structure/atr.ts";
import { tripleBarrier, roundTripCost, labelDistribution, kDiagnosis, labelK, LABEL_K_BASE, SLIPPAGE_ROUND_TRIP_ASSUMED, SLIPPAGE_SENSITIVITY_ROUND_TRIP, LABEL_HORIZONS_BARS } from "../lib/indicators/labels.ts";

const HOUR = 3600000;
const STEP = 6;
const FIRST = 349; // the same warm-up the features need, so the labelled points are the ones that can also be scored
const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: see the header of scripts/measure-label-distribution-live.mjs");
const cal = join(dataDir, "calibration");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const runs = (await readdir(join(dataDir, "indicators"))).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().reverse();
const spreadBps = {};
for (const run of runs) {
  try {
    const raw = await readJson(join(dataDir, "indicators", run, "raw.json"));
    for (const c of raw.contracts) {
      const bid = Number(c.book?.bidPrice), ask = Number(c.book?.askPrice);
      if (bid > 0 && ask >= bid) spreadBps[c.contract.symbol] = ((ask - bid) / ((ask + bid) / 2)) * 10000;
    }
    break;
  } catch {
    /* next run */
  }
}
const symbols = (await readdir(join(cal, "klines", "1h"))).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const configs = [];
for (const h of LABEL_HORIZONS_BARS) for (const slip of SLIPPAGE_SENSITIVITY_ROUND_TRIP) configs.push({ h, slip, k: labelK(h) });
const acc = configs.map(() => ({ all: [], byQuarter: {}, ambiguous: 0, n: 0 }));
const quarterOf = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};
let coinsWithSpread = 0;
const t0 = Date.now();
for (const symbol of symbols) {
  const f = await readJson(join(cal, "klines", "1h", symbol + ".json"));
  const bars = toBars(f.rows, "UM", 1, null, f.end, HOUR).bars;
  const atr = atrSeries(bars, 14);
  const spread = spreadBps[symbol] ?? null;
  if (spread !== null) coinsWithSpread++;
  configs.forEach((cfg, ci) => {
    const cost = roundTripCost({ spreadBps: spread, slippagePct: cfg.slip });
    const a = acc[ci];
    for (let t = FIRST; t + cfg.h < bars.length; t += STEP) {
      const r = tripleBarrier(bars, t, atr, { horizonBars: cfg.h, k: cfg.k, cost });
      a.all.push(r.label);
      (a.byQuarter[quarterOf(bars[t].ct + 1)] ??= []).push(r.label);
      if (r.ambiguous) a.ambiguous++;
      a.n++;
    }
  });
}
const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
console.log(`coins ${symbols.length} (${coinsWithSpread} with a current spread) | ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`FROZEN RULE  k_h = ${LABEL_K_BASE} x sqrt(h/4); slippage sensitivity (round trip) ${SLIPPAGE_SENSITIVITY_ROUND_TRIP.join(", ")}; assumed ${SLIPPAGE_ROUND_TRIP_ASSUMED}`);
configs.forEach((cfg, ci) => {
  const a = acc[ci];
  const d = labelDistribution(a.all);
  const diag = kDiagnosis(d);
  console.log(`\nhorizon ${cfg.h}h  k=${cfg.k.toFixed(3)}  slippage ${cfg.slip}${cfg.slip === SLIPPAGE_ROUND_TRIP_ASSUMED ? " (assumed)" : ""}: n=${d.n} down ${pct(d.shares.down)} flat ${pct(d.shares.flat)} up ${pct(d.shares.up)} | same-bar double touch ${pct(a.ambiguous / Math.max(1, d.n))} | ${diag.ok ? "within the 15%-60% rule" : "OUTSIDE the rule: " + diag.reason}`);
  if (cfg.slip === SLIPPAGE_ROUND_TRIP_ASSUMED) {
    console.log("  by quarter (down / flat / up):");
    for (const [q, labels] of Object.entries(a.byQuarter).sort()) {
      const x = labelDistribution(labels);
      console.log(`    ${q}  n=${String(x.n).padEnd(7)} ${pct(x.shares.down)} ${pct(x.shares.flat)} ${pct(x.shares.up)}`);
    }
  }
});
console.log("\nSURVIVING contracts only. Not re-frozen: k is a method, and delisted contracts (which lean toward 'down') are not in this data.");
