/** Multiclass probability metrics. Every function returns null on invalid input instead of a number that looks like a result. */

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Rows must be finite, non-negative and sum to 1 (1e-6); labels must be valid class indices. */
export function validForecasts(probs: number[][], y: number[], k?: number): boolean {
  if (!probs.length || probs.length !== y.length) return false;
  const kk = k ?? probs[0].length;
  if (kk < 2) return false;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (p.length !== kk || !Number.isInteger(y[i]) || y[i] < 0 || y[i] >= kk) return false;
    let s = 0;
    for (const v of p) {
      if (!finite(v) || v < 0) return false;
      s += v;
    }
    if (Math.abs(s - 1) > 1e-6) return false;
  }
  return true;
}

const weightOf = (w: ArrayLike<number> | undefined, i: number) => (w ? w[i] : 1);

/** Class frequencies of y (optionally weighted). The BSS baseline: what you forecast knowing only how often each class occurs. */
export function baseRates(y: number[], k: number, w?: ArrayLike<number>): number[] | null {
  if (!y.length || k < 2) return null;
  const c = new Array<number>(k).fill(0);
  let total = 0;
  for (let i = 0; i < y.length; i++) {
    if (!Number.isInteger(y[i]) || y[i] < 0 || y[i] >= k) return null;
    const wi = weightOf(w, i);
    if (!finite(wi) || wi < 0) return null;
    c[y[i]] += wi;
    total += wi;
  }
  return total > 0 ? c.map((v) => v / total) : null;
}

/** Multiclass Brier score: mean over samples of Σ_k (p_k − 1[y = k])². Lower is better. */
export function brier(probs: number[][], y: number[], w?: ArrayLike<number>): number | null {
  if (!validForecasts(probs, y)) return null;
  let sum = 0;
  let total = 0;
  for (let i = 0; i < probs.length; i++) {
    const wi = weightOf(w, i);
    if (!finite(wi) || wi < 0) return null;
    let e = 0;
    for (let c = 0; c < probs[i].length; c++) e += (probs[i][c] - (y[i] === c ? 1 : 0)) ** 2;
    sum += wi * e;
    total += wi;
  }
  return total > 0 ? sum / total : null;
}

/**
 * Brier skill score: 1 − Brier(model) / Brier(base rates). The baseline is the class frequencies from the TRAINING fold, not 1/K:
 * with imbalanced classes 1/K is a baseline nobody would use. 0 = no better than the base rates; negative = worse.
 */
export function bss(probs: number[][], y: number[], trainRates: number[], w?: ArrayLike<number>): number | null {
  const k = probs[0]?.length;
  if (!k || trainRates.length !== k || Math.abs(trainRates.reduce((a, b) => a + b, 0) - 1) > 1e-6) return null;
  const model = brier(probs, y, w);
  const ref = brier(probs.map(() => trainRates), y, w);
  if (model === null || ref === null || !(ref > 0)) return null;
  return 1 - model / ref;
}

export interface CalibrationBin {
  n: number;
  meanConfidence: number;
  accuracy: number;
}
export interface EceResult {
  ece: number;
  mce: number;
  bins: CalibrationBin[];
}

/**
 * Top-label expected calibration error over equal-frequency bins of the predicted confidence (max probability). The number of
 * bins is the largest ≤ maxBins that keeps every bin at or above minBinSamples; fewer than 2 such bins ⇒ null (not enough data
 * to say anything about calibration). `bins` is the reliability curve.
 */
export function ece(probs: number[][], y: number[], o: { minBinSamples?: number; maxBins?: number } = {}): EceResult | null {
  if (!validForecasts(probs, y)) return null;
  const minBin = o.minBinSamples ?? 50;
  const nBins = Math.min(o.maxBins ?? 10, Math.floor(probs.length / minBin));
  if (nBins < 2) return null;
  const rows = probs
    .map((p, i) => {
      let best = 0;
      for (let c = 1; c < p.length; c++) if (p[c] > p[best]) best = c;
      return { conf: p[best], hit: best === y[i] ? 1 : 0 };
    })
    .sort((a, b) => a.conf - b.conf);
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < nBins; b++) {
    const lo = Math.floor((b * rows.length) / nBins);
    const hi = Math.floor(((b + 1) * rows.length) / nBins);
    const slice = rows.slice(lo, hi);
    bins.push({ n: slice.length, meanConfidence: slice.reduce((a, r) => a + r.conf, 0) / slice.length, accuracy: slice.reduce((a, r) => a + r.hit, 0) / slice.length });
  }
  let e = 0;
  let m = 0;
  for (const bin of bins) {
    const gap = Math.abs(bin.accuracy - bin.meanConfidence);
    e += (bin.n / rows.length) * gap;
    if (gap > m) m = gap;
  }
  return { ece: e, mce: m, bins };
}

export function classCounts(y: number[], k: number): number[] {
  const c = new Array<number>(k).fill(0);
  for (const v of y) if (Number.isInteger(v) && v >= 0 && v < k) c[v]++;
  return c;
}

export function quantile(values: number[], p: number): number | null {
  if (!values.length || !values.every(finite)) return null;
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}
