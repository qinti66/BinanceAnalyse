import { analyzeStructure, type StructureParams } from "../../structure/analyze.ts";
import type { Bar } from "../../structure/types.ts";
import { contiguousTail, historyTooShort } from "./stats.ts";

/** Bars searched for a sweep. 4h uses 24 (same 0.286 share of its 84-bar lookback that 48 is of 168). */
export const SWEEP_WINDOW_1H = 48;
export const SWEEP_WINDOW_4H = 24;
export const SWEEP_DECAY = 0.97;

export interface StructureValue {
  value: number | null;
  reason: string | null;
}
export interface StructureFeatures {
  f1: StructureValue;
  /** 1 if f1 > 0, else 0. Missing exactly when f1 is missing. */
  f1Occurred: StructureValue;
  f2Up: StructureValue;
  f2Down: StructureValue;
  f3: StructureValue;
}

const val = (value: number): StructureValue => ({ value, reason: null });
const miss = (reason: string): StructureValue => ({ value: null, reason });

/**
 * F group on one timeframe. `bars` ends at the decision bar. Shares one ZigZag and one window between f1, f2 and f3.
 *
 * f1_sweep_reclaim — pure sweep, NOT multiplied by containment (that interaction is unmeasured; see the spec).
 *   A sweep is a bar in the sweep window (48 on 1h, 24 on 4h) whose low pierces the range bottom, which is the LOWEST swing low of
 *   the boundary cluster, while its close is back at or above it (same-bar reclaim, no extra untested parameter).
 *   Strength = depth/ATR × 0.97^(bars ago); f1 is the max, 0 if none.
 *   The bottom is the one known at the decision bar (confirmedIndex <= atIndex); the sweep itself has no confirmation lag.
 *   no_range ⇒ 0 (true: no boundary to sweep). unavailable (too few bars or invalid ATR) ⇒ missing.
 * f1_occurred — the indicator "a sweep happened" (f1 > 0). f1 is zero-inflated (a structural fact: most bars sweep nothing), so the
 *   model gets "did it happen" and "how deep" as two terms and no cut point is chosen for it. Same missing condition as f1.
 * f3_range_containment — share of lookback closes inside the range; no_range ⇒ 0, a real state at the "least range-like" end.
 * f2_up / f2_down — dummies for HH∧HL / LH∧LL over the last two confirmed swing highs and lows in the lookback window.
 *   Fewer than 4 confirmed swings ⇒ BOTH missing: their 0 ("no trend") would be false in a strong trend (R6). Deliberately
 *   asymmetric with f1/f3.
 */
export function structureFeatures(bars: Bar[], params: Readonly<StructureParams>, intervalMs: number, sweepWindow: number = SWEEP_WINDOW_1H): StructureFeatures {
  const need = params.rangeLookback + params.atrPeriod + 1;
  if (bars.length < need) {
    const short = miss(historyTooShort(bars.length, need, intervalMs));
    return { f1: short, f1Occurred: short, f2Up: short, f2Down: short, f3: short };
  }
  if (!contiguousTail(bars, need, intervalMs)) {
    const gap = miss("gap inside the structure window");
    return { f1: gap, f1Occurred: gap, f2Up: gap, f2Down: gap, f3: gap };
  }
  const i = bars.length - 1;
  const r = analyzeStructure(bars, i, params);

  let f1: StructureValue;
  let f3: StructureValue;
  if (r.rangeState === "unavailable") {
    f1 = miss(r.unavailable[0] ?? "range unavailable");
    f3 = f1;
  } else if (r.rangeState === "no_range") {
    f1 = val(0);
    f3 = val(0);
  } else {
    const m = r.findings[0].meta as { bottom: number; atr: number; containment: number };
    let best = 0;
    for (let j = Math.max(0, i - sweepWindow + 1); j <= i; j++) {
      if (bars[j].l < m.bottom && bars[j].c >= m.bottom) {
        const s = ((m.bottom - bars[j].l) / m.atr) * SWEEP_DECAY ** (i - j);
        if (s > best) best = s;
      }
    }
    f1 = val(best);
    f3 = val(m.containment);
  }

  let f2Up: StructureValue;
  let f2Down: StructureValue;
  if (r.confirmedSwingCount < 4) {
    f2Up = miss("fewer than 4 confirmed swings");
    f2Down = f2Up;
  } else {
    const highs = r.windowSwings.filter((s) => s.type === "high");
    const lows = r.windowSwings.filter((s) => s.type === "low");
    if (highs.length < 2 || lows.length < 2) {
      f2Up = miss("fewer than two swing highs or lows");
      f2Down = f2Up;
    } else {
      const [h1, h2] = highs.slice(-2);
      const [l1, l2] = lows.slice(-2);
      f2Up = val(h2.price > h1.price && l2.price > l1.price ? 1 : 0);
      f2Down = val(h2.price < h1.price && l2.price < l1.price ? 1 : 0);
    }
  }
  // Explicit missing check first: in JS `null > 0` is false, which would silently turn a missing f1 into 0.
  const f1Occurred = f1.value === null ? miss(f1.reason ?? "f1 missing") : val(f1.value > 0 ? 1 : 0);
  return { f1, f1Occurred, f2Up, f2Down, f3 };
}
