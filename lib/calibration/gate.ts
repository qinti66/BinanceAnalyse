import { FEATURE_IDS } from "../indicators/features/registry.ts";
import type { LeakStatus } from "./controls.ts";
import type { RegimeCoverage, RegimeCutpoints } from "./regime.ts";

/**
 * The calibration gate. It lives in code, not in a document, because a soft gate is how a trustworthy-looking number gets
 * published from an untrustworthy process. Below the gate the panel shows "calibration insufficient" and draws no probability bar.
 *
 * FAIL CLOSED: an unset threshold, a missing or malformed report, a NaN, or any exception is a failure. There is no
 * "not configured, so allow it" path. There is also no hard-coded BSS number: the bar is the measured random-feature baseline.
 */

/**
 * Two kinds of threshold, and only one of them may be a judgement:
 *  - PERFORMANCE thresholds (how good is good enough), e.g. the BSS bar: never a number picked by hand. They are compared against a
 *    measured baseline (the random-feature p95) or a sign (> 0).
 *  - SUFFICIENCY thresholds (is there enough evidence): may be judgement, but must SAY so. The sin is dressing a judgement up as a
 *    measurement. minFolds and minTestSpanDays below are JUDGEMENT VALUES, not measured values; whoever changes one should know that.
 * minEffectiveN is derived, not typed: a rule of thumb of 20 effective samples per free parameter, so it follows the feature set.
 */
export const EFFECTIVE_SAMPLES_PER_PARAMETER = 20;
/** Free parameters of the multinomial logistic model: (classes - 1) x (features + 1). */
export const freeParameters = (nFeatures: number, nClasses = 3): number => (nClasses - 1) * (nFeatures + 1);
export const deriveMinEffectiveN = (nFeatures: number, nClasses = 3): number => EFFECTIVE_SAMPLES_PER_PARAMETER * freeParameters(nFeatures, nClasses);
/** ECE needs equal-frequency bins of at least 50 samples and at least 5 of them, so the TEST side needs at least this many effective samples. */
export const ECE_MIN_BIN_SAMPLES = 50;
export const ECE_MIN_BINS = 5;
export const MIN_EFFECTIVE_TEST_N = ECE_MIN_BIN_SAMPLES * ECE_MIN_BINS;

export interface GateThresholds {
  /** Maximum top-label ECE. UNSET until the reliability curves have been looked at, so the default gate never passes. */
  eceMax: number | null;
  /** Minimum samples in EVERY class of the test folds. UNSET until decided. */
  minClassSamples: number | null;
  /**
   * The tercile cutpoints of g1 (breadth) and g2 (BTC volatility percentile) over ALL available history, computed once and frozen
   * (see regime.ts). UNSET until multi-regime history exists, so the default gate cannot pass: a model verified in one market regime
   * must not show confident probabilities. Null means "regime coverage unverified", which is a failure, not a warning.
   */
  regimeCutpoints: RegimeCutpoints | null;
  /**
   * Effective test samples required in EACH of the four bins (g1 low/high, g2 low/high). JUDGEMENT VALUE, not a measured one.
   * Two marginal requirements, not a g1 x g2 grid: the grid's nine cells cannot be filled with this much data, and g1 and g2 are
   * correlated. Both axes because they catch different failures: g1 the directional regime effect (a3 saturating on one side),
   * g2 the volatility regime (ATR-based features).
   */
  minRegimeBinSamples: number;
  /** JUDGEMENT VALUE, not a measured one. */
  minFolds: number;
  /** Effective TRAINING sample size after uniqueness weighting. Derived: 20 x free parameters. */
  minEffectiveN: number;
  /** Effective sample size of the pooled TEST folds, listed separately from training. Tied to the ECE bin requirement. */
  minEffectiveTestN: number;
  /**
   * JUDGEMENT VALUE, not a measured one. It is a calendar PROXY for "the test folds cover more than one market regime": it does NOT
   * discriminate regimes, so a 60-day span inside a single regime passes it. There is deliberately no minRegimes check yet, because
   * nothing defines a regime in code. Observed in W1: a3 saturates at -5 (5.03%) but rarely at +5 (0.79%), so the tail that gets clipped
   * depends on the regime; folds that sit in one regime cannot show that. A real check needs a feature-side regime label (e.g. from g1/g2)
   * fixed before training, and is an open item, not a claim this field makes.
   */
  minTestSpanDays: number;
}

export const CALIBRATION_GATE: Readonly<GateThresholds> = {
  eceMax: null,
  minClassSamples: null,
  regimeCutpoints: null,
  minRegimeBinSamples: 100,
  minFolds: 3,
  minEffectiveN: deriveMinEffectiveN(FEATURE_IDS.length),
  minEffectiveTestN: MIN_EFFECTIVE_TEST_N,
  minTestSpanDays: 60,
};

export interface HeadReport {
  folds: { bss: number | null; n: number }[];
  pooled: {
    bss: number | null;
    /** BSS of the same forecasts against labels on the BTC-beta-adjusted path. ≈ 0 means the model only predicts the market. */
    residualBss: number | null;
    ece: number | null;
    classCounts: number[];
    /** Effective size of the training set the model was fitted on. */
    effectiveN: number | null;
    /** Effective size of the pooled test folds. */
    effectiveTestN: number | null;
    /** Effective test samples per regime bin, from regimeCoverage() with the SAME cutpoints as the gate. Null = not computed. */
    regimeCoverage: RegimeCoverage | null;
    testSpanDays: number | null;
  };
  /** 95th percentile BSS of information-free features (randomFeatureBaseline). */
  randomBaselineP95: number | null;
  leakStatus: LeakStatus | null;
}

export interface GateResult {
  pass: boolean;
  /** Every failed check, not only the first. Empty when pass. */
  reasons: string[];
}

const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Evaluate one prediction head (4h and 24h are judged independently). Never throws; anything unexpected fails. */
export function evaluateGate(report: HeadReport | null | undefined, t: Readonly<GateThresholds> = CALIBRATION_GATE): GateResult {
  const reasons: string[] = [];
  try {
    if (!report || typeof report !== "object" || !report.pooled || !Array.isArray(report.folds)) {
      return { pass: false, reasons: ["no evaluation report"] };
    }
    const p = report.pooled;
    const p95 = report.randomBaselineP95;
    // A missing threshold makes every comparison against it false (x < undefined), which would silently skip the check and pass.
    for (const key of ["minFolds", "minEffectiveN", "minEffectiveTestN", "minTestSpanDays"] as const) {
      if (!ok(t[key])) reasons.push("threshold " + key + " not configured");
    }

    if (!ok(p95)) reasons.push("random-feature baseline missing");
    if (!ok(p.bss)) reasons.push("pooled BSS missing");
    else if (ok(p95) && !(p.bss > Math.max(0, p95))) reasons.push("pooled BSS " + p.bss + " does not exceed max(0, random baseline p95 " + p95 + ")");

    if (!ok(p.residualBss)) reasons.push("residual BSS missing");
    else if (!(p.residualBss > 0)) reasons.push("residual BSS " + p.residualBss + " is not above 0: the model may only be predicting the market");

    if (!ok(t.eceMax)) reasons.push("ECE threshold not configured");
    if (!ok(p.ece)) reasons.push("ECE missing");
    else if (ok(t.eceMax) && !(p.ece < t.eceMax)) reasons.push("ECE " + p.ece + " is not below " + t.eceMax);

    if (!ok(t.minClassSamples) || !(t.minClassSamples >= 1)) reasons.push("per-class sample floor not configured");
    if (!Array.isArray(p.classCounts) || p.classCounts.length < 2 || !p.classCounts.every(ok)) reasons.push("class counts missing");
    else if (p.classCounts.some((c) => !(c >= 1))) reasons.push("a class has no test samples");
    else if (ok(t.minClassSamples) && t.minClassSamples >= 1 && p.classCounts.some((c) => c < t.minClassSamples!)) reasons.push("a class has fewer than " + t.minClassSamples + " test samples");

    if (report.folds.length < t.minFolds) reasons.push("only " + report.folds.length + " folds, need " + t.minFolds);
    report.folds.forEach((f, i) => {
      if (!f || !ok(f.bss)) reasons.push("fold " + i + " BSS missing");
      else if (!(f.bss > 0)) reasons.push("fold " + i + " BSS " + f.bss + " is not above 0");
    });

    if (!ok(p.effectiveN)) reasons.push("effective training sample size missing");
    else if (p.effectiveN < t.minEffectiveN) reasons.push("effective training sample size " + p.effectiveN + " below " + t.minEffectiveN);
    if (!ok(p.effectiveTestN)) reasons.push("effective test sample size missing");
    else if (p.effectiveTestN < t.minEffectiveTestN) reasons.push("effective test sample size " + p.effectiveTestN + " below " + t.minEffectiveTestN);
    if (!ok(p.testSpanDays)) reasons.push("test span missing");
    else if (p.testSpanDays < t.minTestSpanDays) reasons.push("test span " + p.testSpanDays + " days below " + t.minTestSpanDays);

    // Regime coverage. Unset cutpoints, a missing coverage, a coverage computed with other cutpoints, or any thin bin is a failure.
    const validAxis = (c: { lower: number; upper: number } | undefined) => !!c && ok(c.lower) && ok(c.upper) && c.lower < c.upper;
    const rc = t.regimeCutpoints;
    const cutsOk = !!rc && validAxis(rc.g1) && validAxis(rc.g2);
    if (!cutsOk) reasons.push("regime coverage unverified: regime cutpoints not configured");
    if (!ok(t.minRegimeBinSamples) || !(t.minRegimeBinSamples >= 1)) reasons.push("threshold minRegimeBinSamples not configured");
    const cov = p.regimeCoverage;
    if (!cov || typeof cov !== "object") reasons.push("regime coverage unverified: the report has no regime coverage");
    else {
      const same = cutsOk && !!cov.cutpoints && ["g1", "g2"].every((a) => {
        const x = cov.cutpoints[a as "g1" | "g2"];
        const y = rc![a as "g1" | "g2"];
        return !!x && x.lower === y.lower && x.upper === y.upper;
      });
      if (cutsOk && !same) reasons.push("regime coverage unverified: it was computed with different cutpoints than the gate's");
      for (const axis of ["g1", "g2"] as const) {
        for (const bin of ["low", "high"] as const) {
          const v = cov[axis]?.[bin];
          if (!ok(v)) reasons.push("regime coverage unverified: " + axis + " " + bin + " bin missing");
          else if (ok(t.minRegimeBinSamples) && t.minRegimeBinSamples >= 1 && v < t.minRegimeBinSamples) reasons.push("regime coverage: " + axis + " " + bin + " tercile has " + v + " effective test samples, below " + t.minRegimeBinSamples);
        }
      }
    }

    if (report.leakStatus !== "clean") reasons.push("shuffled-label control is " + String(report.leakStatus ?? "missing") + ", not clean");
  } catch (e) {
    return { pass: false, reasons: ["evaluation error: " + String(e)] };
  }
  return { pass: reasons.length === 0, reasons };
}
