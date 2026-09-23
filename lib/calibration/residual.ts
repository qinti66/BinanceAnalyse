import type { Bar } from "../structure/types.ts";
import { estimateBeta } from "../indicators/features/registry.ts";
import { residualTripleBarrier, type DirectionLabel } from "../indicators/labels.ts";

// One index of BTC's bars per array, built once: a run labels hundreds of thousands of samples and must not rebuild it for each.
const btcIndex = new WeakMap<Bar[], Map<number, number>>();
const indexOf = (btc: Bar[]): Map<number, number> => {
  let m = btcIndex.get(btc);
  if (!m) {
    m = new Map(btc.map((x, k) => [x.ct, k]));
    btcIndex.set(btc, m);
  }
  return m;
};
const BETA_WINDOW = 200; // bars handed to estimateBeta: it reads the last 169 of them

/**
 * The residual (BTC-beta-adjusted) label of the sample entered at bar `i`, for the skill check "does the model only predict the market?". Evaluation side only:
 * it is a LABEL, not a feature, and it never reaches a model. It uses the same beta as feature e1 (`estimateBeta`, the single implementation) and the same
 * barrier width k, cost and ATR as the plain label, on CLOSES only (BTC's highs and lows are not simultaneous with the coin's).
 * Null when anything is missing: beta not estimable, a BTC bar missing anywhere in the forward window, an invalid ATR, an incomplete window. No fill, no default class.
 */
export function residualLabelAt(o: {
  bars: Bar[];
  i: number;
  btc: Bar[];
  atr: (number | null)[];
  horizonBars: number;
  k: number;
  cost: number | null;
}): { label: DirectionLabel | null; reason: string | null } {
  const { bars, i, btc, atr, horizonBars } = o;
  if (i < 0 || i + horizonBars >= bars.length) return { label: null, reason: "forward window incomplete" };
  const a = atr[i];
  if (a === null || a === undefined || !(a > 0) || !(bars[i].c > 0)) return { label: null, reason: "ATR invalid at t" };
  const idx = indexOf(btc);
  const first = Math.max(0, i - BETA_WINDOW);
  const from = idx.get(bars[first].ct);
  const to = idx.get(bars[i].ct);
  // the beta window is the coin's last bars against BTC's bars over the same span; a BTC bar missing inside it is caught by estimateBeta
  const est = estimateBeta(bars.slice(first, i + 1), from === undefined || to === undefined ? [] : btc.slice(from, to + 1));
  if ("why" in est) return { label: null, reason: est.why };
  const coinCloses: number[] = [];
  const btcCloses: number[] = [];
  for (let j = i; j <= i + horizonBars; j++) {
    const k = idx.get(bars[j].ct);
    if (k === undefined) return { label: null, reason: "BTC bar missing in the forward window" };
    coinCloses.push(bars[j].c);
    btcCloses.push(btc[k].c);
  }
  const label = residualTripleBarrier({ coinCloses, btcCloses, t: 0, horizonBars, k: o.k, atrPct: a / bars[i].c, cost: o.cost, beta: est.beta });
  return label === null ? { label: null, reason: "residual label unavailable" } : { label, reason: null };
}

/**
 * Prior-shift adjustment: forecasts calibrated to one class mix, restated for another. The residual (BTC-beta-adjusted) labels are mostly flat (the market move is
 * removed), the plain labels are not, so forecasts calibrated to the plain mix are punished against the residual labels by the prior mismatch alone, whatever
 * skill they have. Each forecast is multiplied, class by class, by (target prior / source prior) and renormalised. NO new parameter: both priors are the class
 * frequencies of the TRAINING fold (source: plain labels, target: residual labels), so nothing from the test fold enters. A class with a source prior of 0 keeps
 * probability 0 (it cannot be revived). Forecasts that cannot be renormalised come back as null, never as a default.
 */
export function priorShift(probs: number[][], sourceRates: number[], targetRates: number[]): (number[] | null)[] {
  if (sourceRates.length !== targetRates.length) throw new Error("the two priors must have the same number of classes");
  const ratio = targetRates.map((t, c) => (sourceRates[c] > 0 ? t / sourceRates[c] : 0));
  return probs.map((p) => {
    if (p.length !== ratio.length) return null;
    const q = p.map((x, c) => x * ratio[c]);
    const z = q.reduce((a, b) => a + b, 0);
    return z > 0 && Number.isFinite(z) ? q.map((x) => x / z) : null;
  });
}
