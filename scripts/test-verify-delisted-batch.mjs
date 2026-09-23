// Runs the read-only verifier against fixture directories and checks it reports (or does not report) the right problems, and that it never writes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./verify-delisted-batch.mjs", import.meta.url));
const H = 3600000;
const T0 = Date.UTC(2025, 5, 1);
const bar = (i) => [T0 + i * H, "1", "1.1", "0.9", "1", "10", T0 + (i + 1) * H - 1, "10", 5, "5", "5", "0"];

async function scaffold() {
  const dir = await mkdtemp(join(tmpdir(), "verify-test-"));
  for (const d of ["klines/1h", "klines/4h", "funding"]) await mkdir(join(dir, d), { recursive: true });
  return dir;
}
const run = (dir, plan) => execFileSync(process.execPath, [script, dir, ...(plan ? [plan] : [])], { encoding: "utf8" });

// 1. a clean SETTLING contract: no problems
{
  const dir = await scaffold();
  try {
    const delivery = T0 + 50 * H;
    await writeFile(join(dir, "klines", "1h", "A.json"), JSON.stringify({ symbol: "A", source: "data.binance.vision futures/um", trim: { cutBy: "delivery", partialLastBarOpen: null, deliveryMs: delivery }, rows: Array.from({ length: 50 }, (_, i) => bar(i)) }));
    await writeFile(join(dir, "klines", "4h", "A.json"), JSON.stringify({ symbol: "A", source: "data.binance.vision futures/um", trim: { cutBy: "delivery" }, rows: [bar(0)] }));
    await writeFile(join(dir, "funding", "A.json"), JSON.stringify({ symbol: "A", rows: [{ time: T0 + 10 * H, rate: 0.0001 }] }));
    const plan = join(dir, "plan.json");
    await writeFile(plan, JSON.stringify([{ symbol: "A", deliveryMs: delivery }]));
    const out = run(dir, plan);
    assert.match(out, /no problems found/);
    const before = (await readdir(dir, { recursive: true })).sort().join("|");
    run(dir, plan);
    assert.equal((await readdir(dir, { recursive: true })).sort().join("|"), before, "the verifier writes nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 2. an aggregated 4h file: flagged (R1)
{
  const dir = await scaffold();
  try {
    await writeFile(join(dir, "klines", "1h", "B.json"), JSON.stringify({ symbol: "B", source: "data.binance.vision futures/um", trim: {}, rows: [bar(0), bar(1)] }));
    await writeFile(join(dir, "klines", "4h", "B.json"), JSON.stringify({ symbol: "B", source: "aggregated from the trimmed 1h", trim: {}, rows: [bar(0)] }));
    const out = run(dir);
    assert.match(out, /B:.*4h source:.*AGGREGATED/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 3. rows out of order, empty rows, and a funding row past the cut
{
  const dir = await scaffold();
  try {
    await writeFile(join(dir, "klines", "1h", "C.json"), JSON.stringify({ symbol: "C", source: "fapi/v1/klines", trim: {}, rows: [bar(1), bar(0)] }));
    await writeFile(join(dir, "klines", "1h", "D.json"), JSON.stringify({ symbol: "D", source: "fapi/v1/klines", trim: {}, rows: [] }));
    const delivery = T0 + 5 * H;
    await writeFile(join(dir, "klines", "1h", "E.json"), JSON.stringify({ symbol: "E", source: "fapi/v1/klines", trim: { cutBy: "delivery", deliveryMs: delivery }, rows: [bar(0)] }));
    await writeFile(join(dir, "funding", "E.json"), JSON.stringify({ symbol: "E", rows: [{ time: delivery + H, rate: 0.0001 }] }));
    const plan = join(dir, "plan.json");
    await writeFile(plan, JSON.stringify([{ symbol: "E", deliveryMs: delivery }]));
    const out = run(dir, plan);
    assert.match(out, /C: 1h rows not strictly increasing/);
    assert.match(out, /D: 1h has no rows/);
    assert.match(out, /E:.*funding's last row.*is not before the cut/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 4. a "gone" contract (no deliveryDate) miscut as "delivery": flagged
{
  const dir = await scaffold();
  try {
    await writeFile(join(dir, "klines", "1h", "F.json"), JSON.stringify({ symbol: "F", source: "data.binance.vision futures/um", trim: { cutBy: "delivery" }, rows: [bar(0)] }));
    const plan = join(dir, "plan.json");
    await writeFile(plan, JSON.stringify([{ symbol: "F", deliveryMs: null }]));
    const out = run(dir, plan);
    assert.match(out, /F:.*"gone" contract.*cutBy="delivery"/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 5. a mismatched 1h/4h pair, and a missing funding file when a plan is given
{
  const dir = await scaffold();
  try {
    await writeFile(join(dir, "klines", "1h", "G.json"), JSON.stringify({ symbol: "G", source: "fapi/v1/klines", trim: {}, rows: [bar(0)] }));
    const plan = join(dir, "plan.json");
    await writeFile(plan, JSON.stringify([{ symbol: "G", deliveryMs: null }]));
    const out = run(dir, plan);
    assert.match(out, /G: has 1h but no 4h file/);
    assert.match(out, /G: no funding file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 6. a partial last bar correctly placed: no problem; incorrectly placed: flagged
{
  const dir = await scaffold();
  try {
    await writeFile(join(dir, "klines", "1h", "H.json"), JSON.stringify({ symbol: "H", source: "fapi/v1/klines", trim: { partialLastBarOpen: T0 + 4 * H }, rows: [bar(0), bar(1), bar(2), bar(3), bar(4)] }));
    await writeFile(join(dir, "klines", "4h", "H.json"), JSON.stringify({ symbol: "H", source: "fapi/v1/klines", trim: {}, rows: [bar(0)] }));
    const out = run(dir);
    assert.match(out, /no problems found/);
    await writeFile(join(dir, "klines", "1h", "H.json"), JSON.stringify({ symbol: "H", source: "fapi/v1/klines", trim: { partialLastBarOpen: T0 * 99 }, rows: [bar(0), bar(1)] }));
    const out2 = run(dir);
    assert.match(out2, /H: partialLastBarOpen does not point at the last row/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("verify-delisted-batch tests ok");
