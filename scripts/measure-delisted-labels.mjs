// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Class distribution of the triple-barrier labels on the DELISTED contracts obtained so far, with the settlement-time barrier (labels.ts, T30), ORDINARY and
// SETTLEMENT-CUT labels reported SIDE BY SIDE. Contracts without a real deliveryDate ("gone") get no settlement rule: their last H decision points stay unlabelled
// and are counted. Descriptive only: no model, no features, no network.
//
//   node scripts/measure-delisted-labels.mjs <dataDir>      (reads <dataDir>/calibration/delisted/klines/1h and <dataDir>/indicators/<run>/raw.json for a spread proxy)
//
// Spread: delisted contracts have no book today, so the MEDIAN current spread of the surviving contracts stands in (an assumption, optimistic for illiquid coins).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBars } from "../lib/structure/bars.ts";
import { atrSeries } from "../lib/structure/atr.ts";
import { tripleBarrier, roundTripCost, labelK, labelDistribution, splitBySettlement, LABEL_HORIZONS_BARS, SLIPPAGE_ROUND_TRIP_ASSUMED } from "../lib/indicators/labels.ts";
import { decisionEligible } from "./delisted-trim.mjs";
import { assertNativeKlines } from "./kline-source.mjs";

const HOUR = 3600000;
const FIRST = 349; // the same warm-up the features need
const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: see the header of scripts/measure-delisted-labels.mjs");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const runs = (await readdir(join(dataDir, "indicators"))).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().reverse();
const spreads = [];
for (const run of runs) {
  try {
    for (const c of (await readJson(join(dataDir, "indicators", run, "raw.json"))).contracts) {
      const bid = Number(c.book?.bidPrice), ask = Number(c.book?.askPrice);
      if (bid > 0 && ask >= bid) spreads.push(((ask - bid) / ((ask + bid) / 2)) * 10000);
    }
    break;
  } catch {
    /* next */
  }
}
spreads.sort((a, b) => a - b);
const spreadProxy = spreads[spreads.length >> 1];
const dir = join(dataDir, "calibration", "delisted", "klines", "1h");
const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
console.log(`delisted contracts ${files.length} | spread proxy: median of ${spreads.length} surviving contracts = ${spreadProxy.toFixed(2)} bps`);
const cost = roundTripCost({ spreadBps: spreadProxy, slippagePct: SLIPPAGE_ROUND_TRIP_ASSUMED });
const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
const acc = {};
for (const H of LABEL_HORIZONS_BARS) acc[H] = { results: [], nullByReason: {}, perContract: [] };
for (const name of files) {
  const f = assertNativeKlines(await readJson(join(dir, name)), "1h", name);
  const symbol = f.symbol;
  const deliveryMs = f.trim?.deliveryMs ?? null;
  const bars = toBars(f.rows, "UM", 1, null, f.end + HOUR, HOUR).bars;
  const atr = atrSeries(bars, 14);
  for (const H of LABEL_HORIZONS_BARS) {
    let ordinary = 0, settled = 0, unlabelled = 0, skipped = 0;
    for (let t = FIRST; t < bars.length; t++) {
      if (!decisionEligible(f.rows, f.trim, t)) {
        skipped++;
        continue;
      }
      const r = tripleBarrier(bars, t, atr, { horizonBars: H, k: labelK(H), cost, settlementMs: deliveryMs });
      if (r.label === null) {
        unlabelled++;
        acc[H].nullByReason[r.reason] = (acc[H].nullByReason[r.reason] || 0) + 1;
        continue;
      }
      acc[H].results.push(r);
      if (r.settled) settled++;
      else ordinary++;
    }
    acc[H].perContract.push(`${symbol}${deliveryMs === null ? "(no deliveryDate)" : ""}: ${ordinary} ordinary, ${settled} settlement-cut, ${unlabelled} unlabelled${skipped ? ", " + skipped + " partial-hour skipped" : ""}`);
  }
}
for (const H of LABEL_HORIZONS_BARS) {
  const split = splitBySettlement(acc[H].results);
  const show = (label, d) => console.log(`  ${label.padEnd(20)} n=${String(d.n).padEnd(6)} down ${pct(d.shares.down)} flat ${pct(d.shares.flat)} up ${pct(d.shares.up)}`);
  console.log(`\nhorizon ${H}h (k ${labelK(H).toFixed(3)}, round-trip cost ${(cost * 100).toFixed(3)}%)`);
  show("ordinary", split.ordinary);
  show("settlement-cut", split.settled);
  console.log("  unlabelled by reason:", JSON.stringify(acc[H].nullByReason));
  for (const l of acc[H].perContract) console.log("    " + l);
}
console.log("\nOnly the delisted contracts obtained so far (a small batch): counts are small and say nothing yet about the shape of the full distribution. Compare with the survivors' distribution (calibration-log T23).");
