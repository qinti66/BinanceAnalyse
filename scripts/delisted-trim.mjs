// Cutting a delisted contract's archive history where its real life ends.
//
// Why: after a contract is settled, data.binance.vision keeps publishing monthly files for it, filled with bars frozen at the settlement price
// (measured on 1000XUSDT 2026-08: 744 bars, open = high = low = close = 0.02555, volume 0, trades 0, sha256 valid). Using them would train on a price that never
// moved. Two independent rules, and the earlier cut wins:
//   1. deliveryDate (exchangeInfo, for contracts still listed as SETTLING): keep only bars that closed at or before it.
//   2. signature, needing no metadata (contracts that are gone from exchangeInfo have no deliveryDate, and unknown cases may exist): the first run of
//      FROZEN_RUN or more consecutive frozen bars (volume 0, trades 0, open = high = low = close) and everything after it is cut.
// The function also reports what it did, and `assertNothingPastCut` is a hard check for the caller.
const HOUR = 3600000;
export const FROZEN_RUN = 24;

const isFrozen = (r) => Number(r[5]) === 0 && Number(r[8]) === 0 && Number(r[1]) === Number(r[2]) && Number(r[2]) === Number(r[3]) && Number(r[3]) === Number(r[4]);

/** Index of the first bar of the first run of >= minRun consecutive frozen bars, or -1. */
export function firstFrozenRun(rows, minRun = FROZEN_RUN) {
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    run = isFrozen(rows[i]) ? run + 1 : 0;
    if (run >= minRun) return i - run + 1;
  }
  return -1;
}

/** Number of bars that close at or before deliveryMs (open time + step <= deliveryMs), assuming rows sorted oldest first. */
export function barsBeforeDelivery(rows, deliveryMs, stepMs = HOUR) {
  if (!Number.isFinite(deliveryMs)) return rows.length;
  let n = 0;
  while (n < rows.length && Number(rows[n][0]) + stepMs <= deliveryMs) n++;
  return n;
}

/**
 * rows: 12-column klines sorted oldest first. Returns { rows, kept, cutBy, cutAtIndex, dropped: { total, byDelivery, bySignature }, interiorFrozenBars }.
 * cutBy is "delivery", "signature", "both" (same place) or null (nothing to cut).
 */
export function trimDelisted(rows, { deliveryMs = NaN, stepMs = HOUR, minRun = FROZEN_RUN } = {}) {
  for (let i = 1; i < rows.length; i++) if (!(Number(rows[i][0]) > Number(rows[i - 1][0]))) throw new Error("rows must be sorted oldest first with unique open times");
  const byDeliveryIdx = barsBeforeDelivery(rows, deliveryMs, stepMs);
  const sig = firstFrozenRun(rows, minRun);
  const bySignatureIdx = sig >= 0 ? sig : rows.length;
  const cut = Math.min(byDeliveryIdx, bySignatureIdx);
  const kept = rows.slice(0, cut);
  const cutBy = cut === rows.length ? null : byDeliveryIdx === bySignatureIdx ? "both" : byDeliveryIdx < bySignatureIdx ? "delivery" : "signature";
  return {
    rows: kept,
    kept: kept.length,
    cutBy,
    cutAtIndex: cut,
    cutAtTime: cut < rows.length ? Number(rows[cut][0]) : null,
    dropped: { total: rows.length - cut, byDelivery: rows.length - byDeliveryIdx, bySignature: rows.length - bySignatureIdx },
    // frozen bars that remain (shorter halts inside the real life): kept, reported
    interiorFrozenBars: kept.filter(isFrozen).length,
  };
}

/** A hard check for the caller: no bar may sit at or after the cut time. Throws with the offending bar. */
export function assertNothingPastCut(rows, cutAtTime) {
  if (cutAtTime === null || cutAtTime === undefined) return;
  const bad = rows.find((r) => Number(r[0]) >= cutAtTime);
  if (bad) throw new Error("a bar at " + new Date(Number(bad[0])).toISOString() + " is at or after the cut " + new Date(cutAtTime).toISOString());
}

/** Funding rows [{time, rate, ...}] up to (not including) the delivery time; without a delivery time nothing can be cut and the caller is told. */
export function trimFunding(rows, deliveryMs) {
  if (!Number.isFinite(deliveryMs)) return { rows, cut: false, dropped: 0 };
  const kept = rows.filter((r) => r.time < deliveryMs);
  return { rows: kept, cut: kept.length !== rows.length, dropped: rows.length - kept.length };
}
