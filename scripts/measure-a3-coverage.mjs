// Coverage and distribution of the a3_funding_z feature on window W1, from backfilled funding history (calibration-log-v1.md T10).
// Uses the real `fundingZ` with the frozen FUNDING_SCALE_FLOOR. Feature side only: no labels, no returns. No network.
//
//   node scripts/measure-a3-coverage.mjs [funding-dir]      (default data/calibration/funding)
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fundingZ, fundingWindow, FUNDING_SCALE_FLOOR } from "../lib/indicators/features/funding.ts";
import { quantile } from "../lib/calibration/metrics.ts";

const HOUR = 3600000;
const STEP = 6 * HOUR;
const W1_START = Date.UTC(2025, 8, 1);
const W1_END = Date.UTC(2025, 11, 1);
const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "calibration", "funding");
const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

const values = [];
const missing = {};
const perCoin = [];
const byInterval = {};
let total = 0;
for (const f of files) {
  const { rows } = JSON.parse(await readFile(join(dir, f), "utf8"));
  let ok = 0;
  let n = 0;
  for (let t = W1_START; t < W1_END; t += STEP) {
    total++;
    n++;
    const z = fundingZ(rows, t);
    if (z.value === null) {
      missing[z.reason] = (missing[z.reason] || 0) + 1;
      continue;
    }
    ok++;
    values.push(z.value);
    const iv = fundingWindow(rows, t).window.now.intervalHours;
    (byInterval[iv] ||= []).push(z.value);
  }
  perCoin.push(ok / n);
}
const pct = (x) => (100 * x).toFixed(2) + "%";
const q = (a, p) => quantile(a, p).toFixed(3);
console.log(`FUNDING_SCALE_FLOOR = ${FUNDING_SCALE_FLOOR}`);
console.log(`coins ${files.length} | points ${total} | a3 available ${values.length} (${pct(values.length / total)}) | missing reasons ${JSON.stringify(missing)}`);
console.log(`per-coin coverage: min ${pct(Math.min(...perCoin))}, coins under 100%: ${perCoin.filter((c) => c < 1).length}`);
console.log(`a3 p1/p5/p25/p50/p75/p95/p99: ${[0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99].map((p) => q(values, p)).join(" / ")}`);
console.log(`exactly 0: ${pct(values.filter((v) => v === 0).length / values.length)} | at +5: ${pct(values.filter((v) => v === 5).length / values.length)} | at -5: ${pct(values.filter((v) => v === -5).length / values.length)} | clipped total (diagnostic, not a gate): ${pct(values.filter((v) => Math.abs(v) === 5).length / values.length)}`);
for (const [h, a] of Object.entries(byInterval)) console.log(`  latest settlement ${h}h: n=${a.length}, p5/p50/p95 ${q(a, 0.05)} / ${q(a, 0.5)} / ${q(a, 0.95)}, clipped ${pct(a.filter((v) => Math.abs(v) === 5).length / a.length)}`);
