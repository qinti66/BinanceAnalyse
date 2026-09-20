import type { Bar } from "../../structure/types.ts";
import type { FundingRow } from "./funding.ts";
import { contiguousTail, emaValue, lastIndexClosedBy } from "./stats.ts";

export const HOUR_MS = 3600000;

/** Breadth uses a fixed trailing window so the EMA seed is identical wherever it is computed. */
export const BREADTH_WINDOW = 360;
export const BREADTH_EMA_PERIOD = 60;

/** Cross-section at one decision time (the closeTime of the 1h bar). Built by `buildCrossSection`, the one shared implementation. */
export interface CrossSection {
  time: number;
  /** 24h return in percent of every coin that has it at `time`, the scored coin included. */
  ret24h: number[];
  /** Coins whose close is above their own EMA60 at `time`. */
  breadthAbove: number;
  /** Coins with enough history for an EMA60. Coins without it are in neither count. */
  breadthValid: number;
}

/**
 * Everything a coin's feature vector needs beyond its own 1h bars. Each series may extend past the decision time;
 * `buildFeatureVector` cuts them at the decision bar's closeTime, so no caller discipline is needed for R1.
 */
export interface FeatureContext {
  /** The same coin's 4h bars, oldest first. */
  bars4h: Bar[] | null;
  /** BTC 1h bars: at least 169 through the decision time for beta and its 24h return. */
  btcBars: Bar[] | null;
  /** BTC 1h bars deep enough for a 1-year volatility distribution (>= 9457 bars). Must be refreshed every run. */
  btcLongBars: Bar[] | null;
  cross: CrossSection | null;
  /** This coin's settlement history from /fapi/v1/fundingRate. */
  funding: FundingRow[] | null;
  isPerpetual: boolean;
}

/** 24h return in percent at index j, requiring the bar 24h earlier to exist exactly. Null otherwise. */
export function ret24hPct(bars: Bar[], j: number): number | null {
  if (j < 24 || j >= bars.length) return null;
  const now = bars[j];
  const then = bars[j - 24];
  if (now.ct - then.ct !== 24 * HOUR_MS || !(then.c > 0)) return null;
  return (now.c / then.c - 1) * 100;
}

/**
 * Cross-section at closeTime `ct` over a universe of 1h bar arrays. The single implementation for training and live.
 * A coin contributes a return only if it has a bar closing at exactly `ct` and one 24h earlier, and contributes to breadth
 * only if it has 360 contiguous bars ending at `ct` (so its EMA60 is seeded the same way everywhere).
 */
export function buildCrossSection(universe: Bar[][], ct: number): CrossSection {
  const ret24h: number[] = [];
  let above = 0;
  let valid = 0;
  for (const bars of universe) {
    const j = lastIndexClosedBy(bars, ct);
    if (j < 0 || bars[j].ct !== ct) continue;
    const r = ret24hPct(bars, j);
    if (r !== null) ret24h.push(r);
    const upto = bars.slice(0, j + 1);
    if (contiguousTail(upto, BREADTH_WINDOW, HOUR_MS)) {
      const closes = upto.slice(-BREADTH_WINDOW).map((b) => b.c);
      const ema = emaValue(closes, BREADTH_EMA_PERIOD);
      if (ema !== null) {
        valid++;
        if (closes[closes.length - 1] > ema) above++;
      }
    }
  }
  return { time: ct, ret24h, breadthAbove: above, breadthValid: valid };
}
