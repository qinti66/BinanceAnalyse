// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Feature-side availability and distribution of the 1h-only features on an old window (calibration-log-v1.md T4/T5).
// Touches no labels and no returns. usage: node scripts/measure-feature-availability.mjs <klines.json>
import { readFile } from "node:fs/promises";
import { toBars } from "../lib/structure/bars.ts";
import { buildFeatureVector, FEATURE_IDS } from "../lib/indicators/features/registry.ts";

const HOUR = 3600000;
const STEP = 6;
const FIRST = 349; // ATR warm-up 13 + trailing 336
const [, , input] = process.argv;
if (!input) throw new Error("usage: node scripts/measure-feature-availability.mjs <klines.json>");
const data = JSON.parse(await readFile(input, "utf8"));
const ids = ["c1_effort_vs_result", "c2_sell_absorbed", "d1_vol_squeeze_pct", "d2_volume_dryup_pct", "d3_compression_bars", "f1_sweep_reclaim", "f2_up", "f2_down", "f3_range_containment"];
const values = Object.fromEntries(ids.map((k) => [k, []]));
const missing = Object.fromEntries(ids.map((k) => [k, 0]));
const reasons = {};
let points = 0;
for (const klines of Object.values(data.klines)) {
  const { bars } = toBars(klines, "UM", 1, null, data.end, HOUR);
  for (let i = FIRST; i < bars.length; i += STEP) {
    const v = buildFeatureVector(bars, i, { bars4h: null, btcBars: null, btcLongBars: null, cross: null, funding: null, isPerpetual: true });
    points++;
    for (const id of ids) {
      const x = v.values[FEATURE_IDS.indexOf(id)];
      if (Number.isNaN(x)) {
        missing[id]++;
        const key = id + ": " + v.reasons[id];
        reasons[key] = (reasons[key] || 0) + 1;
      } else values[id].push(x);
    }
  }
}
const q = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
};
const pct = (n, d) => ((100 * n) / Math.max(1, d)).toFixed(1) + "%";
console.log("points", points);
for (const id of ids) {
  const a = values[id];
  console.log(id.padEnd(24), "missing", pct(missing[id], points), "| zero", pct(a.filter((x) => x === 0).length, a.length), "| p10/p50/p75/p90/p99", q(a, 0.1), q(a, 0.5), q(a, 0.75), q(a, 0.9), q(a, 0.99), "| max", a.length ? +Math.max(...a).toFixed(3) : null);
}
console.log("missing reasons:", JSON.stringify(reasons));
const f1 = values.f1_sweep_reclaim;
console.log("f1 > 0:", pct(f1.filter((x) => x > 0).length, f1.length), "| f1 > 0.1:", pct(f1.filter((x) => x > 0.1).length, f1.length), "| f1 > 0.5:", pct(f1.filter((x) => x > 0.5).length, f1.length), "| f1 > 1:", pct(f1.filter((x) => x > 1).length, f1.length));
