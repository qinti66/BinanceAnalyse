import { detectRangeDetailed, type RangeState } from "./ranges.ts";
import { confirmedAt, zigzag } from "./swings.ts";
import type { Bar, StructureResult, Swing } from "./types.ts";

export const STRUCTURE_VERSION = "structure-v1";

/**
 * Frozen. Values come from the old-window measurement in docs/calibration-log-v1.md (T1) and the architect's ruling in
 * docs/feature-spec-v1.md. Changing any value means a new version. All are unvalidated heuristics.
 * rangeLookback was not scanned in T1 and is the least-supported of the set; keep it on the sensitivity-check list.
 */
export type StructureParams = {
  swingMode: string;
  atrPeriod: number;
  zigzagAtrMult: number;
  rangeLookback: number;
  rangeMinSwings: number;
  rangeTolAtr: number;
  rangeMinTouches: number;
  rangeMaxHeightAtr: number;
};
export const STRUCTURE_PARAMS: Readonly<StructureParams> = {
  swingMode: "zigzag-atr",
  atrPeriod: 14,
  zigzagAtrMult: 2,
  rangeLookback: 168,
  rangeMinSwings: 4,
  rangeTolAtr: 0.5,
  rangeMinTouches: 2,
  rangeMaxHeightAtr: 25,
};
/** 4h uses the same ATR-relative mult/tol; only the lookback differs (84 bars of 4h = 14 days). Untested on 4h, see the log. */
export const STRUCTURE_PARAMS_4H: Readonly<StructureParams> = { ...STRUCTURE_PARAMS, rangeLookback: 84 };

export interface AnalyzeResult extends StructureResult {
  /**
   * range       — has_range: a range finding is present
   * no_range    — data sufficed and there is no coherent range: a real state, f1 = f3 = 0, NOT missing
   * unavailable — too few bars or invalid ATR: the only state that is missing (also listed in `unavailable`)
   */
  rangeState: RangeState;
  /**
   * Confirmed swings inside the lookback window. f2_trend_state needs >= 4 of them and is MISSING otherwise, because its 0
   * ("no clear trend") would be false in a strong trend. That is deliberately asymmetric with f1/f3; do not unify them.
   */
  confirmedSwingCount: number;
  /** The confirmed swings inside the lookback window, oldest first. Input for f2_up / f2_down. */
  windowSwings: Swing[];
}

/**
 * Structure snapshot as of bar `atIndex`. Reads bars[0..atIndex] only: swings are computed over the series but
 * consumed through `confirmedAt`, ATR is a trailing statistic. Callers must not treat a bar after atIndex as known.
 * Bars after atIndex are ignored, so the result is identical for a series cut at atIndex.
 */
export function analyzeStructure(bars: Bar[], atIndex: number, params: Readonly<StructureParams> = STRUCTURE_PARAMS): AnalyzeResult {
  const unavailable: string[] = [];
  const findings = [];
  const seen = bars.slice(0, atIndex + 1);
  const finite = seen.filter((b) => Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c)).length;
  const swings = confirmedAt(zigzag(bars, { mode: "atr", mult: params.zigzagAtrMult, atrPeriod: params.atrPeriod }), atIndex);
  const windowSwings = swings.filter((s) => s.index > atIndex - params.rangeLookback);
  const { state, range, reason } = detectRangeDetailed(bars, swings, {
    atIndex,
    lookback: params.rangeLookback,
    minSwings: params.rangeMinSwings,
    tolAtr: params.rangeTolAtr,
    minTouches: params.rangeMinTouches,
    maxHeightAtr: params.rangeMaxHeightAtr,
    atrPeriod: params.atrPeriod,
  });
  if (range) findings.push(range);
  else if (state === "unavailable") unavailable.push("range: " + reason);
  return {
    version: STRUCTURE_VERSION,
    params,
    findings,
    coverage: seen.length ? finite / seen.length : 0,
    unavailable,
    rangeState: state,
    confirmedSwingCount: windowSwings.length,
    windowSwings,
  };
}
