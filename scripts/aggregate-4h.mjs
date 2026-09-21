// Build 4h klines from 1h klines locally (no request). A 4h bar opens on 00, 04, 08, 12, 16 or 20 UTC and is made of the four 1h bars that open in it.
// Rows are Binance's 12 raw columns. Only a COMPLETE group of four consecutive 1h bars becomes a 4h bar; an incomplete group is dropped, never
// completed or filled (missing stays missing).
//   open = first open, high = max high, low = min low, close = last close, volume / quote volume / trades / taker volumes = sums.
// scripts/check-4h-reconcile.mjs compares this against Binance's own 4h klines before the aggregation is used for anything.
const H = 3600000;
const H4 = 4 * H;

export function aggregate4h(rows1h) {
  const groups = new Map();
  for (const r of rows1h) {
    const t = Number(r[0]);
    if (!Number.isFinite(t) || t % H !== 0) continue;
    const key = Math.floor(t / H4) * H4;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
  }
  const out = [];
  for (const [key, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    g.sort((a, b) => a[0] - b[0]);
    if (g.length !== 4 || g.some((r, i) => Number(r[0]) !== key + i * H)) continue;
    const n = (r, i) => Number(r[i]);
    out.push([
      key,
      g[0][1],
      String(Math.max(...g.map((r) => n(r, 2)))),
      String(Math.min(...g.map((r) => n(r, 3)))),
      g[3][4],
      String(g.reduce((a, r) => a + n(r, 5), 0)),
      key + H4 - 1,
      String(g.reduce((a, r) => a + n(r, 7), 0)),
      g.reduce((a, r) => a + n(r, 8), 0),
      String(g.reduce((a, r) => a + n(r, 9), 0)),
      String(g.reduce((a, r) => a + n(r, 10), 0)),
      "0",
    ]);
  }
  return out;
}

/** Compare an aggregated bar with Binance's own 4h bar: exact for prices and trade count, a relative tolerance for the sums (decimal strings added in floating point). */
export function compareBars(agg, real, tol = 1e-9) {
  const diffs = [];
  const eq = (a, b) => Number(a) === Number(b);
  const close = (a, b) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(a)), Math.abs(Number(b)));
  if (!eq(agg[0], real[0])) diffs.push("openTime");
  if (!eq(agg[1], real[1])) diffs.push("open");
  if (!eq(agg[2], real[2])) diffs.push("high");
  if (!eq(agg[3], real[3])) diffs.push("low");
  if (!eq(agg[4], real[4])) diffs.push("close");
  if (!close(agg[5], real[5])) diffs.push("volume");
  if (!eq(agg[6], real[6])) diffs.push("closeTime");
  if (!close(agg[7], real[7])) diffs.push("quoteVolume");
  if (!eq(agg[8], real[8])) diffs.push("trades");
  if (!close(agg[9], real[9])) diffs.push("takerBuyVolume");
  if (!close(agg[10], real[10])) diffs.push("takerBuyQuoteVolume");
  return diffs;
}
