import assert from "node:assert/strict";
import { rankOf } from "./log-predictions.mjs";

// ascending by d1 (T40: low d1 = most compressed = the direction that predicts "moved"), rank 1 = most compressed.
{
  const r = rankOf([
    { symbol: "A", d1: 50 },
    { symbol: "B", d1: 10 },
    { symbol: "C", d1: 90 },
  ]);
  assert.deepEqual(r.map((x) => x.symbol), ["B", "A", "C"]);
  assert.equal(r[0].rank, 1);
  assert.equal(r[0].percentile, 0);
  assert.equal(r[r.length - 1].percentile, 1);
}

// non-finite d1 is dropped, not ranked with a placeholder (missing stays missing).
{
  const r = rankOf([
    { symbol: "A", d1: 50 },
    { symbol: "B", d1: NaN },
    { symbol: "C", d1: null },
  ]);
  assert.deepEqual(r.map((x) => x.symbol), ["A"]);
}

// a single entry: percentile is 0, not NaN from a 0/0 division.
{
  const r = rankOf([{ symbol: "A", d1: 50 }]);
  assert.equal(r[0].percentile, 0);
}

console.log("log-predictions tests ok");
