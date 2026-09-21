// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// PROVISIONAL regime cutpoints: the terciles of g1 (market breadth) and g2 (BTC volatility percentile) over the available history, one value per day.
// Feature side only: no labels, no returns, no network. It FREEZES NOTHING: CALIBRATION_GATE.regimeCutpoints stays null until a person records the
// decision (calibration-log-v1.md T11: computed once, then frozen as constants). This script only shows what the numbers would be and how stable they are.
//
//   node --max-old-space-size=8192 scripts/measure-regime-cutpoints.mjs <dataDir> [fromISO] [toISO]
//
// Caveat printed with the result: g1 is computed over the SURVIVING universe (contracts TRADING on 2026-09-21), so historical breadth is overstated.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBars } from "../lib/structure/bars.ts";
import { buildFeatureVector, FEATURE_IDS } from "../lib/indicators/features/registry.ts";
import { buildCrossSection } from "../lib/indicators/features/context.ts";
import { regimeTerciles } from "../lib/calibration/regime.ts";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const TEST_START = Date.UTC(2025, 11, 1);
const [, , dataDir, fromArg, toArg] = process.argv;
if (!dataDir) throw new Error("usage: see the header of scripts/measure-regime-cutpoints.mjs");
const from = Date.parse(fromArg ?? "2025-10-01T00:00:00Z");
const to = Date.parse(toArg ?? "2026-09-21T00:00:00Z");
const cal = join(dataDir, "calibration");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const symbols = (await readdir(join(cal, "klines", "1h"))).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const universe = [];
let btc = null;
let btc4h = null;
for (const symbol of symbols) {
  const f1 = await readJson(join(cal, "klines", "1h", symbol + ".json"));
  const bars = toBars(f1.rows, "UM", 1, null, f1.end, HOUR).bars;
  universe.push(bars);
  if (symbol === "BTCUSDT") {
    btc = bars;
    btc4h = toBars((await readJson(join(cal, "klines", "4h", symbol + ".json"))).rows, "UM", 1, null, f1.end, 4 * HOUR).bars;
  }
}
if (!btc) throw new Error("BTCUSDT is needed");
const gi = FEATURE_IDS.indexOf("g1_breadth_ema60");
const g2i = FEATURE_IDS.indexOf("g2_btc_vol_regime");
const days = [];
for (const b of btc) {
  if (b.t < from - HOUR || (b.t + HOUR) % DAY !== 0 || b.t + HOUR > to) continue;
  const cross = buildCrossSection(universe, b.ct);
  const i = btc.indexOf(b);
  const v = buildFeatureVector(btc, i, { bars4h: btc4h, btcBars: btc, btcLongBars: btc, cross, funding: null, isPerpetual: true });
  days.push({ t: b.ct + 1, g1: v.values[gi], g2: v.values[g2i], coins: cross.breadthValid });
}
const ok = days.filter((d) => Number.isFinite(d.g1) && Number.isFinite(d.g2));
console.log(`days ${days.length}, with both g1 and g2: ${ok.length} (${new Date(ok[0].t).toISOString().slice(0, 10)} .. ${new Date(ok.at(-1).t).toISOString().slice(0, 10)}) | coins in the breadth: ${Math.min(...ok.map((d) => d.coins))}..${Math.max(...ok.map((d) => d.coins))}`);

const f3 = (x) => x.toFixed(3);
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return `min ${f3(s[0])} p10 ${f3(s[Math.floor(0.1 * s.length)])} median ${f3(s[s.length >> 1])} p90 ${f3(s[Math.floor(0.9 * s.length)])} max ${f3(s.at(-1))}`;
};
console.log("g1 (share of coins above their EMA60):", stats(ok.map((d) => d.g1)));
console.log("g2 (BTC 30d realised-vol percentile in its own trailing year):", stats(ok.map((d) => d.g2)));
const corr = (() => {
  const n = ok.length, mx = ok.reduce((a, d) => a + d.g1, 0) / n, my = ok.reduce((a, d) => a + d.g2, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const d of ok) { sxy += (d.g1 - mx) * (d.g2 - my); sxx += (d.g1 - mx) ** 2; syy += (d.g2 - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
})();
console.log("correlation g1 vs g2:", f3(corr));

console.log("\nmonthly mean of g1 / g2 (is more than one regime present?):");
const byM = {};
for (const d of ok) (byM[new Date(d.t).toISOString().slice(0, 7)] ??= []).push(d);
for (const [m, a] of Object.entries(byM).sort()) console.log(`  ${m}  g1 ${f3(a.reduce((x, d) => x + d.g1, 0) / a.length)} (${f3(Math.min(...a.map((d) => d.g1)))}..${f3(Math.max(...a.map((d) => d.g1)))})  g2 ${f3(a.reduce((x, d) => x + d.g2, 0) / a.length)} (${f3(Math.min(...a.map((d) => d.g2)))}..${f3(Math.max(...a.map((d) => d.g2)))})`);

const cutsOf = (set) => ({ g1: regimeTerciles(set.map((d) => d.g1)), g2: regimeTerciles(set.map((d) => d.g2)) });
const show = (label, set) => {
  const c = cutsOf(set);
  console.log(`  ${label.padEnd(40)} n=${String(set.length).padEnd(4)} g1 <=${c.g1 ? f3(c.g1.lower) : "-"} / >=${c.g1 ? f3(c.g1.upper) : "-"} | g2 <=${c.g2 ? f3(c.g2.lower) : "-"} / >=${c.g2 ? f3(c.g2.upper) : "-"}`);
  return c;
};
console.log("\nterciles (lower / upper cutpoint) and their stability across windows:");
const all = show("all days", ok);
const test = show("days from 2025-12-01 (the test window)", ok.filter((d) => d.t >= TEST_START));
show("first half", ok.slice(0, ok.length >> 1));
show("second half", ok.slice(ok.length >> 1));
console.log("\ndays per bin with the ALL-days cutpoints (the gate needs >= 100 EFFECTIVE test samples in each of the four bins):");
const binDays = (set, c) => ({
  g1Low: set.filter((d) => d.g1 <= c.g1.lower).length, g1High: set.filter((d) => d.g1 >= c.g1.upper).length,
  g2Low: set.filter((d) => d.g2 <= c.g2.lower).length, g2High: set.filter((d) => d.g2 >= c.g2.upper).length,
});
console.log("  all days:        ", JSON.stringify(binDays(ok, all)));
console.log("  test window only:", JSON.stringify(binDays(ok.filter((d) => d.t >= TEST_START), all)));
console.log("\nPROVISIONAL, nothing is frozen. Survivorship: g1 counts only coins that are still trading on 2026-09-21, so past breadth is overstated. One year of g2 is the most this data allows (it needs a trailing year of BTC itself).");
