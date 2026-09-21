// R1: training and live scoring must read the SAME thing. Live collection can only ever hold ~400 1h bars (about 16 days), which is far too few to aggregate
// the 336 4h bars a feature needs (1344 hours), so live scoring uses the 4h klines the exchange returns. Training must therefore use the exchange's 4h too,
// never a 4h built from 1h. Where the exchange has no 4h bar the feature is missing; nothing fills it.
//
// Every kline file records where it came from in `source`. This is the check that a file about to feed a feature came from the exchange.
// (scripts/aggregate-4h.mjs and scripts/check-4h-reconcile.mjs are diagnostics that monitor the exchange's 1h/4h consistency; they are not on the data path.)

const NATIVE = /fapi\/v1\/klines|data\.binance\.vision/i;

/** Throws unless `file` is a kline file of `interval` whose source is the exchange (API or public archive), not an aggregate. */
export function assertNativeKlines(file, interval, label = "klines file") {
  if (!file || typeof file !== "object") throw new Error(`${label}: not a klines file`);
  if (file.interval !== undefined && file.interval !== interval) throw new Error(`${label}: interval ${file.interval}, expected ${interval}`);
  const source = String(file.source ?? "");
  if (/aggregat/i.test(source)) throw new Error(`${label}: its ${interval} bars are AGGREGATED ("${source}"); the model must only read the exchange's own ${interval} bars (R1)`);
  if (!NATIVE.test(source)) throw new Error(`${label}: unknown source "${source}"; expected the exchange API or its public archive`);
  return file;
}
