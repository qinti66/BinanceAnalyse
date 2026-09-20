import { atrSeries } from "./atr.ts";
import { clusterLevels } from "./levels.ts";
import { confirmedAt } from "./swings.ts";
import type { Bar, Finding, Swing } from "./types.ts";

export interface RangeMeta {
  top: number;
  bottom: number;
  mid: number;
  atr: number;
  heightAtr: number;
  /** Share (0–1) of closes in the lookback window that lie inside [bottom, top]. A feature, not a gate. */
  containment: number;
  topTouches: number;
  bottomTouches: number;
  swingCount: number;
}
export type Range = Finding<RangeMeta>;

export interface RangeOptions {
  /** Decision bar. Only swings confirmed by this bar and bars up to it are used. */
  atIndex: number;
  /** Window length in bars. Fewer bars than this before atIndex ⇒ unavailable (the window is never shortened). */
  lookback: number;
  /** Fewer confirmed swings than this in the window ⇒ no coherent boundary can exist (no_range, not unavailable). */
  minSwings: number;
  /** Clustering tolerance for equal highs / lows, in ATR units. */
  tolAtr: number;
  /** A boundary is a price level touched by at least this many swings. Structural: it defines what a "level" is. */
  minTouches: number;
  /** Safety valve against degenerate windows, not a discriminator. */
  maxHeightAtr: number;
  atrPeriod: number;
}

/**
 * range        — coherent boundaries were found (has_range = true)
 * no_range     — the data was sufficient to judge, and there is no coherent horizontal boundary pair.
 *                This is a real market state (e.g. drifting or trending), NOT "unknown".
 * unavailable  — the data was insufficient to judge (too few bars, or ATR invalid). The only state that means "missing".
 *
 * Why no_range maps to 0 for f1_sweep_reclaim and f3_range_containment (R6: would a 0 say the opposite of the truth?):
 *   f1 = 0 says "no sweep-and-reclaim happened" — true when there is no horizontal boundary to sweep.
 *   f3 = 0 says "price respects no horizontal level" — true, and it sits at the natural "least range-like" end of a
 *   continuous 0–1 scale (containment inside a real range was measured at 0.27–0.86, p10–p90).
 * This encodes an observed state where it naturally lies. It is NOT imputation; never replace it with a median or mean fill.
 * f2_trend_state is different: its 0 means "no clear trend", which would be false in a strong trend, so it stays missing
 * when fewer than 4 confirmed swings exist (see AnalyzeResult.confirmedSwingCount).
 */
export type RangeState = "range" | "no_range" | "unavailable";

export interface RangeDetection {
  state: RangeState;
  range: Range | null;
  /** Why the state is no_range / unavailable. Null when a range was found. */
  reason: string | null;
}

/**
 * Range from swing clustering: the top is the highest swing high of the best-supported cluster of swing highs, the bottom the
 * lowest swing low of the best-supported cluster of swing lows. Best-supported = most touches, ties → most recent. The boundary
 * is the cluster EXTREME, not its mean: with a mean, the members' own wicks fall below it by arithmetic, so ordinary bars would
 * look like sweeps. Stops rest beyond all known swings, so only a pierce beyond the extreme counts. Each side must have a
 * cluster with at least `minTouches` swings; there is no fallback to a lone extreme, because a boundary that was touched
 * once is not a level. Replaces the role a Chan "central pivot" would play, at a fraction of the cost.
 * Parameter values are frozen in STRUCTURE_PARAMS and are unvalidated heuristics (see calibration-log-v1.md T1).
 */
export function detectRangeDetailed(bars: Bar[], swings: Swing[], opts: RangeOptions): RangeDetection {
  const out = (state: RangeState, reason: string): RangeDetection => ({ state, range: null, reason });
  const { atIndex } = opts;
  if (atIndex < 0 || atIndex >= bars.length) return out("unavailable", "atIndex out of range");
  if (atIndex + 1 < opts.lookback) return out("unavailable", "fewer than " + opts.lookback + " bars before atIndex");
  const atr = atrSeries(bars, opts.atrPeriod)[atIndex];
  if (atr === null || atr === undefined || !(atr > 0)) return out("unavailable", "ATR unavailable at atIndex");
  const win = confirmedAt(swings, atIndex).filter((s) => s.index > atIndex - opts.lookback);
  // Bars and ATR are sufficient from here on, so everything below is a judgement about the market, not about the data.
  if (win.length < opts.minSwings) return out("no_range", "fewer than " + opts.minSwings + " confirmed swings in window");
  const highs = win.filter((s) => s.type === "high");
  const lows = win.filter((s) => s.type === "low");
  if (!highs.length || !lows.length) return out("no_range", "swings on only one side");
  const tol = opts.tolAtr * atr;
  const best = (side: Swing[], type: "high" | "low") => {
    const level = clusterLevels(side, { type, tol, minTouches: opts.minTouches }).sort((a, b) => b.touches - a.touches || b.lastIndex - a.lastIndex)[0];
    return level ? { price: type === "high" ? level.high : level.low, touches: level.touches } : null;
  };
  const top = best(highs, "high");
  const bottom = best(lows, "low");
  if (!top) return out("no_range", "no swing-high level with " + opts.minTouches + " touches");
  if (!bottom) return out("no_range", "no swing-low level with " + opts.minTouches + " touches");
  if (!(top.price > bottom.price)) return out("no_range", "top level not above bottom level");
  const height = top.price - bottom.price;
  if (height > opts.maxHeightAtr * atr) return out("no_range", "boundaries wider than " + opts.maxHeightAtr + " ATR");
  const closes = bars.slice(atIndex - opts.lookback + 1, atIndex + 1).map((b) => b.c);
  const containment = closes.filter((c) => c >= bottom.price && c <= top.price).length / closes.length;
  const startIndex = Math.min(...win.map((s) => s.index));
  const range: Range = {
    kind: "range",
    startIndex,
    endIndex: atIndex,
    startTime: bars[startIndex].t,
    endTime: bars[atIndex].ct,
    priceHigh: top.price,
    priceLow: bottom.price,
    confirmedIndex: Math.max(...win.map((s) => s.confirmedIndex)),
    strength: null,
    meta: {
      top: top.price,
      bottom: bottom.price,
      mid: (top.price + bottom.price) / 2,
      atr,
      heightAtr: height / atr,
      containment,
      topTouches: top.touches,
      bottomTouches: bottom.touches,
      swingCount: win.length,
    },
  };
  return { state: "range", range, reason: null };
}

export const detectRange = (bars: Bar[], swings: Swing[], opts: RangeOptions): Range | null => detectRangeDetailed(bars, swings, opts).range;
