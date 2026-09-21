import { quantile } from "./metrics.ts";

/**
 * Market-regime coverage of the test folds, from feature-side data only; no labels. Two axes, both computed from BTC alone:
 *   trend = BTC's trailing 30-day return in percent (the DIRECTION of the market: bull or bear),
 *   vol   = the g2 feature, BTC's 30-day realised volatility as a percentile of its own trailing year (the VOLATILITY regime).
 * The breadth feature g1 is deliberately NOT an axis: it is a fast, day-to-day quantity (about 2.5 days of memory) whose monthly means are all alike, so a
 * test window covers all of its bins automatically and the check would never fail. It stays a model feature. An axis must pass the persistence ruler
 * (regimeRuns, below) before it may be used here.
 * A model verified inside a single regime says nothing about the others: a3 alone saturates at -5 in 5.03% of the bearish W1 and at +5 in 0.79%,
 * so which tail is clipped depends on the regime. The calendar span check cannot see that; this can.
 *
 * COUNTING UNIT = DAYS. Every coin on the same day shares the same trend and vol values, so counting (coin, day) samples counts one regime observation
 * hundreds of times and any bin would pass. A bin is counted by the number of DISTINCT DAYS whose value falls in it.
 *
 * The cutpoints are the terciles of each axis over ALL of that axis's available history, computed ONCE and frozen as constants in the repo
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
  trend: AxisCutpoints;
  vol: AxisCutpoints;
}
/**
 * THE FROZEN REGIME CUTPOINTS (calibration-log-v1.md T11, T22, T23). Computed ONCE, from scripts/measure-regime-persistence.mjs on 2026-09-21, over ALL available days of
 * each axis, and never recomputed by a run. Both axes depend on BTC only, so adding delisted altcoins to the universe cannot change them.
 *   trend: BTC trailing 30-day return in percent, 720 days (2024-10-01 .. 2026-09-21).
 *   vol:   the g2 feature (BTC 30-day realised volatility percentile in its own trailing year), 356 days (2025-10-01 .. 2026-09-21).
 * "High" is relative to this whole two-year window, not to any local period: the second half of the window alone would put the cutpoints elsewhere
 * (trend lower -0.66 vs -6.18, vol upper 72.2 vs 57.4). That drift is information about the market, not a defect of the method.
 */
export const FROZEN_REGIME_CUTPOINTS: RegimeCutpoints = {
  trend: { lower: -2.6411486578998353, upper: 5.965780629414542 },
  vol: { lower: 43.242009132420094, upper: 63.6986301369863 },
};

/** How each axis earned its place. The deciding statistic was the day-weighted median run (its goalpost check on g1: median 2 days, bar 7). */
export const REGIME_PROVENANCE = {
  deciding: "day-weighted median run",
  bar: 14,
  trend: { days: 720, stretches: 108, perStretchMedian: 2, dayWeightedMedian: 18 },
  vol: { days: 356, stretches: 21, perStretchMedian: 14, dayWeightedMedian: 30 },
} as const;

/** Facts every regime-coverage report must carry, from REGIME_PROVENANCE. The fragile points are stated as fragile, not left in the ledger. */
export function regimeNotes(p: typeof REGIME_PROVENANCE = REGIME_PROVENANCE): string[] {
  return [
    `regime 轴的决定性统计是「按天加权的游程中位数」（门槛 ${p.bar} 天）；两个统计量并排如下，不许只报有利的那个。`,
    `trend 轴（BTC 尾随 30 天收益）：${p.trend.days} 天、${p.trend.stretches} 段游程；按天加权中位数 ${p.trend.dayWeightedMedian} 天（通过），但按段中位数只有 ${p.trend.perStretchMedian} 天（未达 ${p.bar}）：它仅在按天加权的统计下合格，切点附近有大量短游程。`,
    `vol 轴（BTC 波动分位）：${p.vol.days} 天、${p.vol.stretches} 段游程；按天加权中位数 ${p.vol.dayWeightedMedian} 天，但按段中位数恰为 ${p.vol.perStretchMedian}.0（擦线），只有 ${p.vol.stretches} 段，增减一段即可改变按段的结论。`,
    "「高」「低」是相对整个两年窗口而言，不是相对任何局部时期：前后两半各自算出的切点差别很大（底层分布在漂移）。",
  ];
}

export interface RegimeCoverage {
  /** The cutpoints these counts were computed with; the gate refuses counts computed with any other cutpoints. */
  cutpoints: RegimeCutpoints;
  /**
   * The spacing, in days, between the distinct test days the coverage was counted from (the most common gap; null when there are fewer than two days). The day
   * threshold (minRegimeBinDays) is only comparable when the test days are consecutive, i.e. 1: sampling every third day cuts every bin's day count to about a
   * third (measured in the rehearsal: 28 days instead of about 38). The gate refuses any other value.
   */
  samplingIntervalDays: number | null;
  /** Distinct test DAYS whose regime value falls in the low and high bin of each axis. */
  trend: { low: number; high: number };
  vol: { low: number; high: number };
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

/** The most common gap between consecutive distinct days (ties go to the smaller gap); null with fewer than two days. */
export function modalGap(distinctDays: number[]): number | null {
  const d = [...distinctDays].sort((x, y) => x - y);
  if (d.length < 2) return null;
  const counts = new Map<number, number>();
  for (let i = 1; i < d.length; i++) counts.set(d[i] - d[i - 1], (counts.get(d[i] - d[i - 1]) ?? 0) + 1);
  let best = -1;
  let bestN = -1;
  for (const [gap, n] of counts) if (n > bestN || (n === bestN && gap < best)) [best, bestN] = [gap, n];
  return best;
}

/**
 * Distinct test days in the lowest and highest tercile bin of each axis. Boundaries are inclusive (value <= lower, value >= upper).
 * `days[i]` is the integer day (e.g. floor(time / 86400000)) of sample i, and trend[i], vol[i] are that sample's regime values. Samples of the same day
 * must carry the same value; a day whose samples disagree means the inputs are not what they claim, so the result is null. A day with no finite value
 * on an axis is counted in no bin of that axis. Null when the inputs do not line up.
 */
export function regimeCoverage(o: { trend: number[]; vol: number[]; days: ArrayLike<number>; cutpoints: RegimeCutpoints }): RegimeCoverage | null {
  const { trend, vol, days, cutpoints } = o;
  if (trend.length !== vol.length || days.length !== trend.length) return null;
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
  const a = perDay(trend);
  const b = perDay(vol);
  if (!a || !b) return null;
  return { cutpoints, samplingIntervalDays: modalGap([...new Set(Array.from(days))]), trend: count(a, cutpoints.trend), vol: count(b, cutpoints.vol) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The persistence ruler. A regime axis is only useful if the bin a day falls in PERSISTS: if it flips every day or two, any test window covers all
// bins automatically and the coverage check can never fail. So the ruler measures how long a day stays in the same tercile bin (a "run").
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The median run length, in days, that an axis must reach to be a regime axis. JUDGEMENT VALUE, not a measured one. Not a matter of taste: folds span
 * weeks to months, and only when a bin lasts about two weeks is the regime a property of a FOLD; runs of a day or two are day-to-day noise.
 */
export const MIN_MEDIAN_RUN_DAYS = 14;

export type RegimeBin = "low" | "mid" | "high";
export const binOf = (x: number, c: AxisCutpoints): RegimeBin | null => (!finite(x) ? null : x <= c.lower ? "low" : x >= c.upper ? "high" : "mid");

export interface RegimeRuns {
  /** Length of every maximal stretch of consecutive days in the same bin. A missing value ends a stretch and is in none. */
  runs: number[];
  /** Median over the stretches (each counts once). Null when there are none. */
  median: number | null;
  /**
   * Median over DAYS: every day takes the length of the stretch it sits in, and the median is over days. A randomly chosen test day is more likely to sit
   * in a long stretch, so this is closer to "can a test window see a persistent bin" than the per-stretch median, which gives a one-day stretch the same
   * weight as a fifty-day one. Both statistics are ALWAYS reported side by side, never only the favourable one.
   */
  dayWeightedMedian: number | null;
  mean: number | null;
  /** The share of days in each bin, and the median run per bin. */
  byBin: Record<RegimeBin, { days: number; median: number | null }>;
}

const medianOf = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** `values` is one value per CONSECUTIVE day, oldest first. */
export function regimeRuns(values: number[], c: AxisCutpoints): RegimeRuns {
  const runs: number[] = [];
  const perBin: Record<RegimeBin, number[]> = { low: [], mid: [], high: [] };
  const days: Record<RegimeBin, number> = { low: 0, mid: 0, high: 0 };
  let cur: RegimeBin | null = null;
  let len = 0;
  const flush = () => {
    if (cur && len) {
      runs.push(len);
      perBin[cur].push(len);
    }
    cur = null;
    len = 0;
  };
  for (const x of values) {
    const b = binOf(x, c);
    if (b === null) {
      flush();
      continue;
    }
    days[b]++;
    if (b === cur) len++;
    else {
      flush();
      cur = b;
      len = 1;
    }
  }
  flush();
  const mean = runs.length ? runs.reduce((a, r) => a + r, 0) / runs.length : null;
  const perDay: number[] = [];
  for (const r of runs) for (let i = 0; i < r; i++) perDay.push(r);
  return {
    runs,
    median: medianOf(runs),
    dayWeightedMedian: medianOf(perDay),
    mean,
    byBin: { low: { days: days.low, median: medianOf(perBin.low) }, mid: { days: days.mid, median: medianOf(perBin.mid) }, high: { days: days.high, median: medianOf(perBin.high) } },
  };
}

/** Does an axis persist enough to be a regime axis, by the chosen statistic? A null median (no runs) is a no. */
export const persistsAsRegime = (r: RegimeRuns, stat: "perRun" | "dayWeighted" = "perRun"): boolean => {
  const m = stat === "perRun" ? r.median : r.dayWeightedMedian;
  return m !== null && m >= MIN_MEDIAN_RUN_DAYS;
};

/**
 * How far below the bar the KNOWN-BAD axis (g1, breadth) must sit under a new statistic before that statistic is trusted: at most half of the bar.
 * Fixed BEFORE the day-weighted statistic was measured on anything. If g1 passes or comes close, the statistic has moved the goalposts and is abandoned.
 */
export const KNOWN_BAD_MAX_MEDIAN_DAYS = MIN_MEDIAN_RUN_DAYS / 2;

/**
 * BTC's trailing return over `days` days in percent, from 1h bars: close at closeTime `ct` against the close at `ct - days*24h`. Null when either bar is
 * missing (no fill, no nearest bar). BTC alone, so it does not change when other contracts are added to the universe.
 */
export function btcTrailingReturnPct(bars: { ct: number; c: number }[], ct: number, days = 30): number | null {
  const at = (t: number): number | null => {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].ct === t) return bars[mid].c;
      if (bars[mid].ct < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  };
  const now = at(ct);
  const then = at(ct - days * 24 * 3600000);
  return finite(now) && finite(then) && then > 0 ? (now / then - 1) * 100 : null;
}
