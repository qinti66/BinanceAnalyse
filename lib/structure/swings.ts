import { atrSeries } from "./atr.ts";
import type { Bar, Swing } from "./types.ts";

const finiteBar = (b: Bar) => Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c);

/** Swings that were already knowable at `atIndex`. The only safe way to consume swings at a point in time. */
export const confirmedAt = (swings: Swing[], atIndex: number): Swing[] => swings.filter((s) => s.confirmedIndex <= atIndex);

/**
 * Williams k-bar fractals: a swing high is a bar whose high is strictly above the highs of the k bars on each side
 * (swing low mirrors). Equal neighbours disqualify the bar. A window containing a non-finite bar yields no swing.
 * The swing at i is only knowable once bar i+k has closed, so confirmedIndex = i+k; the last k bars never qualify.
 */
export function fractals(bars: Bar[], k = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i + k < bars.length; i++) {
    let ok = true;
    let high = true;
    let low = true;
    for (let j = i - k; j <= i + k && ok; j++) {
      if (!finiteBar(bars[j])) ok = false;
      else if (j !== i) {
        if (bars[j].h >= bars[i].h) high = false;
        if (bars[j].l <= bars[i].l) low = false;
      }
    }
    if (!ok) continue;
    if (high) out.push({ index: i, time: bars[i].t, price: bars[i].h, type: "high", confirmedIndex: i + k });
    if (low) out.push({ index: i, time: bars[i].t, price: bars[i].l, type: "low", confirmedIndex: i + k });
  }
  return out;
}

export interface ZigzagOptions {
  mode: "atr" | "pct";
  /** atr mode: reversal threshold in ATR units (ATR at the confirming bar, so it adapts bar by bar). */
  mult?: number;
  /** pct mode: reversal threshold as a percentage of the extreme price. */
  pct?: number;
  atrPeriod?: number;
}

/**
 * Online ZigZag. A pivot is emitted only when price has reversed by the threshold from the running extreme,
 * at which point confirmedIndex is that bar. The current leg is never emitted, so the last (unconfirmed) segment
 * is excluded by construction. Bars are processed strictly in order, so output for bars[0..n] is a prefix of
 * the output for a longer series. A bar that both extends the extreme and reverses is treated as an extension.
 * Bars with non-finite high/low/close are skipped. An unknown ATR blocks reversal checks, never fakes one.
 */
export function zigzag(bars: Bar[], opts: ZigzagOptions): Swing[] {
  const atr = opts.mode === "atr" ? atrSeries(bars, opts.atrPeriod ?? 14) : [];
  const threshold = (j: number, extreme: number): number | null => {
    if (opts.mode === "atr") {
      const a = atr[j];
      return a === null || opts.mult === undefined ? null : opts.mult * a;
    }
    return opts.pct === undefined ? null : (opts.pct / 100) * extreme;
  };
  const out: Swing[] = [];
  let dir: 0 | 1 | -1 = 0;
  let hi = -1;
  let lo = -1;
  const push = (index: number, type: "high" | "low", price: number, confirmedIndex: number) =>
    out.push({ index, time: bars[index].t, price, type, confirmedIndex });
  for (let j = 0; j < bars.length; j++) {
    const b = bars[j];
    if (!finiteBar(b)) continue;
    if (dir === 0) {
      if (hi < 0 || b.h > bars[hi].h) hi = j;
      if (lo < 0 || b.l < bars[lo].l) lo = j;
      // Test the reversal away from whichever extreme is more recent.
      if (lo > hi) {
        const t = threshold(j, bars[lo].l);
        if (t !== null && j > lo && b.h - bars[lo].l >= t) {
          push(lo, "low", bars[lo].l, j);
          dir = 1;
          hi = j;
        }
      } else if (hi > lo) {
        const t = threshold(j, bars[hi].h);
        if (t !== null && j > hi && bars[hi].h - b.l >= t) {
          push(hi, "high", bars[hi].h, j);
          dir = -1;
          lo = j;
        }
      }
    } else if (dir === 1) {
      if (b.h > bars[hi].h) hi = j;
      else {
        const t = threshold(j, bars[hi].h);
        if (t !== null && bars[hi].h - b.l >= t) {
          push(hi, "high", bars[hi].h, j);
          dir = -1;
          lo = j;
        }
      }
    } else {
      if (b.l < bars[lo].l) lo = j;
      else {
        const t = threshold(j, bars[lo].l);
        if (t !== null && b.h - bars[lo].l >= t) {
          push(lo, "low", bars[lo].l, j);
          dir = 1;
          hi = j;
        }
      }
    }
  }
  return out;
}
