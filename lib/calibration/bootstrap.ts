import { mulberry32 } from "./controls.ts";

/**
 * Day-clustered inference. Every coin on the same day shares one market (the regime features g1 and g2 are literally the same number for all of them, and the labels
 * of a day move together), so the effective number of independent observations of a fold is closer to its number of DAYS than to its number of rows. A test that
 * treats rows as independent understates the noise. Everything here resamples or shifts whole days.
 */

/** One day of one test fold: the weighted Brier sums of the model's forecasts and of the base-rate forecast over that day's samples. */
export interface DayStat {
  day: number;
  model: number;
  base: number;
}

/** BSS of a set of days: 1 - (model Brier sum / base Brier sum). Null when the base sum is not positive. */
export function bssOfDays(days: DayStat[]): number | null {
  let m = 0;
  let b = 0;
  for (const d of days) {
    m += d.model;
    b += d.base;
  }
  return b > 0 && Number.isFinite(m) ? 1 - m / b : null;
}

/** Pooled BSS: the fold BSS values averaged with the given weights (the same pooling the evaluation uses). Null when any fold has none. */
export function pooledBss(folds: DayStat[][], weights: number[]): number | null {
  let num = 0;
  let den = 0;
  for (let f = 0; f < folds.length; f++) {
    const s = bssOfDays(folds[f]);
    if (s === null) return null;
    num += s * weights[f];
    den += weights[f];
  }
  return den > 0 ? num / den : null;
}

export interface BootstrapResult {
  draws: number;
  /** The pooled BSS on the real days. */
  observed: number | null;
  mean: number;
  lo: number;
  hi: number;
  /** The share of resamples whose pooled BSS is above 0. */
  shareAboveZero: number;
}

/**
 * Block bootstrap over DAYS, stratified by fold: in each draw every fold resamples its own days with replacement (as many as it has), the fold BSS values are
 * recomputed from the resampled day sums, and pooled with the same weights. The interval is the 2.5th to 97.5th percentile of the draws.
 */
export function clusterBootstrapBss(folds: DayStat[][], weights: number[], o: { draws?: number; seed?: number } = {}): BootstrapResult | null {
  const draws = o.draws ?? 1000;
  const observed = pooledBss(folds, weights);
  if (observed === null || folds.some((f) => !f.length)) return null;
  const rand = mulberry32(o.seed ?? 1);
  const scores: number[] = [];
  for (let d = 0; d < draws; d++) {
    const resampled = folds.map((days) => Array.from({ length: days.length }, () => days[Math.floor(rand() * days.length)]));
    const s = pooledBss(resampled, weights);
    if (s !== null) scores.push(s);
  }
  if (!scores.length) return null;
  scores.sort((a, b) => a - b);
  const at = (q: number) => scores[Math.min(scores.length - 1, Math.max(0, Math.floor(q * scores.length)))];
  return { draws: scores.length, observed, mean: scores.reduce((a, b) => a + b, 0) / scores.length, lo: at(0.025), hi: at(0.975), shareAboveZero: scores.filter((s) => s > 0).length / scores.length };
}

/**
 * Aggregate per-sample Brier contributions into per-day sums. \`days[i]\` is the integer day of sample i; \`model[i]\` and \`base[i]\` are that sample's (weighted)
 * Brier terms. Samples with a non-finite term are skipped (a missing value stays missing).
 */
export function dayStats(days: ArrayLike<number>, model: ArrayLike<number>, base: ArrayLike<number>): DayStat[] {
  const byDay = new Map<number, DayStat>();
  for (let i = 0; i < days.length; i++) {
    if (!Number.isFinite(model[i]) || !Number.isFinite(base[i])) continue;
    const s = byDay.get(days[i]) ?? byDay.set(days[i], { day: days[i], model: 0, base: 0 }).get(days[i])!;
    s.model += model[i];
    s.base += base[i];
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

/** The Brier term of one forecast against one class: the sum over classes of (p_c - 1[y = c])^2. */
export const brierTerm = (p: number[], y: number): number => p.reduce((a, pc, c) => a + (pc - (c === y ? 1 : 0)) ** 2, 0);
