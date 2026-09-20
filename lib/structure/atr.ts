import type { Bar } from "./types.ts";

/**
 * True range, identical to the definition in `contractMetrics`:
 * max(h-l, |h-prevClose|, |l-prevClose|), and h-l for the first bar.
 * A bar with a non-finite high/low/close yields NaN (missing stays missing).
 */
export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) =>
    i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)),
  );
}

/**
 * ATR as the simple mean of the last `period` true ranges — the same smoothing `contractMetrics` uses,
 * not Wilder's. The first `period-1` entries are null, and so is any window that contains a NaN.
 * Entry i only depends on bars[0..i].
 */
export function atrSeries(bars: Bar[], period = 14): (number | null)[] {
  const tr = trueRange(bars);
  return tr.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (!Number.isFinite(tr[j])) return null;
      sum += tr[j];
    }
    return sum / period;
  });
}
