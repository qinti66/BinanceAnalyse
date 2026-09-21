import { finite, iqr, median } from "./stats.ts";

export const HOUR = 3600000;
export const DAY = 24 * HOUR;

/**
 * Lower bound on the scale of the funding z-score, in percent per day (the fundingDaily unit). MEASURED, not chosen:
 * the p10 of the non-zero trailing-30-day funding IQRs over W1 (359 perpetuals, 130,676 points; calibration-log-v1.md T9, T10, T14, T15, T17).
 * What is frozen is the METHOD, not its value on an incomplete sample or an earlier feature definition: 0.009252 on 308 coins (a firewall interrupted
 * the backfill), 0.009446 on the complete 359, 0.009475 on the 359 after rows on a change of schedule started being dropped (T17).
 * Any re-run replaces the constant directly, with no threshold for "moved enough".
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
export const FUNDING_SCALE_FLOOR: number | null = 0.009475;

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

/** Gap in hours snapped to the nearest allowed interval, or null when it is more than 10% from every one. */
const snapGap = (gapH: number): number | null => {
  let best = 0;
  let bestErr = Infinity;
  for (const h of A3_PARAMS.intervalsHours) {
    const err = Math.abs(gapH - h) / h;
    if (err < bestErr) {
      bestErr = err;
      best = h;
    }
  }
  return bestErr <= A3_PARAMS.snapTolerance ? best : null;
};

/**
 * Per-row normalisation of a settlement's funding rate to percent per day.
 *
 * WHY THE INTERVAL IS ONLY INFERRED: the rate is quoted for the NOMINAL interval in force at that settlement (0.00125 %/h at every schedule:
 * 0.01% per 8h, 0.005% per 4h, 0.00125% per 1h), so daily = rate * 24 / nominal interval. The API does not return the nominal interval, only the
 * elapsed gap to the previous row is observable, and the two differ on the rows around a change of schedule (a 1h->4h switch can produce a row that
 * is labelled 4h after only 1h or 3h). Normalising such a row by its elapsed gap overstates daily by up to 4x. The archive's true interval column is
 * used only to verify this (R1: production never sees it).
 *
 * THE RULE (a refusal, not an estimate; calibration-log-v1.md T15/T16 and docs/feature-spec-v1.md a3 (iv)): a row whose nominal interval cannot be
 * recovered is DROPPED. A row is dropped when
 *   - its gap to the previous row is not within 10% of {1,2,4,8}h (a missed settlement, a partial period), or
 *   - the gap to the NEXT row is not the same snapped interval as the gap to the previous row (it sits at a change of schedule).
 * "Previous gap != next gap" is the definition of "this row is on a boundary", not a fitted threshold; a missed settlement also trips it, and a
 * dropped missed-settlement row is right too. Cost: 1-2 rows per schedule change out of ~180 in a 30-day window.
 *
 * LIMIT (look-ahead is forbidden, R1): the LATEST row of a window has no successor yet, so this test cannot be applied to it. If the latest row is
 * itself a boundary row, it is used until the next settlement reveals it; the rows around it are corrected as soon as the next row exists.
 * The first row has no predecessor and is dropped.
 */
export function normaliseFunding(rows: FundingRow[]): NormalisedFunding[] {
  const sorted = [...rows].filter((r) => finite(r.time) && finite(r.rate)).sort((a, b) => a.time - b.time);
  const snapped = sorted.map((r, i) => (i === 0 ? null : snapGap((r.time - sorted[i - 1].time) / HOUR)));
  const out: NormalisedFunding[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = snapped[i];
    if (prev === null) continue;
    if (i + 1 < sorted.length && snapped[i + 1] !== prev) continue;
    out.push({ time: sorted[i].time, daily: (sorted[i].rate * 100 * 24) / prev, intervalHours: prev });
  }
  return out;
}

/**
 * CANDIDATE RULE B (not used by any feature; production stays on rule A, `normaliseFunding`). Pre-registered before the archive files that
 * can decide between them were downloaded.
 *   Rule A (current): snap each row's gap to {1,2,4,8}h; a gap more than 10% from every one is dropped.
 *   Rule B (candidate): normalise by the ACTUAL gap; drop a row whose gap lies outside [0.5x, 2x] of the median gap of the rows given.
 * B keeps the partial period at a 1h->4h switch (3h sits inside [2h, 8h] of a 4h median) while still refusing a missed settlement
 * (an 8h hole under a 1h schedule is 8x the median). It exists to be compared with the archive's true interval column, once.
 */
export function normaliseFundingRuleB(rows: FundingRow[]): NormalisedFunding[] {
  const sorted = [...rows].filter((r) => finite(r.time) && finite(r.rate)).sort((a, b) => a.time - b.time);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i].time - sorted[i - 1].time) / HOUR);
  const m = median(gaps);
  if (m === null || !(m > 0)) return [];
  const out: NormalisedFunding[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = gaps[i - 1];
    if (g < 0.5 * m || g > 2 * m) continue;
    out.push({ time: sorted[i].time, daily: (sorted[i].rate * 100 * 24) / g, intervalHours: g });
  }
  return out;
}

/**
 * The PRE-REGISTERED reading of a row that rule A refuses (for example the 3h period at a 1h->4h switch), fixed before the data was seen:
 *   the archive's interval column equals the ACTUAL elapsed time  => the row carries real information: adopt rule B
 *   the archive's interval column equals the NOMINAL new interval => the exchange books it at the new interval: keep rule A
 *   neither / inconsistent                                          => escalate to the architect; do NOT pick whichever reads well
 * It is read ONCE and the outcome is recorded whichever way it points. If the data is ambiguous it must not drift toward the more elegant rule.
 */
export type RefusedRowVerdict = "adopt_rule_B" | "keep_rule_A" | "escalate";
export function classifyRefusedRow(o: { truthHours: number; actualHours: number; nominalHours: number }): RefusedRowVerdict {
  const eq = (a: number, b: number) => finite(a) && finite(b) && Math.abs(a - b) < 0.01;
  const isActual = eq(o.truthHours, o.actualHours);
  const isNominal = eq(o.truthHours, o.nominalHours);
  if (isActual && !isNominal) return "adopt_rule_B";
  if (isNominal && !isActual) return "keep_rule_A";
  return "escalate";
}

export type OverallVerdict = RefusedRowVerdict | "untested";
/** One verdict over all refused rows: unanimous or escalate. No refused rows means the question was not tested, which is not a pass. */
export function aggregateVerdict(verdicts: RefusedRowVerdict[]): OverallVerdict {
  if (!verdicts.length) return "untested";
  if (verdicts.every((v) => v === "adopt_rule_B")) return "adopt_rule_B";
  if (verdicts.every((v) => v === "keep_rule_A")) return "keep_rule_A";
  return "escalate";
}

export interface RefusedRowReport {
  time: number;
  actualHours: number;
  /** The interval the rows that follow use (the new schedule), snapped. NaN when there is no following row. */
  nominalHours: number;
  truthHours: number;
  verdict: RefusedRowVerdict;
}

/** Rows rule A refuses, with the actual gap, the nominal new interval, the archive's true value and the pre-registered verdict for each. */
export function refusedRowsReport(rows: { time: number; rate: number; intervalHours: number }[]): RefusedRowReport[] {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const snapOf = (gapH: number) => {
    let best = 0;
    let bestErr = Infinity;
    for (const h of A3_PARAMS.intervalsHours) {
      const err = Math.abs(gapH - h) / h;
      if (err < bestErr) {
        bestErr = err;
        best = h;
      }
    }
    return { best, err: bestErr };
  };
  const out: RefusedRowReport[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].time - sorted[i - 1].time) / HOUR;
    if (snapOf(gap).err <= A3_PARAMS.snapTolerance) continue;
    const next = i + 1 < sorted.length ? snapOf((sorted[i + 1].time - sorted[i].time) / HOUR) : null;
    const nominal = next && next.err <= A3_PARAMS.snapTolerance ? next.best : NaN;
    const truth = sorted[i].intervalHours;
    out.push({ time: sorted[i].time, actualHours: gap, nominalHours: nominal, truthHours: truth, verdict: classifyRefusedRow({ truthHours: truth, actualHours: gap, nominalHours: nominal }) });
  }
  return out;
}

export interface IntervalCheck {
  /** Rows the inference produced an interval for (the first row has no predecessor). */
  compared: number;
  matched: number;
  /**
   * Rows where the inferred interval differs from the archive's own interval column. Per the pre-registered reading, ANY entry on a non-refused row
   * is a semantics/implementation problem to escalate; rule A must not be tuned to raise agreement with these files (production never sees the column).
   * `equalsPreviousInferred` marks the separate failure mode "the column lags one row", a systematic pattern and not a random inconsistency.
   */
  mismatches: { time: number; inferred: number; truth: number; equalsPreviousInferred: boolean }[];
  /** Rows the normalisation dropped (a gap not within 10% of {1,2,4,8}h, or a row on a change of schedule). Not an error, reported separately. */
  refused: number;
}

/**
 * Oracle check for the per-row interval inference. The archive's fundingRate files carry the true funding_interval_hours; the API does not, so
 * production MUST keep inferring (R1: training and live use one implementation). The archive column is used only to verify the inference:
 * same rows, inferred interval vs true interval. Not a source for the feature.
 */
export function checkIntervalInference(rows: { time: number; rate: number; intervalHours: number }[]): IntervalCheck {
  const truth = new Map(rows.map((r) => [r.time, r.intervalHours]));
  const inferred = normaliseFunding(rows.map((r) => ({ time: r.time, rate: r.rate })));
  const mismatches: IntervalCheck["mismatches"] = [];
  let matched = 0;
  inferred.forEach((r, k) => {
    const t = truth.get(r.time);
    if (t === r.intervalHours) matched++;
    else mismatches.push({ time: r.time, inferred: r.intervalHours, truth: t ?? NaN, equalsPreviousInferred: k > 0 && t === inferred[k - 1].intervalHours });
  });
  const refused = Math.max(0, rows.length - 1 - inferred.length);
  return { compared: inferred.length, matched, mismatches, refused };
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

/**
 * WHAT DOES THE ARCHIVE'S INTERVAL COLUMN MEAN? Pre-registered before any file that could answer it was opened.
 * At every switch between two adjacent non-refused rows (the first row of a new interval, `old -> new`), look at the column on the last old row and on the
 * first new row (`truthPrev`, `truthAt`):
 *   (old, new)  the column records the length of the period that ENDS at the row     = "period_ending_at_row"  (what rule A infers)
 *   (old, old)  the column lags by one row, it still shows the old interval          = "lag_old_period"
 *   (new, new)  the column leads, it already shows the new interval on the old row   = "lead_new_period"
 *   anything else                                                                    = "other"
 * A meaning is established only with at least MIN_SEMANTIC_EVENTS switch events and ALL of them in the same pattern. Fewer events is "untested"
 * (not a pass); mixed patterns are "unresolved" (escalate). This is a question about a data format, not a sample from a distribution.
 */
export const MIN_SEMANTIC_EVENTS = 10;
/** From this many events, all in one pattern, the reading is recorded as SUGGESTIVE: nothing is established and nothing is changed; P3 rechecks it. */
export const SUGGESTIVE_SEMANTIC_EVENTS = 3;
/** A rule change needs at least this many rows that rule A refuses, AND an established meaning of the column. Below it the reading is only suggestive. */
export const MIN_REFUSED_ROWS_FOR_RULE_CHANGE = 3;

export type SemanticPattern = "period_ending_at_row" | "lag_old_period" | "lead_new_period" | "other";
export interface SemanticEvent {
  time: number;
  oldHours: number;
  newHours: number;
  truthPrev: number;
  truthAt: number;
  pattern: SemanticPattern;
}
export type SemanticsTier = "established" | "suggestive" | "untested" | "unresolved";
export interface SemanticsVerdict {
  tier: SemanticsTier;
  /** The unanimous pattern for "established" and "suggestive"; null otherwise. */
  pattern: SemanticPattern | null;
  events: number;
}

/** Switch events between adjacent non-refused rows, each labelled with the pattern the archive column follows there. */
export function semanticEvents(rows: { time: number; rate: number; intervalHours: number }[]): SemanticEvent[] {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const snapped = sorted.map((r, i) => {
    if (i === 0) return null;
    const gapH = (r.time - sorted[i - 1].time) / HOUR;
    let best = 0;
    let bestErr = Infinity;
    for (const h of A3_PARAMS.intervalsHours) {
      const err = Math.abs(gapH - h) / h;
      if (err < bestErr) {
        bestErr = err;
        best = h;
      }
    }
    return bestErr <= A3_PARAMS.snapTolerance ? best : null;
  });
  const events: SemanticEvent[] = [];
  for (let i = 2; i < sorted.length; i++) {
    const oldH = snapped[i - 1];
    const newH = snapped[i];
    if (oldH === null || newH === null || oldH === newH) continue;
    const truthPrev = sorted[i - 1].intervalHours;
    const truthAt = sorted[i].intervalHours;
    const pattern: SemanticPattern =
      truthPrev === oldH && truthAt === newH ? "period_ending_at_row" : truthPrev === oldH && truthAt === oldH ? "lag_old_period" : truthPrev === newH && truthAt === newH ? "lead_new_period" : "other";
    events.push({ time: sorted[i].time, oldHours: oldH, newHours: newH, truthPrev, truthAt, pattern });
  }
  return events;
}

/**
 * Three tiers, fixed BEFORE the data was read:
 *   >= 10 events, all one pattern      => "established" (a basis for P3)
 *   3..9 events, all one pattern       => "suggestive"  (record the pattern and the count; establish nothing, change nothing; P3 rechecks)
 *   fewer than 3 events                => "untested"
 *   3 or more events with mixed patterns, or the pattern "other" => "unresolved" (escalate)
 * The reading scope is fixed before reading. If the count lands in 3..9 the result IS "suggestive": no other file may be added to reach 10.
 */
export function semanticsVerdict(events: SemanticEvent[]): SemanticsVerdict {
  const n = events.length;
  if (n < SUGGESTIVE_SEMANTIC_EVENTS) return { tier: "untested", pattern: null, events: n };
  const first = events[0].pattern;
  if (first === "other" || !events.every((e) => e.pattern === first)) return { tier: "unresolved", pattern: null, events: n };
  return { tier: n >= MIN_SEMANTIC_EVENTS ? "established" : "suggestive", pattern: first, events: n };
}

export interface IntervalDecision {
  /** What to do with the production rule. */
  action: "keep_rule_A" | "adopt_rule_B" | "escalate";
  /** True when the reading is only suggestive (too few refused rows, or no established meaning): recorded, not acted on. */
  suggestive: boolean;
  reasons: string[];
}

/**
 * The pre-registered decision, in one place, applied ONCE to the whole batch:
 *  - any mismatch on a NON-refused row                      => escalate (never tune rule A to fit)
 *  - the column's meaning unresolved                           => escalate
 *  - the meaning untested or only suggestive                   => cannot change the rule: keep A, suggestive
 *  - fewer than MIN_REFUSED_ROWS_FOR_RULE_CHANGE refused rows => keep A, suggestive
 *  - otherwise the unanimous verdict on the refused rows decides: adopt B / keep A / escalate
 */
export function decideIntervalRule(o: { mismatches: IntervalCheck["mismatches"]; semantics: SemanticsVerdict; refusedVerdicts: RefusedRowVerdict[] }): IntervalDecision {
  const reasons: string[] = [];
  if (o.mismatches.length) {
    const lag = o.mismatches.filter((m) => m.equalsPreviousInferred).length;
    reasons.push(o.mismatches.length + " mismatch(es) on non-refused rows" + (lag ? " (" + lag + " equal the previous row's inferred interval: the systematic-lag form, itself an informative meaning of the column)" : "") + ": semantics/implementation problem, escalate; do not tune rule A to fit");
    return { action: "escalate", suggestive: false, reasons };
  }
  if (o.semantics.tier === "unresolved") {
    reasons.push("the column's meaning is unresolved (" + o.semantics.events + " switch events, mixed or unrecognised patterns): escalate");
    return { action: "escalate", suggestive: false, reasons };
  }
  const overall = aggregateVerdict(o.refusedVerdicts);
  if (overall === "escalate") {
    reasons.push("the refused rows disagree with each other or match neither reading, escalate");
    return { action: "escalate", suggestive: false, reasons };
  }
  if (o.semantics.tier === "untested") {
    reasons.push("only " + o.semantics.events + " switch event(s), below " + SUGGESTIVE_SEMANTIC_EVENTS + ": the column's meaning is untested");
    return { action: "keep_rule_A", suggestive: true, reasons };
  }
  if (o.semantics.tier === "suggestive") {
    reasons.push(o.semantics.events + " switch events, all '" + o.semantics.pattern + "', below " + MIN_SEMANTIC_EVENTS + ": SUGGESTIVE only, nothing established; recorded and rechecked in P3, no rule change");
    return { action: "keep_rule_A", suggestive: true, reasons };
  }
  if (o.refusedVerdicts.length < MIN_REFUSED_ROWS_FOR_RULE_CHANGE) {
    reasons.push(o.refusedVerdicts.length + " refused row(s), below " + MIN_REFUSED_ROWS_FOR_RULE_CHANGE + ": a rule change is not supported yet; keep rule A" + (overall === "untested" ? "" : ", the reading (" + overall + ") is only suggestive"));
    return { action: "keep_rule_A", suggestive: true, reasons };
  }
  reasons.push("meaning established (" + o.semantics.pattern + ", " + o.semantics.events + " events) and " + o.refusedVerdicts.length + " refused rows agree: " + overall);
  return { action: overall === "adopt_rule_B" ? "adopt_rule_B" : "keep_rule_A", suggestive: false, reasons };
}
