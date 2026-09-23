import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// Read-only verification of the delisted-contract files downloaded by fetch-delisted.mjs. No network, nothing is written.
//
//   node scripts/verify-delisted-batch.mjs <outDir> [plan.json]
//
// Checks, per file:
//   - source is the exchange (API or archive), never an aggregate (R1)
//   - rows non-empty, strictly increasing open times
//   - trim.cutBy consistent with whether the contract has a real deliveryDate (SETTLING vs "gone")
//   - a partial last bar (partialLastBarOpen), if any, is the LAST row and matches what decisionEligible would say
//   - funding's last row precedes its cut point (delivery, or the 1h data's own end for a "gone" contract)
// Nothing here downloads or fixes anything; problems are reported for a human/architect decision.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNativeKlines } from "./kline-source.mjs";
import { partialLastIndex, decisionEligible } from "./delisted-trim.mjs";

const [, , outDir, planPath] = process.argv;
if (!outDir) throw new Error("usage: node scripts/verify-delisted-batch.mjs <outDir> [plan.json]");
const plan = planPath ? JSON.parse(await readFile(planPath, "utf8")) : null;
const planOf = plan ? new Map(plan.map((p) => [p.symbol, p])) : null;

const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e) {
    return { __error: String(e) };
  }
};

async function listSymbols(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  } catch {
    return [];
  }
}

const problems = [];
const note = (symbol, msg) => problems.push(`${symbol}: ${msg}`);

const oneHour = await listSymbols(join(outDir, "klines", "1h"));
const fourHour = await listSymbols(join(outDir, "klines", "4h"));
const funding = await listSymbols(join(outDir, "funding"));
console.log(`files: 1h ${oneHour.length} | 4h ${fourHour.length} | funding ${funding.length}`);
for (const s of oneHour) if (!fourHour.includes(s)) note(s, "has 1h but no 4h file");
for (const s of fourHour) if (!oneHour.includes(s)) note(s, "has 4h but no 1h file");

let checked = 0;
for (const symbol of oneHour) {
  checked++;
  const f1 = await readJson(join(outDir, "klines", "1h", symbol + ".json"));
  if (f1.__error) {
    note(symbol, "1h unreadable: " + f1.__error);
    continue;
  }
  try {
    assertNativeKlines(f1, "1h", symbol + " 1h");
  } catch (e) {
    note(symbol, "1h source: " + e.message);
  }
  if (!Array.isArray(f1.rows) || !f1.rows.length) {
    note(symbol, "1h has no rows");
    continue;
  }
  for (let i = 1; i < f1.rows.length; i++) {
    if (!(Number(f1.rows[i][0]) > Number(f1.rows[i - 1][0]))) {
      note(symbol, "1h rows not strictly increasing at index " + i);
      break;
    }
  }
  const p = planOf?.get(symbol);
  if (p) {
    const hasDelivery = p.deliveryMs !== null && p.deliveryMs !== undefined;
    if (hasDelivery && f1.trim?.cutBy && !/delivery|both/.test(f1.trim.cutBy) && f1.trim.cutBy !== "trailing") {
      note(symbol, `SETTLING contract but cutBy="${f1.trim.cutBy}" (expected delivery/both, or trailing after a delivery cut)`);
    }
    if (!hasDelivery && f1.trim?.cutBy === "delivery") note(symbol, `"gone" contract (no deliveryDate) but cutBy="delivery"`);
  }
  const partial = f1.trim?.partialLastBarOpen;
  if (partial !== null && partial !== undefined) {
    const idx = partialLastIndex(f1.rows, f1.trim);
    if (idx !== f1.rows.length - 1) note(symbol, "partialLastBarOpen does not point at the last row");
    if (decisionEligible(f1.rows, f1.trim, f1.rows.length - 1)) note(symbol, "the partial last bar is marked decision-eligible (should not be)");
  }

  if (fourHour.includes(symbol)) {
    const f4 = await readJson(join(outDir, "klines", "4h", symbol + ".json"));
    if (f4.__error) note(symbol, "4h unreadable: " + f4.__error);
    else {
      try {
        assertNativeKlines(f4, "4h", symbol + " 4h");
      } catch (e) {
        note(symbol, "4h source: " + e.message);
      }
      if (!Array.isArray(f4.rows) || !f4.rows.length) note(symbol, "4h has no rows");
      if (f4.trim?.partialLastBarOpen) note(symbol, "4h has a partial-last-bar mark (4h is never given keepPartialLast)");
    }
  }

  if (funding.includes(symbol)) {
    const ff = await readJson(join(outDir, "funding", symbol + ".json"));
    if (ff.__error) note(symbol, "funding unreadable: " + ff.__error);
    else if (Array.isArray(ff.rows) && ff.rows.length) {
      const lastT = ff.rows[ff.rows.length - 1].time;
      const cutMs = p?.deliveryMs ?? (f1.rows.length ? Number(f1.rows[f1.rows.length - 1][0]) + 3600000 : null);
      if (cutMs !== null && !(lastT < cutMs)) note(symbol, `funding's last row (${new Date(lastT).toISOString()}) is not before the cut (${new Date(cutMs).toISOString()})`);
    }
  } else if (plan) {
    note(symbol, "no funding file (expected one if --funding was used)");
  }
}

console.log(`checked ${checked} contract(s)`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log("  - " + p);
} else {
  console.log("no problems found");
}
