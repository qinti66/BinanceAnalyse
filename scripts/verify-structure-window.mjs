// Train/serve skew probe for the structure features on the 400-bar window that live scoring will use (calibration-log-v1.md T12).
// ZigZag is path dependent, so analysing a long history must give the same answer as analysing only the latest 400 bars.
// Feature side only; no labels; no network.
//
//   node scripts/verify-structure-window.mjs <w1-1h-klines.json> <archive-dir>
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBars } from "../lib/structure/bars.ts";
import { analyzeStructure, STRUCTURE_PARAMS, STRUCTURE_PARAMS_4H } from "../lib/structure/analyze.ts";

const HOUR = 3600000;
const WINDOW = 400;
const STEP = 6;
const [, , w1Path, archiveDir] = process.argv;
if (!w1Path || !archiveDir) throw new Error("usage: node scripts/verify-structure-window.mjs <w1-1h-klines.json> <archive-dir>");
const w1 = JSON.parse(await readFile(w1Path, "utf8"));
const rd = async (p) => JSON.parse(await readFile(p, "utf8"));
const merge = (a, b) => {
  const seen = new Set();
  return [...a, ...b].filter((k) => (seen.has(k[0]) ? false : seen.add(k[0]))).sort((x, y) => x[0] - y[0]);
};

function compare(bars, params) {
  let n = 0, same = 0, bothRange = 0, metaSame = 0;
  for (let i = WINDOW - 1; i < bars.length; i += STEP) {
    const full = analyzeStructure(bars, i, params);
    const win = analyzeStructure(bars.slice(i - WINDOW + 1, i + 1), WINDOW - 1, params);
    n++;
    if (full.rangeState === win.rangeState && full.confirmedSwingCount === win.confirmedSwingCount) same++;
    if (full.rangeState === "range" && win.rangeState === "range") {
      bothRange++;
      const a = full.findings[0].meta, b = win.findings[0].meta;
      if (["top", "bottom", "topTouches", "bottomTouches", "containment"].every((k) => Math.abs(a[k] - b[k]) < 1e-9)) metaSame++;
    }
  }
  return { n, same, bothRange, metaSame };
}

const tot = { "1h": { n: 0, same: 0, bothRange: 0, metaSame: 0 }, "4h": { n: 0, same: 0, bothRange: 0, metaSame: 0 } };
for (const symbol of Object.keys(w1.klines)) {
  const rows1h = merge((await rd(join(archiveDir, `${symbol}-1h.json`))).rows, w1.klines[symbol]);
  const rows4h = (await rd(join(archiveDir, `${symbol}-4h.json`))).rows;
  for (const [label, bars, params] of [["1h", toBars(rows1h, "UM", 1, null, w1.end, HOUR).bars, STRUCTURE_PARAMS], ["4h", toBars(rows4h, "UM", 1, null, w1.end, 4 * HOUR).bars, STRUCTURE_PARAMS_4H]]) {
    const r = compare(bars, params);
    for (const k of Object.keys(r)) tot[label][k] += r[k];
  }
}
const pct = (a, b) => ((100 * a) / Math.max(1, b)).toFixed(2) + "%";
for (const [label, t] of Object.entries(tot)) {
  console.log(`${label}: ${t.n} points | rangeState and swing count identical to the last-${WINDOW}-bar analysis: ${pct(t.same, t.n)} | of ${t.bothRange} range points, boundaries/touches/containment identical: ${pct(t.metaSame, t.bothRange)}`);
}
