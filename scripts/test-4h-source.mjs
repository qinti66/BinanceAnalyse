// R1 for the 4h bars: training must read the exchange's own 4h, never a 4h built from 1h. These tests make that a mechanical fact, not a promise:
//   1. the source check accepts only files that say they came from the exchange, and rejects an aggregate;
//   2. no script on the data path imports the aggregator (only the reconciliation diagnostic and tests may);
//   3. every script that reads the 4h kline files of the calibration data passes them through the source check.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeKlines } from "./kline-source.mjs";
import { aggregate4h } from "./aggregate-4h.mjs";

// 1. the check itself
const ok = (source, interval = "4h") => ({ interval, source, rows: [] });
assert.doesNotThrow(() => assertNativeKlines(ok("fapi/v1/klines"), "4h"), "the API backfill");
assert.doesNotThrow(() => assertNativeKlines(ok("data.binance.vision futures/um monthly, sha256-verified, trimmed"), "4h"), "the public archive");
assert.throws(() => assertNativeKlines(ok("aggregated from the trimmed 1h"), "4h"), /AGGREGATED/);
assert.throws(() => assertNativeKlines(ok("Aggregated from 1h"), "4h"), /AGGREGATED/, "case does not matter");
assert.throws(() => assertNativeKlines(ok("aggregated, fapi/v1/klines"), "4h"), /AGGREGATED/, "a mention of the API does not rescue an aggregate");
assert.throws(() => assertNativeKlines(ok(""), "4h"), /unknown source/, "no source is not trusted");
assert.throws(() => assertNativeKlines(ok(undefined), "4h"), /unknown source/);
assert.throws(() => assertNativeKlines(ok("somewhere else"), "4h"), /unknown source/);
assert.throws(() => assertNativeKlines(ok("fapi/v1/klines", "1h"), "4h"), /expected 4h/, "the wrong interval");
assert.throws(() => assertNativeKlines(null, "4h"), /not a klines file/);
assert.throws(() => assertNativeKlines("x", "4h"), /not a klines file/);
// an aggregate built by aggregate4h carries no exchange source, so it cannot be dressed up by accident: the function returns bare rows, not a file
assert.ok(Array.isArray(aggregate4h([])), "aggregate4h returns rows only; a file has to be written by someone who then has to give it a source");

// 2. nobody on the data path imports the aggregator
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const libDir = join(scriptsDir, "..", "lib");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const sources = [...readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs")).map((f) => join(scriptsDir, f)), ...walk(libDir).filter((f) => /\.(ts|mjs)$/.test(f))];
const importsAggregator = (text) => /from\s+["'][^"']*aggregate-4h(\.mjs)?["']|import\(\s*["'][^"']*aggregate-4h(\.mjs)?["']\s*\)/.test(text);
const ALLOWED_AGGREGATOR_USERS = new Set(["check-4h-reconcile.mjs", "test-delisted-trim.mjs", "test-4h-source.mjs"]);
const users = sources.filter((f) => importsAggregator(readFileSync(f, "utf8"))).map((f) => f.split(/[\\/]/).pop());
assert.deepEqual(users.filter((u) => !ALLOWED_AGGREGATOR_USERS.has(u)), [], "a script outside the diagnostics imports the 4h aggregator (R1)");
// positive control: the scan does find the importers that are allowed (a scan that finds nothing proves nothing)
assert.ok(users.includes("check-4h-reconcile.mjs"), "the scan must see the reconciliation diagnostic");
assert.ok(sources.length > 50, "the scan covered " + sources.length + " files");
assert.ok(importsAggregator(`import { aggregate4h } from "./aggregate-4h.mjs";`) && importsAggregator(`const m = await import("./aggregate-4h.mjs")`), "the pattern catches both import forms");

// 3. every reader of the 4h calibration klines checks the source
const readsCalibration4h = (text) => /["']klines["']\s*,\s*["']4h["']/.test(text);
const NOT_FEATURE_READERS = new Set(["fetch-delisted.mjs", "backfill-klines.mjs", "check-4h-reconcile.mjs", "summarize-data.mjs"]); // writers and diagnostics
const readers = sources.filter((f) => f.endsWith(".mjs") && !f.split(/[\\/]/).pop().startsWith("test-") && readsCalibration4h(readFileSync(f, "utf8")));
const unchecked = readers.filter((f) => !NOT_FEATURE_READERS.has(f.split(/[\\/]/).pop()) && !/assertNativeKlines\(/.test(readFileSync(f, "utf8"))).map((f) => f.split(/[\\/]/).pop());
assert.deepEqual(unchecked, [], "a script reads the 4h calibration klines without the R1 source check");
const checked = readers.map((f) => f.split(/[\\/]/).pop());
for (const must of ["measure-live-coverage.mjs", "rehearse-pipeline.mjs", "measure-regime-persistence.mjs", "measure-regime-cutpoints.mjs"]) assert.ok(checked.includes(must), must + " reads 4h klines and must be covered by this scan");
console.log("4h source tests ok:", users.length, "aggregator importers,", readers.length, "readers of the 4h klines");
