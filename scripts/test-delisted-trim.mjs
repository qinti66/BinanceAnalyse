import assert from "node:assert/strict";
import { firstFrozenRun, barsBeforeDelivery, trimDelisted, assertNothingPastCut, trimFunding, FROZEN_RUN } from "./delisted-trim.mjs";
import { aggregate4h, compareBars } from "./aggregate-4h.mjs";

const H = 3600000;
const T0 = Date.UTC(2025, 0, 1);
const live = (i, p = 10 + (i % 7) * 0.1) => [T0 + i * H, String(p), String(p + 0.2), String(p - 0.2), String(p + 0.05), "100", T0 + (i + 1) * H - 1, "1000", 40, "50", "500", "0"];
const frozen = (i, p = 0.02555) => [T0 + i * H, String(p), String(p), String(p), String(p), "0", T0 + (i + 1) * H - 1, "0", 0, "0", "0", "0"];
const seq = (n, from = 0) => Array.from({ length: n }, (_, k) => live(from + k));
const tail = (n, from) => Array.from({ length: n }, (_, k) => frozen(from + k));

// signature detection
assert.equal(firstFrozenRun([...seq(10), ...tail(24, 10)]), 10, "24 frozen bars: the run starts at its first bar");
assert.equal(firstFrozenRun([...seq(10), ...tail(23, 10)]), -1, "23 is not enough");
assert.equal(firstFrozenRun([...seq(10), ...tail(23, 10), live(33), ...tail(30, 34)]), 34, "a live bar breaks a run; the run of 30 is found");
assert.equal(firstFrozenRun(seq(50)), -1);
assert.equal(firstFrozenRun([]), -1);
assert.equal(firstFrozenRun([...seq(5), ...tail(24, 5).map((r) => [...r.slice(0, 8), 1, ...r.slice(9)])]), -1, "a frozen price WITH a trade is not frozen");
assert.equal(firstFrozenRun([...seq(5), ...tail(24, 5).map((r) => [...r.slice(0, 5), "3", ...r.slice(6)])]), -1, "a frozen price with volume is not frozen");
assert.equal(firstFrozenRun([...seq(5), ...tail(24, 5).map((r, k) => [r[0], r[1], r[2], r[3], k % 2 ? "0.02556" : r[4], ...r.slice(5)])]), -1, "open, high, low and close must all be equal");
assert.equal(FROZEN_RUN, 24);

// delivery cut
const d = T0 + 100 * H; // delivery exactly on the hour
assert.equal(barsBeforeDelivery(seq(200), d), 100, "bars that closed at or before the delivery hour: the bar [99h,100h) is kept, [100h,101h) is not");
assert.equal(barsBeforeDelivery(seq(200), d + 1800000), 100, "a delivery mid-hour drops the partial bar");
assert.equal(barsBeforeDelivery(seq(200), NaN), 200, "no delivery date: nothing cut by this rule");
assert.equal(barsBeforeDelivery(seq(50), d), 50);

// trimDelisted: both rules, the earlier wins
const life = seq(100);
const wholeMonth = [...life, ...tail(300, 100)]; // 100 real bars, then frozen up to the month end
let r = trimDelisted(wholeMonth, { deliveryMs: d });
assert.equal(r.kept, 100);
assert.equal(r.cutBy, "both", "both rules cut at the same bar");
assert.equal(r.dropped.total, 300);
assert.equal(r.cutAtTime, T0 + 100 * H);
r = trimDelisted(wholeMonth, {}); // a contract gone from exchangeInfo: only the signature
assert.equal(r.kept, 100);
assert.equal(r.cutBy, "signature");
r = trimDelisted([...life, ...tail(300, 100)], { deliveryMs: T0 + 60 * H }); // delivery earlier than the frozen run
assert.equal(r.kept, 60);
assert.equal(r.cutBy, "delivery", "an earlier delivery date wins");
assert.equal(r.dropped.bySignature, 300);
r = trimDelisted([...life, ...tail(300, 100)], { deliveryMs: T0 + 5000 * H }); // delivery later than the data: the signature still catches it
assert.equal(r.kept, 100);
assert.equal(r.cutBy, "signature", "metadata that would let the fake bars through does not");
r = trimDelisted(seq(40), { deliveryMs: T0 + 5000 * H });
assert.equal(r.cutBy, null);
assert.equal(r.kept, 40);
assert.equal(r.cutAtTime, null);
// a short halt inside the real life is kept and reported, not cut
r = trimDelisted([...seq(30), ...tail(10, 30), ...seq(20, 40)], {});
assert.equal(r.kept, 60);
assert.equal(r.interiorFrozenBars, 10);
assert.equal(r.cutBy, null);
assert.throws(() => trimDelisted([live(1), live(0)], {}), /sorted oldest first/);
assert.throws(() => trimDelisted([live(0), live(0)], {}), /unique open times/);

// the hard check
r = trimDelisted(wholeMonth, {});
assertNothingPastCut(r.rows, r.cutAtTime);
assert.throws(() => assertNothingPastCut(wholeMonth, r.cutAtTime), /at or after the cut/);
assertNothingPastCut(seq(3), null);

// funding
const f = [{ time: d - 8 * H, rate: 1 }, { time: d, rate: 2 }, { time: d + 8 * H, rate: 3 }];
assert.deepEqual(trimFunding(f, d).rows.map((x) => x.rate), [1], "a settlement at the delivery time itself is not kept");
assert.equal(trimFunding(f, d).dropped, 2);
assert.equal(trimFunding(f, NaN).cut, false, "no delivery date: not cut, and the caller can see that");

// 4h aggregation
const four = Array.from({ length: 8 }, (_, i) => live(i)); // T0 is 00:00 UTC, a 4h boundary
const a = aggregate4h(four);
assert.equal(a.length, 2);
assert.deepEqual([a[0][0], a[0][6]], [T0, T0 + 4 * H - 1]);
assert.equal(a[0][1], four[0][1], "open = first open");
assert.equal(a[0][4], four[3][4], "close = last close");
assert.equal(Number(a[0][2]), Math.max(...four.slice(0, 4).map((x) => Number(x[2]))), "high = max");
assert.equal(Number(a[0][3]), Math.min(...four.slice(0, 4).map((x) => Number(x[3]))), "low = min");
assert.equal(Number(a[0][5]), 400);
assert.equal(a[0][8], 160);
assert.equal(aggregate4h([...four.slice(0, 3), ...four.slice(4)]).length, 1, "an incomplete group is dropped, never completed");
assert.equal(aggregate4h([four[0], four[1], four[3]]).length, 0);
assert.equal(aggregate4h(four.map((x, i) => (i === 5 ? [x[0] + 1, ...x.slice(1)] : x))).length, 1, "a bar off the hour grid breaks its group");
assert.deepEqual(compareBars(a[0], a[0]), []);
assert.deepEqual(compareBars(a[0], [...a[0].slice(0, 2), "99", ...a[0].slice(3)]), ["high"]);
console.log("delisted-trim and aggregate-4h tests ok");

// ---- the whole per-contract flow with a fake archive (no network)
{
  const { processSymbol, planFor } = await import("./fetch-delisted.mjs");
  const { mkdtemp, mkdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "delisted-test-"));
  try {
    for (const d of ["klines/1h", "klines/4h", "funding"]) await mkdir(join(dir, d), { recursive: true });
    const Y = Date.UTC(2025, 0, 1);
    const csvOf = (rows) => "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n" + rows.map((r) => r.join(",")).join("\n");
    const bar = (i, frozenBar) => {
      const t = Y + i * H;
      return frozenBar ? [t, "0.02555", "0.02555", "0.02555", "0.02555", "0", t + H - 1, "0", 0, "0", "0", "0"] : [t, "1.0", "1.2", "0.9", "1.1", "5", t + H - 1, "5.5", 3, "2", "2.2", "0"];
    };
    // January 2025 (744 hours): real for 300 hours, then frozen to the end of the month; delivery at hour 300 exactly
    const january = Array.from({ length: 744 }, (_, i) => bar(i, i >= 300));
    const fundingCsv = "calc_time,funding_interval_hours,last_funding_rate\n" + [0, 8, 16, 24, 32].map((h) => `${Y + h * 300 * 0 + h * 3600000 * 10},8,0.0001`).join("\n");
    const seen = [];
    const getMonth = async (url, name) => {
      seen.push(name);
      if (name === "TESTUSDT-1h-2025-01") return { status: "ok", csv: csvOf(january), bytes: 1000 };
      if (name === "TESTUSDT-fundingRate-2025-01") return { status: "ok", csv: fundingCsv, bytes: 100 };
      return { status: "missing" };
    };
    const plan = [{ symbol: "TESTUSDT", kind: "SETTLING", first: "2025-01", end: "2025-01", months: 1, deliveryMs: Y + 300 * H }];
    const r = await processSymbol(planFor(plan, "TESTUSDT"), { outDir: dir, withFunding: true, getMonth });
    const file = JSON.parse(await readFile(join(dir, "klines", "1h", "TESTUSDT.json"), "utf8"));
    assert.equal(file.rows.length, 300, "744 bars in the month, 300 real ones kept");
    assert.equal(file.trim.cutBy, "both");
    assert.equal(file.trim.dropped.total, 444);
    assert.equal(file.end, Y + 300 * H, "the file ends where the real life ends");
    assert.ok(file.rows.every((x) => Number(x[0]) < Y + 300 * H), "no bar past the delivery");
    assert.ok(file.rows.every((x) => Number(x[8]) > 0), "every kept bar traded");
    const four = JSON.parse(await readFile(join(dir, "klines", "4h", "TESTUSDT.json"), "utf8"));
    assert.equal(four.rows.length, 75, "300 hours = 75 complete 4h bars");
    const fund = JSON.parse(await readFile(join(dir, "funding", "TESTUSDT.json"), "utf8"));
    assert.ok(fund.rows.every((x) => x.time < Y + 300 * H) && fund.rows.length > 0 && fund.dropped > 0, "funding is cut at the delivery too");
    assert.equal(r.requests, 4, "one kline month and one funding month, each with its checksum");
    assert.match(r.line, /1h kept 300, dropped 444 \(both at 2025-01-13T12:00\)/);
    assert.deepEqual(seen, ["TESTUSDT-1h-2025-01", "TESTUSDT-fundingRate-2025-01"]);
    // a contract with no delivery date: only the signature protects it
    const gone = [{ symbol: "TESTUSDT", kind: "gone", first: "2025-01", end: "2025-01", months: 1, deliveryMs: null }];
    const g = await processSymbol(planFor(gone, "TESTUSDT"), { outDir: dir, withFunding: true, getMonth });
    assert.match(g.line, /kept 300, dropped 444 \(signature/);
    assert.match(g.line, /NOT cut \(no delivery date\)/, "funding cannot be cut without a delivery date, and the report says so");
    assert.throws(() => planFor(plan, "NOPEUSDT"), /not in the plan/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log("fetch-delisted flow test ok");
