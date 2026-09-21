import { quantile } from "./metrics.ts";

/**
 * Market-regime coverage of the test folds, from feature-side data only (g1 breadth, g2 BTC volatility percentile); no labels.
 * A model verified inside a single regime says nothing about the others: a3 alone saturates at -5 in 5.03% of the bearish W1 and at +5 in 0.79%,
 * so which tail is clipped depends on the regime. The calendar span check cannot see that; this can.
 *
 * COUNTING UNIT = DAYS. Every coin on the same day shares the same g1 and g2, so counting (coin, day) samples counts one regime observation
 * hundreds of times and any bin would pass. A bin is counted by the number of DISTINCT DAYS whose value falls in it.
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
  /** Distinct test DAYS whose regime value falls in the low and high bin of each axis. */
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
 * Distinct test days in the lowest and highest tercile bin of each axis. Boundaries are inclusive (value <= lower, value >= upper).
 * `days[i]` is the integer day (e.g. floor(time / 86400000)) of sample i, and g1[i], g2[i] are that sample's regime values. Samples of the same day
 * must carry the same value; a day whose samples disagree means the inputs are not what they claim, so the result is null. A day with no finite value
 * on an axis is counted in no bin of that axis. Null when the inputs do not line up.
 */
export function regimeCoverage(o: { g1: number[]; g2: number[]; days: ArrayLike<number>; cutpoints: RegimeCutpoints }): RegimeCoverage | null {
  const { g1, g2, days, cutpoints } = o;
  if (g1.length !== g2.length || days.length !== g1.length) return null;
  const perDay = (xs: number[]): Map<number, number> | null => {
    const byDay = new Map<number, number>();
    for (let i = 0; i < xs.length; i++) {
      const d = days[i];
      if (!Number.isInteger(d)) return null;
      const x = xs[i];
      if (!finite(x)) continue;
      const seen = byDay.get(d);
      if (seen === undefined) byDay.set(d, x);
      else if (seen !== x) return null;
    }
    return byDay;
  };
  const count = (byDay: Map<number, number>, c: AxisCutpoints) => {
    let low = 0;
    let high = 0;
    for (const x of byDay.values()) {
      if (x <= c.lower) low++;
      if (x >= c.upper) high++;
    }
    return { low, high };
  };
  const a = perDay(g1);
  const b = perDay(g2);
  if (!a || !b) return null;
  return { cutpoints, g1: count(a, cutpoints.g1), g2: count(b, cutpoints.g2) };
}
