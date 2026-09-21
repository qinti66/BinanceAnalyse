import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// Does aggregating 1h klines into 4h reproduce Binance's own 4h klines? Reads local files only: no network, nothing is written.
//
//   node scripts/check-4h-reconcile.mjs [klinesDir]      (default data/calibration/klines; needs 1h/ and 4h/ inside)
//
// Every symbol that has both files: aggregate its 1h bars (aggregate-4h.mjs) and compare each aggregated bar with the 4h bar of the same open time.
// Prices and trade counts must match exactly; volume-like sums to a 1e-9 relative tolerance. Reported: how many bars compared, how many differ and in
// which fields, how many of Binance's 4h bars have no complete 1h group (and vice versa).
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate4h, compareBars } from "./aggregate-4h.mjs";

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "calibration", "klines");
const symbols = (await readdir(join(dir, "1h"))).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
let compared = 0, exact = 0, symbolsChecked = 0, only1h = 0, only4h = 0;
const fields = {};
const worst = [];
for (const symbol of symbols) {
  let f1, f4;
  try {
    f1 = JSON.parse(await readFile(join(dir, "1h", symbol + ".json"), "utf8"));
    f4 = JSON.parse(await readFile(join(dir, "4h", symbol + ".json"), "utf8"));
  } catch {
    continue;
  }
  symbolsChecked++;
  const real = new Map(f4.rows.map((r) => [Number(r[0]), r]));
  const agg = aggregate4h(f1.rows);
  const aggKeys = new Set();
  let bad = 0;
  for (const a of agg) {
    aggKeys.add(a[0]);
    const r = real.get(a[0]);
    if (!r) {
      only1h++;
      continue;
    }
    compared++;
    const d = compareBars(a, r);
    if (!d.length) exact++;
    else {
      bad++;
      for (const x of d) fields[x] = (fields[x] || 0) + 1;
    }
  }
  for (const k of real.keys()) if (!aggKeys.has(k)) only4h++;
  if (bad) worst.push([symbol, bad]);
}
console.log(`symbols ${symbolsChecked} | 4h bars compared ${compared} | identical ${exact} (${((100 * exact) / Math.max(1, compared)).toFixed(4)}%) | differing ${compared - exact}`);
console.log(`Binance 4h bars with no complete 1h group: ${only4h} | aggregated bars Binance has no 4h bar for: ${only1h}`);
console.log("differing fields:", JSON.stringify(fields));
if (worst.length) console.log("symbols with differences (top 8):", worst.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `${s}:${n}`).join(", "));
