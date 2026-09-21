// Turn scripts/fetch-archive.mjs fundingRate output into the same per-symbol files that scripts/backfill-funding.mjs writes
// (data/calibration/funding/<SYMBOL>.json, git-ignored), so every consumer reads one format.
//
// The archive's funding_interval_hours column is DROPPED on purpose. The API does not return it, so production must infer the interval (R1);
// letting the true column reach any feature input would be train/serve skew. It stays in the archive JSON, for the oracle check only.
//
//   node scripts/import-archive-funding.mjs <archive-dir> <funding-dir>
import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** archive { symbol, from, to, rows: [{time, rate, intervalHours}] } -> funding file { symbol, source, rows: [{time, rate}] } (no interval column). */
export function toFundingFile(archive) {
  const seen = new Set();
  const rows = archive.rows
    .filter((r) => Number.isFinite(r.time) && Number.isFinite(r.rate) && (seen.has(r.time) ? false : seen.add(r.time)))
    .sort((a, b) => a.time - b.time)
    .map((r) => ({ time: r.time, rate: r.rate }));
  return { symbol: archive.symbol, source: "data.binance.vision fundingRate monthly, sha256-verified (interval column dropped)", from: archive.from, to: archive.to, rows };
}

async function main() {
  const [, , archiveDir, fundingDir] = process.argv;
  if (!archiveDir || !fundingDir) throw new Error("usage: node scripts/import-archive-funding.mjs <archive-dir> <funding-dir>");
  await mkdir(fundingDir, { recursive: true });
  let n = 0;
  for (const f of (await readdir(archiveDir)).filter((x) => x.endsWith("-fundingRate.json"))) {
    const out = toFundingFile(JSON.parse(await readFile(join(archiveDir, f), "utf8")));
    await writeFile(join(fundingDir, out.symbol + ".json"), JSON.stringify(out));
    n++;
  }
  console.log(`imported ${n} symbols into ${fundingDir}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
