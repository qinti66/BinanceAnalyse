// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// A REHEARSAL of the calibration pipeline on the real downloaded universe. It checks that every stage RUNS and that its controls behave (the random-feature
// baseline sits near zero, shuffled labels destroy the score, the gate refuses). It is NOT a result: the numbers below say nothing about whether the
// features predict anything, no threshold is set or tuned by it, and nothing it prints may be quoted as a model performance.
//
//   node --max-old-space-size=8192 scripts/rehearse-pipeline.mjs <dataDir> [horizon: 4 | 24] [everyNthDay]
//
// Universe: only contracts still trading on 2026-09-21 (survivors). The gate is therefore given the truth about the universe: 121 delisted contracts
// identified, none obtained. Its verdict on that is part of the rehearsal.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toBars } from "../lib/structure/bars.ts";
import { atrSeries } from "../lib/structure/atr.ts";
import { buildFeatureVector, FEATURE_IDS } from "../lib/indicators/features/registry.ts";
import { buildCrossSection } from "../lib/indicators/features/context.ts";
import { lastIndexClosedBy } from "../lib/indicators/features/stats.ts";
import { tripleBarrier, roundTripCost, labelK, classIndex, SLIPPAGE_ROUND_TRIP_ASSUMED } from "../lib/indicators/labels.ts";
import { walkForwardFolds, foldViolations, uniquenessWeights, effectiveN, MIN_TEST_START_MS } from "../lib/calibration/splits.ts";
import { fitSoftmax, predictProba } from "../lib/calibration/softmax.ts";
import { baseRates, bss, ece, classCounts } from "../lib/calibration/metrics.ts";
import { randomFeatureBaseline, blockShiftLabels, leakCheck } from "../lib/calibration/controls.ts";
import { evaluateGate, CALIBRATION_GATE } from "../lib/calibration/gate.ts";
import { regimeCoverage, FROZEN_REGIME_CUTPOINTS, btcTrailingReturnPct } from "../lib/calibration/regime.ts";
import { assertNativeKlines } from "./kline-source.mjs";

const HOUR = 3600000;
const DAY = 24 * HOUR;
const [, , dataDir, horizonArg, everyArg] = process.argv;
if (!dataDir) throw new Error("usage: see the header of scripts/rehearse-pipeline.mjs");
const H = Number(horizonArg ?? 24);
const EVERY = Number(everyArg ?? 1);
const K = labelK(H);
const cal = join(dataDir, "calibration");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const runs = (await readdir(join(dataDir, "indicators"))).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().reverse();
const spread = {};
for (const run of runs) {
  try {
    for (const c of (await readJson(join(dataDir, "indicators", run, "raw.json"))).contracts) {
      const bid = Number(c.book?.bidPrice), ask = Number(c.book?.askPrice);
      if (bid > 0 && ask >= bid) spread[c.contract.symbol] = ((ask - bid) / ((ask + bid) / 2)) * 10000;
    }
    break;
  } catch {
    /* next */
  }
}
const symbols = (await readdir(join(cal, "klines", "1h"))).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const coins = [];
for (const symbol of symbols) {
  const f1 = await readJson(join(cal, "klines", "1h", symbol + ".json"));
  const f4 = assertNativeKlines(await readJson(join(cal, "klines", "4h", symbol + ".json")), "4h", symbol + " 4h"); // R1: the exchange's own 4h, never an aggregate
  let funding = null;
  try {
    funding = (await readJson(join(cal, "funding", symbol + ".json"))).rows;
  } catch {
    funding = null;
  }
  const bars = toBars(f1.rows, "UM", 1, null, f1.end, HOUR).bars;
  coins.push({ symbol, bars, bars4h: toBars(f4.rows, "UM", 1, null, f4.end, 4 * HOUR).bars, funding, atr: atrSeries(bars, 14), spread: spread[symbol] ?? null });
}
const btc = coins.find((c) => c.symbol === "BTCUSDT").bars;
const universe = coins.map((c) => c.bars);
const cts = btc.filter((b) => (b.t + HOUR) % DAY === 0 && b.t + HOUR >= Date.UTC(2025, 9, 1)).map((b) => b.ct).filter((_, i) => i % EVERY === 0);
console.log(`coins ${coins.length}, decision days ${cts.length}, horizon ${H}h (k ${K.toFixed(3)}), every ${EVERY} day(s)`);

// 1. samples: features (all 21 present, else dropped: R3) and the label
const samples = [];
const X = [];
const Y = [];
const tr = [];
const vo = [];
const gi = FEATURE_IDS.indexOf("g2_btc_vol_regime");
const regimeByDay = new Map();
let considered = 0;
const t0 = Date.now();
for (let d = 0; d < cts.length; d++) {
  const ct = cts[d];
  const cross = buildCrossSection(universe, ct);
  for (const c of coins) {
    const i = lastIndexClosedBy(c.bars, ct);
    if (i < 0 || c.bars[i].ct !== ct) continue;
    considered++;
    const v = buildFeatureVector(c.bars, i, { bars4h: c.bars4h, btcBars: btc, btcLongBars: btc, cross, funding: c.funding, isPerpetual: true });
    if (c.symbol === "BTCUSDT") regimeByDay.set(Math.floor((ct + 1) / DAY), { trend: btcTrailingReturnPct(btc, ct, 30), vol: v.values[gi] });
    if (v.missing.length) continue;
    const cost = roundTripCost({ spreadBps: c.spread, slippagePct: SLIPPAGE_ROUND_TRIP_ASSUMED });
    const l = tripleBarrier(c.bars, i, c.atr, { horizonBars: H, k: K, cost });
    if (l.label === null) continue;
    samples.push({ group: c.symbol, time: ct, endTime: c.bars[l.endIndex].ct });
    X.push(Array.from(v.values));
    Y.push(classIndex(l.label));
  }
  if ((d + 1) % 60 === 0) console.log(`  ${d + 1}/${cts.length} days, ${samples.length} samples, ${Math.round((Date.now() - t0) / 1000)}s`);
}
console.log(`points considered ${considered}, usable (21 features + a label) ${samples.length}`);

// 2. walk-forward folds (purge + embargo), all test blocks after the consumed window
const weights = uniquenessWeights(samples, HOUR);
const testEnd = Math.max(...samples.map((s) => s.time)) + 1;
const folds = walkForwardFolds(samples, { nFolds: 4, horizonBars: H, barMs: HOUR, testStart: MIN_TEST_START_MS, testEnd });
const violations = folds.flatMap((f) => foldViolations(samples, f, { horizonBars: H, barMs: HOUR }));
console.log(`folds ${folds.length}, split violations ${violations.length}${violations.length ? ": " + violations.slice(0, 3).join(" | ") : ""}`);

// The leak control keeps the time structure: every coin's labels are rotated along its own time axis (blockShiftLabels), which breaks only the link between
// features and labels. A whole-set permutation would destroy the overlap structure of the labels and could hide a leak that lives in it (a false negative).
const shift = blockShiftLabels(samples, Y, 4242);
console.log(`label control: labels rotated within each coin (${shift.shifted} samples shifted, ${shift.unshifted} in coins too short to shift)`);
const YS = shift.labels;
const L2 = 0.05;
const rows = [];
const allTest = { probs: [], y: [], w: [], days: [], trend: [], vol: [] };
let baseline = null;
for (const f of folds) {
  const trainY = f.trainIdx.map((i) => Y[i]);
  const testY = f.testIdx.map((i) => Y[i]);
  const trW = f.trainIdx.map((i) => weights[i]);
  const teW = f.testIdx.map((i) => weights[i]);
  if (trainY.length < 100 || testY.length < 50) {
    rows.push({ fold: f.index, note: "too few samples", train: trainY.length, test: testY.length });
    continue;
  }
  const rates = baseRates(trainY, 3, trW);
  const model = fitSoftmax(f.trainIdx.map((i) => X[i]), trainY, 3, { l2: L2, sampleWeights: trW, maxIter: 60 });
  const probs = predictProba(model, f.testIdx.map((i) => X[i]));
  const real = bss(probs, testY, rates, teW);
  const shufTrainY = f.trainIdx.map((i) => YS[i]);
  const shufTestY = f.testIdx.map((i) => YS[i]);
  const shufModel = fitSoftmax(f.trainIdx.map((i) => X[i]), shufTrainY, 3, { l2: L2, sampleWeights: trW, maxIter: 60 });
  const shuf = bss(predictProba(shufModel, f.testIdx.map((i) => X[i])), shufTestY, baseRates(shufTrainY, 3, trW), teW);
  const rb = randomFeatureBaseline({ trainY, testY, k: 3, nFeatures: FEATURE_IDS.length, l2: L2, trainWeights: trW, testWeights: teW, draws: 20, seed: 100 + f.index, maxIter: 60 });
  baseline = rb ?? baseline;
  rows.push({ fold: f.index, train: trainY.length, test: testY.length, purged: f.purged, effTrain: Math.round(effectiveN(trW)), effTest: Math.round(effectiveN(teW)), real, shuf, randP95: rb?.p95 ?? null, randMean: rb?.mean ?? null, classes: classCounts(testY, 3) });
  probs.forEach((p, j) => {
    allTest.probs.push(p);
    allTest.y.push(testY[j]);
    allTest.w.push(teW[j]);
    const day = Math.floor((samples[f.testIdx[j]].time + 1) / DAY);
    const r = regimeByDay.get(day);
    allTest.days.push(day);
    allTest.trend.push(r?.trend ?? NaN);
    allTest.vol.push(r?.vol ?? NaN);
  });
}
const f4 = (x) => (x === null || x === undefined ? "-" : x.toFixed(4));
console.log("\nfold  train   test   effTrain effTest  purged   BSS(real)  BSS(shuffled)  random mean / p95   test classes (down/flat/up)");
for (const r of rows) console.log(r.note ? `${r.fold}  ${r.note} (${r.train}/${r.test})` : `${r.fold}  ${String(r.train).padEnd(7)}${String(r.test).padEnd(7)}${String(r.effTrain).padEnd(9)}${String(r.effTest).padEnd(8)}${String(r.purged).padEnd(8)}${f4(r.real).padStart(9)}  ${f4(r.shuf).padStart(12)}  ${f4(r.randMean).padStart(8)} / ${f4(r.randP95).padStart(7)}   ${r.classes.join("/")}`);

// 3. pooled numbers and the gate
const good = rows.filter((r) => !r.note && r.real !== null);
const wsum = good.reduce((a, r) => a + r.effTest, 0);
const pooledBss = wsum ? good.reduce((a, r) => a + r.real * r.effTest, 0) / wsum : null;
const pooledShuf = wsum ? good.reduce((a, r) => a + r.shuf * r.effTest, 0) / wsum : null;
const p95 = baseline?.p95 ?? null;
const leak = leakCheck({ realBss: pooledBss, shuffledBss: pooledShuf, randomP95: p95 });
const eceRes = allTest.y.length ? ece(allTest.probs, allTest.y, { minBinSamples: 50, maxBins: 10 }) : null;
const cov = regimeCoverage({ trend: allTest.trend, vol: allTest.vol, days: allTest.days, cutpoints: FROZEN_REGIME_CUTPOINTS });
console.log(`\npooled BSS ${f4(pooledBss)} | shuffled ${f4(pooledShuf)} | random-feature p95 ${f4(p95)} | leak control: ${leak.status} (${leak.reason})`);
console.log(`ECE ${eceRes ? f4(eceRes.ece) : "-"} | regime coverage in DAYS (frozen cutpoints):`, cov ? JSON.stringify({ trend: cov.trend, vol: cov.vol }) : "null (a day carried two different values, or days did not line up)");
const testSpanDays = allTest.days.length ? Math.max(...allTest.days) - Math.min(...allTest.days) + 1 : null;
const report = {
  folds: good.map((r) => ({ bss: r.real, n: r.test })),
  pooled: { bss: pooledBss, residualBss: null, ece: eceRes?.ece ?? null, classCounts: classCounts(allTest.y, 3), effectiveN: good.length ? good.at(-1).effTrain : null, effectiveTestN: wsum || null, regimeCoverage: cov, testSpanDays },
  randomBaselineP95: p95,
  leakStatus: leak.status,
  universe: { identifiedDelisted: 121, obtainedDelisted: 0, unobtained: [{ symbol: "(all 121)", reason: "not yet downloaded: batches await the user's approval" }] },
};
const gate = evaluateGate(report, CALIBRATION_GATE);
console.log(`\nGATE (shipped default): pass = ${gate.pass}; reasons:`);
for (const r of gate.reasons) console.log("  - " + r);
console.log("notes carried by the result:");
for (const n of gate.notes) console.log("  * " + n);
console.log("\nREHEARSAL ONLY. residualBss is not computed here (null), so the gate lists it as missing. Survivors only. None of these numbers is a model result.");
