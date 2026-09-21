// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// How many funding rows does the boundary-row rule drop, and how long is the exposure the rule cannot cover? (calibration-log-v1.md T17)
// Feature side only: no labels, no returns, no network. Reads the backfilled funding files.
//
//   node scripts/measure-funding-boundary-rows.mjs [funding-dir]      (default data/calibration/funding)
//
// Drop rate: the share of rows (other than each coin's first row) that normaliseFunding drops: a gap outside {1,2,4,8}h +/-10%, or a row whose next
// gap differs from its previous gap.
// Exposure: the rule needs the NEXT row, and at a decision time the latest row has none (no look-ahead, R1). So while the latest row is a
// boundary row that has not been revealed yet, it is used as is. An hourly decision point is "exposed" when the latest row at or before it is a
// row that WILL be dropped once its successor arrives. This is an upper bound on how often a3 could rest on a wrongly normalised row: a boundary
// row is only wrong when its elapsed gap differs from its nominal interval, which the API cannot show.
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseFunding } from "../lib/indicators/features/funding.ts";

const HOUR = 3600000;
const W1_START = Date.UTC(2025, 8, 1);
const W1_END = Date.UTC(2025, 11, 1);
const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "calibration", "funding");
const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

let rowsTotal = 0;
let dropped = 0;
let coinsAffected = 0;
let exposedHours = 0;
let pointsTotal = 0;
const droppedBySymbol = [];
for (const f of files) {
  const { symbol, rows } = JSON.parse(await readFile(join(dir, f), "utf8"));
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const kept = new Set(normaliseFunding(sorted).map((r) => r.time));
  // Rows the rule actually judges: neither the first (no predecessor) nor the last (no successor yet).
  const judged = sorted.slice(1, -1);
  const gone = judged.filter((r) => !kept.has(r.time));
  rowsTotal += judged.length;
  dropped += gone.length;
  if (gone.length) {
    coinsAffected++;
    droppedBySymbol.push([symbol, gone.length]);
  }
  // Exposure: for each dropped row, the hourly decision points between its settlement and its successor's settlement.
  const dropIdx = new Set(gone.map((r) => r.time));
  for (let i = 0; i < sorted.length - 1; i++) {
    if (!dropIdx.has(sorted[i].time)) continue;
    const from = Math.max(sorted[i].time, W1_START);
    const to = Math.min(sorted[i + 1].time, W1_END);
    if (to > from) exposedHours += Math.floor((to - from) / HOUR);
  }
  pointsTotal += Math.floor((W1_END - W1_START) / HOUR);
}
const pct = (a, b, d = 3) => ((100 * a) / Math.max(1, b)).toFixed(d) + "%";
console.log(`coins ${files.length} | rows judged ${rowsTotal} | dropped by the boundary rule ${dropped} (${pct(dropped, rowsTotal)}) | coins with at least one dropped row ${coinsAffected}`);
console.log(`exposure: ${exposedHours} hourly decision points (of ${pointsTotal}, ${pct(exposedHours, pointsTotal, 4)}) sit on a latest row that will turn out to be a boundary row; the rule cannot cover these`);
console.log("coins with dropped rows:", droppedBySymbol.slice(0, 30).map(([s, n]) => `${s}:${n}`).join(" "));
