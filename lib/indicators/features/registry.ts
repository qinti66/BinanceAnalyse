import { atrSeries } from "../../structure/atr.ts";
import { STRUCTURE_PARAMS, STRUCTURE_PARAMS_4H } from "../../structure/analyze.ts";
import type { Bar } from "../../structure/types.ts";
import { HOUR_MS, ret24hPct, type FeatureContext } from "./context.ts";
import { fundingZ } from "./funding.ts";
import { contiguousTail, finite, historyTooShort, lastIndexClosedBy, median, olsSlope, pctRank } from "./stats.ts";
import { SWEEP_WINDOW_4H, SWEEP_WINDOW_1H, structureFeatures } from "./structureFeatures.ts";

/**
 * Implements docs/feature-spec-v1.md. Frozen before training; a change to any definition needs a new FEATURE_VERSION and the
 * artifact stores it, so scoring refuses a mismatched model. All definitions are unvalidated heuristics (no backtest).
 *
 * R1: `buildFeatureVector` is the ONLY implementation. Training and live scoring both call it.
 * R6: a value is 0 only when 0 tells the truth; otherwise the feature is missing (NaN + an entry in `missing`).
 */
export const FEATURE_VERSION = "features-v1";

export const FEATURE_IDS = [
  "c1_effort_vs_result",
  "c2_sell_absorbed",
  "d1_vol_squeeze_pct",
  "d2_volume_dryup_pct",
  "d3_compression_bars",
  "d4_vol_squeeze_4h",
  "e1_rel_btc_24h",
  "e2_rel_median_24h",
  "e3_ret_rank_pct",
  "f1_sweep_reclaim",
  "f1_occurred",
  "f2_up",
  "f2_down",
  "f3_range_containment",
  "f1_sweep_reclaim_4h",
  "f1_occurred_4h",
  "f2_up_4h",
  "f2_down_4h",
  "g1_breadth_ema60",
  "g2_btc_vol_regime",
  "a3_funding_z",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

/** Only the latest bars are ever read, in training and live alike, so a longer training history cannot change a value. */
export const FEATURE_WINDOW = 400;
const TRAIL = 336;
const ATR_PERIOD = 14;
const PRECONDITION_BARS = TRAIL + ATR_PERIOD - 1; // 349: ATR warm-up + trailing window
const D3_CAP = 168;
const D2_MIN_SLOT_SAMPLES = 8;
const BETA_RETURNS = 168;
const BETA_CLIP: [number, number] = [0, 3];
const MIN_CROSS_COINS = 50;
const BTC_RV_RETURNS = 720; // 30 days of 1h returns
const BTC_RV_SAMPLES = 365; // one per day over the last year
const BTC_LONG_BARS = (BTC_RV_SAMPLES - 1) * 24 + BTC_RV_RETURNS + 1; // 9457

type R = { v: number | null; why: string | null };
const ok = (v: number): R => ({ v, why: null });
const no = (why: string): R => ({ v: null, why });

export interface FeatureVector {
  ids: readonly string[];
  /** Same order as `ids`. NaN marks a missing feature. */
  values: Float64Array;
  missing: string[];
  reasons: Record<string, string>;
  version: string;
}

interface Prep {
  b: Bar[];
  i: number;
  atr: (number | null)[];
  atrPct: (number | null)[];
}

/** Trailing-window preconditions shared by the 336-window features. Null with a reason when unmet. */
function prep(b: Bar[], intervalMs: number): { p: Prep | null; why: string | null } {
  if (b.length < PRECONDITION_BARS) return { p: null, why: historyTooShort(b.length, PRECONDITION_BARS, intervalMs) };
  if (!contiguousTail(b, PRECONDITION_BARS, intervalMs)) return { p: null, why: "gap inside the trailing window" };
  const atr = atrSeries(b, ATR_PERIOD);
  const atrPct = atr.map((a, j) => (a === null ? null : (a / b[j].c) * 100));
  return { p: { b, i: b.length - 1, atr, atrPct }, why: null };
}

const tail = <T>(xs: T[], n: number) => xs.slice(xs.length - n);
const allFinite = (xs: (number | null)[]): xs is number[] => xs.every((x) => x !== null && finite(x));

/** c1: pct(qvUsd, trailing 336) − pct(range/ATR, trailing 336). High = big effort, price barely moved. Both numerator and ATR are in price units (R2). */
function c1(b: Bar[]): R {
  const { p, why } = prep(b, HOUR_MS);
  if (!p) return no(why!);
  const win = tail(p.b, TRAIL);
  const qv = win.map((x) => x.qvUsd);
  if (!allFinite(qv)) return no("qvUsd missing in trailing window");
  const atrWin = tail(p.atr, TRAIL);
  if (!allFinite(atrWin) || atrWin.some((a) => !(a > 0))) return no("ATR invalid in trailing window");
  // Range in ATR units: (h−l)/atr[j]. Numerator and denominator are both prices, so the ratio is dimensionless (spec R2 alignment clause).
  const ra = win.map((x, k) => (x.h - x.l) / atrWin[k]);
  const a = pctRank(qv[qv.length - 1], qv);
  const c = pctRank(ra[ra.length - 1], ra);
  return a === null || c === null ? no("non-finite range or volume") : ok(a - c);
}

/** c2: sellRatio × (1 − min(1, |Δclose|/ATR)). Sellers were active but price did not move. qvUsd = 0 ⇒ sellRatio = 0, explicitly. */
function c2(b: Bar[]): R {
  if (b.length < ATR_PERIOD + 1) return no(historyTooShort(b.length, ATR_PERIOD + 1, HOUR_MS));
  if (!contiguousTail(b, ATR_PERIOD + 1, HOUR_MS)) return no("gap inside the last 15 bars");
  const i = b.length - 1;
  const atr = atrSeries(b, ATR_PERIOD)[i];
  if (atr === null || !(atr > 0)) return no("ATR invalid");
  const qv = b[i].qvUsd;
  const tb = b[i].takerBuyUsd;
  if (qv === null || tb === null) return no("qvUsd or takerBuyUsd missing");
  const sellRatio = qv === 0 ? 0 : Math.max(0, (qv - tb) / qv);
  const move = Math.abs(b[i].c - b[i - 1].c) / atr;
  return ok(sellRatio * (1 - Math.min(1, move)));
}

/** d1 / d4: percentile of ATR% within its own trailing 336 bars. Low = tight. Mid-rank on ties. */
function squeezePct(b: Bar[], intervalMs: number): R {
  const { p, why } = prep(b, intervalMs);
  if (!p) return no(why!);
  const w = tail(p.atrPct, TRAIL);
  if (!allFinite(w)) return no("ATR invalid in trailing window");
  const v = pctRank(w[w.length - 1], w);
  return v === null ? no("percentile unavailable") : ok(v);
}

/**
 * d2: pct(qvUsd / hourOfDayBaseline, trailing 336). The baseline is the median of the same UTC hour within the window
 * (24 slots, 14 samples each; at least 8 required). It is fixed for the window, like d3's M, so no extra history is needed.
 */
function d2(b: Bar[]): R {
  const { p, why } = prep(b, HOUR_MS);
  if (!p) return no(why!);
  const win = tail(p.b, TRAIL);
  const qv = win.map((x) => x.qvUsd);
  if (!allFinite(qv)) return no("qvUsd missing in trailing window");
  const slot = (x: Bar) => Math.floor(x.t / HOUR_MS) % 24;
  const bySlot: number[][] = Array.from({ length: 24 }, () => []);
  win.forEach((x, k) => bySlot[slot(x)].push(qv[k]));
  if (bySlot.some((s) => s.length < D2_MIN_SLOT_SAMPLES)) return no("an hour-of-day slot has fewer than 8 samples");
  const base = bySlot.map((s) => median(s)!);
  if (base.some((m) => !(m > 0))) return no("hour-of-day baseline volume is zero");
  const ratio = win.map((x, k) => qv[k] / base[slot(x)]);
  const v = pctRank(ratio[ratio.length - 1], ratio);
  return v === null ? no("percentile unavailable") : ok(v);
}

/**
 * d3: consecutive bars back from i with ATR% below M, capped at 168. M is the median of the trailing 336 ending at i, a constant
 * (a rolling M would need 517 bars, more than is available live). 0 means "not compressed now", which is true, so it is not missing.
 */
function d3(b: Bar[]): R {
  const { p, why } = prep(b, HOUR_MS);
  if (!p) return no(why!);
  const w = tail(p.atrPct, TRAIL);
  if (!allFinite(w)) return no("ATR invalid in trailing window");
  const m = median(w)!;
  let n = 0;
  for (let k = w.length - 1; k >= 0 && n < D3_CAP; k--) {
    if (w[k] < m) n++;
    else break;
  }
  return ok(n);
}

/**
 * e1/e2/e3 shared inputs: 24h return in percent and atrPct_24h ≡ atrPct_1h × √24 (frozen by the spec).
 * The √24 is one global constant, so the regression coefficient absorbs it; all cross-coin normalisation comes from each coin's own
 * atrPct_1h. Do NOT "improve" this to a realised 24h volatility: that is no longer a constant multiple and would change the
 * cross-coin relationship and add a missing-data condition.
 */
function relBase(b: Bar[]): { ret: number; atrPct24: number } | string {
  if (b.length < ATR_PERIOD + 1) return historyTooShort(b.length, ATR_PERIOD + 1, HOUR_MS);
  if (!contiguousTail(b, ATR_PERIOD + 1, HOUR_MS)) return "gap inside the last 15 bars";
  const i = b.length - 1;
  const ret = ret24hPct(b, i);
  if (ret === null) return "24h return unavailable";
  const atr = atrSeries(b, ATR_PERIOD)[i];
  if (atr === null || !(atr > 0)) return "ATR invalid";
  return { ret, atrPct24: (atr / b[i].c) * 100 * Math.sqrt(24) };
}

function e1(b: Bar[], btc: Bar[] | null): R {
  const base = relBase(b);
  if (typeof base === "string") return no(base);
  if (!btc || !btc.length) return no("BTC bars missing");
  const need = BETA_RETURNS + 1;
  if (b.length < need) return no(historyTooShort(b.length, need, HOUR_MS));
  if (!contiguousTail(b, need, HOUR_MS)) return no("gap inside the beta window");
  const byCt = new Map(btc.map((x) => [x.ct, x]));
  const coin = tail(b, need);
  const bench = coin.map((x) => byCt.get(x.ct));
  if (bench.some((x) => x === undefined)) return no("BTC bars do not cover the beta window");
  const rc: number[] = [];
  const rb: number[] = [];
  for (let k = 1; k < need; k++) {
    rc.push(coin[k].c / coin[k - 1].c - 1);
    rb.push(bench[k]!.c / bench[k - 1]!.c - 1);
  }
  const slope = olsSlope(rb, rc);
  if (slope === null) return no("beta cannot be estimated");
  const beta = Math.min(BETA_CLIP[1], Math.max(BETA_CLIP[0], slope));
  const j = lastIndexClosedBy(btc, b[b.length - 1].ct);
  if (j < 0 || btc[j].ct !== b[b.length - 1].ct) return no("BTC has no bar at the decision time");
  const btcRet = ret24hPct(btc, j);
  if (btcRet === null) return no("BTC 24h return unavailable");
  return ok((base.ret - beta * btcRet) / base.atrPct24);
}

function e2(b: Bar[], ctx: FeatureContext): R {
  const base = relBase(b);
  if (typeof base === "string") return no(base);
  const cs = ctx.cross;
  if (!cs || cs.time !== b[b.length - 1].ct) return no("cross-section missing or not at the decision time");
  if (cs.ret24h.length < MIN_CROSS_COINS) return no("fewer than 50 coins in the cross-section");
  return ok((base.ret - median(cs.ret24h)!) / base.atrPct24);
}

function e3(b: Bar[], ctx: FeatureContext): R {
  const base = relBase(b);
  if (typeof base === "string") return no(base);
  const cs = ctx.cross;
  if (!cs || cs.time !== b[b.length - 1].ct) return no("cross-section missing or not at the decision time");
  if (cs.ret24h.length < MIN_CROSS_COINS) return no("fewer than 50 coins in the cross-section");
  const v = pctRank(base.ret, cs.ret24h);
  return v === null ? no("rank unavailable") : ok(v);
}

function g1(b: Bar[], ctx: FeatureContext): R {
  const cs = ctx.cross;
  if (!cs || cs.time !== b[b.length - 1].ct) return no("cross-section missing or not at the decision time");
  if (cs.breadthValid < MIN_CROSS_COINS) return no("fewer than 50 coins with an EMA60");
  return ok(cs.breadthAbove / cs.breadthValid);
}

/** g2: BTC 30-day realised volatility, as a percentile of its own last 365 daily samples. A single point of failure: needs a fresh 1-year BTC history. */
function g2(ct: number, btcLong: Bar[] | null): R {
  if (!btcLong) return no("BTC long history missing");
  const end = lastIndexClosedBy(btcLong, ct);
  if (end < 0 || btcLong[end].ct !== ct) return no("BTC long history has no bar at the decision time");
  if (end + 1 < BTC_LONG_BARS) return no("BTC history shorter than 1 year");
  const bars = btcLong.slice(end + 1 - BTC_LONG_BARS, end + 1);
  if (!contiguousTail(bars, BTC_LONG_BARS, HOUR_MS)) return no("gap inside the BTC 1-year history");
  const n = bars.length;
  const s1 = new Float64Array(n + 1);
  const s2 = new Float64Array(n + 1);
  for (let k = 1; k < n; k++) {
    const r = Math.log(bars[k].c / bars[k - 1].c);
    s1[k + 1] = s1[k] + r;
    s2[k + 1] = s2[k] + r * r;
  }
  // rv ending at bar index e uses returns e-719..e, i.e. prefix positions e-719+1 .. e+1
  const rv = (e: number) => {
    const a = e - BTC_RV_RETURNS + 1;
    const sum = s1[e + 1] - s1[a];
    const sq = s2[e + 1] - s2[a];
    return Math.sqrt(Math.max(0, (sq - (sum * sum) / BTC_RV_RETURNS) / (BTC_RV_RETURNS - 1)));
  };
  const samples: number[] = [];
  for (let m = 0; m < BTC_RV_SAMPLES; m++) samples.push(rv(n - 1 - 24 * m));
  const v = pctRank(samples[0], samples);
  return v === null ? no("percentile unavailable") : ok(v);
}

/** Cut an optional series at the decision time so a caller cannot leak the future into a feature. */
const upto = (bars: Bar[] | null, ct: number, keep: number): Bar[] | null => {
  if (!bars) return null;
  const j = lastIndexClosedBy(bars, ct);
  return j < 0 ? [] : bars.slice(Math.max(0, j + 1 - keep), j + 1);
};

/**
 * The one feature builder (R1). Reads bars[0..atIndex] only, and only the latest FEATURE_WINDOW of them; every context series is
 * cut at the decision bar's closeTime here, so even a context that extends past it cannot leak.
 * A missing feature is NaN in `values`, listed in `missing` with a reason. It is never replaced by 0 or an imputed value.
 */
export function buildFeatureVector(bars: Bar[], atIndex: number, ctx: FeatureContext): FeatureVector {
  const values = new Float64Array(FEATURE_IDS.length).fill(NaN);
  const reasons: Record<string, string> = {};
  const set = (id: FeatureId, r: R | { value: number | null; reason: string | null }) => {
    const v = "v" in r ? r.v : r.value;
    const why = "why" in r ? r.why : r.reason;
    if (v === null || !finite(v)) reasons[id] = why ?? "missing";
    else values[FEATURE_IDS.indexOf(id)] = v;
  };
  const finish = (): FeatureVector => ({
    ids: FEATURE_IDS,
    values,
    missing: FEATURE_IDS.filter((_, k) => Number.isNaN(values[k])),
    reasons,
    version: FEATURE_VERSION,
  });

  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex >= bars.length) {
    for (const id of FEATURE_IDS) reasons[id] = "atIndex out of range";
    return finish();
  }
  const b = bars.slice(Math.max(0, atIndex + 1 - FEATURE_WINDOW), atIndex + 1);
  const ct = b[b.length - 1].ct;
  const b4 = upto(ctx.bars4h, ct, FEATURE_WINDOW);
  const btc = upto(ctx.btcBars, ct, FEATURE_WINDOW);

  set("c1_effort_vs_result", c1(b));
  set("c2_sell_absorbed", c2(b));
  set("d1_vol_squeeze_pct", squeezePct(b, HOUR_MS));
  set("d2_volume_dryup_pct", d2(b));
  set("d3_compression_bars", d3(b));
  set("d4_vol_squeeze_4h", b4 ? squeezePct(b4, 4 * HOUR_MS) : no("4h bars missing"));
  set("e1_rel_btc_24h", e1(b, btc));
  set("e2_rel_median_24h", e2(b, ctx));
  set("e3_ret_rank_pct", e3(b, ctx));

  const s1 = structureFeatures(b, STRUCTURE_PARAMS, HOUR_MS, SWEEP_WINDOW_1H);
  set("f1_sweep_reclaim", s1.f1);
  set("f1_occurred", s1.f1Occurred);
  set("f2_up", s1.f2Up);
  set("f2_down", s1.f2Down);
  set("f3_range_containment", s1.f3);
  if (b4) {
    const s4 = structureFeatures(b4, STRUCTURE_PARAMS_4H, 4 * HOUR_MS, SWEEP_WINDOW_4H);
    set("f1_sweep_reclaim_4h", s4.f1);
    set("f1_occurred_4h", s4.f1Occurred);
    set("f2_up_4h", s4.f2Up);
    set("f2_down_4h", s4.f2Down);
  } else {
    for (const id of ["f1_sweep_reclaim_4h", "f1_occurred_4h", "f2_up_4h", "f2_down_4h"] as const) set(id, no("4h bars missing"));
  }

  set("g1_breadth_ema60", g1(b, ctx));
  set("g2_btc_vol_regime", g2(ct, ctx.btcLongBars));
  set("a3_funding_z", ctx.isPerpetual ? fundingZ(ctx.funding, ct) : { value: null, reason: "not a perpetual contract" });
  return finish();
}

/**
 * The excluded share of coins above which the 58-day boundary of d4 must be reconsidered. Pre-registered so the decision is not made by feel:
 * d4 (a 336-bar trailing percentile on 4h plus 13 ATR warm-up bars = 349 bars = 58.2 days) is the one requirement that keeps young listings
 * from getting a probability. Today that is 1.1% of coins. Above this share, or if the product explicitly wants newly listed coins, the 4h trailing
 * window of d4 is the only thing to revisit. Not before: changing a frozen definition for a marginal case costs more than it returns.
 */
export const AGE_EXCLUSION_REVIEW_SHARE = 0.05;

export interface CoverageSummary {
  total: number;
  /** Every feature present: eligible for a probability. */
  complete: number;
  /** Missing at least one feature because the history is too short (a recent listing). */
  excludedByHistory: number;
  excludedByHistoryShare: number;
  /** Missing something for another reason (a gap in the bars, a missing series, too few swings for f2 ...). */
  otherMissing: number;
  /** Coins missing each feature. */
  byFeature: Record<string, number>;
  /** True when the age exclusion is above AGE_EXCLUSION_REVIEW_SHARE. */
  reviewRequired: boolean;
}

const isHistoryReason = (why: string | undefined) => !!why && why.startsWith("history too short");

/**
 * Coverage summary for one collection run: how many coins can get a probability, and how many are held back by age. A coin counts as an age
 * exclusion when ANY of its missing features was missing for lack of history; the run log should print this every time so the boundary is
 * visible instead of a silent blank.
 */
export function summariseCoverage(vectors: FeatureVector[]): CoverageSummary {
  const total = vectors.length;
  const byFeature: Record<string, number> = {};
  let complete = 0;
  let excludedByHistory = 0;
  let otherMissing = 0;
  for (const v of vectors) {
    for (const id of v.missing) byFeature[id] = (byFeature[id] || 0) + 1;
    if (!v.missing.length) complete++;
    else if (v.missing.some((id) => isHistoryReason(v.reasons[id]))) excludedByHistory++;
    else otherMissing++;
  }
  const share = total ? excludedByHistory / total : 0;
  return { total, complete, excludedByHistory, excludedByHistoryShare: share, otherMissing, byFeature, reviewRequired: share > AGE_EXCLUSION_REVIEW_SHARE };
}
