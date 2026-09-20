import { quantile } from "./metrics.ts";

/**
 * Market-regime coverage of the test folds, from feature-side data only (g1 breadth, g2 BTC volatility percentile); no labels.
 * A model verified inside a single regime says nothing about the others: a3 alone saturates at -5 in 5.03% of the bearish W1 and at +5 in 0.79%,
 * so which tail is clipped depends on the regime. The calendar span check cannot see that; this can.
 *
 * The cutpoints are the terciles of g1 and g2 over ALL available history, computed ONCE and frozen as constants in the repo
 * (recorded in calibration-log-v1.md); a run never recomputes them. This is not label leakage and not model selection (the model never
 * sees a regime label): it is only the definition of "high volatility". Recomputing per run would let the gate drift with the data.
 */

export interface AxisCutpoints {
  /** Values <= lower are the "low" regime bin. */
  lower: number;
  /** Values >= upper are the "high" regime bin. */
  upper: number;
}
export interface RegimeCutpoints {
  g1: AxisCutpoints;
  g2: AxisCutpoints;
}
export interface RegimeCoverage {
  /** The cutpoints these counts were computed with; the gate refuses counts computed with any other cutpoints. */
  cutpoints: RegimeCutpoints;
  /** Effective (uniqueness-weighted) test samples in the low and high bin of each axis. */
  g1: { low: number; high: number };
  g2: { low: number; high: number };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Tercile cutpoints of one axis over the full history. Null when there are too few finite values to define terciles. */
export function regimeTerciles(values: number[]): AxisCutpoints | null {
  const v = values.filter(finite);
  if (v.length < 30) return null;
  const lower = quantile(v, 1 / 3);
  const upper = quantile(v, 2 / 3);
  return lower === null || upper === null || !(lower < upper) ? null : { lower, upper };
}

/**
 * Effective test samples in the lowest and highest tercile bin of each axis. Boundaries are inclusive (value <= lower, value >= upper).
 * A missing (non-finite) value is counted in no bin. Null when the inputs do not line up.
 */
export function regimeCoverage(o: { g1: number[]; g2: number[]; weights?: ArrayLike<number>; cutpoints: RegimeCutpoints }): RegimeCoverage | null {
  const { g1, g2, weights, cutpoints } = o;
  if (g1.length !== g2.length || (weights && weights.length !== g1.length)) return null;
  const count = (xs: number[], c: AxisCutpoints) => {
    let low = 0;
    let high = 0;
    xs.forEach((x, i) => {
      const w = weights ? weights[i] : 1;
      if (!finite(x) || !finite(w) || w < 0) return;
      if (x <= c.lower) low += w;
      if (x >= c.upper) high += w;
    });
    return { low, high };
  };
  return { cutpoints, g1: count(g1, cutpoints.g1), g2: count(g2, cutpoints.g2) };
}
