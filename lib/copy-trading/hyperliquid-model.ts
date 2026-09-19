// Hyperliquid 聪明钱模块 Phase 1：完全替换原币安带单模块。详见 docs/module-redesign-v2.md 第四节。
// 与原币安模块（lib/copy-trading/model.ts，现已不再被页面使用，保留供参考）的关键差异：
//   - 能看到「现在」的实时持仓（clearinghouseState），不再依赖重建历史订单推断已平仓周期；
//   - 没有对手账户和撮合级数据，也没有「订单笔数/边界周期」这类可重建证据，因此没有移植币安那 11 项资格门槛，
//     改用一套更小、明确标注未回测的门槛（见 evaluateEntity 的 checks）；
//   - Hyperliquid 全链上公开透明，缺乏「对刷/快速反向」这类需要私有撮合数据才能判断的异常筛查，本版不做等价物。
import type { HyperliquidClearinghouseState, HyperliquidLeaderboardRow, HyperliquidVaultDetails, HyperliquidVaultSummaryEntry } from "./hyperliquid";

export const RULE_VERSION = "hyperliquid-copy-v1";
export const FRESH_MS = 12 * 3600000; // 实时持仓的新鲜度窗口；比币安版本的48小时更短，因为这里展示的是"现在"的持仓，不是历史。
export type Kind = "trader" | "vault";
export type Pool = "quality" | "ordinary";
export type WindowKey = "day" | "week" | "month" | "allTime";
export const WINDOWS: WindowKey[] = ["day", "week", "month", "allTime"];

const numeric = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v: number | null, n = 2): number | null => (v === null ? null : Math.round(v * 10 ** n) / 10 ** n);

export interface RawEntity {
  kind: Kind;
  address: string;
  name: string | null;
  leader?: string | null;
  tvl?: number | null;
  createdAt?: number | null;
  isClosed?: boolean | null;
  allowDeposits?: boolean | null;
  followerCount?: number | null;
  leaderCommission?: number | null;
  apr?: number | null;
  performance: Partial<Record<WindowKey, { pnl: number | null; roi: number | null; vlm: number | null }>>;
  clearinghouse: HyperliquidClearinghouseState | null;
  clearinghouseError?: string | null;
  observedAt: string;
}

/** 从官方个人交易员排行榜行构建原始条目（窗口业绩已在快照里自带，不需要额外请求）。 */
export function rawEntityFromLeaderboard(row: HyperliquidLeaderboardRow, clearinghouse: HyperliquidClearinghouseState | null, error: string | null, observedAt: string): RawEntity {
  const performance: RawEntity["performance"] = {};
  for (const [window, perf] of row.windowPerformances ?? []) {
    if (WINDOWS.includes(window as WindowKey)) performance[window as WindowKey] = { pnl: numeric(perf.pnl), roi: numeric(perf.roi), vlm: numeric(perf.vlm) };
  }
  return { kind: "trader", address: row.ethAddress, name: row.displayName, performance, clearinghouse, clearinghouseError: error, observedAt };
}

/** 从官方金库列表条目构建原始条目；金库自带的 pnls 只有数值序列没有时间戳，这里只取最后一个点作为该窗口的"当前"盈亏。
 *  vaultDetails（可选增强）能补充 followers/allowDeposits/leaderCommission，缺失时这些字段保持 null，不影响门槛判定以外的展示。 */
export function rawEntityFromVault(
  entry: HyperliquidVaultSummaryEntry,
  detail: HyperliquidVaultDetails | null,
  clearinghouse: HyperliquidClearinghouseState | null,
  error: string | null,
  observedAt: string
): RawEntity {
  const performance: RawEntity["performance"] = {};
  for (const [window, series] of entry.pnls ?? []) {
    if (WINDOWS.includes(window as WindowKey) && series.length) performance[window as WindowKey] = { pnl: numeric(series.at(-1)), roi: null, vlm: null };
  }
  return {
    kind: "vault",
    address: entry.summary.vaultAddress,
    name: entry.summary.name,
    leader: entry.summary.leader,
    tvl: numeric(entry.summary.tvl),
    createdAt: entry.summary.createTimeMillis ?? null,
    isClosed: entry.summary.isClosed,
    allowDeposits: detail?.allowDeposits ?? null,
    followerCount: detail?.followers?.length ?? null,
    leaderCommission: detail?.leaderCommission ?? null,
    apr: detail?.apr ?? entry.apr ?? null,
    performance,
    clearinghouse,
    clearinghouseError: error,
    observedAt,
  };
}

export interface PositionView {
  coin: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPx: number | null;
  leverage: number | null;
  leverageType: string | null;
  notional: number | null;
  unrealizedPnl: number | null;
  liquidationPx: number | null;
  marginUsed: number | null;
}

function positionsFrom(state: HyperliquidClearinghouseState | null): PositionView[] {
  if (!state) return [];
  return (state.assetPositions ?? [])
    .map((a) => a.position)
    .map((p) => {
      const szi = numeric(p.szi);
      if (szi === null || szi === 0) return null;
      return {
        coin: p.coin,
        side: (szi > 0 ? "LONG" : "SHORT") as "LONG" | "SHORT",
        size: Math.abs(szi),
        entryPx: numeric(p.entryPx),
        leverage: numeric(p.leverage?.value ?? null),
        leverageType: p.leverage?.type ?? null,
        notional: numeric(p.positionValue),
        unrealizedPnl: numeric(p.unrealizedPnl),
        liquidationPx: numeric(p.liquidationPx),
        marginUsed: numeric(p.marginUsed),
      };
    })
    .filter((p): p is PositionView => p !== null);
}

export function evaluateEntity(raw: RawEntity, now = Date.now()) {
  const positions = positionsFrom(raw.clearinghouse);
  const accountValue = numeric(raw.clearinghouse?.marginSummary.accountValue ?? null);
  const totalMarginUsed = numeric(raw.clearinghouse?.marginSummary.totalMarginUsed ?? null);
  const longNotional = positions.filter((p) => p.side === "LONG").reduce((s, p) => s + (p.notional ?? 0), 0);
  const shortNotional = positions.filter((p) => p.side === "SHORT").reduce((s, p) => s + (p.notional ?? 0), 0);
  const totalNotional = longNotional + shortNotional;
  const netExposurePct = totalNotional > 0 ? round(((longNotional - shortNotional) / totalNotional) * 100) : null;
  const weightedLeverage = totalNotional > 0 ? positions.reduce((s, p) => s + (p.leverage ?? 0) * (p.notional ?? 0), 0) / totalNotional : null;

  const allTime = raw.performance.allTime ?? null;
  const day = raw.performance.day ?? null,
    week = raw.performance.week ?? null;
  const observedMs = Date.parse(raw.observedAt);
  const fresh = Number.isFinite(observedMs) && now - observedMs <= FRESH_MS && observedMs <= now + 300000;
  const ageDays = raw.createdAt ? Math.max(0, (now - raw.createdAt) / 86400000) : null;
  const recentActivity = (day?.vlm ?? 0) > 0 || (week?.vlm ?? 0) > 0 || positions.length > 0;

  const checks = [
    { key: "data", label: "本次实时持仓查询成功（clearinghouseState 无错误）", pass: raw.clearinghouse !== null && !raw.clearinghouseError },
    { key: "fresh", label: "数据在" + FRESH_MS / 3600000 + "小时内采集", pass: fresh },
    { key: "scale", label: "账户价值≥$20,000", pass: accountValue !== null && accountValue >= 20000 },
    { key: "pnl", label: "全部历史（allTime）浮动盈亏为正", pass: allTime?.pnl !== null && allTime !== null && (allTime.pnl ?? 0) > 0 },
    { key: "active", label: "近1周有成交量或当前持有实盘仓位", pass: recentActivity },
    ...(raw.kind === "vault"
      ? [
          { key: "open", label: "金库仍在开放、接受新存款（未知不算不通过）", pass: raw.isClosed !== true && raw.allowDeposits !== false },
          { key: "tenure", label: "金库运行至少30天", pass: ageDays !== null && ageDays >= 30 },
        ]
      : []),
  ].map((c) => ({ ...c, pass: Boolean(c.pass) }));
  const eligible = checks.every((c) => c.pass);

  return {
    kind: raw.kind,
    address: raw.address,
    name: raw.name,
    leader: raw.leader ?? null,
    tvl: raw.tvl ?? null,
    createdAt: raw.createdAt ?? null,
    ageDays: round(ageDays, 1),
    isClosed: raw.isClosed ?? null,
    allowDeposits: raw.allowDeposits ?? null,
    followerCount: raw.followerCount ?? null,
    leaderCommission: raw.leaderCommission ?? null,
    apr: raw.apr ?? null,
    performance: raw.performance,
    accountValue,
    totalMarginUsed,
    positions,
    positionCount: positions.length,
    distinctCoins: new Set(positions.map((p) => p.coin)).size,
    longNotional: round(longNotional, 0),
    shortNotional: round(shortNotional, 0),
    totalNotional: round(totalNotional, 0),
    netExposurePct,
    weightedLeverage: round(weightedLeverage, 1),
    observedAt: raw.observedAt,
    fresh,
    error: raw.clearinghouseError ?? null,
    checks,
    pool: (eligible ? "quality" : "ordinary") as Pool,
    autoTag: eligible ? "聪明钱候选" : !checks.find((c) => c.key === "data")?.pass ? "本轮数据未获取" : "继续观察",
    reasons: checks.filter((c) => !c.pass).map((c) => c.label),
  };
}
export type Entity = ReturnType<typeof evaluateEntity>;

// ---- 跨快照持仓变化追踪 ----
// 项目里没有接入任何数据库（db/schema.ts 有现成的 traders/traderSnapshots/tradeEvents 表，但没有任何真实模块在用它；
// 指标、广场、带单三个模块全部是 data/<module>/ + public/<module>/latest.json 的平铺 JSON 文件），这里延续同样的约定，
// 不引入新的存储方式：把"事件"直接累积在快照 JSON 自己的 events 数组里（做法与原币安模块 makeSnapshot 的 changes 日志一致）。
export const SIZE_CHANGE_THRESHOLD = 0.3; // 名义价值变化≥30%才记为增/减仓事件；阈值为经验取值，未回测，用于过滤价格波动造成的噪音。
export interface PositionEvent {
  address: string;
  name: string | null;
  kind: Kind;
  coin: string;
  type: "opened" | "closed" | "reversed" | "increased" | "reduced";
  fromSide: "LONG" | "SHORT" | null;
  toSide: "LONG" | "SHORT" | null;
  fromNotional: number | null;
  toNotional: number | null;
  detectedAt: string;
}
/** 比较前后两轮快照的持仓，产出变化事件。只对上一轮也出现过的地址比较——新发现的地址没有基线，
 *  它当前的持仓不算"新开仓"，只是我们第一次看到它（不按"以前没有"推断，缺失基线就是缺失基线）。 */
export function diffPositions(previous: Entity[] | undefined | null, current: { address: string; kind: Kind; name: string | null; positions: PositionView[] }[], detectedAt: string): PositionEvent[] {
  if (!previous?.length) return [];
  const prevByAddress = new Map(previous.map((e) => [e.address, e]));
  const events: PositionEvent[] = [];
  for (const cur of current) {
    const prev = prevByAddress.get(cur.address);
    if (!prev) continue;
    const prevByCoin = new Map(prev.positions.map((p) => [p.coin, p]));
    const currByCoin = new Map(cur.positions.map((p) => [p.coin, p]));
    const coins = new Set([...prevByCoin.keys(), ...currByCoin.keys()]);
    const meta = { address: cur.address, name: cur.name, kind: cur.kind };
    for (const coin of coins) {
      const before = prevByCoin.get(coin) ?? null,
        after = currByCoin.get(coin) ?? null;
      if (!before && after) {
        events.push({ ...meta, coin, type: "opened", fromSide: null, toSide: after.side, fromNotional: null, toNotional: after.notional, detectedAt });
      } else if (before && !after) {
        events.push({ ...meta, coin, type: "closed", fromSide: before.side, toSide: null, fromNotional: before.notional, toNotional: null, detectedAt });
      } else if (before && after) {
        if (before.side !== after.side) {
          events.push({ ...meta, coin, type: "reversed", fromSide: before.side, toSide: after.side, fromNotional: before.notional, toNotional: after.notional, detectedAt });
        } else {
          const b = before.notional ?? 0,
            a = after.notional ?? 0;
          if (b > 0 && Math.abs(a - b) / b >= SIZE_CHANGE_THRESHOLD) {
            events.push({ ...meta, coin, type: a > b ? "increased" : "reduced", fromSide: before.side, toSide: after.side, fromNotional: before.notional, toNotional: after.notional, detectedAt });
          }
        }
      }
    }
  }
  return events;
}

// 显式声明返回类型，避免 previous?:Snapshot 的参数类型和函数自身的 ReturnType 互相循环引用。
export interface Snapshot {
  schemaVersion: 2;
  ruleVersion: string;
  generatedAt: string;
  source: string;
  entities: Entity[];
  events: PositionEvent[];
  coverage: { discoveredTraders: number; discoveredVaults: number; analyzed: number; quality: number; ordinary: number; positionErrors: number; newEvents: number };
  notes: string[];
}
export function buildHyperliquidSnapshot(rows: RawEntity[], discovered: { traders: number; vaults: number }, now = Date.now(), previous?: Snapshot | null): Snapshot {
  // 同一地址不该同时以"个人交易员"和"金库"两种身份各出现一次——一个真实例子是 HLP 金库，
  // 它的链上地址账户价值巨大，天然也会出现在官方的个人交易员总排行榜里。采集脚本已经按已知金库地址过滤了候选，
  // 这里再做一次兜底去重（按 address，金库身份优先），不依赖调用方一定做对，避免页面按 address 当 key 时崩溃或重复计数。
  const dedup = new Map<string, RawEntity>();
  for (const r of rows) {
    const prior = dedup.get(r.address);
    if (!prior || (prior.kind !== "vault" && r.kind === "vault")) dedup.set(r.address, r);
  }
  const entities = [...dedup.values()].map((r) => evaluateEntity(r, now)).sort((a, b) => Number(b.pool === "quality") - Number(a.pool === "quality") || (b.accountValue ?? 0) - (a.accountValue ?? 0));
  const quality = entities.filter((e) => e.pool === "quality").length;
  const detectedAt = new Date(now).toISOString();
  const newEvents = diffPositions(previous?.entities, entities, detectedAt);
  // 事件只在两次采集之间做净比较：如果中间隔了很久，多次开平仓可能被合并成一次净变化，或完全被错过；不是逐笔成交记录。
  const events = [...newEvents, ...(previous?.events ?? [])].slice(0, 500);
  return {
    schemaVersion: 2 as const,
    ruleVersion: RULE_VERSION,
    generatedAt: detectedAt,
    source: "Hyperliquid 官方公开数据：地址发现用 stats-data.hyperliquid.xyz（官方前端排行榜/金库列表实际调用的公开快照），持仓与详情用 api.hyperliquid.xyz/info 官方文档接口",
    entities,
    events,
    coverage: {
      discoveredTraders: discovered.traders,
      discoveredVaults: discovered.vaults,
      analyzed: entities.length,
      quality,
      ordinary: entities.length - quality,
      positionErrors: entities.filter((e) => e.error).length,
      newEvents: newEvents.length,
    },
    notes: [
      "候选是本工具的研究标记，不是 Hyperliquid 官方认证，门槛未回测。公开持仓不能证明策略质量，也不能排除对手方风险。",
      "Hyperliquid 全链上撮合公开透明，没有对手账户对刷这类需要私有撮合数据才能判断的异常，本版不做该类筛查。",
      "个人交易员的地址是公开钱包地址，可能包含多个策略或委托资金，并非都专注单一交易风格；金库（vault）地址是链上合约地址，持仓即金库自身策略。",
      "业绩窗口（day/week/month/allTime）为 Hyperliquid 官方口径，彼此滚动重叠，不是独立分段业绩；金库的窗口数值来自官方快照的末尾点，不是时间序列均值。",
      "实时持仓是查询时刻的快照，不是逐笔成交记录；未实现盈亏随价格波动，仅供参考，不是已实现收益。",
      "候选门槛：账户价值≥$20,000、全部历史浮动盈亏为正、近1周有成交或持仓；金库额外要求仍开放存款、运行≥30天。均为经验取值，会随样本调整。",
      "地址发现来自官方排行榜/金库快照的候选子集（账户价值或TVL较高的部分），不是全市场地址普查，存在选择偏差。",
      "持仓变化事件（events）只比较相邻两次采集的净结果，不是逐笔成交流水；采集间隔越长，越可能漏掉中间的开平仓，或把多次变化合并成一次。新地址第一次出现时不产生事件（没有基线可比）。变化阈值（±30%名义价值）未回测。",
    ],
  };
}
