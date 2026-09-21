import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// Download the archive history of delisted contracts, cut it where the contract's real life ends, and write it OUTSIDE the training folders.
//
//   node scripts/fetch-delisted.mjs <plan.json> <outDir> <SYMBOL[,SYMBOL...]|@file> [--funding]
//
// AUTHORISATION: every batch needs the user's explicit approval in the session that runs it. This script does exactly the symbols on its command line,
// never the whole plan. Files come from data.binance.vision, each verified against its published SHA256; nothing is fetched after the delivery month.
//
// Output (under <outDir>, never data/calibration):
//   klines/1h/<SYMBOL>.json   the trimmed 1h bars + what was cut and why
//   klines/4h/<SYMBOL>.json   4h aggregated locally from the trimmed 1h (scripts/aggregate-4h.mjs; reconciliation: scripts/check-4h-reconcile.mjs)
//   funding/<SYMBOL>.json     with --funding: the archive's fundingRate months, cut at the delivery time; a missing month is reported, never assumed
// The cut is delisted-trim.mjs (deliveryDate, and the frozen-bar signature for contracts with no delivery date). A hard check refuses to write a file
// that has a bar at or after its cut. Stops at once on anything but 200 or 404 (403, 429, 451 ... are obeyed, never worked around).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchVerified, unzipCsv, parseKlinesCsv, parseFundingCsv, months } from "./fetch-archive.mjs";
import { readSymbolsArg } from "./symbols.mjs";
import { trimDelisted, trimFunding, assertNothingPastCut } from "./delisted-trim.mjs";
import { aggregate4h } from "./aggregate-4h.mjs";

const HOUR = 3600000;
export const BASE = "https://data.binance.vision/data/futures/um/monthly";

class StopRun extends Error {}

async function getMonth(url, tmp, name) {
  const r = await fetchVerified(url, 150);
  if (r.status === "missing") return { status: "missing" };
  if (r.status !== "ok") throw new StopRun(`${name}: ${r.status}; stopping, not retrying`);
  return { status: "ok", csv: await unzipCsv(r.buf, tmp, name), bytes: r.buf.length };
}

export function planFor(plan, symbol) {
  const p = plan.find((x) => x.symbol === symbol);
  if (!p) throw new Error(symbol + " is not in the plan");
  return p;
}

/**
 * One contract: request its months, cut, write the three files. `getMonth(url, name)` is injectable so the whole flow is testable without a network.
 * Returns { requests, bytes, line }.
 */
export async function processSymbol(p, { outDir, withFunding, getMonth: get }) {
  const symbol = p.symbol;
  let requests = 0;
  let bytes = 0;
  const ms = months(p.first, p.end);
  const rows = [];
  const missingMonths = [];
  for (const month of ms) {
    const name = `${symbol}-1h-${month}`;
    const r = await get(`${BASE}/klines/${symbol}/1h/${name}.zip`, name);
    requests += 2;
    if (r.status === "missing") {
      missingMonths.push(month);
      continue;
    }
    bytes += r.bytes;
    rows.push(...parseKlinesCsv(r.csv));
  }
  const byTime = new Map(rows.map((x) => [x[0], x]));
  const sorted = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  const t = trimDelisted(sorted, { deliveryMs: p.deliveryMs ?? NaN, stepMs: HOUR });
  assertNothingPastCut(t.rows, t.cutAtTime);
  const start = Date.UTC(Number(p.first.slice(0, 4)), Number(p.first.slice(5, 7)) - 1, 1);
  const end = t.rows.length ? Number(t.rows.at(-1)[0]) + HOUR : start;
  const trim = { cutBy: t.cutBy, cutAtTime: t.cutAtTime, dropped: t.dropped, interiorFrozenBars: t.interiorFrozenBars, deliveryMs: p.deliveryMs ?? null };
  await writeFile(join(outDir, "klines", "1h", symbol + ".json"), JSON.stringify({ symbol, interval: "1h", start, end, source: "data.binance.vision futures/um monthly, sha256-verified, trimmed", trim, missingMonths, rows: t.rows }));
  const rows4h = aggregate4h(t.rows);
  await writeFile(join(outDir, "klines", "4h", symbol + ".json"), JSON.stringify({ symbol, interval: "4h", start, end: rows4h.length ? Number(rows4h.at(-1)[0]) + 4 * HOUR : start, source: "aggregated from the trimmed 1h", rows: rows4h }));
  let fundingNote = "";
  if (withFunding) {
    const frows = [];
    const fmissing = [];
    for (const month of ms) {
      const name = `${symbol}-fundingRate-${month}`;
      const r = await get(`${BASE}/fundingRate/${symbol}/${name}.zip`, name);
      requests += 2;
      if (r.status === "missing") {
        fmissing.push(month);
        continue;
      }
      bytes += r.bytes;
      frows.push(...parseFundingCsv(r.csv));
    }
    const ft = trimFunding(frows.sort((a, b) => a.time - b.time).map((x) => ({ time: x.time, rate: x.rate })), p.deliveryMs ?? NaN);
    await writeFile(join(outDir, "funding", symbol + ".json"), JSON.stringify({ symbol, source: "data.binance.vision futures/um fundingRate monthly, trimmed", missingMonths: fmissing, cutByDelivery: ft.cut, dropped: ft.dropped, rows: ft.rows }));
    fundingNote = ` | funding ${ft.rows.length} rows, ${fmissing.length}/${ms.length} months missing${p.deliveryMs === null ? ", NOT cut (no delivery date)" : `, ${ft.dropped} cut`}`;
  }
  const line = `${symbol} [${p.kind}] ${ms.length} month(s), ${missingMonths.length} missing | 1h kept ${t.kept}, dropped ${t.dropped.total} (${t.cutBy ?? "nothing to cut"}${t.cutAtTime ? " at " + new Date(t.cutAtTime).toISOString().slice(0, 16) : ""}), frozen bars kept inside ${t.interiorFrozenBars} | 4h ${rows4h.length}${fundingNote}`;
  return { requests, bytes, line };
}

async function main() {
  const [, , planPath, outDir, symbolsArg, ...rest] = process.argv;
  if (!planPath || !outDir || !symbolsArg) throw new Error("usage: see the header of scripts/fetch-delisted.mjs");
  const withFunding = rest.includes("--funding");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const symbols = await readSymbolsArg(symbolsArg);
  for (const s of symbols) planFor(plan, s); // every symbol must be in the plan before anything is requested
  for (const d of ["klines/1h", "klines/4h", "funding", "tmp"]) await mkdir(join(outDir, d), { recursive: true });
  const tmp = join(outDir, "tmp");
  let requests = 0;
  let bytes = 0;
  for (const symbol of symbols) {
    const r = await processSymbol(planFor(plan, symbol), { outDir, withFunding, getMonth: (url, name) => getMonth(url, tmp, name) });
    requests += r.requests;
    bytes += r.bytes;
    console.log(r.line);
  }
  console.log(`done: ${symbols.length} contract(s), ${requests} requests, ${(bytes / 1e6).toFixed(2)} MB`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error((e instanceof StopRun ? "STOPPED: " : "FAILED: ") + e.message);
    process.exitCode = 1;
  });
}
