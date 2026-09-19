// Hyperliquid 聪明钱 Phase 1：完全替换币安带单模块的数据源。详见 docs/module-redesign-v2.md 第三节（Phase 0）与第四节（Phase 1）。
// 两类只读、免鉴权、官方数据源：
//   1) POST https://api.hyperliquid.xyz/info（官方文档化接口）：clearinghouseState 查实时持仓、vaultDetails 查金库详情、userFills 查历史成交。
//      按 IP 限速，聚合权重预算 1200/分钟；clearinghouseState 权重2，vaultDetails/userFills 权重20（本文件按20保守估计）。
//   2) GET https://stats-data.hyperliquid.xyz/Mainnet/{leaderboard,vaults}：Hyperliquid 官方前端（app.hyperliquid.xyz/leaderboard、/vaults）
//      自己渲染排行榜时实际调用的公开只读 JSON 快照（无鉴权、无分页，一次性返回全量），用作地址发现，不抓取网页 HTML、不逆向未公开接口。
export const HYPERLIQUID_RULE = "hyperliquid-phase1-v1";
const ENDPOINT = "https://api.hyperliquid.xyz/info";
const STATS_BASE = "https://stats-data.hyperliquid.xyz/Mainnet";

export interface HyperliquidPosition {
  coin: string;
  szi: string; // 有符号仓位规模，字符串数值（正=多，负=空）
  entryPx: string | null;
  leverage: { type: string; value: number } | null;
  unrealizedPnl: string | null;
  liquidationPx: string | null;
  marginUsed: string | null;
  positionValue: string | null;
}

export interface HyperliquidMarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface HyperliquidClearinghouseState {
  assetPositions: { position: HyperliquidPosition; type: string }[];
  marginSummary: HyperliquidMarginSummary;
  crossMarginSummary?: HyperliquidMarginSummary;
  withdrawable?: string;
}

export interface HyperliquidFill {
  coin: string;
  px: string;
  sz: string;
  side: string; // "B" 买 / "A" 卖
  time: number;
  startPosition?: string;
  dir?: string;
  closedPnl?: string;
  hash?: string;
  oid?: number;
  fee?: string;
}

/** vaultDetails 返回的单个窗口业绩：accountValueHistory/pnlHistory 为 [时间戳,数值字符串] 对，vlm 为该窗口累计名义成交额。 */
export interface HyperliquidVaultWindow {
  accountValueHistory: [number, string][];
  pnlHistory: [number, string][];
  vlm: string;
}
export interface HyperliquidVaultFollower {
  user: string;
  vaultEquity: string;
  pnl: string;
  allTimePnl: string;
  daysFollowing: number;
  vaultEntryTime: number;
  lockupUntil: number;
}
export interface HyperliquidVaultRelationship {
  type: "normal" | "child" | "parent" | string;
  data?: { childAddresses?: string[] } | null;
}
export interface HyperliquidVaultDetails {
  name: string;
  vaultAddress: string;
  leader: string;
  description: string;
  portfolio: [string, HyperliquidVaultWindow][];
  apr: number;
  followerState: unknown;
  leaderFraction: number;
  leaderCommission: number;
  followers: HyperliquidVaultFollower[];
  maxDistributable: number;
  maxWithdrawable: number;
  isClosed: boolean;
  relationship: HyperliquidVaultRelationship;
  allowDeposits: boolean;
  alwaysCloseOnWithdraw: boolean;
}

/** stats-data.hyperliquid.xyz/Mainnet/vaults：官方前端渲染 /vaults 列表页实际调用的公开 JSON 快照，一次性返回全量金库（含已关闭的）。 */
export interface HyperliquidVaultSummaryEntry {
  apr: number;
  pnls: [string, string[]][];
  summary: {
    name: string;
    vaultAddress: string;
    leader: string;
    tvl: string;
    isClosed: boolean;
    relationship: HyperliquidVaultRelationship;
    createTimeMillis: number;
  };
}
/** stats-data.hyperliquid.xyz/Mainnet/leaderboard：官方前端渲染 /leaderboard 页实际调用的公开 JSON 快照，一次性返回全量个人交易员排名。 */
export interface HyperliquidLeaderboardRow {
  ethAddress: string;
  accountValue: string;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
  prize: number;
  displayName: string | null;
}

export class HyperliquidError extends Error {
  status?: number;
  // Node 的 TypeScript strip-only 模式不支持构造函数参数属性简写，这里手动赋值。
  constructor(message: string, status?: number) {
    super(message);
    this.name = "HyperliquidError";
    this.status = status;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addressPattern = /^0x[0-9a-fA-F]{40}$/;

// 官方 /info 接口按 IP 聚合权重限速，预算 1200/分钟；这里只保守跟踪本进程发出的权重，留 25% 余量（900/分钟），
// 不追求精确复刻官方计费规则，只求不主动撞到限速——precisely matching the doc's "respect real limits, never bypass" stance
// established in scripts/update-copy-pools.mjs after repeated 429/限流 failures on the Binance side.
const WEIGHT_BUDGET_PER_MINUTE = 900;
const weightLog: { at: number; weight: number }[] = [];
async function throttle(weight: number) {
  for (;;) {
    const now = Date.now();
    while (weightLog.length && now - weightLog[0].at > 60000) weightLog.shift();
    const spent = weightLog.reduce((s, w) => s + w.weight, 0);
    if (spent + weight <= WEIGHT_BUDGET_PER_MINUTE) {
      weightLog.push({ at: now, weight });
      return;
    }
    await wait(Math.max(50, 60000 - (now - weightLog[0].at) + 10));
  }
}

/** 对 /info 的通用 POST 封装：先按权重预算排队，网络失败重试，429 按 Retry-After（或指数退避）暂停，非200直接报错不静默。 */
async function post<T>(body: Record<string, unknown>, weight: number, attempts = 3): Promise<T> {
  await throttle(weight);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429) {
        lastError = new HyperliquidError("HTTP 429：限流，重试后仍未恢复", 429);
        if (attempt === attempts - 1) break;
        const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await wait(Math.min(30000, retryAfter * 1000));
        continue;
      }
      if (!res.ok) throw new HyperliquidError("HTTP " + res.status, res.status);
      return (await res.json()) as T;
    } catch (e) {
      lastError = e;
      if (e instanceof HyperliquidError && e.status && e.status < 500 && e.status !== 429) throw e;
      if (attempt < attempts - 1) await wait(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new HyperliquidError(String(lastError));
}

const requireAddress = (address: string) => {
  if (!addressPattern.test(address)) throw new HyperliquidError("地址格式无效，应为 0x 开头的40位十六进制地址：" + address);
};

/** 查询某地址当前的实时持仓、保证金与账户总价值。地址需为 0x 开头的以太坊风格地址（Hyperliquid 使用 EVM 地址体系）；vault 地址同样适用。 */
export async function fetchClearinghouseState(address: string): Promise<HyperliquidClearinghouseState> {
  requireAddress(address);
  return post<HyperliquidClearinghouseState>({ type: "clearinghouseState", user: address }, 2);
}

/** 查询某地址的历史成交（userFills）。startTime 为可选的毫秒时间戳，仅取该时间之后的成交。 */
export async function fetchUserFills(address: string, startTime?: number): Promise<HyperliquidFill[]> {
  requireAddress(address);
  const body: Record<string, unknown> = startTime ? { type: "userFillsByTime", user: address, startTime } : { type: "userFills", user: address };
  const data = await post<HyperliquidFill[]>(body, 20);
  return Array.isArray(data) ? data : [];
}

/** 查询某个金库的详情：业绩窗口序列、APR、跟随者、是否接受新存款等。vaultAddress 必须来自 fetchVaultList() 或其他官方来源，不接受任意地址猜测。 */
export async function fetchVaultDetails(vaultAddress: string): Promise<HyperliquidVaultDetails> {
  requireAddress(vaultAddress);
  return post<HyperliquidVaultDetails>({ type: "vaultDetails", vaultAddress }, 20);
}

/** 地址发现：官方个人交易员排行榜全量快照（不分页，一次性返回全部地址；本文件不做速率限制，因为只请求一次）。 */
export async function fetchLeaderboard(): Promise<HyperliquidLeaderboardRow[]> {
  const res = await fetch(STATS_BASE + "/leaderboard", { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new HyperliquidError("排行榜快照 HTTP " + res.status, res.status);
  const data = (await res.json()) as { leaderboardRows?: unknown };
  if (!Array.isArray(data.leaderboardRows)) throw new HyperliquidError("排行榜快照结构无效");
  return data.leaderboardRows as HyperliquidLeaderboardRow[];
}

/** 地址发现：官方金库列表全量快照（含已关闭的金库，调用方自行过滤）。 */
export async function fetchVaultList(): Promise<HyperliquidVaultSummaryEntry[]> {
  const res = await fetch(STATS_BASE + "/vaults", { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new HyperliquidError("金库快照 HTTP " + res.status, res.status);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new HyperliquidError("金库快照结构无效");
  return data as HyperliquidVaultSummaryEntry[];
}
