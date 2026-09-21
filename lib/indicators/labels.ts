import type { Bar } from "../structure/types.ts";

/**
 * Direction labels by the triple-barrier method. The ONE label implementation: training and forward scoring both call it.
 * Nothing here is validated against outcomes. k is set by the class-share rule (LABEL_K_BASE / labelK); the cost inputs are assumptions,
 * see SLIPPAGE_ROUND_TRIP_ASSUMED.
 */

export type DirectionLabel = "down" | "flat" | "up";
/** Class order used for probability vectors and counts everywhere in calibration. */
export const DIRECTION_CLASSES: readonly DirectionLabel[] = ["down", "flat", "up"];
export const classIndex = (l: DirectionLabel): number => DIRECTION_CLASSES.indexOf(l);

/** Prediction horizons in 1h bars: the 4h head and the 24h head. */
export const LABEL_HORIZONS_BARS = [4, 24] as const;

/**
 * Barrier width in ATR units, by horizon: k_h = LABEL_K_BASE × √(h / 4).
 * The barriers are set from the 1h ATR, so a 24-bar window naturally travels much further than one 1h ATR; a single k cannot serve
 * both heads (measured: k = 1.0 leaves 24h "flat" at 1.3%). √ scaling is one parameter plus a rule, instead of a free k per head.
 * LABEL_K_BASE = 1.0 is a MEASURED-ADEQUATE value, not an optimum: on the 4h head 0.5 (flat 7%) and 1.5 (flat 63%) fail the
 * 15%–60% class-share rule and 1.0 is the only tested value that passes. The class shares at k_24 = √6 were run, not interpolated
 * (calibration-log-v1.md T7/T8). We look for a k that is adequate and not fished, not the best one.
 */
export const LABEL_K_BASE = 1.0;
export const LABEL_K_CALIBRATED = true;
export const labelK = (horizonBars: number): number => LABEL_K_BASE * Math.sqrt(horizonBars / 4);

export const TAKER_FEE = 0.0005; // 0.05% per side

/**
 * Slippage assumption, ROUND TRIP: 0.05% per side. Nothing measurable exists (no fills, no historical order book), so this is a
 * deliberately conservative guess: when a number must be guessed, guess against yourself. Total round-trip cost = 2 × taker fee +
 * spread + this = 0.20% + spread. Sensitivity to be reported at 0.02% / 0.05% / 0.10% per side.
 * Known biases, in opposite directions and not claimed to cancel: this slippage is PESSIMISTIC; the spread proxy used for history
 * (each coin's current spread) is OPTIMISTIC, because past liquidity was usually worse.
 */
export const SLIPPAGE_ROUND_TRIP_ASSUMED = 0.001;
export const SLIPPAGE_SENSITIVITY_ROUND_TRIP = [0.0004, 0.001, 0.002] as const;

const HOUR_MS = 3600000;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Net round-trip cost as a fraction: 2 × taker fee + measured spread + slippage estimate. Any missing component ⇒ null
 * (a missing cost is not a zero cost). Labels without a cost describe gross moves nobody can trade.
 */
export function roundTripCost(o: { spreadBps: number | null; slippagePct: number | null; takerFee?: number }): number | null {
  const fee = o.takerFee ?? TAKER_FEE;
  if (!finite(o.spreadBps) || o.spreadBps < 0 || !finite(o.slippagePct) || o.slippagePct < 0 || !(fee >= 0)) return null;
  return 2 * fee + o.spreadBps / 10000 + o.slippagePct;
}

export interface TripleBarrierOptions {
  horizonBars: number;
  /** Barrier width in ATR% units. */
  k: number;
  /** Net round-trip cost (fraction), from `roundTripCost`. Null ⇒ the label is null. */
  cost: number | null;
  /**
   * Both barriers inside one bar cannot be ordered without tick data. "down" (default) treats it as the unfavourable outcome;
   * "flat" refuses to guess. "down" is asymmetric between classes: check its frequency before trusting it.
   */
  sameBar?: "down" | "flat";
  /**
   * The settlement time (ms) of a contract that has been SETTLED, from its real deliveryDate; null or absent for every other contract.
   * PRE-REGISTERED RULE (architect, calibration-log T30; not one word of it may change without a new registration):
   *   If the contract has a REAL deliveryDate and t + horizon runs past the settlement time, the settlement time acts as a barrier that arrives EARLY:
   *   1. the barriers are checked as usual over the bars from t+1 to the settlement time;
   *   2. the first barrier touched decides the label (up or down), exactly as an ordinary label;
   *   3. reaching the settlement time with no barrier touched is flat.
   *   k, cost, ATR and the same-bar rule are the ordinary ones: NO new parameter.
   * Why it is not a patch: for a live contract an incomplete forward window means the data has not been produced yet, so the outcome is UNKNOWN and the label
   * is null. For a settled contract the outcome is KNOWN (the position is closed at the settlement price). A contract with no real deliveryDate (gone from
   * exchangeInfo) never gets this rule: its end is inferred, and an inferred end may truncate data but may not assert an outcome.
   * Applies only when the bars really do end at the settlement (the last bar opens before it and reaches it); otherwise the window is incomplete as ever.
   */
  settlementMs?: number | null;
}

export interface LabelResult {
  label: DirectionLabel | null;
  reason: string | null;
  /** Index of the last bar whose data the label used: t + horizon. Needed to purge overlapping samples. */
  endIndex: number | null;
  /** Bar index where a barrier was touched, if any. */
  touchIndex: number | null;
  ambiguous: boolean;
  /** True when the forward window was cut short by the settlement time (see TripleBarrierOptions.settlementMs): reported separately, never mixed into the ordinary distribution. */
  settled: boolean;
}

const none = (reason: string): LabelResult => ({ label: null, reason, endIndex: null, touchIndex: null, ambiguous: false, settled: false });

/**
 * Entry at the close of bar t. Barriers: entry × (1 ± (k·ATR% + cost)). The first bar in t+1..t+horizon whose high reaches the upper
 * barrier or whose low reaches the lower one decides the label; neither within the horizon ⇒ flat. The ATR is the one known at t.
 * An incomplete forward window, a gap, an invalid ATR or a missing cost ⇒ null, never a default class.
 * `atr` is the ATR series of the same bars (atrSeries), passed in so it is computed once per series.
 */
export function tripleBarrier(bars: Bar[], t: number, atr: (number | null)[], o: TripleBarrierOptions): LabelResult {
  if (!Number.isInteger(t) || t < 0 || t >= bars.length) return none("t out of range");
  let end = t + o.horizonBars;
  let settled = false;
  if (end >= bars.length) {
    // The window runs past the last bar. For an ordinary contract that is an unknown future: null. For a settled contract whose bars end AT the settlement it is
    // a window cut short by the settlement: the barriers are checked to the end of the data, and no touch means flat.
    const last = bars.length - 1;
    const s = o.settlementMs;
    const endsAtSettlement = typeof s === "number" && Number.isFinite(s) && bars[last].t < s && bars[last].t + HOUR_MS >= s;
    if (!endsAtSettlement) return none("forward window incomplete");
    if (t >= last) return none("no bar after the entry before the settlement");
    end = last;
    settled = true;
  }
  if (!finite(o.cost) || o.cost < 0) return none("cost missing");
  const a = atr[t];
  const entry = bars[t].c;
  if (a === null || a === undefined || !(a > 0) || !(entry > 0)) return none("ATR invalid at t");
  const width = o.k * (a / entry) + o.cost;
  const up = entry * (1 + width);
  const down = entry * (1 - width);
  for (let j = t + 1; j <= end; j++) {
    const b = bars[j];
    if (b.t - bars[j - 1].t !== HOUR_MS) return none("gap inside the forward window");
    if (!finite(b.h) || !finite(b.l)) return none("high/low missing in the forward window");
    const hitUp = b.h >= up;
    const hitDown = b.l <= down;
    if (hitUp && hitDown) {
      const policy = o.sameBar ?? "down";
      return { label: policy === "down" ? "down" : "flat", reason: null, endIndex: end, touchIndex: j, ambiguous: true, settled };
    }
    if (hitUp) return { label: "up", reason: null, endIndex: end, touchIndex: j, ambiguous: false, settled };
    if (hitDown) return { label: "down", reason: null, endIndex: end, touchIndex: j, ambiguous: false, settled };
  }
  return { label: "flat", reason: null, endIndex: end, touchIndex: null, ambiguous: false, settled };
}

/** The class distribution of ordinary labels and of settlement-cut labels, SIDE BY SIDE: a difference between the two is a fact to know, not to average away. */
export function splitBySettlement(results: LabelResult[]): { ordinary: LabelDistribution; settled: LabelDistribution } {
  return {
    ordinary: labelDistribution(results.filter((r) => !r.settled).map((r) => r.label)),
    settled: labelDistribution(results.filter((r) => r.settled).map((r) => r.label)),
  };
}

export interface LabelDistribution {
  n: number;
  nNull: number;
  counts: Record<DirectionLabel, number>;
  shares: Record<DirectionLabel, number>;
}

export function labelDistribution(labels: (DirectionLabel | null)[]): LabelDistribution {
  const counts: Record<DirectionLabel, number> = { down: 0, flat: 0, up: 0 };
  let nNull = 0;
  for (const l of labels) {
    if (l === null) nNull++;
    else counts[l]++;
  }
  const n = labels.length - nNull;
  const share = (c: number) => (n ? c / n : 0);
  return { n, nNull, counts, shares: { down: share(counts.down), flat: share(counts.flat), up: share(counts.up) } };
}

/** The rule for setting k: a class under 15% or over 60% means k is wrong. An empty distribution is never "ok". */
export function kDiagnosis(d: LabelDistribution): { ok: boolean; offenders: { label: DirectionLabel; share: number; problem: "under 15%" | "over 60%" }[] } {
  const offenders: { label: DirectionLabel; share: number; problem: "under 15%" | "over 60%" }[] = [];
  if (!d.n) return { ok: false, offenders };
  for (const l of DIRECTION_CLASSES) {
    if (d.shares[l] < 0.15) offenders.push({ label: l, share: d.shares[l], problem: "under 15%" });
    else if (d.shares[l] > 0.6) offenders.push({ label: l, share: d.shares[l], problem: "over 60%" });
  }
  return { ok: offenders.length === 0, offenders };
}

/**
 * The same barrier logic on the BTC-beta-adjusted path, for the residual skill check: if a model only predicts the market it
 * has no skill against these labels. Closes only (BTC highs and lows are not simultaneous with the coin's), so a barrier is
 * touched when a CLOSE crosses it. `beta` is the coin's estimated beta to BTC at t.
 */
export function residualTripleBarrier(o: { coinCloses: number[]; btcCloses: number[]; t: number; horizonBars: number; k: number; atrPct: number; cost: number | null; beta: number }): DirectionLabel | null {
  const { coinCloses: c, btcCloses: b, t, horizonBars } = o;
  if (!finite(o.cost) || o.cost < 0 || !(o.atrPct > 0) || !finite(o.beta)) return null;
  if (c.length !== b.length || t < 0 || t + horizonBars >= c.length || !(c[t] > 0) || !(b[t] > 0)) return null;
  const width = o.k * o.atrPct + o.cost;
  for (let j = t + 1; j <= t + horizonBars; j++) {
    if (!(c[j] > 0) || !(b[j] > 0)) return null;
    const path = (c[j] / c[t] - 1) - o.beta * (b[j] / b[t] - 1);
    if (path >= width) return "up";
    if (path <= -width) return "down";
  }
  return "flat";
}
