// Append one prediction snapshot per collection run: for every currently-trading UM USDT perpetual, its d1_vol_squeeze_pct value and rank at
// this moment. INPUT SIDE ONLY -- no label, no outcome, no cost assumption is computed or stored here. Prospective validation (docs/findings-v1.md,
// T36-T40) needs "what the ranking said at the time" paired with "what actually happened later"; the outcome side is recomputed after the fact from
// the same tripleBarrier() used everywhere else, from the klines, never from a value frozen at write time (that would bake today's cost assumptions
// into a verdict about the future).
//
//   node scripts/log-predictions.mjs [dataDir]     (default dataDir: repo root)
//
// Reads the latest live indicators snapshot (data/indicators/latest.json -> raw.json); does not make any network request itself. Meant to be run
// right after collect-indicators.mjs (collect-all.mjs already calls it that way). Appends one line of JSON to a git-ignored, append-only file.
import "./require-node.mjs";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toBars } from "../lib/structure/bars.ts";
import { buildFeatureVector, FEATURE_IDS } from "../lib/indicators/features/registry.ts";

const HOUR = 3600000;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.argv[2] || root;
const d1Idx = FEATURE_IDS.indexOf("d1_vol_squeeze_pct");

export function rankOf(values) {
  // values: [{ symbol, d1 }], d1 ascending = most compressed first (T40: this is the direction that predicts "moved").
  const withValue = values.filter((v) => Number.isFinite(v.d1)).sort((a, b) => a.d1 - b.d1);
  const n = withValue.length;
  return withValue.map((v, i) => ({ symbol: v.symbol, d1: v.d1, rank: i + 1, percentile: n > 1 ? i / (n - 1) : 0 }));
}

async function main() {
  const pointer = JSON.parse(await readFile(join(dataDir, "data", "indicators", "latest.json"), "utf8"));
  const raw = JSON.parse(await readFile(join(pointer.path, "raw.json"), "utf8"));
  const capturedAt = raw.completedAt ?? new Date().toISOString();

  const values = [];
  for (const c of raw.contracts) {
    if (c.contract.family !== "UM" || c.contract.quoteAsset !== "USDT" || c.contract.contractType !== "PERPETUAL") continue;
    if (!Array.isArray(c.klines) || c.klines.length < 20) continue; // too little history to say anything
    const bars = toBars(c.klines, "UM", 1, null, Date.now(), HOUR).bars;
    if (!bars.length) continue;
    const v = buildFeatureVector(bars, bars.length - 1, { bars4h: null, btcBars: null, btcLongBars: null, cross: null, funding: null, isPerpetual: true });
    if (v.missing.includes("d1_vol_squeeze_pct")) continue; // missing stays missing: not ranked, not recorded with a placeholder
    values.push({ symbol: c.contract.symbol, d1: v.values[d1Idx] });
  }

  const ranked = rankOf(values);
  const outDir = join(dataDir, "data", "predictions");
  await mkdir(outDir, { recursive: true });
  const line = JSON.stringify({ capturedAt, n: ranked.length, entries: ranked }) + "\n";
  await appendFile(join(outDir, "predictions.ndjson"), line);
  console.log(`predictions logged: ${ranked.length} symbols at ${capturedAt} -> data/predictions/predictions.ndjson`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("FAILED: " + (e.message || e));
    process.exitCode = 1;
  });
}
