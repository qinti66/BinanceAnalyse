import { finite, iqr, median } from "./stats.ts";

export const HOUR = 3600000;
export const DAY = 24 * HOUR;

/**
 * Lower bound on the scale of the funding z-score, in percent per day (the fundingDaily unit). MEASURED, not chosen:
 * the p10 of the non-zero trailing-30-day funding IQRs over W1 (308 perpetuals, 112,112 points; calibration-log-v1.md T9/T10).
 *
 * What the floor is for: it stops a division by ~0 for the 36.85% of points whose funding was constant for 30 days, and it acts ONLY
 * on points that lack a real scale. Above it (56.84% of points) it has no effect. There its three outcomes are all true statements:
 * IQR >= floor is untouched; IQR = 0 and the current rate equal to the constant gives z = 0 ("it has not moved and still has not");
 * IQR = 0 and a jump gives a large z that clips to +/-5 ("a rate that never moves moved today" is extreme by definition).
 *
 * The +/-5 clip rate (5.82% at this floor) is a DIAGNOSTIC, not a gate. An earlier protocol required <= 2%; that number was unfounded
 * and unreachable: even where the floor is irrelevant (IQR >= 0.3) the clip rate is ~2% because funding is heavy-tailed, and getting under
 * 2% would need a floor above the median IQR, which turns z into an absolute deviation and breaks R2.
 * Pre-registered alternative if a3's delta-BSS is near 0 in P3: clip at +/-10 instead of +/-5, ONE try on the validation folds only.
 */
export const FUNDING_SCALE_FLOOR: number | null = 0.009252;

export const A3_PARAMS = {
  windowDays: 30,
  minRows: 60,
  minSpanDays: 25,
  clip: 5,
  intervalsHours: [1, 2, 4, 8],
  /** A gap further than this fraction from every allowed interval is dropped rather than guessed. */
  snapTolerance: 0.1,
  /** The latest settlement must be recent: within this many of its own intervals of the decision time. */
  maxStaleIntervals: 2,
} as const;

/** One settlement from /fapi/v1/fundingRate: fundingTime (ms) and the rate for that settlement period (fraction, e.g. 0.0001). */
export interface FundingRow {
  time: number;
  rate: number;
}

export interface NormalisedFunding {
  time: number;
  /** Percent per day, same convention as `fundingDaily` in indicators/model.ts. */
  daily: number;
  intervalHours: number;
}

/**
 * Per-row settlement interval inferred from the gap to the previous row, snapped to the nearest allowed interval.
 * A gap more than 10% away from every allowed interval (e.g. a missed settlement) drops the row instead of guessing.
 * The first row has no predecessor and is dropped.
 */
export function normaliseFunding(rows: FundingRow[]): NormalisedFunding[] {
  const sorted = [...rows].filter((r) => finite(r.time) && finite(r.rate)).sort((a, b) => a.time - b.time);
  const out: NormalisedFunding[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gapH = (sorted[i].time - sorted[i - 1].time) / HOUR;
    let best = 0;
    let bestErr = Infinity;
    for (const h of A3_PARAMS.intervalsHours) {
      const err = Math.abs(gapH - h) / h;
      if (err < bestErr) {
        bestErr = err;
        best = h;
      }
    }
    if (bestErr > A3_PARAMS.snapTolerance) continue;
    out.push({ time: sorted[i].time, daily: (sorted[i].rate * 100 * 24) / best, intervalHours: best });
  }
  return out;
}

export interface FundingWindow {
  /** Valid rows (interval inferred and snapped) in the trailing window. */
  rows: NormalisedFunding[];
  spanDays: number;
  median: number;
  iqr: number;
  /** The latest settlement at or before the decision time. */
  now: NormalisedFunding;
}

/**
 * The trailing-30-day funding window as of `atTime`, or a reason it cannot be judged: fewer than 60 valid rows, a span under 25 days,
 * or a stale latest settlement. The single implementation used by the feature and by the floor measurement (R1).
 */
export function fundingWindow(rows: FundingRow[] | null, atTime: number): { window: FundingWindow | null; reason: string | null } {
  const miss = (reason: string) => ({ window: null, reason });
  if (!rows) return miss("no funding history");
  const win = normaliseFunding(rows.filter((r) => r.time <= atTime)).filter((r) => r.time > atTime - A3_PARAMS.windowDays * DAY);
  if (win.length < A3_PARAMS.minRows) return miss("fewer than " + A3_PARAMS.minRows + " valid funding rows in 30 days");
  const spanDays = (win[win.length - 1].time - win[0].time) / DAY;
  if (spanDays < A3_PARAMS.minSpanDays) return miss("funding history spans under " + A3_PARAMS.minSpanDays + " days");
  const now = win[win.length - 1];
  if (atTime - now.time > A3_PARAMS.maxStaleIntervals * now.intervalHours * HOUR) return miss("latest funding settlement is stale");
  const daily = win.map((r) => r.daily);
  const med = median(daily);
  const spread = iqr(daily);
  if (med === null || spread === null) return miss("funding statistics unavailable");
  return { window: { rows: win, spanDays, median: med, iqr: spread, now }, reason: null };
}

export interface FundingZResult {
  value: number | null;
  reason: string | null;
}

/**
 * a3_funding_z = clip((fundingDaily_now − median) / max(IQR, floor), −5, +5) over the trailing 30 days (by time, not by count).
 * With a constant history and a current value equal to it the numerator is 0, so z = 0 ("not pushed", true).
 * With a constant history and a current value that differs, the floor keeps the scale positive and the clip yields ±5
 * ("extreme deviation", true). No branching, both meanings come out correct.
 * Missing: floor not calibrated; fewer than 60 valid rows or a span under 25 days; the latest settlement is stale.
 */
export function fundingZ(rows: FundingRow[] | null, atTime: number, floor: number | null = FUNDING_SCALE_FLOOR): FundingZResult {
  const miss = (reason: string): FundingZResult => ({ value: null, reason });
  if (floor === null || !(floor > 0)) return miss("FUNDING_SCALE_FLOOR not calibrated");
  const { window, reason } = fundingWindow(rows, atTime);
  if (!window) return miss(reason ?? "funding window unavailable");
  const z = (window.now.daily - window.median) / Math.max(window.iqr, floor);
  return { value: Math.max(-A3_PARAMS.clip, Math.min(A3_PARAMS.clip, z)), reason: null };
}
