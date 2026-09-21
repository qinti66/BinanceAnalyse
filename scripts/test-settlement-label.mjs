// The pre-registered settlement-time barrier (labels.ts, TripleBarrierOptions.settlementMs; calibration-log T30):
// a settled contract's window that runs past its settlement is cut AT the settlement, the barriers are checked as usual to that point, first touch decides,
// no touch is flat. Contracts without a real deliveryDate never get it. No new parameter.
import assert from "node:assert/strict";
import { tripleBarrier, splitBySettlement } from "../lib/indicators/labels.ts";
import { atrSeries } from "../lib/structure/atr.ts";

const H = 3600000;
const T0 = Date.UTC(2025, 5, 1);
const bar = (i, o, h, l, c) => ({ t: T0 + i * H, ct: T0 + (i + 1) * H - 1, o, h, l, c, v: 1, qvUsd: 1, takerBuyUsd: 1, trades: 1, flow: null });
// a calm series around 100 with a small range (ATR% about 0.4%)
const calm = (n) => Array.from({ length: n }, (_, i) => bar(i, 100, 100.2, 99.8, 100));
const OPT = { horizonBars: 24, k: 1, cost: 0.001 };
const SETTLE = T0 + 100 * H; // the last bar is [99h, 100h): the bars end exactly at the settlement

// 1. a crash inside the last hours before the settlement: the down barrier is touched first, exactly as an ordinary label
{
  const bars = calm(100);
  bars[97] = bar(97, 100, 100.1, 70, 72); // -28%
  const atr = atrSeries(bars, 14);
  const r = tripleBarrier(bars, 90, atr, { ...OPT, settlementMs: SETTLE });
  assert.equal(r.label, "down");
  assert.equal(r.settled, true, "the window ran past the settlement: it is a settlement-cut label, and marked as one");
  assert.equal(r.touchIndex, 97);
  assert.equal(r.endIndex, 99, "the label used the data up to the last bar");
  // WITHOUT the settlement time the same decision has no label at all (the old rule, and still the rule for a contract with no real deliveryDate)
  const plain = tripleBarrier(bars, 90, atr, OPT);
  assert.equal(plain.label, null);
  assert.equal(plain.reason, "forward window incomplete");
  assert.equal(plain.settled, false);
}
// 2. nothing touched by the settlement: flat (the settlement time is a time barrier that arrived early)
{
  const bars = calm(100);
  const r = tripleBarrier(bars, 90, atrSeries(bars, 14), { ...OPT, settlementMs: SETTLE });
  assert.equal(r.label, "flat");
  assert.equal(r.settled, true);
  assert.equal(r.touchIndex, null);
}
// 3. up barrier
{
  const bars = calm(100);
  bars[95] = bar(95, 100, 130, 99.9, 129);
  assert.equal(tripleBarrier(bars, 90, atrSeries(bars, 14), { ...OPT, settlementMs: SETTLE }).label, "up");
}
// 4. the same-bar rule is the ordinary one
{
  const bars = calm(100);
  bars[95] = bar(95, 100, 130, 70, 100);
  const r = tripleBarrier(bars, 90, atrSeries(bars, 14), { ...OPT, settlementMs: SETTLE });
  assert.equal(r.label, "down");
  assert.equal(r.ambiguous, true);
  assert.equal(tripleBarrier(bars, 90, atrSeries(bars, 14), { ...OPT, settlementMs: SETTLE, sameBar: "flat" }).label, "flat");
}
// 5. k, cost and ATR are the ordinary ones: a settlement-cut label equals the ordinary label on the same bars whenever a barrier is touched before the settlement
{
  const bars = calm(100);
  bars[97] = bar(97, 100, 100.1, 70, 72);
  const extended = [...bars, ...Array.from({ length: 30 }, (_, i) => bar(100 + i, 72, 72.1, 71.9, 72))];
  const atr = atrSeries(bars, 14);
  const settledLabel = tripleBarrier(bars, 90, atr, { ...OPT, settlementMs: SETTLE });
  const ordinary = tripleBarrier(extended, 90, atrSeries(extended, 14), OPT);
  assert.equal(settledLabel.label, ordinary.label);
  assert.equal(settledLabel.touchIndex, ordinary.touchIndex);
  assert.equal(ordinary.settled, false);
}
// 6. where the rule does NOT apply, the label is null as ever
{
  const bars = calm(100);
  const atr = atrSeries(bars, 14);
  assert.equal(tripleBarrier(bars, 90, atr, { ...OPT, settlementMs: null }).label, null, "no deliveryDate");
  assert.equal(tripleBarrier(bars, 90, atr, { ...OPT, settlementMs: undefined }).label, null);
  assert.equal(tripleBarrier(bars, 90, atr, { ...OPT, settlementMs: NaN }).label, null);
  assert.equal(tripleBarrier(bars, 90, atr, { ...OPT, settlementMs: T0 + 400 * H }).label, null, "the settlement is far after the data: the data did not end at it, the window is simply incomplete");
  assert.equal(tripleBarrier(bars, 90, atr, { ...OPT, settlementMs: T0 + 50 * H }).label, null, "a settlement before the last bar opened: the bars do not end at it");
  assert.equal(tripleBarrier(bars, 99, atr, { ...OPT, settlementMs: SETTLE }).label, null, "a decision at the last bar has no bar after it before the settlement");
  assert.match(tripleBarrier(bars, 99, atr, { ...OPT, settlementMs: SETTLE }).reason, /no bar after the entry/);
  assert.equal(tripleBarrier(bars, 98, atr, { ...OPT, settlementMs: SETTLE }).label, "flat", "one bar left before the settlement is enough for a label");
}
// 7. a partial last hour (delivery mid-hour): the bars end INSIDE the last bar
{
  const bars = calm(101); // the last bar [100h, 101h) is the partial hour
  bars[100] = bar(100, 100, 100.1, 60, 65);
  const r = tripleBarrier(bars, 90, atrSeries(bars, 14), { ...OPT, settlementMs: T0 + 100 * H + 1800000 });
  assert.equal(r.label, "down", "the last move, in the partial hour, is in the label path");
  assert.equal(r.settled, true);
  assert.equal(r.touchIndex, 100);
}
// 8. windows that are complete are untouched by the option: same result, not settled
{
  const bars = calm(200);
  bars[150] = bar(150, 100, 100.1, 70, 72);
  const atr = atrSeries(bars, 14);
  const a = tripleBarrier(bars, 140, atr, OPT);
  const b = tripleBarrier(bars, 140, atr, { ...OPT, settlementMs: T0 + 200 * H });
  assert.deepEqual(a, b);
  assert.equal(b.settled, false, "a fully observed window is an ordinary label even for a settled contract");
}
// 9. missing stays missing inside the window
{
  const bars = calm(100).filter((b, i) => i !== 95); // a gap inside the forward window
  assert.equal(tripleBarrier(bars, 90, atrSeries(bars, 14), { ...OPT, settlementMs: SETTLE }).label, null, "a gap is still a gap");
  const noCost = tripleBarrier(calm(100), 90, atrSeries(calm(100), 14), { ...OPT, cost: null, settlementMs: SETTLE });
  assert.equal(noCost.label, null);
}
// 10. reported separately, never mixed
{
  const calmBars = calm(100);
  const crash = calm(100);
  crash[97] = bar(97, 100, 100.1, 70, 72);
  const results = [
    tripleBarrier(calmBars, 90, atrSeries(calmBars, 14), { ...OPT, settlementMs: SETTLE }), // settled flat
    tripleBarrier(crash, 90, atrSeries(crash, 14), { ...OPT, settlementMs: SETTLE }), // settled down
    tripleBarrier(crash, 50, atrSeries(crash, 14), OPT), // ordinary, complete window (flat)
    tripleBarrier(calmBars, 99, atrSeries(calmBars, 14), { ...OPT, settlementMs: SETTLE }), // null: no bar after
  ];
  const split = splitBySettlement(results);
  assert.equal(split.settled.n, 2);
  assert.equal(split.ordinary.n, 1);
  assert.equal(split.settled.counts.down, 1);
  assert.equal(split.settled.counts.flat, 1);
  assert.equal(split.ordinary.counts.flat, 1);
}
console.log("settlement-label tests ok");
