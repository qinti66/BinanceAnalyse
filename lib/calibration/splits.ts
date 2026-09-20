/**
 * Purged walk-forward splits with an embargo, by TIME (never by coin: different coins at the same hour are highly correlated,
 * so splitting by coin would put the same information in both train and test).
 */

/** W1 (2025-09-01 → 2025-12-01) was spent choosing the range parameters. No test fold may start before its end. */
export const MIN_TEST_START_MS = Date.UTC(2025, 11, 1);

/** The label of a sample looks forward `horizon` bars, so a fold gap must cover that plus a day. */
export const embargoBars = (horizonBars: number): number => horizonBars + 24;

export interface SampleSpan {
  /** Series the sample belongs to (a symbol). Label overlap is only shared within a group. */
  group: string;
  /** Decision time (closeTime of the entry bar), ms. */
  time: number;
  /** Time of the last bar the label used, ms. */
  endTime: number;
}

export interface Fold {
  index: number;
  testStart: number;
  testEnd: number;
  trainIdx: number[];
  testIdx: number[];
  /** Train candidates removed because their label window reaches into the embargo zone before the test block. */
  purged: number;
}

export interface FoldOptions {
  nFolds: number;
  horizonBars: number;
  barMs: number;
  /** The evaluation period [testStart, testEnd) split into nFolds equal blocks. */
  testStart: number;
  testEnd: number;
  minTestStart?: number;
}

/**
 * Fold k tests the block [a, b) and trains on every sample whose LABEL had ended at least `embargo` before a:
 *   train = { endTime <= a − embargoBars × barMs }.
 * This purges any sample whose label window overlaps the test block and adds the embargo gap in one rule. Training is expanding.
 * Throws if the first test block would start before MIN_TEST_START_MS (fail closed: a leaked window must not run).
 */
export function walkForwardFolds(samples: SampleSpan[], o: FoldOptions): Fold[] {
  const floor = o.minTestStart ?? MIN_TEST_START_MS;
  if (!(o.nFolds >= 1) || !Number.isInteger(o.nFolds)) throw new Error("nFolds must be a positive integer");
  if (!(o.testEnd > o.testStart)) throw new Error("empty test period");
  if (o.testStart < floor) throw new Error("test period starts before the consumed window ends (" + new Date(floor).toISOString() + ")");
  const gap = embargoBars(o.horizonBars) * o.barMs;
  const width = (o.testEnd - o.testStart) / o.nFolds;
  const folds: Fold[] = [];
  for (let k = 0; k < o.nFolds; k++) {
    const a = o.testStart + k * width;
    const b = k === o.nFolds - 1 ? o.testEnd : o.testStart + (k + 1) * width;
    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    let purged = 0;
    samples.forEach((s, i) => {
      if (s.time >= a && s.time < b) testIdx.push(i);
      else if (s.endTime <= a - gap) trainIdx.push(i);
      else if (s.time < a) purged++;
    });
    folds.push({ index: k, testStart: a, testEnd: b, trainIdx, testIdx, purged });
  }
  return folds;
}

/** Independent check of the split invariants. Returns the list of violations (empty when sound). */
export function foldViolations(samples: SampleSpan[], f: Fold, o: { horizonBars: number; barMs: number }): string[] {
  const gap = embargoBars(o.horizonBars) * o.barMs;
  const bad: string[] = [];
  for (const i of f.trainIdx) if (!(samples[i].endTime <= f.testStart - gap)) bad.push("train sample " + i + " label reaches into the embargo or the test block");
  for (const i of f.testIdx) if (!(samples[i].time >= f.testStart && samples[i].time < f.testEnd)) bad.push("test sample " + i + " lies outside its block");
  const train = new Set(f.trainIdx);
  for (const i of f.testIdx) if (train.has(i)) bad.push("sample " + i + " is in both train and test");
  return bad;
}

/**
 * Average uniqueness of each sample's label window (López de Prado): for each hour slot in the window, 1 / (number of samples of
 * the same group whose window covers that slot), averaged over the window. A sample that shares its window with 23 neighbours
 * carries about 1/24 of an independent observation. Sum of the weights ≈ the effective number of independent samples.
 */
export function uniquenessWeights(samples: SampleSpan[], barMs: number): Float64Array {
  const out = new Float64Array(samples.length);
  const byGroup = new Map<string, number[]>();
  samples.forEach((s, i) => {
    const g = byGroup.get(s.group);
    if (g) g.push(i);
    else byGroup.set(s.group, [i]);
  });
  for (const idxs of byGroup.values()) {
    const start = idxs.map((i) => Math.floor(samples[i].time / barMs));
    const end = idxs.map((i) => Math.floor(samples[i].endTime / barMs));
    const lo = Math.min(...start);
    const hi = Math.max(...end);
    const diff = new Float64Array(hi - lo + 2);
    idxs.forEach((_, n) => {
      diff[start[n] - lo] += 1;
      diff[end[n] - lo + 1] -= 1;
    });
    const conc = new Float64Array(hi - lo + 1);
    let run = 0;
    for (let s = 0; s <= hi - lo; s++) {
      run += diff[s];
      conc[s] = run;
    }
    idxs.forEach((i, n) => {
      let sum = 0;
      for (let s = start[n] - lo; s <= end[n] - lo; s++) sum += 1 / conc[s];
      out[i] = sum / (end[n] - start[n] + 1);
    });
  }
  return out;
}

/** Effective sample size: the sum of uniqueness weights (≈ independent observations). */
export const effectiveN = (weights: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < weights.length; i++) s += weights[i];
  return s;
};
