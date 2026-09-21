// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// Oracle check of the per-row funding-interval inference against the archive's TRUE interval column (calibration-log-v1.md T13, T14).
// The archive's fundingRate files carry funding_interval_hours; the API does not. Production must keep INFERRING the interval (R1: one implementation
// for training and live), so the archive column is used only here, to verify the inference. It never reaches a feature.
//
// The reading is PRE-REGISTERED (docs/feature-spec-v1.md a3 (iv)) and implemented in lib/indicators/features/funding.ts before any file that could
// decide it was opened: semantic events, refused rows, mismatches on non-refused rows, and one decision over the whole batch.
// It is read ONCE. Run it on the whole pre-agreed batch in a single pass and record the outcome whichever way it points.
// The reading scope is fixed BEFORE reading. If the semantic-event count lands in 3..9 the result is "suggestive"; no other file may be added to reach 10.
//
//   node scripts/check-funding-interval-oracle.mjs <fundingRate.json> [<fundingRate.json> ...]     (files written by scripts/fetch-archive.mjs)
// No network.
import { readFile } from "node:fs/promises";
import { checkIntervalInference, refusedRowsReport, semanticEvents, semanticsVerdict, decideIntervalRule, MIN_SEMANTIC_EVENTS, SUGGESTIVE_SEMANTIC_EVENTS, MIN_REFUSED_ROWS_FOR_RULE_CHANGE } from "../lib/indicators/features/funding.ts";

const files = process.argv.slice(2);
if (!files.length) throw new Error("usage: node scripts/check-funding-interval-oracle.mjs <fundingRate.json> [...]");
let compared = 0, matched = 0, refusedCount = 0;
const mismatches = [];
const refused = [];
const events = [];
for (const file of files) {
  const { symbol, rows } = JSON.parse(await readFile(file, "utf8"));
  const r = checkIntervalInference(rows);
  const ev = semanticEvents(rows);
  const rf = refusedRowsReport(rows);
  const truthIntervals = [...new Set(rows.map((x) => x.intervalHours))].sort((a, b) => a - b);
  console.log(`${String(symbol).padEnd(14)} rows ${String(rows.length).padEnd(4)} true intervals: ${truthIntervals.join("h,")}h | compared ${r.compared} matched ${r.matched} mismatched ${r.mismatches.length} | switch events ${ev.length} | refused rows ${rf.length}`);
  compared += r.compared; matched += r.matched; refusedCount += r.refused;
  mismatches.push(...r.mismatches.map((m) => ({ symbol, ...m })));
  refused.push(...rf.map((x) => ({ symbol, ...x })));
  events.push(...ev.map((x) => ({ symbol, ...x })));
}
const iso = (t) => new Date(t).toISOString().slice(0, 16);
const pattern = {};
for (const e of events) pattern[e.pattern] = (pattern[e.pattern] || 0) + 1;
console.log(`\nTOTAL compared ${compared}, matched ${matched}, mismatched on non-refused rows ${mismatches.length}, refused by rule A ${refusedCount}`);
const sem = semanticsVerdict(events);
console.log(`\nSEMANTICS (>= ${MIN_SEMANTIC_EVENTS} events all one pattern = established; ${SUGGESTIVE_SEMANTIC_EVENTS}..${MIN_SEMANTIC_EVENTS - 1} = suggestive; fewer = untested; mixed = unresolved): ${events.length} events, patterns ${JSON.stringify(pattern)} => ${sem.tier}${sem.pattern ? " (" + sem.pattern + ")" : ""}`);
for (const e of events.slice(0, 40)) console.log(`  ${e.symbol.padEnd(12)} ${iso(e.time)}  ${e.oldHours}h->${e.newHours}h  archive column (last old row, first new row) = (${e.truthPrev}, ${e.truthAt})  ${e.pattern}`);
console.log(`\nREFUSED ROWS (a rule change needs >= ${MIN_REFUSED_ROWS_FOR_RULE_CHANGE}): ${refused.length}`);
for (const x of refused) console.log(`  ${x.symbol.padEnd(12)} ${iso(x.time)}  actual gap ${x.actualHours.toFixed(3)}h, nominal new interval ${x.nominalHours}h, archive says ${x.truthHours}h  => ${x.verdict}`);
console.log(`\nMISMATCHES on non-refused rows: ${mismatches.length}`);
for (const m of mismatches.slice(0, 40)) console.log(`  ${m.symbol.padEnd(12)} ${iso(m.time)}  inferred ${m.inferred}h, archive ${m.truth}h${m.equalsPreviousInferred ? "  [equals the previous row's interval: the LAG form]" : ""}`);
const decision = decideIntervalRule({ mismatches, semantics: sem, refusedVerdicts: refused.map((x) => x.verdict) });
console.log(`\nPRE-REGISTERED DECISION: ${decision.action}${decision.suggestive ? " (suggestive only: recorded, not acted on)" : ""}`);
for (const r of decision.reasons) console.log("  - " + r);
process.exitCode = decision.action === "escalate" ? 2 : 0;
