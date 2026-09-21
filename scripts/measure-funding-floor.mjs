// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Measure FUNDING_SCALE_FLOOR (calibration-log-v1.md T9, T10, T14), by the protocol in docs/feature-spec-v1.md (a3):
//   on window W1, take the trailing-30-day funding IQR (normalised to fundingDaily) of every perpetual and use the p10 of the NON-ZERO IQRs.
//   The +/-5 clip rate is a DIAGNOSTIC, not a gate: the earlier "<= 2%" criterion was unfounded and unreachable (heavy tails alone give ~2%) and is void.
//   The frozen thing is the METHOD; re-run it whenever the sample changes and compare the number it gives with the constant in funding.ts.
// Feature side only: no labels, no returns.
//
//   node scripts/measure-funding-floor.mjs [funding-dir]      (default data/calibration/funding)
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fundingWindow, FUNDING_SCALE_FLOOR } from "../lib/indicators/features/funding.ts";
import { quantile } from "../lib/calibration/metrics.ts";

const HOUR = 3600000;
const STEP = 6 * HOUR;
const W1_START = Date.UTC(2025, 8, 1);
const W1_END = Date.UTC(2025, 11, 1);
const CLIP = 5;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2] ?? join(root, "data", "calibration", "funding");
const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

const points = []; // one row per valid (coin, time)
const missing = {};
let total = 0;
for (const f of files) {
  const { symbol, rows } = JSON.parse(await readFile(join(dir, f), "utf8"));
  for (let t = W1_START; t < W1_END; t += STEP) {
    total++;
    const { window, reason } = fundingWindow(rows, t);
    if (!window) {
      missing[reason] = (missing[reason] || 0) + 1;
      continue;
    }
    points.push({ symbol, iqr: window.iqr, dev: window.now.daily - window.median, interval: window.now.intervalHours });
  }
}

const nonZero = points.filter((p) => p.iqr > 0).map((p) => p.iqr);
const pct = (x) => (100 * x).toFixed(2) + "%";
const clipRate = (subset, floor) => {
  if (!subset.length) return null;
  return subset.filter((p) => Math.abs(p.dev / Math.max(p.iqr, floor)) > CLIP).length / subset.length;
};
const fmt = (v) => (v === null ? "n/a" : pct(v));
const sig = (v) => Number(v.toPrecision(4));

console.log(`coins ${files.length} | evaluation points ${total} | valid ${points.length} (${pct(points.length / Math.max(1, total))})`);
console.log("missing reasons:", JSON.stringify(missing));
console.log(`IQR = 0 at ${pct(points.filter((p) => p.iqr === 0).length / Math.max(1, points.length))} of valid points; non-zero IQR n = ${nonZero.length}`);
console.log("non-zero IQR (percent/day) p1/p5/p10/p25/p50/p75/p90/p99:", [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99].map((q) => sig(quantile(nonZero, q))).join(" / "));

const floor = quantile(nonZero, 0.1);
console.log(`\nPROTOCOL FLOOR = p10 of non-zero IQR = ${sig(floor)} percent/day`);
const at = clipRate(points, floor);
console.log(`clip rate at |z| > ${CLIP} with that floor: ${fmt(at)}   (diagnostic only, not a gate)`);
console.log(`the constant in funding.ts is ${FUNDING_SCALE_FLOOR}; this run gives ${sig(floor)}: a difference of ${(100 * (floor / FUNDING_SCALE_FLOOR - 1)).toFixed(2)}%`);
console.log(`  among IQR = 0 points: ${fmt(clipRate(points.filter((p) => p.iqr === 0), floor))} | among IQR > 0 points: ${fmt(clipRate(points.filter((p) => p.iqr > 0), floor))}`);
console.log(`  by settlement interval of the latest row: ${[...new Set(points.map((p) => p.interval))].sort((a, b) => a - b).map((h) => `${h}h ${fmt(clipRate(points.filter((p) => p.interval === h), floor))} (n=${points.filter((p) => p.interval === h).length})`).join(" | ")}`);

console.log("\nSENSITIVITY (for the record; the floor is the protocol's p10, this is not a search)");
console.log("  floor percentile   floor (pct/day)   clip rate");
for (const q of [0.05, 0.1, 0.25, 0.5]) {
  const fl = quantile(nonZero, q);
  console.log("  p" + String(q * 100).padEnd(16), String(sig(fl)).padEnd(17), fmt(clipRate(points, fl)));
}
