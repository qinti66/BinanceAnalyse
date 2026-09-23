// NOTE: this script statically imports .ts files, so it needs Node >=22.18 (or >=23.6); the require-node.mjs entry gate cannot run before that load error.
// A REHEARSAL of the calibration pipeline on the real downloaded universe. It checks that every stage RUNS and that its controls behave (the random-feature
// baseline sits near zero, shuffled labels destroy the score, the gate refuses). It is NOT a result: the numbers below say nothing about whether the
// features predict anything, no threshold is set or tuned by it, and nothing it prints may be quoted as a model performance.
//
//   node --max-old-space-size=8192 scripts/rehearse-pipeline.mjs <dataDir> [horizon: 4 | 24] [everyNthDay]
//
// Universe: survivors only, unless DELISTED_DIR is set (env var, e.g. CypeData/data/calibration/delisted): then the identified delisted contracts obtained
// so far are ADDED to the training and test universe, each carrying its own settlement time (architect T30: a settled contract's forward window that runs
// past its settlement is cut there, first barrier touch decides, no touch is flat; a contract with no real deliveryDate does not get this rule and simply
// stops producing decisions once its data ends). DELISTED_PLAN points at the plan file with each symbol's deliveryMs (default docs/delisted-plan-v1.json).
//
// "Obtained" (T32, architect ruling): a delisted contract counts as obtained only if it contributed AT LEAST ONE sample that passed R3 (all 21 features
// present) and got a label -- not merely "a file was downloaded" and not merely "the window has rows". A contract with real 1h/4h data but no funding
// history has a3_funding_z missing on every row, so by R3 every one of its rows is dropped: it identifies but contributes nothing, and is reported as
// unobtained with that reason, distinct from "no real trading data in the window at all" (BTCSTUSDT, FRONTUSDT: real trading ended before the plan's
// start date, so the window itself has zero rows).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync as readFileSyncFs, renameSync, writeFileSync as writeFileSyncFs } from "node:fs";
import { toBars } from "../lib/structure/bars.ts";
import { atrSeries } from "../lib/structure/atr.ts";
import { buildFeatureVector, FEATURE_IDS } from "../lib/indicators/features/registry.ts";
import { buildCrossSection } from "../lib/indicators/features/context.ts";
import { lastIndexClosedBy } from "../lib/indicators/features/stats.ts";
import { tripleBarrier, roundTripCost, labelK, classIndex, SLIPPAGE_ROUND_TRIP_ASSUMED } from "../lib/indicators/labels.ts";
import { walkForwardFolds, foldViolations, uniquenessWeights, effectiveN, MIN_TEST_START_MS } from "../lib/calibration/splits.ts";
import { fitSoftmax, predictProba } from "../lib/calibration/softmax.ts";
import { baseRates, bss, ece, classCounts } from "../lib/calibration/metrics.ts";
import { randomFeatureBaseline, blockShiftLabels, dayBlockPermuteLabels, leakCheck, mulberry32 } from "../lib/calibration/controls.ts";
import { clusterBootstrapBss, dayStats, brierTerm, pooledBss as pooledBssOfDays } from "../lib/calibration/bootstrap.ts";
import { evaluateGate, CALIBRATION_GATE } from "../lib/calibration/gate.ts";
import { regimeCoverage, FROZEN_REGIME_CUTPOINTS, btcTrailingReturnPct } from "../lib/calibration/regime.ts";
import { residualLabelAt, priorShift } from "../lib/calibration/residual.ts";
import { assertNativeKlines } from "./kline-source.mjs";
import { decisionEligible } from "./delisted-trim.mjs";

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
  coins.push({ symbol, bars, bars4h: toBars(f4.rows, "UM", 1, null, f4.end, 4 * HOUR).bars, funding, atr: atrSeries(bars, 14), spread: spread[symbol] ?? null, delisted: false, settlementMs: null, trim1h: null });
}

// Delisted contracts (optional). "identified" is every file found; a zero-row window is recorded and never added to `coins` (nothing to compute on).
// Whether each one is "obtained" can only be known after the sample loop below has actually tried to use it (R3), so that classification happens later.
//
// Cost input (bug found and fixed after a full run showed 0% delisted contribution): `spread[symbol]` only covers contracts in TODAY's live indicators
// snapshot, so a delisted symbol is never in it and its cost was always null -> tripleBarrier returned null for essentially every decision (T34). Architect
// ruling: use a fixed stand-in spread taken from the SURVIVORS' own current spread distribution (never an invented number), at the p90 (delisted contracts
// are, by construction, the illiquid tail -- the median would understate their real cost and bias their labels toward easier/more-predictable). Reported
// with mandatory p50/p90/p99 sensitivity: if the pooled-BSS conclusion flips across the three, that is reported as "undetermined", not averaged away.
const spreadValues = Object.values(spread).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
const percentile = (p) => (spreadValues.length ? spreadValues[Math.min(spreadValues.length - 1, Math.floor(p * spreadValues.length))] : null);
const SPREAD_PCTL = Number(process.env.DELISTED_SPREAD_PCTL ?? 90);
const DELISTED_SPREAD_BPS = percentile(SPREAD_PCTL / 100);
console.log(`survivor spread distribution (bps, n=${spreadValues.length}): p50 ${percentile(0.5)?.toFixed(2)} | p90 ${percentile(0.9)?.toFixed(2)} | p99 ${percentile(0.99)?.toFixed(2)} -- delisted stand-in this run: p${SPREAD_PCTL} = ${DELISTED_SPREAD_BPS?.toFixed(2)}`);
const DELISTED_DIR = process.env.DELISTED_DIR ?? null;
let delistedIdentified = 0;
const delistedZeroRows = []; // { symbol, reason } -- real trading ended before the requested window, so the file itself has no rows
const delistedFundingMissing = new Set(); // symbols added to `coins` whose funding file is absent or empty
if (DELISTED_DIR) {
  const planPath = process.env.DELISTED_PLAN ?? "docs/delisted-plan-v1.json";
  const plan = new Map(JSON.parse(readFileSyncFs(planPath, "utf8")).map((p) => [p.symbol, p]));
  const dSymbols = (await readdir(join(DELISTED_DIR, "klines", "1h"))).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  delistedIdentified = dSymbols.length;
  for (const symbol of dSymbols) {
    const f1 = await readJson(join(DELISTED_DIR, "klines", "1h", symbol + ".json"));
    if (!Array.isArray(f1.rows) || !f1.rows.length) {
      delistedZeroRows.push({ symbol, reason: "真实交易在窗口开始之前已结束，窗口内无可用数据" });
      continue;
    }
    const bars = toBars(f1.rows, "UM", 1, null, f1.end, HOUR).bars;
    if (!bars.length) {
      delistedZeroRows.push({ symbol, reason: "真实交易在窗口开始之前已结束，窗口内无可用数据" });
      continue;
    }
    const f4 = assertNativeKlines(await readJson(join(DELISTED_DIR, "klines", "4h", symbol + ".json")), "4h", symbol + " 4h");
    let funding = null;
    try {
      funding = (await readJson(join(DELISTED_DIR, "funding", symbol + ".json"))).rows;
    } catch {
      funding = null;
    }
    if (!Array.isArray(funding) || !funding.length) delistedFundingMissing.add(symbol);
    const settlementMs = plan.get(symbol)?.deliveryMs ?? null;
    coins.push({ symbol, bars, bars4h: toBars(f4.rows, "UM", 1, null, f4.end, 4 * HOUR).bars, funding, atr: atrSeries(bars, 14), spread: DELISTED_SPREAD_BPS, delisted: true, settlementMs, trim1h: f1.trim ?? null });
  }
  console.log(`delisted contracts: ${delistedIdentified} identified | ${delistedZeroRows.length} with zero rows in the window (real trading predates it): ${delistedZeroRows.map((z) => z.symbol).join(", ") || "-"} | ${delistedFundingMissing.size} with real klines but no funding history: ${[...delistedFundingMissing].join(", ") || "-"}`);
}

const btc = coins.find((c) => c.symbol === "BTCUSDT").bars;
const universe = coins.map((c) => c.bars);
const cts = btc.filter((b) => (b.t + HOUR) % DAY === 0 && b.t + HOUR >= Date.UTC(2025, 9, 1)).map((b) => b.ct).filter((_, i) => i % EVERY === 0);
console.log(`coins ${coins.length}, decision days ${cts.length}, horizon ${H}h (k ${K.toFixed(3)}), every ${EVERY} day(s)`);

// 1. samples: features (all 21 present, else dropped: R3) and the label
const samples = [];
const X = [];
const Y = [];
const YR = []; // the residual (BTC-beta-adjusted) label class, or -1 when it cannot be computed (missing stays missing)
const gi = FEATURE_IDS.indexOf("g2_btc_vol_regime");
const regimeByDay = new Map();
let considered = 0;
const missingCounts = {}; // feature id -> count of decision points where it was missing (R3 in action)
let fundingMissingDelistedConsidered = 0;
let fundingMissingDelistedA3Missing = 0;
const t0 = Date.now();
for (let d = 0; d < cts.length; d++) {
  const ct = cts[d];
  const cross = buildCrossSection(universe, ct);
  for (const c of coins) {
    const i = lastIndexClosedBy(c.bars, ct);
    if (i < 0 || c.bars[i].ct !== ct) continue;
    if (c.delisted && !decisionEligible(c.bars.map((b) => [b.t]), c.trim1h, i)) continue; // never a decision point on the partial settlement hour (T29)
    considered++;
    const v = buildFeatureVector(c.bars, i, { bars4h: c.bars4h, btcBars: btc, btcLongBars: btc, cross, funding: c.funding, isPerpetual: true });
    if (c.symbol === "BTCUSDT") regimeByDay.set(Math.floor((ct + 1) / DAY), { trend: btcTrailingReturnPct(btc, ct, 30), vol: v.values[gi] });
    for (const id of v.missing) missingCounts[id] = (missingCounts[id] ?? 0) + 1;
    if (c.delisted && delistedFundingMissing.has(c.symbol)) {
      fundingMissingDelistedConsidered++;
      if (v.missing.includes("a3_funding_z")) fundingMissingDelistedA3Missing++;
    }
    if (v.missing.length) continue;
    const cost = roundTripCost({ spreadBps: c.spread, slippagePct: SLIPPAGE_ROUND_TRIP_ASSUMED });
    const l = tripleBarrier(c.bars, i, c.atr, { horizonBars: H, k: K, cost, settlementMs: c.settlementMs });
    if (l.label === null) continue;
    samples.push({ group: c.symbol, time: ct, endTime: c.bars[l.endIndex].ct, settled: l.settled, daysToSettlement: c.delisted && c.settlementMs ? (c.settlementMs - ct) / DAY : null });
    X.push(Array.from(v.values));
    Y.push(classIndex(l.label));
    const rl = residualLabelAt({ bars: c.bars, i, btc, atr: c.atr, horizonBars: H, k: K, cost });
    YR.push(rl.label === null ? -1 : classIndex(rl.label));
  }
  if ((d + 1) % 60 === 0) console.log(`  ${d + 1}/${cts.length} days, ${samples.length} samples, ${Math.round((Date.now() - t0) / 1000)}s`);
}
console.log(`points considered ${considered}, usable (21 features + a label) ${samples.length}`);
let delistedUniverse = null;
if (DELISTED_DIR) {
  // R3 in action: a delisted contract with real klines but no funding history should have a3_funding_z missing on essentially every decision point.
  console.log(`R3 check on funding-missing delisted contracts: ${fundingMissingDelistedConsidered} decision points considered, ${fundingMissingDelistedA3Missing} had a3_funding_z missing (${fundingMissingDelistedConsidered ? ((100 * fundingMissingDelistedA3Missing) / fundingMissingDelistedConsidered).toFixed(1) : "-"}%)`);
  // "obtained" (T32): at least one sample that survived R3 and got a label.
  const samplesPerSymbol = {};
  for (const s of samples) samplesPerSymbol[s.group] = (samplesPerSymbol[s.group] ?? 0) + 1;
  const delistedSymbolsWithData = coins.filter((c) => c.delisted).map((c) => c.symbol);
  const zeroSampleDelisted = delistedSymbolsWithData.filter((s) => !samplesPerSymbol[s]);
  const obtainedDelisted = delistedSymbolsWithData.length - zeroSampleDelisted.length;
  const unobtained = [
    ...delistedZeroRows,
    ...zeroSampleDelisted.map((symbol) => ({
      symbol,
      reason: delistedFundingMissing.has(symbol) ? "缺资金费率历史，按 R3（a3_funding_z 缺失）全部行被排除，未贡献训练样本" : "有 K 线数据但未贡献任何通过完整性检查的样本",
    })),
  ];
  console.log(`obtained (T32: >=1 sample that passed R3 and got a label): ${obtainedDelisted} / ${delistedIdentified} = ${((100 * obtainedDelisted) / delistedIdentified).toFixed(1)}% | unobtained: ${unobtained.map((u) => u.symbol).join(", ")}`);
  delistedUniverse = { identifiedDelisted: delistedIdentified, obtainedDelisted, unobtained };
}
{
  const share = (ys) => { const n = ys.filter((y) => y >= 0).length; return [0, 1, 2].map((c) => ((100 * ys.filter((y) => y === c).length) / Math.max(1, n)).toFixed(1) + "%").join(" / "); };
  console.log("class shares (down / flat / up): plain labels", share(Y), "| residual (BTC-beta-adjusted) labels", share(YR), "| residual label missing for", YR.filter((y) => y < 0).length, "samples");
}

// 2. walk-forward folds (purge + embargo), all test blocks after the consumed window
const weights = uniquenessWeights(samples, HOUR);
// (a loop, not Math.max(...array): spreading 170,000 arguments overflows the call stack)
const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m), -Infinity);
const minOf = (xs) => xs.reduce((m, x) => (x < m ? x : m), Infinity);
const testEnd = maxOf(samples.map((s) => s.time)) + 1;
const folds = walkForwardFolds(samples, { nFolds: 4, horizonBars: H, barMs: HOUR, testStart: MIN_TEST_START_MS, testEnd });
const violations = folds.flatMap((f) => foldViolations(samples, f, { horizonBars: H, barMs: HOUR }));
console.log(`folds ${folds.length}, split violations ${violations.length}${violations.length ? ": " + violations.slice(0, 3).join(" | ") : ""}`);

// The leak control keeps the time structure: every coin's labels are rotated along its own time axis (blockShiftLabels), which breaks only the link between
// features and labels. A whole-set permutation would destroy the overlap structure of the labels and could hide a leak that lives in it (a false negative).
const shift = blockShiftLabels(samples, Y, 4242);
console.log(`label control: labels rotated within each coin (${shift.shifted} samples shifted, ${shift.unshifted} in coins too short to shift)`);
const YS = shift.labels;
const L2 = 0.05;
const NULL_DRAWS = Number(process.env.NULL_DRAWS ?? 30);
const BOOT_DRAWS = 1000;
const NULL_BLOCK_DAYS = Number(process.env.NULL_BLOCK_DAYS ?? 7); // labels keep their order inside a block of this many days
const sampleDay = samples.map((x) => Math.floor((x.time + 1) / DAY));
const rows = [];
const allTest = { probs: [], y: [], w: [], days: [], trend: [], vol: [], delisted: [], settled: [], daysToSettlement: [] };
const allResidual = { probs: [], y: [], w: [], days: [] }; // prior-shift-adjusted forecasts vs residual labels, pooled across folds (the gate's definition)
const delistedSymbolSet = new Set(coins.filter((c) => c.delisted).map((c) => c.symbol));
let delistedTrainRows = 0;
let delistedTestRows = 0;
const foldDays = { plain: [], resA: [], resB: [] }; // per fold: the day sums of the Brier terms, for the day-clustered bootstrap
const foldWeights = [];
const foldFits = []; // what the day-shifted null needs to re-fit
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
  const testDays = f.testIdx.map((i) => sampleDay[i]);
  foldDays.plain.push(dayStats(testDays, probs.map((p, j) => brierTerm(p, testY[j]) * teW[j]), testY.map((y, j) => brierTerm(rates, y) * teW[j])));
  foldWeights.push(effectiveN(teW));
  foldFits.push({ f, trW, teW });

  // Residual skill. The residual (BTC-beta-adjusted) labels have another class mix than the plain ones (mostly flat: the market move is removed), so forecasts
  // calibrated to the plain mix are penalised against them by the prior mismatch alone. THE GATE'S DEFINITION (architect ruling, calibration-log T31): the BSS of the
  // prior-shift-adjusted forecasts against the residual labels, the adjustment using only the TRAINING fold's priors (no new parameter). Reported side by side:
  // the unadjusted BSS (the original definition) and (b) a model re-fitted on the residual labels (a diagnostic that scores a model which is never deployed).
  const trR = f.trainIdx.filter((i) => YR[i] >= 0);
  const teR = f.testIdx.map((i, j) => (YR[i] >= 0 ? j : -1)).filter((j) => j >= 0);
  const residualRates = trR.length ? baseRates(trR.map((i) => YR[i]), 3, trR.map((i) => weights[i])) : null;
  let residual = null;
  let residualRaw = null;
  let residualOwn = null;
  if (residualRates && rates && teR.length) {
    const yR = teR.map((j) => YR[f.testIdx[j]]);
    const wR = teR.map((j) => teW[j]);
    const dR = teR.map((j) => testDays[j]);
    residualRaw = bss(teR.map((j) => probs[j]), yR, residualRates, wR);
    const shifted = priorShift(teR.map((j) => probs[j]), rates, residualRates);
    const okIdx = shifted.map((q, k) => (q === null ? -1 : k)).filter((k) => k >= 0);
    residual = bss(okIdx.map((k) => shifted[k]), okIdx.map((k) => yR[k]), residualRates, okIdx.map((k) => wR[k]));
    foldDays.resA.push(dayStats(okIdx.map((k) => dR[k]), okIdx.map((k) => brierTerm(shifted[k], yR[k]) * wR[k]), okIdx.map((k) => brierTerm(residualRates, yR[k]) * wR[k])));
    for (const k of okIdx) {
      allResidual.probs.push(shifted[k]);
      allResidual.y.push(yR[k]);
      allResidual.w.push(wR[k]);
      allResidual.days.push(dR[k]);
    }
    const ownModel = fitSoftmax(trR.map((i) => X[i]), trR.map((i) => YR[i]), 3, { l2: L2, sampleWeights: trR.map((i) => weights[i]), maxIter: 60 });
    const ownProbs = predictProba(ownModel, teR.map((j) => X[f.testIdx[j]]));
    residualOwn = bss(ownProbs, yR, residualRates, wR);
    foldDays.resB.push(dayStats(dR, ownProbs.map((p, k) => brierTerm(p, yR[k]) * wR[k]), yR.map((y, k) => brierTerm(residualRates, y) * wR[k])));
  }
  const shufTrainY = f.trainIdx.map((i) => YS[i]);
  const shufTestY = f.testIdx.map((i) => YS[i]);
  const shufModel = fitSoftmax(f.trainIdx.map((i) => X[i]), shufTrainY, 3, { l2: L2, sampleWeights: trW, maxIter: 60 });
  const shuf = bss(predictProba(shufModel, f.testIdx.map((i) => X[i])), shufTestY, baseRates(shufTrainY, 3, trW), teW);
  const rb = randomFeatureBaseline({ trainY, testY, k: 3, nFeatures: FEATURE_IDS.length, l2: L2, trainWeights: trW, testWeights: teW, draws: 20, seed: 100 + f.index, maxIter: 60 });
  baseline = rb ?? baseline;
  rows.push({ residual, residualRaw, residualOwn, residualN: teR.length, fold: f.index, train: trainY.length, test: testY.length, purged: f.purged, effTrain: Math.round(effectiveN(trW)), effTest: Math.round(effectiveN(teW)), real, shuf, randP95: rb?.p95 ?? null, randMean: rb?.mean ?? null, classes: classCounts(testY, 3) });
  delistedTrainRows += f.trainIdx.filter((i) => delistedSymbolSet.has(samples[i].group)).length;
  delistedTestRows += f.testIdx.filter((i) => delistedSymbolSet.has(samples[i].group)).length;
  probs.forEach((p, j) => {
    allTest.probs.push(p);
    allTest.y.push(testY[j]);
    allTest.w.push(teW[j]);
    const day = testDays[j];
    const r = regimeByDay.get(day);
    allTest.days.push(day);
    allTest.trend.push(r?.trend ?? NaN);
    allTest.vol.push(r?.vol ?? NaN);
    allTest.delisted.push(delistedSymbolSet.has(samples[f.testIdx[j]].group));
    allTest.settled.push(samples[f.testIdx[j]].settled);
    allTest.daysToSettlement.push(samples[f.testIdx[j]].daysToSettlement);
  });
}
const f4 = (x) => (x === null || x === undefined ? "-" : x.toFixed(4));
console.log("\nfold  train   test   effTrain effTest  purged   BSS(real)  BSS(shuffled)  random mean / p95   test classes (down/flat/up)");
for (const r of rows) console.log(r.note ? `${r.fold}  ${r.note} (${r.train}/${r.test})` : `${r.fold}  ${String(r.train).padEnd(7)}${String(r.test).padEnd(7)}${String(r.effTrain).padEnd(9)}${String(r.effTest).padEnd(8)}${String(r.purged).padEnd(8)}${f4(r.real).padStart(9)}  ${f4(r.shuf).padStart(12)}  ${f4(r.randMean).padStart(8)} / ${f4(r.randP95).padStart(7)}   ${r.classes.join("/")}`);

// 3. pooled numbers and the gate
const good = rows.filter((r) => !r.note && r.real !== null);
const wsum = good.reduce((a, r) => a + r.effTest, 0);
const pooledBss = wsum ? good.reduce((a, r) => a + r.real * r.effTest, 0) / wsum : null;
const residualGood = good.filter((r) => r.residual !== null);
const rsum = residualGood.reduce((a, r) => a + r.effTest, 0);
const pooledResidual = rsum ? residualGood.reduce((a, r) => a + r.residual * r.effTest, 0) / rsum : null;
const pooledShuf = wsum ? good.reduce((a, r) => a + r.shuf * r.effTest, 0) / wsum : null;
const p95 = baseline?.p95 ?? null;
const leak = leakCheck({ realBss: pooledBss, shuffledBss: pooledShuf, randomP95: p95 });
const eceRes = allTest.y.length ? ece(allTest.probs, allTest.y, { minBinSamples: 50, maxBins: 10 }) : null;
const cov = regimeCoverage({ trend: allTest.trend, vol: allTest.vol, days: allTest.days, cutpoints: FROZEN_REGIME_CUTPOINTS });

// T35 test 1 (architect ruling, 2026-09-23): does the panel's p(class) actually rank real occurrences of that class, independent of overall calibration?
// Sort by the model's predicted probability for one class, cut into 10 equal-COUNT deciles (highest first), and report the ACTUAL rate of that class in
// each decile against the overall base rate. A model with no ranking power for a class gives a flat line at the base rate across deciles.
function liftDeciles(probs, y, w, classIdx) {
  const n = probs.length;
  if (!n) return null;
  const order = probs.map((_, i) => i).sort((a, b) => probs[b][classIdx] - probs[a][classIdx]);
  const totalW = w.reduce((a, x) => a + x, 0);
  const baseRate = order.reduce((a, i) => a + (y[i] === classIdx ? w[i] : 0), 0) / totalW;
  const deciles = [];
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor((d * n) / 10);
    const hi = Math.floor(((d + 1) * n) / 10);
    const idx = order.slice(lo, hi);
    const dw = idx.reduce((a, i) => a + w[i], 0);
    const rate = dw > 0 ? idx.reduce((a, i) => a + (y[i] === classIdx ? w[i] : 0), 0) / dw : null;
    const meanP = dw > 0 ? idx.reduce((a, i) => a + probs[i][classIdx] * w[i], 0) / dw : null;
    // full 3-class distribution within this decile (T35, architect: "41.5% up" alone does not say what the other 58.5% is)
    const dist = dw > 0 ? [0, 1, 2].map((c) => idx.reduce((a, i) => a + (y[i] === c ? w[i] : 0), 0) / dw) : null;
    deciles.push({ n: idx.length, rate, meanP, dist });
  }
  return { baseRate, deciles, order };
}
function printLift(label, probs, y, w, classNames = CLASS_NAMES_G) {
  for (let c = 0; c < classNames.length; c++) {
    const r = liftDeciles(probs, y, w, c);
    if (!r) { console.log(`${label} class=${classNames[c]}: no data`); continue; }
    const curve = r.deciles.map((d) => (d.rate === null ? "-" : (100 * d.rate).toFixed(1))).join(" | ");
    console.log(`${label} class=${classNames[c]}: base rate ${(100 * r.baseRate).toFixed(1)}% | deciles (highest predicted p first, actual rate%): ${curve}`);
    const top = r.deciles[0];
    if (top?.dist) console.log(`  top decile full distribution (n=${top.n}): ${classNames.map((cn, k) => `${cn} ${(100 * top.dist[k]).toFixed(1)}%`).join(" / ")}`);
  }
}
const CLASS_NAMES_G = ["down", "flat", "up"];
console.log("\nLIFT BY DECILE (T35 test 1): sorted by the model's predicted p(class), highest decile first; a flat line at the base rate = no ranking power for that class.");
printLift("plain labels, pooled test", allTest.probs, allTest.y, allTest.w);
console.log("\nLIFT BY DECILE (T35 test 2): same, but on the prior-shift-adjusted forecasts scored against RESIDUAL (BTC-beta-adjusted) labels -- the gate's definition.");
printLift("residual labels, pooled test", allResidual.probs, allResidual.y, allResidual.w);

// T35, architect: the lift metric needs the SAME day-clustered bootstrap CI as everything else (rows on one day are not independent). Resample distinct days
// with replacement, rebuild the resampled multiset of rows, and recompute (a) top-decile rate minus base rate and (b) top-decile rate minus bottom-decile
// rate on that resample. Reuses the ALREADY-sorted order of the full dataset (rows only get duplicated or dropped by resampling, never reordered against
// each other) so it does not re-sort per draw -- 1000 draws over ~150k rows would be too slow otherwise.
function dayClusteredLiftCi(probs, y, w, days, classIdx, o = {}) {
  const draws = o.draws ?? 1000;
  const n = probs.length;
  if (!n) return null;
  const order = probs.map((_, i) => i).sort((a, b) => probs[b][classIdx] - probs[a][classIdx]);
  const byDay = new Map();
  for (let i = 0; i < n; i++) {
    if (!byDay.has(days[i])) byDay.set(days[i], []);
    byDay.get(days[i]).push(i);
  }
  const distinctDays = [...byDay.keys()];
  const rand = mulberry32(o.seed ?? 21);
  const topMinusBase = [];
  const topMinusBottom = [];
  for (let d = 0; d < draws; d++) {
    const mult = new Map(); // original index -> how many times it's repeated in this resample
    for (let k = 0; k < distinctDays.length; k++) {
      const day = distinctDays[Math.floor(rand() * distinctDays.length)];
      for (const i of byDay.get(day)) mult.set(i, (mult.get(i) ?? 0) + 1);
    }
    let totalCount = 0;
    let totalW = 0;
    let baseHit = 0;
    for (const [i, m] of mult) {
      totalCount += m;
      totalW += w[i] * m;
      if (y[i] === classIdx) baseHit += w[i] * m;
    }
    if (totalW <= 0) continue;
    const baseRate = baseHit / totalW;
    const decileSize = Math.floor(totalCount / 10);
    if (decileSize < 1) continue;
    let seen = 0;
    let topW = 0, topHit = 0, bottomW = 0, bottomHit = 0;
    for (const i of order) {
      const m = mult.get(i);
      if (!m) continue;
      const take = Math.min(m, decileSize - seen);
      if (take <= 0) break;
      topW += w[i] * take;
      if (y[i] === classIdx) topHit += w[i] * take;
      seen += take;
      if (seen >= decileSize) break;
    }
    // bottom decile: walk from the END of `order` filtered to this resample
    let seenB = 0;
    for (let k = order.length - 1; k >= 0 && seenB < decileSize; k--) {
      const i = order[k];
      const m = mult.get(i);
      if (!m) continue;
      const take = Math.min(m, decileSize - seenB);
      bottomW += w[i] * take;
      if (y[i] === classIdx) bottomHit += w[i] * take;
      seenB += take;
    }
    if (topW > 0 && bottomW > 0) {
      const topRate = topHit / topW;
      const bottomRate = bottomHit / bottomW;
      topMinusBase.push(topRate - baseRate);
      topMinusBottom.push(topRate - bottomRate);
    }
  }
  const ci = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
    return { mean: s.reduce((a, b) => a + b, 0) / s.length, lo: at(0.025), hi: at(0.975), n: s.length };
  };
  return { topMinusBase: ci(topMinusBase), topMinusBottom: ci(topMinusBottom) };
}
function printLiftCi(label, probs, y, w, days, classNames = CLASS_NAMES_G) {
  for (let c = 0; c < classNames.length; c++) {
    const r = dayClusteredLiftCi(probs, y, w, days, c, { draws: 1000, seed: 700 + c });
    if (!r || !r.topMinusBase || !r.topMinusBottom) { console.log(`${label} class=${classNames[c]}: CI unavailable`); continue; }
    const pct = (x) => (100 * x).toFixed(1) + "pp";
    console.log(`${label} class=${classNames[c]}: top decile - base rate: mean ${pct(r.topMinusBase.mean)} 95% CI [${pct(r.topMinusBase.lo)}, ${pct(r.topMinusBase.hi)}] (n=${r.topMinusBase.n}) | top - bottom decile: mean ${pct(r.topMinusBottom.mean)} 95% CI [${pct(r.topMinusBottom.lo)}, ${pct(r.topMinusBottom.hi)}]`);
  }
}
console.log("\nLIFT DAY-CLUSTERED BOOTSTRAP CI (1000 resamples of whole days), plain labels:");
printLiftCi("plain labels, pooled test", allTest.probs, allTest.y, allTest.w, allTest.days);
console.log("\nLIFT DAY-CLUSTERED BOOTSTRAP CI (1000 resamples of whole days), residual labels:");
printLiftCi("residual labels, pooled test", allResidual.probs, allResidual.y, allResidual.w, allResidual.days);

// T36 (architect, 2026-09-23): a hypothesis formed AFTER seeing the class-decomposed lift results above ("the model separates moved-vs-flat but not the
// direction of the move") -- reported as exploratory only, on the SAME test folds already looked at many times in this session, so it must be verified on
// data collected AFTER today before it can inform anything shipped. Same 21 features, same walk-forward folds, same weights, same L2/maxIter -- only the
// label definition changes (flat vs {down,up} collapsed to one class), no tuning of any kind.
console.log("\n=== EXPLORATORY (T36, hypothesis formed after seeing today's data -- needs prospective verification, not an upgrade to the gate): 'moved' (touched either barrier) vs 'not_moved' (flat), same features/folds/weights, no tuning ===");
const MOVED_NAMES = ["not_moved", "moved"];
const YB = Y.map((y) => (y === 1 ? 0 : 1)); // flat -> 0 (not_moved), down or up -> 1 (moved)
const bRows = [];
const bAllTest = { probs: [], y: [], w: [], days: [] };
const bFoldDays = [];
const bFoldWeights = [];
for (const f of folds) {
  const trainY = f.trainIdx.map((i) => YB[i]);
  const testY = f.testIdx.map((i) => YB[i]);
  const trW = f.trainIdx.map((i) => weights[i]);
  const teW = f.testIdx.map((i) => weights[i]);
  if (trainY.length < 100 || testY.length < 50) {
    bRows.push({ fold: f.index, note: "too few samples", train: trainY.length, test: testY.length });
    continue;
  }
  const rates = baseRates(trainY, 2, trW);
  const model = fitSoftmax(f.trainIdx.map((i) => X[i]), trainY, 2, { l2: L2, sampleWeights: trW, maxIter: 60 });
  const probs = predictProba(model, f.testIdx.map((i) => X[i]));
  const real = bss(probs, testY, rates, teW);
  const testDays = f.testIdx.map((i) => sampleDay[i]);
  bFoldDays.push(dayStats(testDays, probs.map((p, j) => brierTerm(p, testY[j]) * teW[j]), testY.map((y, j) => brierTerm(rates, y) * teW[j])));
  bFoldWeights.push(effectiveN(teW));
  bRows.push({ fold: f.index, train: trainY.length, test: testY.length, real, effTest: Math.round(effectiveN(teW)) });
  probs.forEach((p, j) => {
    bAllTest.probs.push(p);
    bAllTest.y.push(testY[j]);
    bAllTest.w.push(teW[j]);
    bAllTest.days.push(testDays[j]);
  });
}
const bGood = bRows.filter((r) => !r.note && r.real !== null);
const bWsum = bGood.reduce((a, r) => a + r.effTest, 0);
const bPooledBss = bWsum ? bGood.reduce((a, r) => a + r.real * r.effTest, 0) / bWsum : null;
console.log("moved/not_moved per-fold BSS:", bRows.map((r) => (r.note ? `-(${r.note})` : f4(r.real))).join(" | "), "| pooled", f4(bPooledBss));
const bBoot = clusterBootstrapBss(bFoldDays, bFoldWeights, { draws: BOOT_DRAWS, seed: 31 });
console.log("moved/not_moved DAY-CLUSTERED BOOTSTRAP (1000 resamples), pooled BSS:", bBoot ? `${f4(bBoot.observed)}  95% CI [${f4(bBoot.lo)}, ${f4(bBoot.hi)}]  share of resamples above 0: ${(100 * bBoot.shareAboveZero).toFixed(1)}%` : "-");
const bEce = bAllTest.y.length ? ece(bAllTest.probs, bAllTest.y, { minBinSamples: 50, maxBins: 10 }) : null;
console.log("moved/not_moved ECE:", bEce ? f4(bEce.ece) : "-");
printLift("moved/not_moved, pooled test", bAllTest.probs, bAllTest.y, bAllTest.w, MOVED_NAMES);
printLiftCi("moved/not_moved, pooled test", bAllTest.probs, bAllTest.y, bAllTest.w, bAllTest.days, MOVED_NAMES);

// T37 (architect, 2026-09-23): "moved" may just be volatility clustering restated -- d1 alone (today's ATR percentile) is the most naive volatility-persistence
// rule there is. Nested comparison, SAME folds/labels(moved)/weights/L2/maxIter as above, ONLY the feature columns change: baseline A = d1 alone, baseline B =
// the whole compression group (d1, d3, d4), full = all 21. Legitimate to run on the already-looked-at test folds: this asks about RELATIVE contribution of
// the feature set, not whether the effect is real (that still needs T36's prospective check). No tuning of k, L2, or anything else between the three.
console.log("\n=== NESTED FEATURE-SET COMPARISON (T37), moved/not_moved label, same folds/weights/training settings, only the feature columns differ ===");
const featureSets = {
  "baseline A (d1 only)": ["d1_vol_squeeze_pct"],
  "baseline B (d1+d3+d4, compression group)": ["d1_vol_squeeze_pct", "d3_compression_bars", "d4_vol_squeeze_4h"],
  "full (all 21)": FEATURE_IDS,
};
for (const [name, ids] of Object.entries(featureSets)) {
  const colIdx = ids.map((id) => FEATURE_IDS.indexOf(id));
  const Xs = X.map((row) => colIdx.map((k) => row[k]));
  const fRows = [];
  const fAllTest = { probs: [], y: [], w: [], days: [] };
  const fFoldDays = [];
  const fFoldWeights = [];
  for (const f of folds) {
    const trainY = f.trainIdx.map((i) => YB[i]);
    const testY = f.testIdx.map((i) => YB[i]);
    const trW = f.trainIdx.map((i) => weights[i]);
    const teW = f.testIdx.map((i) => weights[i]);
    if (trainY.length < 100 || testY.length < 50) {
      fRows.push({ fold: f.index, note: "too few samples" });
      continue;
    }
    const rates = baseRates(trainY, 2, trW);
    const model = fitSoftmax(f.trainIdx.map((i) => Xs[i]), trainY, 2, { l2: L2, sampleWeights: trW, maxIter: 60 });
    const probs = predictProba(model, f.testIdx.map((i) => Xs[i]));
    const real = bss(probs, testY, rates, teW);
    const testDays = f.testIdx.map((i) => sampleDay[i]);
    fFoldDays.push(dayStats(testDays, probs.map((p, j) => brierTerm(p, testY[j]) * teW[j]), testY.map((y, j) => brierTerm(rates, y) * teW[j])));
    fFoldWeights.push(effectiveN(teW));
    fRows.push({ fold: f.index, real, effTest: Math.round(effectiveN(teW)) });
    probs.forEach((p, j) => {
      fAllTest.probs.push(p);
      fAllTest.y.push(testY[j]);
      fAllTest.w.push(teW[j]);
      fAllTest.days.push(testDays[j]);
    });
  }
  const fGood = fRows.filter((r) => !r.note && r.real !== null);
  const fWsum = fGood.reduce((a, r) => a + r.effTest, 0);
  const fPooledBss = fWsum ? fGood.reduce((a, r) => a + r.real * r.effTest, 0) / fWsum : null;
  const fBoot = clusterBootstrapBss(fFoldDays, fFoldWeights, { draws: BOOT_DRAWS, seed: 41 });
  const fEce = fAllTest.y.length ? ece(fAllTest.probs, fAllTest.y, { minBinSamples: 50, maxBins: 10 }) : null;
  console.log(`\n-- ${name} (${ids.length} feature${ids.length === 1 ? "" : "s"}) --`);
  console.log("  per-fold BSS:", fRows.map((r) => (r.note ? "-" : f4(r.real))).join(" | "), "| pooled", f4(fPooledBss));
  console.log("  DAY-CLUSTERED BOOTSTRAP pooled BSS:", fBoot ? `${f4(fBoot.observed)}  95% CI [${f4(fBoot.lo)}, ${f4(fBoot.hi)}]  share above 0: ${(100 * fBoot.shareAboveZero).toFixed(1)}%` : "-");
  console.log("  ECE:", fEce ? f4(fEce.ece) : "-");
  printLift(`  ${name}, pooled test`, fAllTest.probs, fAllTest.y, fAllTest.w, MOVED_NAMES);
}

// T38 (architect, 2026-09-23): the full 21-feature model's only edge over baseline A was calibration (lower ECE), and that may be buyable more cheaply than
// 20 extra features. baseline A (d1 alone) + isotonic calibration, fit ONLY on a calibration-validation slice carved out of each fold's TRAINING data (the
// LAST 20% of that fold's training days, chronologically -- never the test fold), vs the full 21-feature model. Exploratory (T36 still applies): needs
// prospective verification. No tuning of k/L2/features between this and baseline A above.
function isotonicFit(x, y, w) {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const stack = [];
  for (const i of idx) {
    let cur = { xLo: x[i], xHi: x[i], sum: y[i] * w[i], w: w[i] };
    while (stack.length && stack[stack.length - 1].sum / stack[stack.length - 1].w > cur.sum / cur.w) {
      const prev = stack.pop();
      cur = { xLo: prev.xLo, xHi: cur.xHi, sum: prev.sum + cur.sum, w: prev.w + cur.w };
    }
    stack.push(cur);
  }
  return stack.map((b) => ({ xLo: b.xLo, xHi: b.xHi, mean: b.sum / b.w }));
}
function isotonicPredict(blocks, xq) {
  if (!blocks.length) return xq;
  if (xq <= blocks[0].xLo) return blocks[0].mean;
  if (xq >= blocks[blocks.length - 1].xHi) return blocks[blocks.length - 1].mean;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (xq >= b.xLo && xq <= b.xHi) return b.mean;
    if (i + 1 < blocks.length && xq > b.xHi && xq < blocks[i + 1].xLo) {
      const b2 = blocks[i + 1];
      const t = (xq - b.xHi) / (b2.xLo - b.xHi);
      return b.mean + t * (b2.mean - b.mean);
    }
  }
  return blocks[blocks.length - 1].mean;
}
console.log("\n=== BASELINE A + ISOTONIC CALIBRATION (T38) vs the full 21-feature model, moved/not_moved label ===");
{
  const d1Idx = FEATURE_IDS.indexOf("d1_vol_squeeze_pct");
  const iRows = [];
  const iAllTest = { probs: [], y: [], w: [], days: [] };
  const iFoldDays = [];
  const iFoldWeights = [];
  // T39 (architect): confound check -- the calibration split trains on only 80% of the fold's data, so a worse BSS could be "less training data", not
  // "calibration hurt". Collector for baseline A trained on the SAME fitIdx (80%), NO calibration, as the clean control.
  const jRows = [];
  const jAllTest = { probs: [], y: [], w: [], days: [] };
  const jFoldDays = [];
  const jFoldWeights = [];
  const calEceParts = []; // {model, blocks, calProbs, calY, calW} per fold, to compute calibration-set ECE after (T39 overfitting check)
  const pRows = [];
  const pAllTest = { probs: [], y: [], w: [], days: [] };
  const pFoldDays = [];
  const pFoldWeights = [];
  for (const f of folds) {
    const trainDaysSorted = [...new Set(f.trainIdx.map((i) => sampleDay[i]))].sort((a, b) => a - b);
    const cut = Math.floor(trainDaysSorted.length * 0.8);
    const fitDays = new Set(trainDaysSorted.slice(0, cut));
    const calDays = new Set(trainDaysSorted.slice(cut));
    const fitIdx = f.trainIdx.filter((i) => fitDays.has(sampleDay[i]));
    const calIdx = f.trainIdx.filter((i) => calDays.has(sampleDay[i]));
    const testY = f.testIdx.map((i) => YB[i]);
    const teW = f.testIdx.map((i) => weights[i]);
    if (fitIdx.length < 100 || calIdx.length < 50 || testY.length < 50) {
      iRows.push({ fold: f.index, note: "too few samples for fit/cal split" });
      jRows.push({ fold: f.index, note: "too few samples for fit/cal split" });
      pRows.push({ fold: f.index, note: "too few samples for fit/cal split" });
      continue;
    }
    const fitY = fitIdx.map((i) => YB[i]);
    const fitW = fitIdx.map((i) => weights[i]);
    const model = fitSoftmax(fitIdx.map((i) => [X[i][d1Idx]]), fitY, 2, { l2: L2, sampleWeights: fitW, maxIter: 60 });
    const rates = baseRates(fitY, 2, fitW); // reference for BSS: the base rates known at fit time, same convention as elsewhere
    const testDays = f.testIdx.map((i) => sampleDay[i]);

    // control: same fitIdx-trained model, NO calibration, scored directly on the test fold
    const rawTestProbsCtl = predictProba(model, f.testIdx.map((i) => [X[i][d1Idx]]));
    const realCtl = bss(rawTestProbsCtl, testY, rates, teW);
    jFoldDays.push(dayStats(testDays, rawTestProbsCtl.map((p, j) => brierTerm(p, testY[j]) * teW[j]), testY.map((y, j) => brierTerm(rates, y) * teW[j])));
    jFoldWeights.push(effectiveN(teW));
    jRows.push({ fold: f.index, real: realCtl, effTest: Math.round(effectiveN(teW)) });
    rawTestProbsCtl.forEach((p, j) => {
      jAllTest.probs.push(p);
      jAllTest.y.push(testY[j]);
      jAllTest.w.push(teW[j]);
      jAllTest.days.push(testDays[j]);
    });

    // isotonic, fit on calIdx only
    const calProbs = predictProba(model, calIdx.map((i) => [X[i][d1Idx]]));
    const calY = calIdx.map((i) => YB[i]);
    const calW = calIdx.map((i) => weights[i]);
    const blocks = isotonicFit(calProbs.map((p) => p[1]), calY, calW);
    calEceParts.push({ blocks, calProbs, calY, calW });
    const rawTestProbs = predictProba(model, f.testIdx.map((i) => [X[i][d1Idx]]));
    const probs = rawTestProbs.map((p) => {
      const p1 = Math.min(1, Math.max(0, isotonicPredict(blocks, p[1])));
      return [1 - p1, p1];
    });
    const real = bss(probs, testY, rates, teW);
    iFoldDays.push(dayStats(testDays, probs.map((p, j) => brierTerm(p, testY[j]) * teW[j]), testY.map((y, j) => brierTerm(rates, y) * teW[j])));
    iFoldWeights.push(effectiveN(teW));
    iRows.push({ fold: f.index, real, effTest: Math.round(effectiveN(teW)), fitN: fitIdx.length, calN: calIdx.length });
    probs.forEach((p, j) => {
      iAllTest.probs.push(p);
      iAllTest.y.push(testY[j]);
      iAllTest.w.push(teW[j]);
      iAllTest.days.push(testDays[j]);
    });

    // T39 step 3 (architect): the control above rules out "less training data" as the explanation, and the calibration-vs-test ECE gap shows some overfitting.
    // Pre-registered fallback, tried ONCE: Platt scaling (2 parameters: A*logit(p1)+B, fit by logistic regression on the SAME calIdx, never the test fold) --
    // fewer degrees of freedom than the isotonic step function, which is the point given the calibration set is only ~18 effective (day-clustered) samples.
    const logit = (p) => Math.log(Math.min(1 - 1e-9, Math.max(1e-9, p)) / (1 - Math.min(1 - 1e-9, Math.max(1e-9, p))));
    const plattModel = fitSoftmax(calProbs.map((p) => [logit(p[1])]), calY, 2, { l2: L2, sampleWeights: calW, maxIter: 60 });
    const plattProbs = predictProba(plattModel, rawTestProbs.map((p) => [logit(p[1])]));
    const realPlatt = bss(plattProbs, testY, rates, teW);
    pFoldDays.push(dayStats(testDays, plattProbs.map((p, j) => brierTerm(p, testY[j]) * teW[j]), testY.map((y, j) => brierTerm(rates, y) * teW[j])));
    pFoldWeights.push(effectiveN(teW));
    pRows.push({ fold: f.index, real: realPlatt, effTest: Math.round(effectiveN(teW)) });
    plattProbs.forEach((p, j) => {
      pAllTest.probs.push(p);
      pAllTest.y.push(testY[j]);
      pAllTest.w.push(teW[j]);
      pAllTest.days.push(testDays[j]);
    });
  }
  const jGood = jRows.filter((r) => !r.note && r.real !== null);
  const jWsum = jGood.reduce((a, r) => a + r.effTest, 0);
  const jPooledBss = jWsum ? jGood.reduce((a, r) => a + r.real * r.effTest, 0) / jWsum : null;
  const jBoot = clusterBootstrapBss(jFoldDays, jFoldWeights, { draws: BOOT_DRAWS, seed: 52 });
  const jEce = jAllTest.y.length ? ece(jAllTest.probs, jAllTest.y, { minBinSamples: 50, maxBins: 10 }) : null;
  console.log("-- control: baseline A trained on the SAME 80% fit split, NO calibration --");
  console.log("per-fold BSS:", jRows.map((r) => (r.note ? "-" : f4(r.real))).join(" | "), "| pooled", f4(jPooledBss));
  console.log("DAY-CLUSTERED BOOTSTRAP pooled BSS:", jBoot ? `${f4(jBoot.observed)}  95% CI [${f4(jBoot.lo)}, ${f4(jBoot.hi)}]  share above 0: ${(100 * jBoot.shareAboveZero).toFixed(1)}%` : "-");
  console.log("ECE:", jEce ? f4(jEce.ece) : "-");
  printLift("baseline A, 80% fit only, no calibration, pooled test", jAllTest.probs, jAllTest.y, jAllTest.w, MOVED_NAMES);

  const iGood = iRows.filter((r) => !r.note && r.real !== null);
  const iWsum = iGood.reduce((a, r) => a + r.effTest, 0);
  const iPooledBss = iWsum ? iGood.reduce((a, r) => a + r.real * r.effTest, 0) / iWsum : null;
  const iBoot = clusterBootstrapBss(iFoldDays, iFoldWeights, { draws: BOOT_DRAWS, seed: 51 });
  const iEce = iAllTest.y.length ? ece(iAllTest.probs, iAllTest.y, { minBinSamples: 50, maxBins: 10 }) : null;
  // T39 overfitting check: calibration-set ECE (in-sample for the isotonic map) vs test-set ECE (out-of-sample).
  const calProbsAll = calEceParts.flatMap((p) => p.calProbs.map((raw) => { const p1 = Math.min(1, Math.max(0, isotonicPredict(p.blocks, raw[1]))); return [1 - p1, p1]; }));
  const calYAll = calEceParts.flatMap((p) => p.calY);
  const calEce = calProbsAll.length ? ece(calProbsAll, calYAll, { minBinSamples: 50, maxBins: 10 }) : null;
  console.log("\n-- baseline A + isotonic --");
  console.log("fit/cal split sizes per fold:", iRows.map((r) => (r.note ? "-" : `fit=${r.fitN} cal=${r.calN}`)).join(" | "));
  console.log("per-fold BSS:", iRows.map((r) => (r.note ? "-" : f4(r.real))).join(" | "), "| pooled", f4(iPooledBss));
  console.log("DAY-CLUSTERED BOOTSTRAP pooled BSS:", iBoot ? `${f4(iBoot.observed)}  95% CI [${f4(iBoot.lo)}, ${f4(iBoot.hi)}]  share above 0: ${(100 * iBoot.shareAboveZero).toFixed(1)}%` : "-");
  console.log("ECE on the TEST fold (out-of-sample):", iEce ? f4(iEce.ece) : "-", "| ECE on the CALIBRATION set itself (in-sample for the isotonic map):", calEce ? f4(calEce.ece) : "-");
  printLift("baseline A + isotonic, pooled test", iAllTest.probs, iAllTest.y, iAllTest.w, MOVED_NAMES);

  const pGood = pRows.filter((r) => !r.note && r.real !== null);
  const pWsum = pGood.reduce((a, r) => a + r.effTest, 0);
  const pPooledBss = pWsum ? pGood.reduce((a, r) => a + r.real * r.effTest, 0) / pWsum : null;
  const pBoot = clusterBootstrapBss(pFoldDays, pFoldWeights, { draws: BOOT_DRAWS, seed: 53 });
  const pEce = pAllTest.y.length ? ece(pAllTest.probs, pAllTest.y, { minBinSamples: 50, maxBins: 10 }) : null;
  console.log("\n-- baseline A + Platt scaling (2 parameters, fit on the SAME calIdx, tried once per T39 step 3) --");
  console.log("per-fold BSS:", pRows.map((r) => (r.note ? "-" : f4(r.real))).join(" | "), "| pooled", f4(pPooledBss));
  console.log("DAY-CLUSTERED BOOTSTRAP pooled BSS:", pBoot ? `${f4(pBoot.observed)}  95% CI [${f4(pBoot.lo)}, ${f4(pBoot.hi)}]  share above 0: ${(100 * pBoot.shareAboveZero).toFixed(1)}%` : "-");
  console.log("ECE:", pEce ? f4(pEce.ece) : "-");
  printLift("baseline A + Platt, pooled test", pAllTest.probs, pAllTest.y, pAllTest.w, MOVED_NAMES);
}

// T40 (architect, 2026-09-23): a single-feature logistic regression is a monotone transform of that feature, and ranking only depends on monotonicity -- so
// sorting directly by the raw d1 value (no model, no training, no calibration) should give the same decile curve as baseline A's model output. If it does,
// the ML layer adds nothing over "compute d1, sort by it". Tested both sort directions since the sign of the relationship is not assumed.
console.log("\n=== T40: does the model add anything over sorting by RAW d1 directly (no fitting at all)? Both directions reported, direction not assumed. ===");
{
  const d1Idx2 = FEATURE_IDS.indexOf("d1_vol_squeeze_pct");
  const rawScore = [];
  const rawY = [];
  const rawW = [];
  const rawDays = [];
  for (const f of folds) {
    const testY = f.testIdx.map((i) => YB[i]);
    const teW = f.testIdx.map((i) => weights[i]);
    if (testY.length < 50) continue;
    const testDays = f.testIdx.map((i) => sampleDay[i]);
    f.testIdx.forEach((i, j) => {
      rawScore.push(X[i][d1Idx2]);
      rawY.push(testY[j]);
      rawW.push(teW[j]);
      rawDays.push(testDays[j]);
    });
  }
  const probsHighFirst = rawScore.map((s) => [0, s]); // decile 1 = highest raw d1 (most "already volatile")
  const probsLowFirst = rawScore.map((s) => [0, -s]); // decile 1 = lowest raw d1 (most "squeezed / compressed")
  console.log("\n-- sorted by raw d1 DESCENDING (decile 1 = highest d1, i.e. already-volatile coins) --");
  printLift("raw d1 desc, pooled test", probsHighFirst, rawY, rawW, ["_unused", "moved (raw d1 desc)"]);
  console.log("\n-- sorted by raw d1 ASCENDING (decile 1 = lowest d1, i.e. most compressed / squeezed coins) --");
  printLift("raw d1 asc, pooled test", probsLowFirst, rawY, rawW, ["_unused", "moved (raw d1 asc)"]);
  console.log("\nfor reference, baseline A's FITTED MODEL curve (already reported above, repeated here for side-by-side reading): base rate 70.8%, deciles 86.3 | 81.6 | 77.5 | 74.4 | 72.0 | 69.4 | 66.1 | 65.4 | 61.6 | 54.0");
  const ciHigh = dayClusteredLiftCi(probsHighFirst, rawY, rawW, rawDays, 1, { draws: 1000, seed: 61 });
  const ciLow = dayClusteredLiftCi(probsLowFirst, rawY, rawW, rawDays, 1, { draws: 1000, seed: 62 });
  const pct = (x) => (100 * x).toFixed(1) + "pp";
  if (ciHigh?.topMinusBase) console.log(`raw d1 desc: top decile - base rate: mean ${pct(ciHigh.topMinusBase.mean)} 95% CI [${pct(ciHigh.topMinusBase.lo)}, ${pct(ciHigh.topMinusBase.hi)}]`);
  if (ciLow?.topMinusBase) console.log(`raw d1 asc:  top decile - base rate: mean ${pct(ciLow.topMinusBase.mean)} 95% CI [${pct(ciLow.topMinusBase.lo)}, ${pct(ciLow.topMinusBase.hi)}]`);
}

if (DELISTED_DIR) {
  // Mandatory split (architect T33, predefined before seeing the result): the same forecasts, scored separately on the delisted-contract rows and the
  // survivor rows of the pooled test set. If the pooled BSS goes UP after adding delisted contracts, close and comparable BSS on both halves points to "more
  // training data, a better fit"; a delisted half that scores noticeably HIGHER than the survivor half is suspicious and must be treated as a data artefact,
  // not a result -- candidates: the frozen-bar cut leaving a recognisable trailing shape, the settlement barrier making labels systematically easier
  // (a shorter window touches a barrier less often, so more flat, easier to call), or "volume dried up before delisting" acting as a feature that only
  // exists in the training data and can never be observed live in the same way (identifying "this coin is dying" is not a tradeable conclusion: by the time
  // it is identifiable, the delisting has already been announced).
  const idxD = allTest.probs.map((_, j) => j).filter((j) => allTest.delisted[j]);
  const idxS = allTest.probs.map((_, j) => j).filter((j) => !allTest.delisted[j]);
  const sub = (idx) => ({ probs: idx.map((j) => allTest.probs[j]), y: idx.map((j) => allTest.y[j]), w: idx.map((j) => allTest.w[j]) });
  const rateAll = baseRates(allTest.y, 3, allTest.w);
  const bssOf = (idx) => (idx.length && rateAll ? bss(sub(idx).probs, sub(idx).y, rateAll, sub(idx).w) : null);
  const eceOf = (idx) => (idx.length ? ece(sub(idx).probs, sub(idx).y, { minBinSamples: 50, maxBins: 10 }) : null);
  const dBss = bssOf(idxD);
  const sBss = bssOf(idxS);
  const dEce = eceOf(idxD);
  const sEce = eceOf(idxS);
  const delistedTotalSamples = samples.filter((s) => delistedSymbolSet.has(s.group)).length;
  if (idxD.length !== delistedTestRows) console.log(`  (sanity mismatch: fold-loop test count ${delistedTestRows} vs pooled-flag count ${idxD.length} -- investigate before trusting the split below)`);
  console.log(`\ndelisted contribution to samples: ${delistedTotalSamples} / ${samples.length} = ${((100 * delistedTotalSamples) / Math.max(1, samples.length)).toFixed(2)}% of ALL usable (train+test) samples | train rows summed across folds (folds overlap, expanding window) ${delistedTrainRows} | pooled test ${idxD.length} / ${allTest.probs.length} = ${((100 * idxD.length) / Math.max(1, allTest.probs.length)).toFixed(2)}%`);
  console.log(`same forecasts, scored separately: delisted-rows BSS ${f4(dBss)} (n=${idxD.length}, ECE ${dEce ? f4(dEce.ece) : "-"}) | survivor-rows BSS ${f4(sBss)} (n=${idxS.length}, ECE ${sEce ? f4(sEce.ece) : "-"}) | both use the SAME pooled base rate (not each half's own)`);

  // T35 (architect ruling, 2026-09-23): the trigger I originally wrote for this investigation ("pooled BSS rises") was mis-specified -- the delisted rows are
  // only 5.26% of the pooled test set, so no amount of skill on them can move the pooled number enough to trip that trigger. Doing the split anyway, for
  // reasons independent of whether the pooled BSS moved. All of this is descriptive; it is not read or interpreted here, per "report numbers first".
  const rateD = baseRates(sub(idxD).y, 3, sub(idxD).w);
  const rateS = baseRates(sub(idxS).y, 3, sub(idxS).w);
  const dBssOwn = idxD.length && rateD ? bss(sub(idxD).probs, sub(idxD).y, rateD, sub(idxD).w) : null;
  const sBssOwn = idxS.length && rateS ? bss(sub(idxS).probs, sub(idxS).y, rateS, sub(idxS).w) : null;
  console.log(`same forecasts, EACH GROUP'S OWN base rate (not the pooled one): delisted-rows BSS ${f4(dBssOwn)} (own base rate [down/flat/up] ${rateD ? rateD.map((x) => x.toFixed(3)).join("/") : "-"}) | survivor-rows BSS ${f4(sBssOwn)} (own base rate ${rateS ? rateS.map((x) => x.toFixed(3)).join("/") : "-"}) | pooled-rate survivor-rows BSS for comparison ${f4(sBss)}`);

  // (a) settled (settlement-barrier-cut) vs ordinary labels, delisted rows only, pooled base rate (same reference as the headline split).
  const idxDSettled = idxD.filter((j) => allTest.settled[j] === true);
  const idxDOrdinary = idxD.filter((j) => allTest.settled[j] === false);
  console.log(`(a) delisted rows by label type: settlement-cut BSS ${f4(bssOf(idxDSettled))} (n=${idxDSettled.length}, classes ${classCounts(sub(idxDSettled).y, 3).join("/")}) | ordinary BSS ${f4(bssOf(idxDOrdinary))} (n=${idxDOrdinary.length}, classes ${classCounts(sub(idxDOrdinary).y, 3).join("/")})`);

  // (b) per true-class contribution, pooled base rate, delisted vs survivor.
  const CLASS_NAMES = ["down", "flat", "up"];
  for (let c = 0; c < 3; c++) {
    const idxDc = idxD.filter((j) => allTest.y[j] === c);
    const idxSc = idxS.filter((j) => allTest.y[j] === c);
    console.log(`(b) true class = ${CLASS_NAMES[c]}: delisted BSS ${f4(bssOf(idxDc))} (n=${idxDc.length}) | survivor BSS ${f4(bssOf(idxSc))} (n=${idxSc.length}) | pooled base rate`);
  }

  // (c) delisted rows only, bucketed by days-to-settlement at decision time (only rows with a real deliveryMs have this; "gone" contracts do not).
  const buckets = [
    [90, Infinity, ">90d"],
    [30, 90, "30-90d"],
    [7, 30, "7-30d"],
    [0, 7, "<7d"],
  ];
  const idxDWithDts = idxD.filter((j) => allTest.daysToSettlement[j] !== null && Number.isFinite(allTest.daysToSettlement[j]));
  console.log(`(c) delisted rows with a known days-to-settlement: ${idxDWithDts.length} / ${idxD.length} (the rest are "gone" contracts with no real deliveryDate)`);
  for (const [lo, hi, label] of buckets) {
    const idxB = idxDWithDts.filter((j) => allTest.daysToSettlement[j] >= lo && allTest.daysToSettlement[j] < hi);
    console.log(`(c) days-to-settlement ${label}: BSS ${f4(bssOf(idxB))} (n=${idxB.length}, classes ${classCounts(sub(idxB).y, 3).join("/")}) | pooled base rate`);
  }
}
const avgW = (key) => { const g = good.filter((r) => r[key] !== null && r[key] !== undefined); const w = g.reduce((a, r) => a + r.effTest, 0); return w ? g.reduce((a, r) => a + r[key] * r.effTest, 0) / w : null; };
console.log("residual BSS, THE GATE'S DEFINITION (prior-shift-adjusted forecasts vs residual labels; training priors only), per fold:", rows.map((r) => (r.note ? "-" : f4(r.residual))).join(" | "), "| pooled", f4(pooledResidual));
console.log("  side by side: unadjusted (the original definition) per fold", rows.map((r) => (r.note ? "-" : f4(r.residualRaw))).join(" | "), "| pooled", f4(avgW("residualRaw")), " || (b) a model re-fitted on the residual labels (never deployed; a diagnostic) per fold", rows.map((r) => (r.note ? "-" : f4(r.residualOwn))).join(" | "), "| pooled", f4(avgW("residualOwn")));

// Day-clustered inference. Rows of one day share one market, so the effective number of independent observations is about the number of DAYS, and a row-independent
// noise baseline is too narrow. (1) a block bootstrap over days for the pooled BSS; (2) a null built from the SAME features and the same label structure with the
// labels of every coin taken from another day (the same day-shift for all coins), re-fitted in every fold.
const wts = foldWeights;
const bootPlain = clusterBootstrapBss(foldDays.plain, wts, { draws: BOOT_DRAWS, seed: 11 });
const bootA = foldDays.resA.length === foldDays.plain.length ? clusterBootstrapBss(foldDays.resA, wts, { draws: BOOT_DRAWS, seed: 12 }) : null;
const bootB = foldDays.resB.length === foldDays.plain.length ? clusterBootstrapBss(foldDays.resB, wts, { draws: BOOT_DRAWS, seed: 13 }) : null;
const ci = (b) => (b ? `${f4(b.observed)}  95% CI [${f4(b.lo)}, ${f4(b.hi)}]  share of resamples above 0: ${(100 * b.shareAboveZero).toFixed(1)}%` : "-");
console.log(`\nDAY-CLUSTERED BOOTSTRAP (${BOOT_DRAWS} resamples of whole days within each fold), pooled BSS:`);
console.log("  plain      ", ci(bootPlain));
console.log("  residual (a, the gate's definition)", ci(bootA));
console.log("  residual (b, own model)            ", ci(bootB));
console.log("  sanity: pooled BSS from the day sums", f4(pooledBssOfDays(foldDays.plain, wts)), "vs the fold-weighted BSS above", f4(pooledBss));
// Per-permutation checkpointing (calibration-log T31: two background kills so far). The checkpoint is keyed by k (1..NULL_DRAWS): each draw's seed is a
// deterministic function of k alone, so a resumed run fills exactly the missing k's with exactly the seeds an uninterrupted run would have used --
// "keep going from the current count" would silently reassign seeds to different k's once anything is missing, and is never used here.
const CHECKPOINT = process.env.NULL_CHECKPOINT ?? join(dataDir, `null-checkpoint-h${H}-every${EVERY}-block${NULL_BLOCK_DAYS}.json`);
function loadCheckpoint() {
  if (!existsSync(CHECKPOINT)) return {};
  try {
    const doc = JSON.parse(readFileSyncFs(CHECKPOINT, "utf8"));
    if (doc.horizon !== H || doc.every !== EVERY || doc.blockDays !== NULL_BLOCK_DAYS) return {}; // a different run's checkpoint: start clean
    return doc.draws ?? {};
  } catch (e) {
    // A partial write from a kill mid-save, or a missing/corrupt file: treat as if nothing were recorded (every draw is redone). Logged, not silent:
    // a silently swallowed error here previously made checkpointing look like it worked when it never ran at all (calibration-log T31).
    console.log(`checkpoint ${CHECKPOINT} unreadable (${e.message}); starting the null draws from scratch`);
    return {};
  }
}
function saveCheckpoint(draws) {
  const tmp = CHECKPOINT + ".tmp";
  writeFileSyncFs(tmp, JSON.stringify({ horizon: H, every: EVERY, blockDays: NULL_BLOCK_DAYS, draws }));
  renameSync(tmp, CHECKPOINT);
}
const checkpointed = loadCheckpoint();
const nullPooled = [];
if (NULL_DRAWS > 0) {
  const t1 = Date.now();
  const resumedCount = Object.keys(checkpointed).length;
  if (resumedCount) console.log(`resuming from checkpoint ${CHECKPOINT}: ${resumedCount}/${NULL_DRAWS} draws already on disk, filling the gap by k`);
  for (let seed = 1; seed <= NULL_DRAWS; seed++) {
    if (checkpointed[seed] !== undefined) {
      nullPooled.push(checkpointed[seed]);
      continue;
    }
    let num = 0;
    let den = 0;
    for (let k = 0; k < foldFits.length; k++) {
      const { f, trW, teW } = foldFits[k];
      // the day-block permutation is applied INSIDE the training set and INSIDE the test set separately, so the class-mix drift between them stays what it really is
      const shTr = dayBlockPermuteLabels(samples, sampleDay, Y, f.trainIdx, NULL_BLOCK_DAYS, 9000 + 1000 * seed + 2 * k);
      const shTe = dayBlockPermuteLabels(samples, sampleDay, Y, f.testIdx, NULL_BLOCK_DAYS, 9000 + 1000 * seed + 2 * k + 1);
      const tr = f.trainIdx.map((i, idx) => idx).filter((idx) => shTr.labels[idx] >= 0);
      const te = f.testIdx.map((i, idx) => idx).filter((idx) => shTe.labels[idx] >= 0);
      if (tr.length < 100 || te.length < 50) continue;
      const ytr = tr.map((idx) => shTr.labels[idx]);
      const yte = te.map((idx) => shTe.labels[idx]);
      const wtr = tr.map((idx) => trW[idx]);
      const mdl = fitSoftmax(tr.map((idx) => X[f.trainIdx[idx]]), ytr, 3, { l2: L2, sampleWeights: wtr, maxIter: 60 });
      const sc = bss(predictProba(mdl, te.map((idx) => X[f.testIdx[idx]])), yte, baseRates(ytr, 3, wtr), te.map((idx) => teW[idx]));
      if (sc !== null) {
        num += sc * wts[k];
        den += wts[k];
      }
    }
    if (den > 0) {
      const val = num / den;
      nullPooled.push(val);
      checkpointed[seed] = val;
      saveCheckpoint(checkpointed);
    }
  }
  nullPooled.sort((a, b) => a - b);
  const nm = nullPooled.reduce((a, b) => a + b, 0) / nullPooled.length;
  const nsd = Math.sqrt(nullPooled.reduce((a, b) => a + (b - nm) ** 2, 0) / Math.max(1, nullPooled.length - 1));
  const q = (x) => nullPooled[Math.min(nullPooled.length - 1, Math.floor(x * nullPooled.length))];
  const geReal = nullPooled.filter((x) => x >= pooledBss).length;
  console.log(`\nDAY-SHIFTED NULL (${nullPooled.length} draws: same features; labels day-block-permuted inside each fold's training set and inside its test set, blocks of ${NULL_BLOCK_DAYS} days, the same map for all coins; re-fitted in every fold; ${Math.round((Date.now() - t1) / 1000)}s):`);
  console.log(`  pooled BSS of the null: mean ${f4(nm)}  sd ${f4(nsd)}  p50 ${f4(q(0.5))}  p95 ${f4(q(0.95))}  max ${f4(nullPooled.at(-1))}   | real pooled BSS ${f4(pooledBss)}: ${geReal} of ${nullPooled.length} null draws are at least as high (permutation p >= ${((geReal + 1) / (nullPooled.length + 1)).toFixed(3)})`);
}
console.log(`\nROW-INDEPENDENT baselines (kept for comparison; they understate the noise): pooled BSS ${f4(pooledBss)} | shuffled ${f4(pooledShuf)} | random-feature p95 ${f4(p95)} | leak control: ${leak.status} (${leak.reason})`);
console.log(`ECE ${eceRes ? f4(eceRes.ece) : "-"} | regime coverage in DAYS (frozen cutpoints):`, cov ? JSON.stringify({ trend: cov.trend, vol: cov.vol }) : "null (a day carried two different values, or days did not line up)");
const testSpanDays = allTest.days.length ? maxOf(allTest.days) - minOf(allTest.days) + 1 : null;
const report = {
  folds: good.map((r) => ({ bss: r.real, n: r.test })),
  pooled: { bss: pooledBss, residualBss: pooledResidual, ece: eceRes?.ece ?? null, classCounts: classCounts(allTest.y, 3), effectiveN: good.length ? good.at(-1).effTrain : null, effectiveTestN: wsum || null, regimeCoverage: cov, testSpanDays },
  randomBaselineP95: p95,
  leakStatus: leak.status,
  universe: delistedUniverse ?? { identifiedDelisted: 121, obtainedDelisted: 0, unobtained: Array.from({ length: 121 }, (_, k) => ({ symbol: "delisted-" + (k + 1), reason: "not yet downloaded: batches await the user's approval" })) },
};
const gate = evaluateGate(report, CALIBRATION_GATE);
console.log(`\nGATE (shipped default): pass = ${gate.pass}; reasons:`);
for (const r of gate.reasons) console.log("  - " + r);
console.log("notes carried by the result:");
for (const n of gate.notes) console.log("  * " + n);
console.log("\nREHEARSAL ONLY. Survivors only. None of these numbers is a model result.");
