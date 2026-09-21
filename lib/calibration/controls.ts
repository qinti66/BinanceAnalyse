import { baseRates, bss, quantile } from "./metrics.ts";
import { fitSoftmax, predictProba } from "./softmax.ts";

/**
 * The two controls that stop the pipeline from flattering itself:
 *  - random-feature baseline: how much BSS a model gets from features that carry no information. The real model must beat its
 *    95th percentile, so the bar comes from the data instead of a number someone picked.
 *  - shuffled-label control: with the labels permuted, the metric must collapse to that noise level. If it does not, the
 *    pipeline is leaking.
 */

/** Small deterministic PRNG (mulberry32) so every control reproduces exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function shuffled<T>(values: T[], seed: number): T[] {
  const out = [...values];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface RandomBaseline {
  n: number;
  bss: number[];
  mean: number;
  /** The bar: the 95th percentile of the BSS reached with information-free features. */
  p95: number;
}

/**
 * Train the same model on N draws of pure-noise features (same shape as the real matrix) and evaluate on noise test features.
 * `nFeatures` must equal the real model's feature count, otherwise the baseline understates the luck available to it.
 */
export function randomFeatureBaseline(o: {
  trainY: number[];
  testY: number[];
  k: number;
  nFeatures: number;
  l2: number;
  trainWeights?: ArrayLike<number>;
  testWeights?: ArrayLike<number>;
  draws?: number;
  seed?: number;
  maxIter?: number;
}): RandomBaseline | null {
  const draws = o.draws ?? 100;
  const rates = baseRates(o.trainY, o.k, o.trainWeights);
  if (!rates || !o.testY.length || o.nFeatures < 1) return null;
  const rand = mulberry32(o.seed ?? 1);
  const noise = (n: number) => Array.from({ length: n }, () => Array.from({ length: o.nFeatures }, () => gaussian(rand)));
  const scores: number[] = [];
  for (let d = 0; d < draws; d++) {
    const model = fitSoftmax(noise(o.trainY.length), o.trainY, o.k, { l2: o.l2, sampleWeights: o.trainWeights, maxIter: o.maxIter });
    const s = bss(predictProba(model, noise(o.testY.length)), o.testY, rates, o.testWeights);
    if (s !== null) scores.push(s);
  }
  const p95 = quantile(scores, 0.95);
  if (p95 === null) return null;
  return { n: scores.length, bss: scores, mean: scores.reduce((a, b) => a + b, 0) / scores.length, p95 };
}

/**
 * The label control that keeps the time structure and breaks only the link between features and labels. Within EACH group (a coin) the labels are rotated
 * along the time axis by an offset that is a quarter to three quarters of the group's length, so a sample keeps its features but gets the label of the same
 * coin at a different time. What is kept: the label multiset of every group, and the autocorrelation of the labels (neighbouring samples still get neighbouring
 * labels; only one seam per group breaks). What is broken: the feature-label alignment. Permuting the labels of the whole sample set instead destroys the
 * overlap structure of the labels, and a leak that lives in that structure would then look absent (a false negative).
 * `order` is each sample's rank in time within its group, from the samples' own times. Groups shorter than 8 samples are left in place and counted.
 */
export function blockShiftLabels<T>(samples: { group: string; time: number }[], labels: T[], seed: number): { labels: T[]; shifted: number; unshifted: number } {
  if (samples.length !== labels.length) throw new Error("samples and labels must line up");
  const rand = mulberry32(seed);
  const byGroup = new Map<string, number[]>();
  samples.forEach((s, i) => (byGroup.get(s.group) ?? byGroup.set(s.group, []).get(s.group)!).push(i));
  const out = labels.slice();
  let shifted = 0;
  let unshifted = 0;
  for (const idx of byGroup.values()) {
    idx.sort((a, b) => samples[a].time - samples[b].time);
    const n = idx.length;
    if (n < 8) {
      unshifted += n;
      continue;
    }
    const offset = Math.floor(n / 4 + rand() * (n / 2));
    for (let j = 0; j < n; j++) out[idx[j]] = labels[idx[(j + offset) % n]];
    shifted += n;
  }
  return { labels: out, shifted, unshifted };
}

export type LeakStatus = "clean" | "leak_suspected" | "inconclusive";

/**
 * Decision from the shuffled-label control. It is only informative when the real model beat the random-feature bar: with no
 * signal to destroy, shuffling proves nothing, so that case is "inconclusive" (and the gate treats it as not passing).
 */
export function leakCheck(o: { realBss: number | null; shuffledBss: number | null; randomP95: number | null }): { status: LeakStatus; reason: string } {
  const ok = (v: number | null): v is number => typeof v === "number" && Number.isFinite(v);
  if (!ok(o.realBss) || !ok(o.shuffledBss) || !ok(o.randomP95)) return { status: "inconclusive", reason: "a required value is missing" };
  if (!(o.realBss > o.randomP95)) return { status: "inconclusive", reason: "the real model does not beat the random-feature bar, so there is no signal for shuffling to destroy" };
  if (o.shuffledBss > o.randomP95) return { status: "leak_suspected", reason: "shuffled labels still score above the random-feature bar" };
  return { status: "clean", reason: "shuffling the labels drops the score to noise level" };
}
