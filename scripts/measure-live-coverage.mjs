// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Feature coverage on the FULL downloaded universe (~526 coins, 1h + 4h klines, funding), one decision point per coin per day at 00:00 UTC.
// Feature side only: no labels, no returns, no network. It answers what the 20-coin pilot could not: e2, e3 and g1 with a real cross-section,
// and the joint coverage (every one of the 21 features present at once) by month and by coin age.
//
//   node --max-old-space-size=8192 scripts/measure-live-coverage.mjs <dataDir> [fromISO] [toISO]
//     <dataDir>  a directory holding calibration/klines/1h, calibration/klines/4h, calibration/funding, indicators/<run>/raw.json (the newest run gives listing dates)
//     from/to    decision-time window, default 2025-10-01 .. 2026-09-21 (BTC needs 9457 hourly bars = 394 days for g2, so nothing earlier can be complete)
//
// Survivorship: only contracts TRADING on 2026-09-21 are in the data (docs: memory survivorship-delisted-perps). Every figure here is for that
// surviving universe and must not be read as a statement about coins that were delisted.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBars } from "../lib/structure/bars.ts";
import { buildFeatureVector, FEATURE_IDS } from "../lib/indicators/features/registry.ts";
import { buildCrossSection } from "../lib/indicators/features/context.ts";
import { lastIndexClosedBy } from "../lib/indicators/features/stats.ts";
import { assertNativeKlines } from "./kline-source.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const [, , dataDir, fromArg, toArg] = process.argv;
if (!dataDir) throw new Error("usage: see the header of scripts/measure-live-coverage.mjs");
const from = Date.parse(fromArg ?? "2025-10-01T00:00:00Z");
const to = Date.parse(toArg ?? "2026-09-21T00:00:00Z");
const cal = join(dataDir, "calibration");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

// listing dates from the newest snapshot
const runs = (await readdir(join(dataDir, "indicators"))).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort();
let onboard = {};
for (const run of runs.reverse()) {
  try {
    const raw = await readJson(join(dataDir, "indicators", run, "raw.json"));
    onboard = Object.fromEntries(raw.contracts.map((c) => [c.contract.symbol, c.contract.onboardDate]));
    break;
  } catch {
    /* try the next run */
  }
}

const symbols = (await readdir(join(cal, "klines", "1h"))).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const t0 = Date.now();
const coins = [];
let btc = null;
for (const symbol of symbols) {
  const f1 = await readJson(join(cal, "klines", "1h", symbol + ".json"));
  const f4 = assertNativeKlines(await readJson(join(cal, "klines", "4h", symbol + ".json")), "4h", symbol + " 4h"); // R1: the exchange's own 4h, never an aggregate
  let funding = null;
  try {
    funding = (await readJson(join(cal, "funding", symbol + ".json"))).rows;
  } catch {
    funding = null;
  }
  const bars = toBars(f1.rows, "UM", 1, null, f1.end, HOUR).bars;
  const bars4h = toBars(f4.rows, "UM", 1, null, f4.end, 4 * HOUR).bars;
  if (symbol === "BTCUSDT") btc = bars;
  coins.push({ symbol, bars, bars4h, funding, onboard: onboard[symbol] ?? null });
}
if (!btc) throw new Error("BTCUSDT 1h klines are needed for e1 and g2");
console.log(`loaded ${coins.length} coins in ${Math.round((Date.now() - t0) / 1000)}s | bars ${coins.reduce((a, c) => a + c.bars.length, 0)} | funding files ${coins.filter((c) => c.funding).length}`);

const universe = coins.map((c) => c.bars);
const cts = btc.filter((b) => b.t >= from - HOUR && (b.t + HOUR) % DAY === 0 && b.t + HOUR <= to).map((b) => b.ct);
console.log(`decision times ${cts.length} (${new Date(cts[0] + 1).toISOString().slice(0, 10)} .. ${new Date(cts.at(-1) + 1).toISOString().slice(0, 10)}), one per day, 00:00 UTC`);

const total = { n: 0, complete: 0 };
const missing = Object.fromEntries(FEATURE_IDS.map((id) => [id, 0]));
const reasons = {};
const byMonth = {};
const byAge = { "<60d": { n: 0, complete: 0 }, "60-180d": { n: 0, complete: 0 }, ">=180d": { n: 0, complete: 0 }, unknown: { n: 0, complete: 0 } };
const byCoin = new Map();
const bump = (o, key, complete) => {
  const x = (o[key] ??= { n: 0, complete: 0 });
  x.n++;
  if (complete) x.complete++;
};
const idx = coins.map(() => 0);
for (let k = 0; k < cts.length; k++) {
  const ct = cts[k];
  const cross = buildCrossSection(universe, ct);
  for (let ci = 0; ci < coins.length; ci++) {
    const c = coins[ci];
    const i = lastIndexClosedBy(c.bars, ct);
    if (i < 0 || c.bars[i].ct !== ct) continue; // the coin has no bar at this decision time (not listed yet)
    const v = buildFeatureVector(c.bars, i, { bars4h: c.bars4h, btcBars: btc, btcLongBars: btc, cross, funding: c.funding, isPerpetual: true });
    const complete = v.missing.length === 0;
    total.n++;
    if (complete) total.complete++;
    for (const id of v.missing) {
      missing[id]++;
      const why = (v.reasons[id] ?? "?").replace(/\d+(\.\d+)?/g, "#");
      const key = id + ": " + why;
      reasons[key] = (reasons[key] || 0) + 1;
    }
    bump(byMonth, new Date(ct + 1).toISOString().slice(0, 7), complete);
    const age = c.onboard ? (c.bars[i].t - c.onboard) / DAY : null;
    bump(byAge, age === null ? "unknown" : age < 60 ? "<60d" : age < 180 ? "60-180d" : ">=180d", complete);
    const bc = byCoin.get(c.symbol) ?? { n: 0, complete: 0 };
    bc.n++;
    if (complete) bc.complete++;
    byCoin.set(c.symbol, bc);
  }
  if ((k + 1) % 30 === 0) console.log(`  ${k + 1}/${cts.length} decision times, ${Math.round((Date.now() - t0) / 1000)}s`);
}

const pct = (a, b) => ((100 * a) / Math.max(1, b)).toFixed(1) + "%";
console.log(`\ndecision points (coin, day) ${total.n} | JOINT: all ${FEATURE_IDS.length} features present at ${total.complete} (${pct(total.complete, total.n)})`);
console.log("\nper-feature missing rate:");
for (const id of FEATURE_IDS) console.log(`  ${id.padEnd(24)} ${pct(missing[id], total.n).padStart(6)}`);
console.log("\ntop missing reasons (numbers replaced by #):");
for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(8)}  ${k}`);
console.log("\njoint coverage by month:");
for (const [m, x] of Object.entries(byMonth).sort()) console.log(`  ${m}  n=${String(x.n).padEnd(7)} ${pct(x.complete, x.n).padStart(6)}`);
console.log("\njoint coverage by coin age at the decision:");
for (const [m, x] of Object.entries(byAge)) console.log(`  ${m.padEnd(8)} n=${String(x.n).padEnd(7)} ${pct(x.complete, x.n).padStart(6)}`);
const lows = [...byCoin.entries()].filter(([, x]) => x.n >= 30).sort((a, b) => a[1].complete / a[1].n - b[1].complete / b[1].n).slice(0, 8);
console.log("\nlowest-coverage coins (>=30 points):", lows.map(([s, x]) => `${s} ${pct(x.complete, x.n)}`).join(", "));
console.log("\nSURVIVING universe only (contracts TRADING on 2026-09-21); delisted coins are absent.");
