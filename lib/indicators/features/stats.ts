import type { Bar } from "../../structure/types.ts";

/** Plain statistics used by the feature registry. Every function returns null when the input cannot support an answer. */

export const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function median(values: number[]): number | null {
  if (!values.length || !values.every(finite)) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear-interpolated quantile (type 7) of an already sorted array. */
export function quantileSorted(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

export function iqr(values: number[]): number | null {
  if (!values.length || !values.every(finite)) return null;
  const s = [...values].sort((a, b) => a - b);
  return quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
}

/**
 * Percentile rank of x within series, 0–100, ties take the mid-rank: (below + 0.5 × equal) / n.
 * `x` is normally an element of `series` (the trailing window ends at the decision bar). Null on an empty or non-finite input.
 */
export function pctRank(x: number, series: number[]): number | null {
  if (!finite(x) || !series.length || !series.every(finite)) return null;
  let below = 0;
  let equal = 0;
  for (const v of series) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return (100 * (below + 0.5 * equal)) / series.length;
}

/** OLS slope of y on x. Null with fewer than 2 points or zero variance in x. */
export function olsSlope(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n || !x.every(finite) || !y.every(finite)) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : null;
}

/** EMA seeded with the simple mean of the first `period` values; same recurrence as `ema` in indicators/model.ts. */
export function emaValue(values: number[], period: number): number | null {
  if (values.length < period || !values.every(finite)) return null;
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const v of values.slice(period)) e += (2 / (period + 1)) * (v - e);
  return e;
}

/** True when the last `n` bars exist and their open times are exactly `intervalMs` apart. */
export function contiguousTail(bars: Bar[], n: number, intervalMs: number): boolean {
  if (bars.length < n) return false;
  for (let j = bars.length - n + 1; j < bars.length; j++) if (bars[j].t - bars[j - 1].t !== intervalMs) return false;
  return true;
}

/** Index of the last bar whose closeTime is <= ct, or -1. Bars must be sorted oldest first. */
export function lastIndexClosedBy(bars: Bar[], ct: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ct <= ct) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
