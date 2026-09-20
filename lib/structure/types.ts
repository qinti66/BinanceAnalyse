export type ContractFamily = "UM" | "CM";

/** USD-normalised flow of one candle. Same shape and semantics as the legacy `candleFlow` result. */
export interface CandleFlow {
  inflow: number;
  outflow: number;
  net: number;
  total: number;
}

/**
 * One validated candle. Prices are in the raw quote unit (multiplied contracts such as 1000x keep
 * their multiplier; CM is USD per contract). Volumes are family-normalised to USD where possible.
 * Missing values stay null / NaN — never zero.
 */
export interface Bar {
  t: number; // openTime
  ct: number; // closeTime
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null; // base-unit volume (UM = base, CM = contracts)
  qvUsd: number | null; // USD turnover; null when the family conversion is unavailable or invalid
  takerBuyUsd: number | null; // USD taker-buy turnover
  trades: number | null;
  /** Full USD flow from the single family conversion (`candleFlow`). Null when it cannot be computed. */
  flow: CandleFlow | null;
}

export interface BarsResult {
  bars: Bar[];
  /** Last bar closes at cutoff-1 and every open-time gap equals intervalMs. */
  contiguous: boolean;
  /** Share of raw kline rows that passed validation (0 when there are no rows). */
  coverage: number;
}

/** One point of a long/short ratio history. Long/short account shares stay null when missing. */
export interface RatioSample {
  time: number;
  ratio: number;
  long: number | null;
  short: number | null;
}

export interface Ticker24h {
  high: number | null;
  low: number | null;
  quoteVolume: number | null;
  trades: number | null;
}

/** Heavy series consumed by structure analysis. Lives only during analysis; never written to the snapshot. */
export interface AnalysisInputs {
  bars: Bar[];
  contiguous: boolean;
  /** Top-trader long/short by account count (per-head). */
  topAccount: RatioSample[];
  /** Top-trader long/short by position size. A different signal from topAccount; never merged with it. */
  topPosition: RatioSample[];
  globalAccount: RatioSample[];
  ticker24h: Ticker24h | null;
}

/** A confirmed swing point. Unknowable before `confirmedIndex`: never use it for any decision at an earlier bar. */
export interface Swing {
  index: number;
  time: number; // openTime of the pivot bar
  price: number;
  type: "high" | "low";
  confirmedIndex: number;
}

/** Uniform detection result. `confirmedIndex` is when the finding became knowable (look-ahead guard). */
export interface Finding<M = unknown> {
  kind: string;
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  priceHigh: number;
  priceLow: number;
  confirmedIndex: number;
  strength: number | null;
  meta: M;
}

export interface StructureResult {
  version: string;
  /** Parameter snapshot; ships with the artifact so results are reproducible. */
  params: Readonly<Record<string, number | string>>;
  findings: Finding[];
  coverage: number;
  /** Detections that could not run for lack of data. "Could not judge" is not "did not happen". */
  unavailable: string[];
}
