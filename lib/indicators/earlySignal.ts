// 早期信号体系 v1 —— 研究用启发式规则，尚未回测，不构成买卖建议。
// 设计文档：docs/module-redesign-v2.md 第一节。所有归一化区间均为经验取值，会随样本积累调整。
export const EARLY_SIGNAL_RULE = "indicator-early-v1";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number | null, n = 2): number | null => (v === null ? null : Math.round(v * 10 ** n) / 10 ** n);

export interface RatioPoint {
  time: number;
  value: number;
}

export interface EarlySignalInputs {
  /** 按小时先后排列（最旧在前，最新在后）的 ATR/价格 百分比序列，理论上覆盖近14天（约336点）。 */
  atrPctSeries: number[];
  /** 按小时先后排列的“单笔平均成交额（USD）”序列：quoteVolume / numTrades。 */
  avgTradeSizeSeries: number[];
  /** 按小时先后排列的整点 OI 数量，至少需要最近6个点用于计算加速度。 */
  oiQtyHourly: (number | null)[];
  /** 按小时先后排列的1h净流比（%），最多取最近24个点用于统计连续同向计数。 */
  netRatioHourly: (number | null)[];
  /** 顶级账户（前20%保证金）多空比历史点，来自 /futures/data/topLongShortAccountRatio（按人头）。缺失即缺失，不回退到按仓位的 topLongShortPositionRatio（口径不同，不可与全市场账户比对）。 */
  topRatioSeries: RatioPoint[];
  /** 全市场账户多空比历史点，来自 /futures/data/globalLongShortAccountRatio。 */
  globalRatioSeries: RatioPoint[];
  /** 按小时先后排列的收盘价，用于 OBV／价量背离计算。 */
  closeSeries: number[];
  /** 按小时先后排列的成交额（USD），与 closeSeries 对齐，用于 OBV 计算。 */
  quoteVolumeSeries: number[];
  /** 当前24h等效资金费率（%），仅作辅助否决，不进入主公式权重。 */
  fundingDaily: number | null;
}

export interface EarlySignalContext {
  /** 4h OI 变化（%），由指标聚合层提供，用于“疑似启动”标签判定。 */
  oi4: number | null;
  /** 4h 价格变化（%）。 */
  p4: number | null;
  /** 4h 主动净流比（%），注意早期候选阈值（5%）比确认用阈值（8%）更宽松。 */
  netRatio4h: number | null;
}

export interface EarlySignal {
  ruleVersion: string;
  volSqueezePct: number | null;
  oiAccel: number | null;
  topShortDivergence: number | null;
  avgTradeSizePct: number | null;
  netRatioStreak: number | null;
  obvDivergence: { diverging: boolean; magnitude: number } | null;
  fundingLag: number | null;
  earlyScore: number | null;
  earlyScoreCoverage: number;
  earlyCandidate: boolean;
}

/** value 在 series（不含 value 本身）历史分布中的百分位排名，0-100；样本不足8个返回 null。 */
export function percentileRank(series: number[], value: number): number | null {
  const sample = series.filter(finite);
  if (sample.length < 8 || !finite(value)) return null;
  const below = sample.filter((v) => v <= value).length;
  return round((below / sample.length) * 100, 1);
}

function slopePerHour(points: RatioPoint[]): number | null {
  const sample = points.filter((p) => finite(p.value) && finite(p.time));
  if (sample.length < 2) return null;
  const first = sample[0],
    last = sample[sample.length - 1];
  const hours = (last.time - first.time) / 3600000;
  if (hours <= 0) return null;
  return (last.value - first.value) / hours;
}

function pctChange(a: number | null, b: number | null): number | null {
  if (!finite(a) || !finite(b) || b === 0) return null;
  return (a / b - 1) * 100;
}

/** 最新1h OI变化率 − 过去4h平均1h OI变化率；需要最近6个整点 OI 数量点（t-5..t）。 */
export function computeOiAccel(oiQtyHourly: (number | null)[]): number | null {
  if (oiQtyHourly.length < 6) return null;
  const last6 = oiQtyHourly.slice(-6);
  if (last6.some((v) => v === null)) return null;
  const vals = last6 as number[];
  const latest = pctChange(vals[5], vals[4]);
  const priors = [pctChange(vals[4], vals[3]), pctChange(vals[3], vals[2]), pctChange(vals[2], vals[1]), pctChange(vals[1], vals[0])];
  if (latest === null || priors.some((c) => c === null)) return null;
  const avgPrior = (priors as number[]).reduce((a, b) => a + b, 0) / 4;
  return round(latest - avgPrior, 3);
}

/** 过去N根1h K线中，netRatio同向（同为正或同为负）的连续计数，从最近一根向过去数；正数=连续净流入，负数=连续净流出。
 *  没有序列或最近一根缺失时返回 null（缺失不按0计分）。 */
export function computeNetRatioStreak(netRatioHourly: (number | null)[]): number | null {
  const latest = netRatioHourly.at(-1);
  if (latest === undefined || latest === null || !finite(latest)) return null;
  let streak = 0;
  for (let i = netRatioHourly.length - 1; i >= 0; i--) {
    const v = netRatioHourly[i];
    if (v === null || !finite(v)) break;
    if (streak === 0) {
      if (v > 0) streak = 1;
      else if (v < 0) streak = -1;
      else break;
    } else if (streak > 0 && v > 0) streak++;
    else if (streak < 0 && v < 0) streak--;
    else break;
  }
  return streak;
}

function obvSeries(closeSeries: number[], volumeSeries: number[]): number[] {
  const n = Math.min(closeSeries.length, volumeSeries.length);
  const obv: number[] = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      obv.push(0);
      continue;
    }
    const dir = closeSeries[i] > closeSeries[i - 1] ? 1 : closeSeries[i] < closeSeries[i - 1] ? -1 : 0;
    cum += dir * volumeSeries[i];
    obv.push(cum);
  }
  return obv;
}

/** 比较最近 window 小时内 OBV 斜率方向与价格斜率方向；价格滞涨但 OBV 仍在增，标记背离。窗口默认24h，数据不足返回 null。 */
export function computeObvDivergence(closeSeries: number[], quoteVolumeSeries: number[], window = 24): { diverging: boolean; magnitude: number } | null {
  const n = Math.min(closeSeries.length, quoteVolumeSeries.length);
  if (n < window + 1) return null;
  const closeWindow = closeSeries.slice(-window - 1),
    volumeWindow = quoteVolumeSeries.slice(-window - 1);
  if (!closeWindow.every(finite) || !volumeWindow.every(finite) || closeWindow[0] === 0) return null;
  const obv = obvSeries(closeWindow, volumeWindow);
  const priceSlopePct = ((closeWindow[closeWindow.length - 1] - closeWindow[0]) / closeWindow[0]) * 100;
  const obvRange = Math.max(1e-9, Math.max(...obv) - Math.min(...obv));
  const obvSlopePct = ((obv[obv.length - 1] - obv[0]) / obvRange) * 100;
  // 价格基本没涨（<=0.3%）但OBV仍明显上行（>=20%量能区间），视为价量正背离（早期信号）。
  const diverging = priceSlopePct <= 0.3 && obvSlopePct >= 20;
  return { diverging, magnitude: round(Math.abs(obvSlopePct - priceSlopePct), 2) ?? 0 };
}

/** 顶级账户多空比近6h斜率 − 全市场账户多空比近6h斜率；正且明显=高净值账户领先散户调整方向。单位：比值/小时。 */
export function computeTopShortDivergence(topRatioSeries: RatioPoint[], globalRatioSeries: RatioPoint[], hours = 6): number | null {
  const topEnd = topRatioSeries.at(-1)?.time,
    globalEnd = globalRatioSeries.at(-1)?.time;
  if (topEnd === undefined || globalEnd === undefined) return null;
  const top = topRatioSeries.filter((p) => p.time >= topEnd - hours * 3600000);
  const global = globalRatioSeries.filter((p) => p.time >= globalEnd - hours * 3600000);
  const topSlope = slopePerHour(top),
    globalSlope = slopePerHour(global);
  if (topSlope === null || globalSlope === null) return null;
  return round(topSlope - globalSlope, 5);
}

// ---- 归一化映射（0-100），区间为经验取值，未回测；写在这里保持公式可复现 ----
const normalizeTopDivergence = (v: number) => clamp(((v + 0.02) / 0.08) * 100, 0, 100); // 域 [-0.02, 0.06] 比值/小时
const normalizeStreak = (v: number) => clamp((Math.max(0, v) / 12) * 100, 0, 100); // 12根1h同向K线=满分域
const normalizeTradeSize = (pct: number) => clamp((pct - 50) * 2, 0, 100); // 仅奖励高于历史中位数的单笔均值

export function computeEarlySignal(input: EarlySignalInputs, ctx: EarlySignalContext): EarlySignal {
  const atrLatest = input.atrPctSeries.at(-1);
  const volSqueezePct = input.atrPctSeries.length >= 9 && finite(atrLatest) ? percentileRank(input.atrPctSeries.slice(0, -1), atrLatest) : null;
  const tradeLatest = input.avgTradeSizeSeries.at(-1);
  const avgTradeSizePct =
    input.avgTradeSizeSeries.length >= 9 && finite(tradeLatest) ? percentileRank(input.avgTradeSizeSeries.slice(0, -1), tradeLatest) : null;
  const oiAccel = computeOiAccel(input.oiQtyHourly);
  const netRatioStreak = computeNetRatioStreak(input.netRatioHourly);
  const obvDivergence = computeObvDivergence(input.closeSeries, input.quoteVolumeSeries);
  const topShortDivergence = computeTopShortDivergence(input.topRatioSeries, input.globalRatioSeries);
  const fundingLag = finite(input.fundingDaily) ? round(Math.abs(input.fundingDaily), 4) : null;

  const topTerm = topShortDivergence === null ? null : Math.min(30, normalizeTopDivergence(topShortDivergence));
  const squeezeTerm = volSqueezePct === null ? null : Math.min(25, (100 - volSqueezePct) * 0.25);
  const streakTerm = netRatioStreak === null ? null : Math.min(25, normalizeStreak(netRatioStreak));
  const tradeTerm = avgTradeSizePct === null ? null : Math.min(20, normalizeTradeSize(avgTradeSizePct));
  const terms = [topTerm, squeezeTerm, streakTerm, tradeTerm];
  const known = terms.filter((t): t is number => t !== null);
  // 缺失子项不按0填充；样本覆盖率<2/4时分数不具可比性，返回 null。
  let earlyScore = known.length >= 2 ? round(known.reduce((a, b) => a + b, 0), 1) : null;
  // fundingLag 仅作否决/折扣：资金费率已明显偏离（说明市场可能已察觉），对早期分打折，不作为加分项。
  if (earlyScore !== null && fundingLag !== null && fundingLag >= 0.08) earlyScore = round(earlyScore * 0.85, 1);

  const earlyCandidate =
    finite(ctx.oi4) &&
    finite(ctx.p4) &&
    finite(ctx.netRatio4h) &&
    volSqueezePct !== null &&
    ctx.oi4! >= 3 &&
    Math.abs(ctx.p4!) < 1 &&
    ctx.netRatio4h! >= 5 &&
    volSqueezePct < 30;

  return {
    ruleVersion: EARLY_SIGNAL_RULE,
    volSqueezePct,
    oiAccel,
    topShortDivergence,
    avgTradeSizePct,
    netRatioStreak,
    obvDivergence,
    fundingLag,
    earlyScore,
    earlyScoreCoverage: known.length,
    earlyCandidate: Boolean(earlyCandidate),
  };
}
