/**
 * L2-regularised multinomial logistic regression. Deliberately small and dependency-free: with a few thousand effective samples and
 * at most 30 features a linear model is what the data can support, and its coefficients are a small JSON that can live in git.
 * Rows must be complete: a linear model cannot skip a missing feature, so a NaN is an error, not something to impute (R3).
 */

export interface SoftmaxModel {
  k: number;
  mean: number[];
  sd: number[];
  /** (p + 1) × k, bias in the last row. */
  weights: number[][];
}

export interface FitOptions {
  l2: number;
  sampleWeights?: ArrayLike<number>;
  maxIter?: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function softmaxRow(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

function standardise(x: number[][], mean: number[], sd: number[]): number[][] {
  return x.map((row) => [...row.map((v, j) => (v - mean[j]) / sd[j]), 1]);
}

function assertComplete(x: number[][]): void {
  for (const row of x) for (const v of row) if (!finite(v)) throw new Error("incomplete feature row: a missing value cannot be fed to the model");
}

/** Weighted negative log-likelihood plus L2 on the non-bias weights, and its gradient. */
function lossAndGrad(z: number[][], y: number[], w: number[], total: number, W: number[][], k: number, l2: number): { loss: number; grad: number[][] } {
  const p = z[0].length;
  const grad = Array.from({ length: p }, () => new Array<number>(k).fill(0));
  let loss = 0;
  for (let i = 0; i < z.length; i++) {
    const logits = new Array<number>(k).fill(0);
    for (let c = 0; c < k; c++) for (let j = 0; j < p; j++) logits[c] += z[i][j] * W[j][c];
    const pr = softmaxRow(logits);
    loss -= (w[i] / total) * Math.log(Math.max(pr[y[i]], 1e-300));
    for (let c = 0; c < k; c++) {
      const d = ((w[i] / total) * (pr[c] - (y[i] === c ? 1 : 0)));
      for (let j = 0; j < p; j++) grad[j][c] += d * z[i][j];
    }
  }
  for (let j = 0; j < p - 1; j++) for (let c = 0; c < k; c++) {
    loss += 0.5 * l2 * W[j][c] ** 2;
    grad[j][c] += l2 * W[j][c];
  }
  return { loss, grad };
}

export function fitSoftmax(x: number[][], y: number[], k: number, o: FitOptions): SoftmaxModel {
  if (!x.length || x.length !== y.length) throw new Error("x and y must be non-empty and the same length");
  if (!(o.l2 >= 0)) throw new Error("l2 must be non-negative");
  assertComplete(x);
  for (const v of y) if (!Number.isInteger(v) || v < 0 || v >= k) throw new Error("label out of range");
  const n = x.length;
  const p = x[0].length;
  const w = Array.from({ length: n }, (_, i) => (o.sampleWeights ? o.sampleWeights[i] : 1));
  if (w.some((v) => !finite(v) || v < 0)) throw new Error("invalid sample weight");
  const total = w.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error("sample weights sum to zero");
  const mean = new Array<number>(p).fill(0);
  const sd = new Array<number>(p).fill(1);
  for (let j = 0; j < p; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += (w[i] / total) * x[i][j];
    let v = 0;
    for (let i = 0; i < n; i++) v += (w[i] / total) * (x[i][j] - m) ** 2;
    mean[j] = m;
    sd[j] = v > 1e-24 ? Math.sqrt(v) : 1;
  }
  const z = standardise(x, mean, sd);
  let W = Array.from({ length: p + 1 }, () => new Array<number>(k).fill(0));
  let { loss, grad } = lossAndGrad(z, y, w, total, W, k, o.l2);
  let step = 1;
  for (let it = 0; it < (o.maxIter ?? 200); it++) {
    const g2 = grad.reduce((a, r) => a + r.reduce((b, v) => b + v * v, 0), 0);
    if (g2 < 1e-14) break;
    let accepted = false;
    for (let tries = 0; tries < 30; tries++) {
      const cand = W.map((r, j) => r.map((v, c) => v - step * grad[j][c]));
      const next = lossAndGrad(z, y, w, total, cand, k, o.l2);
      if (next.loss <= loss - 1e-4 * step * g2) {
        W = cand;
        loss = next.loss;
        grad = next.grad;
        step *= 1.5;
        accepted = true;
        break;
      }
      step *= 0.5;
    }
    if (!accepted) break;
  }
  return { k, mean, sd, weights: W };
}

/** Class probabilities for complete rows. Each row sums to 1. */
export function predictProba(model: SoftmaxModel, x: number[][]): number[][] {
  assertComplete(x);
  const z = standardise(x, model.mean, model.sd);
  return z.map((row) => softmaxRow(Array.from({ length: model.k }, (_, c) => row.reduce((a, v, j) => a + v * model.weights[j][c], 0))));
}
