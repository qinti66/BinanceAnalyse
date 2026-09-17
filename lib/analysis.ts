export type PositionCycle = {
  openedAt: number;
  closedAt: number;
  turnover: number;
  grossPnl: number;
  fees: number;
  side: "long" | "short";
  symbol: string;
};

export type HoldingMetrics = {
  sampleSize: number;
  medianHoldSeconds: number | null;
  under60sRatio: number | null;
  under5mRatio: number | null;
  sameMinuteReversalRatio: number | null;
  dailyTurnoverToEquity: number | null;
  feeToGrossProfit: number | null;
  washRiskScore: number | null;
  confidence: number;
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const ratio = (value: number, threshold: number) => clamp(value / threshold);

export function computeHoldingMetrics(cycles: PositionCycle[], averageEquity: number, windowDays: number): HoldingMetrics {
  if (!cycles.length) return { sampleSize: 0, medianHoldSeconds: null, under60sRatio: null, under5mRatio: null, sameMinuteReversalRatio: null, dailyTurnoverToEquity: null, feeToGrossProfit: null, washRiskScore: null, confidence: 0 };

  const ordered = [...cycles].sort((a, b) => a.closedAt - b.closedAt);
  const durations = ordered.map((cycle) => Math.max(0, Math.round((cycle.closedAt - cycle.openedAt) / 1000))).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length % 2 ? durations[middle] : Math.round((durations[middle - 1] + durations[middle]) / 2);
  const under60s = durations.filter((value) => value <= 60).length / durations.length;
  const under5m = durations.filter((value) => value <= 300).length / durations.length;

  let reversals = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.symbol === current.symbol && previous.side !== current.side && current.openedAt - previous.closedAt <= 60_000) reversals += 1;
  }
  const reversalRatio = ordered.length > 1 ? reversals / (ordered.length - 1) : 0;
  const turnover = ordered.reduce((sum, cycle) => sum + Math.abs(cycle.turnover), 0);
  const turnoverToEquity = averageEquity > 0 && windowDays > 0 ? turnover / averageEquity / windowDays : 0;
  const fees = ordered.reduce((sum, cycle) => sum + Math.abs(cycle.fees), 0);
  const grossProfit = ordered.reduce((sum, cycle) => sum + Math.max(0, cycle.grossPnl), 0);
  const feeRatio = grossProfit > 0 ? fees / grossProfit : fees > 0 ? 1 : 0;

  const risk = 100 * (
    .22 * ratio(under60s, .30) +
    .18 * ratio(under5m, .45) +
    .16 * ratio(reversalRatio, .20) +
    .16 * ratio(turnoverToEquity, 20) +
    .14 * ratio(feeRatio, .35) +
    .14 * ratio(Math.max(0, .5 - median / 3600), .5)
  );
  const confidence = clamp(ordered.length / 100) * clamp(windowDays / 30);

  return {
    sampleSize: ordered.length,
    medianHoldSeconds: median,
    under60sRatio: under60s,
    under5mRatio: under5m,
    sameMinuteReversalRatio: reversalRatio,
    dailyTurnoverToEquity: turnoverToEquity,
    feeToGrossProfit: feeRatio,
    washRiskScore: Math.round(risk * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
  };
}

export function capCompositeScore(publicScore: number, washRiskScore: number | null) {
  if (washRiskScore === null) return { score: Math.min(publicScore, 89), status: "pending" as const };
  if (washRiskScore >= 60) return { score: Math.min(publicScore, 49), status: "flagged" as const };
  return { score: Math.round((publicScore * .7 + (100 - washRiskScore) * .3) * 10) / 10, status: "verified" as const };
}
