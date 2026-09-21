import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { klineFacts, fundingFacts, positionFacts, summarise } from "./summarize-data.mjs";

const H = 3600000;
const bar = (t, o = 10, h = 11, l = 9, c = 10, v = 5) => [t, String(o), String(h), String(l), String(c), String(v), t + H - 1, "1", 1, "1", "1", "0"];
const run = (n, from = 0) => Array.from({ length: n }, (_, i) => bar(from + i * H));

// klineFacts
assert.deepEqual(klineFacts({ end: 5 * H, rows: run(5) }, H), { bars: 5, first: 0, last: 4 * H, gaps: 0, bad: 0, unordered: 0, shortOfEnd: false });
assert.equal(klineFacts({ end: 5 * H, rows: [...run(2), ...run(2, 3 * H)] }, H).gaps, 1, "a missing bar is a gap");
assert.equal(klineFacts({ end: 6 * H, rows: run(5) }, H).shortOfEnd, true, "the file stops before the requested end");
assert.equal(klineFacts({ end: 5 * H, rows: [bar(0), bar(H, 10, 8, 9, 10)] }, H).bad, 1, "high below low");
assert.equal(klineFacts({ end: 5 * H, rows: [bar(0, 10, 11, 9, 12)] }, H).bad, 1, "close above high");
assert.equal(klineFacts({ end: 5 * H, rows: [bar(0, 0, 11, 9, 10)] }, H).bad, 1, "a zero price");
assert.equal(klineFacts({ end: 5 * H, rows: [bar(0, 10, 11, 9, 10, -1)] }, H).bad, 1, "a negative volume");
assert.equal(klineFacts({ end: 5 * H, rows: [bar(0), bar(0)] }, H).unordered, 1, "a duplicate open time");
assert.equal(klineFacts({ end: 5 * H, rows: [] }, H).bars, 0);
assert.equal(klineFacts({}, H).bars, 0, "a file without rows");
assert.equal(klineFacts({ end: 5 * H, rows: [bar(0, 10, 10, 10, 10, 0)] }, H).bad, 0, "a flat bar with no volume is legitimate");

// fundingFacts
assert.deepEqual(fundingFacts({ rows: [{ time: 1, rate: 0.0001 }, { time: 2, rate: -0.0002 }] }), { rows: 2, first: 1, last: 2, bad: 0, unordered: 0 });
assert.equal(fundingFacts({ rows: [{ time: 1, rate: NaN }] }).bad, 1);
assert.equal(fundingFacts({ rows: [{ time: 2, rate: 0 }, { time: 1, rate: 0 }] }).unordered, 1);

// positionFacts: a contiguous hourly run has no holes; a hole widens the span beyond the point count
assert.deepEqual(positionFacts({ points: [{ timestamp: 0 }, { timestamp: H }, { timestamp: 2 * H }] }), { points: 3, first: 0, last: 2 * H, holes: 0, spanHours: 2 });
assert.deepEqual(positionFacts({ points: [{ timestamp: 3 * H }, { timestamp: 0 }, { timestamp: H }] }), { points: 3, first: 0, last: 3 * H, holes: 1, spanHours: 3 }, "unsorted input, one missing hour");
assert.equal(positionFacts({}).points, 0);

// the whole summary over a fixture directory, and it must not write anything
const dir = await mkdtemp(join(tmpdir(), "sum-test-"));
try {
  const cal = join(dir, "calibration");
  await mkdir(join(cal, "klines", "1h"), { recursive: true });
  await mkdir(join(cal, "klines", "4h"), { recursive: true });
  await mkdir(join(cal, "funding"), { recursive: true });
  await mkdir(join(dir, "indicators", "positions"), { recursive: true });
  const put = (p, o) => writeFile(join(cal, ...p), JSON.stringify(o));
  await put(["klines", "1h", "A.json"], { symbol: "A", interval: "1h", start: 0, end: 5 * H, rows: run(5) });
  await put(["klines", "1h", "哈基米USDT.json"], { symbol: "哈基米USDT", interval: "1h", start: 0, end: 5 * H, rows: [] });
  await put(["klines", "1h", "C.json"], { symbol: "C", interval: "1h", start: 0, end: 5 * H, rows: [...run(2), ...run(2, 3 * H)] });
  await writeFile(join(cal, "klines", "1h", "D.json"), "{ truncated");
  await put(["funding", "A.json"], { symbol: "A", start: 0, end: 5 * H, rows: [{ time: 0, rate: 0.0001 }, { time: 8 * H, rate: 0.0001 }] });
  await put(["funding", "E.json"], { symbol: "E", start: 0, end: 5 * H, rows: [] });
  await writeFile(join(dir, "indicators", "positions", "UM-A.json"), JSON.stringify({ lastFetchedAt: 1, points: [{ timestamp: 0 }, { timestamp: H }], gaps: [{ from: 1, to: 2 }] }));
  const before = (await readdir(cal, { recursive: true })).sort().join("|");
  const out = await summarise(dir);
  const text = out.join("\n");
  assert.match(out[0], /^klines 1h: 4 files \| 2 with bars \| 9 bars \| 1970-01-01T00:00Z \.\. 1970-01-01T04:00Z/);
  assert.match(text, /1 empty \(listed after the range\)/);
  assert.match(text, /1 with gaps \(e\.g\. C\)/);
  assert.match(text, /1 unreadable/);
  assert.match(text, /klines 4h: 0 files/);
  assert.match(text, /funding: 2 files \| 1 with rows \| 2 rows/);
  assert.match(text, /1 empty/);
  assert.match(text, /positions: 1 files \| 2 points .* recorded gaps 1 \| most points in one file 2/);
  assert.doesNotMatch(text, /hourly holes/, "contiguous points: no holes line");
  await writeFile(join(dir, "indicators", "positions", "UM-B.json"), JSON.stringify({ points: [{ timestamp: 0 }, { timestamp: H }, { timestamp: 5 * H }], gaps: [] }));
  const holesText = (await summarise(dir)).join("\n");
  assert.match(holesText, /hourly holes inside the exchange data: 1 files \(e\.g\. UM-B \(3 points over 5h, 1 holes\)\)/);
  assert.equal((await readdir(cal, { recursive: true })).sort().join("|"), before, "nothing was written");
  // a clean directory reports no problems
  const clean = await mkdtemp(join(tmpdir(), "sum-clean-"));
  try {
    await mkdir(join(clean, "calibration", "klines", "1h"), { recursive: true });
    await writeFile(join(clean, "calibration", "klines", "1h", "A.json"), JSON.stringify({ interval: "1h", start: 0, end: 5 * H, rows: run(5) }));
    const cleanOut = await summarise(clean);
    assert.equal(cleanOut[1], "  problems: none");
  } finally {
    await rm(clean, { recursive: true, force: true });
  }
  // a missing directory is reported, not fatal
  assert.match((await summarise(join(dir, "nothing-here")))[0], /no directory/);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log("summarize-data tests ok");
