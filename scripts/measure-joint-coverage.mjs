// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Joint feature coverage on window W1: the share of (coin, time) decision points at which ALL features of the v1 model are available (R3).
// Feature side only: no labels, no returns. No network: reads files that were already downloaded.
//
//   node scripts/measure-joint-coverage.mjs <w1-1h-klines.json> <archive-dir> <funding-dir> <raw-snapshot.json>
//     <w1-1h-klines.json>  { start, end, klines: { SYMBOL: rows } }  the 1h bars of W1 itself
//     <archive-dir>        <SYMBOL>-1h.json (the month before W1), <SYMBOL>-4h.json, BTCUSDT-1h.json  from scripts/fetch-archive.mjs
//     <funding-dir>        <SYMBOL>.json { rows: [{time, rate}] }  from scripts/backfill-funding.mjs
//     <raw-snapshot.json>  used ONLY for each coin's listing date (onboardDate)
//
// A 20-coin sample cannot satisfy the "at least 50 coins in the cross-section" rule of e2, e3 and g1. Live, with ~500 coins, that rule is
// always met, so those three are reported SEPARATELY as "pending the live universe" and never counted as measured. The joint figure is
// given both without them (measured) and with them assumed available (an inference, labelled as such).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBars } from "../lib/structure/bars.ts";
import { buildFeatureVector, FEATURE_IDS } from "../lib/indicators/features/registry.ts";
import { buildCrossSection } from "../lib/indicators/features/context.ts";

const HOUR = 3600000;
const STEP = 6;
const PENDING = ["e2_rel_median_24h", "e3_ret_rank_pct", "g1_breadth_ema60"];
const [, , w1Path, archiveDir, fundingDir, rawPath] = process.argv;
if (!w1Path || !archiveDir || !fundingDir || !rawPath) throw new Error("usage: see the header of scripts/measure-joint-coverage.mjs");
const w1 = JSON.parse(await readFile(w1Path, "utf8"));
const raw = JSON.parse(await readFile(rawPath, "utf8"));
const onboard = Object.fromEntries(raw.contracts.map((c) => [c.contract.symbol, c.contract.onboardDate]));
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

const merge = (a, b) => {
  const seen = new Set();
  return [...a, ...b].filter((k) => (seen.has(k[0]) ? false : seen.add(k[0]))).sort((x, y) => x[0] - y[0]);
};
const btcRows = (await readJson(join(archiveDir, "BTCUSDT-1h.json"))).rows;
const btc = toBars(btcRows, "UM", 1, null, w1.end, HOUR).bars;

const coins = [];
for (const symbol of Object.keys(w1.klines)) {
  const aug = (await readJson(join(archiveDir, `${symbol}-1h.json`))).rows;
  const rows4h = (await readJson(join(archiveDir, `${symbol}-4h.json`))).rows;
  let funding = null;
  try {
    funding = (await readJson(join(fundingDir, symbol + ".json"))).rows;
  } catch {
    funding = null;
  }
  coins.push({
    symbol,
    bars: toBars(merge(aug, w1.klines[symbol]), "UM", 1, null, w1.end, HOUR).bars,
    bars4h: toBars(rows4h, "UM", 1, null, w1.end, 4 * HOUR).bars,
    funding,
    onboard: onboard[symbol],
  });
}
const universe = coins.map((c) => c.bars);
const crossCache = new Map();
const crossAt = (ct) => {
  if (!crossCache.has(ct)) crossCache.set(ct, buildCrossSection(universe, ct));
  return crossCache.get(ct);
};

const rows = [];
for (const c of coins) {
  const start = c.bars.findIndex((b) => b.t >= w1.start);
  for (let i = start; i >= 0 && i < c.bars.length && c.bars[i].t < w1.end; i += STEP) {
    const ct = c.bars[i].ct;
    const v = buildFeatureVector(c.bars, i, { bars4h: c.bars4h, btcBars: btc, btcLongBars: btc, cross: crossAt(ct), funding: c.funding, isPerpetual: true });
    const ageDays = (c.bars[i].t - c.onboard) / (24 * HOUR);
    rows.push({ symbol: c.symbol, ageDays, hasFunding: c.funding !== null, missing: v.missing, reasons: v.reasons });
  }
}

// A pending feature counts as available only if its sole reason for missing is the small cross-section of this sample.
const pendingOnlyBecauseOfSample = (r, id) => /cross-section|fewer than 50 coins/.test(r.reasons[id] ?? "");
const measuredMissing = (r) => r.missing.filter((id) => !PENDING.includes(id));
const realPendingMissing = (r) => r.missing.filter((id) => PENDING.includes(id) && !pendingOnlyBecauseOfSample(r, id));

const usable = rows.filter((r) => r.hasFunding);
const pct = (a, b) => ((100 * a) / Math.max(1, b)).toFixed(1) + "%";
const summarise = (label, set) => {
  const measured = set.filter((r) => measuredMissing(r).length === 0).length;
  const assumed = set.filter((r) => measuredMissing(r).length === 0 && realPendingMissing(r).length === 0).length;
  console.log(`${label.padEnd(34)} n=${String(set.length).padEnd(5)} joint (18 measured features): ${pct(measured, set.length).padStart(6)} | with e2/e3/g1 ASSUMED available: ${pct(assumed, set.length).padStart(6)}`);
};

console.log(`coins ${coins.length} (${coins.filter((c) => c.funding).length} with funding history) | decision points ${rows.length} (${usable.length} with funding) | features ${FEATURE_IDS.length}`);
console.log(`\nper-feature missing rate (points with funding history; e2/e3/g1 shown as "pending" when only the 20-coin universe blocks them)`);
for (const id of FEATURE_IDS) {
  const miss = usable.filter((r) => r.missing.includes(id));
  const pending = PENDING.includes(id) ? miss.filter((r) => pendingOnlyBecauseOfSample(r, id)).length : 0;
  const real = miss.length - pending;
  console.log(`  ${id.padEnd(24)} missing ${pct(real, usable.length).padStart(6)}${pending ? `   pending live universe ${pct(pending, usable.length)}` : ""}`);
}
const why = {};
for (const r of usable) for (const id of measuredMissing(r)) {
  const k = id + ": " + (r.reasons[id] ?? "?");
  why[k] = (why[k] || 0) + 1;
}
console.log("\nmissing reasons (measured features):", JSON.stringify(why));

console.log("\nJOINT COVERAGE (all features present at the same (coin, time)); coins without funding history are excluded, that is a gap in the local backfill");
summarise("all coins in the sample", usable);
summarise("older coins (listed >= 180 days ago)", usable.filter((r) => r.ageDays >= 180));
summarise("newer coins (listed < 180 days ago)", usable.filter((r) => r.ageDays < 180));
const byCoin = {};
for (const r of usable) (byCoin[r.symbol] ||= []).push(r);
console.log("\nper coin (joint, 18 measured features):");
for (const [s, a] of Object.entries(byCoin)) console.log(`  ${s.padEnd(14)} ${pct(a.filter((r) => measuredMissing(r).length === 0).length, a.length).padStart(6)}  age at W1 start ${Math.round((w1.start - onboard[s]) / (24 * HOUR))}d  ${a.every((r) => measuredMissing(r).length === 0) ? "" : "missing: " + [...new Set(a.flatMap(measuredMissing))].join(",")}`);
