import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// Which delisted contracts to fetch from the archive, and for which months. Reads local files only: no network.
//
//   node scripts/make-delisted-plan.mjs <universe.json> <archive-symbols.json> <out.json> [--from YYYY-MM]
//
//   <universe.json>        the exchangeInfo of one collection run (data/indicators/<run>/universe.json)
//   <archive-symbols.json> the output of scripts/probe-archive-symbols.mjs (which USDT perpetuals the archive holds, and their months)
//
// A contract is in the plan when it is NOT among the contracts we already hold and it lived after --from (default 2024-09):
//   SETTLING code perpetuals (delisted, deliveryDate known): months from max(first, from) to the delivery month.
//   "gone" (in the archive but no longer in exchangeInfo, so no deliveryDate): months from max(first, from) to the archive's last month; the frozen-tail
//   signature in delisted-trim.mjs is what ends them.
// Months after the delivery month are never listed: those files hold frozen bars (see delisted-trim.mjs).
import { readFile, writeFile } from "node:fs/promises";
import { months } from "./fetch-archive.mjs";

const ym = (t) => new Date(t).toISOString().slice(0, 7);

export function buildPlan(universe, archive, from = "2024-09") {
  const info = new Map(universe.um.symbols.map((s) => [s.symbol, s]));
  const plan = [];
  for (const c of archive.candidates) {
    const s = info.get(c.symbol);
    let kind;
    let end;
    let deliveryMs = null;
    if (s && s.status === "SETTLING" && s.underlyingType === "COIN" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT") {
      kind = "SETTLING";
      deliveryMs = s.deliveryDate;
      end = ym(deliveryMs);
    } else if (!s && c.inRange > 0) {
      kind = "gone";
      end = c.last;
    } else continue;
    const first = c.first > from ? c.first : from;
    if (end < first) continue;
    plan.push({ symbol: c.symbol, kind, first, end, months: months(first, end).length, deliveryMs, delivery: deliveryMs === null ? null : new Date(deliveryMs).toISOString() });
  }
  return plan.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

if (process.argv[1] && process.argv[1].endsWith("make-delisted-plan.mjs")) {
  const [, , uPath, aPath, out, ...rest] = process.argv;
  if (!uPath || !aPath || !out) throw new Error("usage: see the header of scripts/make-delisted-plan.mjs");
  const fi = rest.indexOf("--from");
  const plan = buildPlan(JSON.parse(await readFile(uPath, "utf8")), JSON.parse(await readFile(aPath, "utf8")), fi >= 0 ? rest[fi + 1] : "2024-09");
  await writeFile(out, JSON.stringify(plan, null, 1) + "\n");
  const files = plan.reduce((a, p) => a + p.months, 0);
  console.log(`${plan.length} contracts (${plan.filter((p) => p.kind === "SETTLING").length} SETTLING, ${plan.filter((p) => p.kind === "gone").length} gone) | ${files} monthly 1h files (+${files} funding) | written to ${out}`);
}
