// Hyperliquid 聪明钱采集：完全替换原币安带单模块。详见 docs/module-redesign-v2.md 第四节。
// 地址发现：官方排行榜/金库快照（一次性返回全量，无需分页）；持仓与金库详情：官方 api.hyperliquid.xyz/info 接口（内置权重限速）。
import { mkdir, writeFile, rename, open, unlink, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchClearinghouseState, fetchVaultDetails, fetchLeaderboard, fetchVaultList } from "../lib/copy-trading/hyperliquid.ts";
import { rawEntityFromLeaderboard, rawEntityFromVault, buildHyperliquidSnapshot } from "../lib/copy-trading/hyperliquid-model.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data/hyperliquid"),
  dest = join(root, "public/copy-trading");
await mkdir(dataDir, { recursive: true });
await mkdir(dest, { recursive: true });
const lockPath = join(dataDir, "update.lock");
let lock;
try {
  lock = await open(lockPath, "wx");
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
} catch {
  console.error("Hyperliquid 采集已有任务或遗留锁；请先检查，不重复启动。");
  process.exit(1);
}
const startedAt = new Date().toISOString();
const runDir = join(dataDir, startedAt.replace(/[:.]/g, "-"));
await mkdir(runDir, { recursive: true });
const progress = (x) => console.log(JSON.stringify(x));
const TRADER_CANDIDATES = 80,
  VAULT_CANDIDATES = 50,
  MIN_TRADER_ACCOUNT_VALUE = 20000;

// 读取上一轮快照用于跨快照持仓变化追踪；只有 schemaVersion===2（同样是 Hyperliquid 快照）才当作有效基线，
// 旧版币安快照或读取失败都当作没有基线（不产生任何"变化"事件），不拿不兼容的数据硬比较。
let previous = null;
try {
  const prevRaw = JSON.parse(await readFile(join(dest, "latest.json"), "utf8"));
  if (prevRaw?.schemaVersion === 2 && Array.isArray(prevRaw.entities)) previous = prevRaw;
} catch {
  /* no previous snapshot yet; first run has no baseline for diffing */
}

try {
  progress({ phase: "discovery", message: "正在拉取官方排行榜快照" });
  const leaderboard = await fetchLeaderboard();
  progress({ phase: "discovery", message: "正在拉取官方金库快照" });
  const vaultList = await fetchVaultList();
  await writeFile(join(runDir, "leaderboard-count.json"), JSON.stringify({ count: leaderboard.length }));
  await writeFile(join(runDir, "vaults-count.json"), JSON.stringify({ count: vaultList.length }));

  // 金库的链上地址本身也会作为一个普通地址出现在个人交易员排行榜里（比如 HLP 金库账户价值巨大，天然也上了总排行榜）。
  // 一个地址只应该有一种身份：既然它是金库，就不能同时又被当成"个人交易员"重复收录——不然快照里会出现同一地址两条记录，
  // 页面按 address 做 React key 会撞车，候选/观察池计数也会被同一个地址计两次。
  const vaultAddressSet = new Set(vaultList.map((v) => v.summary.vaultAddress));
  const byAccountValue = leaderboard.filter((r) => Number(r.accountValue) >= MIN_TRADER_ACCOUNT_VALUE && !vaultAddressSet.has(r.ethAddress)).sort((a, b) => Number(b.accountValue) - Number(a.accountValue));
  const byAllTimeRoi = leaderboard
    .filter((r) => Number(r.accountValue) >= MIN_TRADER_ACCOUNT_VALUE && !vaultAddressSet.has(r.ethAddress))
    .filter((r) => (r.windowPerformances ?? []).some(([w]) => w === "allTime"))
    .sort((a, b) => {
      const roi = (row) => Number(row.windowPerformances.find(([w]) => w === "allTime")?.[1]?.roi ?? 0);
      return roi(b) - roi(a);
    });
  const traderMap = new Map();
  for (const r of [...byAccountValue.slice(0, TRADER_CANDIDATES), ...byAllTimeRoi.slice(0, TRADER_CANDIDATES)]) traderMap.set(r.ethAddress, r);
  const traderCandidates = [...traderMap.values()];

  const activeVaults = vaultList.filter((v) => !v.summary.isClosed && v.summary.relationship?.type !== "child" && Number(v.summary.tvl) > 0).sort((a, b) => Number(b.summary.tvl) - Number(a.summary.tvl));
  const vaultCandidates = activeVaults.slice(0, VAULT_CANDIDATES);

  progress({ phase: "candidates", message: "候选：" + traderCandidates.length + " 位个人交易员、" + vaultCandidates.length + " 个金库", traders: traderCandidates.length, vaults: vaultCandidates.length });

  const rows = [];
  let done = 0;
  const total = traderCandidates.length + vaultCandidates.length;
  async function processTrader(row) {
    const observedAt = new Date().toISOString();
    try {
      const state = await fetchClearinghouseState(row.ethAddress);
      rows.push(rawEntityFromLeaderboard(row, state, null, observedAt));
    } catch (e) {
      rows.push(rawEntityFromLeaderboard(row, null, String(e), observedAt));
    }
    done++;
    if (done % 10 === 0 || done === total) progress({ phase: "profiles", message: "已复核 " + done + " / " + total, done, total });
  }
  async function processVault(entry) {
    const observedAt = new Date().toISOString();
    let detail = null,
      state = null,
      error = null;
    try {
      state = await fetchClearinghouseState(entry.summary.vaultAddress);
    } catch (e) {
      error = String(e);
    }
    try {
      detail = await fetchVaultDetails(entry.summary.vaultAddress);
    } catch {
      /* vaultDetails is an enrichment; missing detail keeps followers/allowDeposits/leaderCommission null, not a hard failure. */
    }
    rows.push(rawEntityFromVault(entry, detail, state, error, observedAt));
    done++;
    if (done % 10 === 0 || done === total) progress({ phase: "profiles", message: "已复核 " + done + " / " + total, done, total });
  }
  // 两类候选各自内部串行（共用 hyperliquid.ts 的全局权重限速），两类之间并行以缩短墙钟时间；限速队列已经防止合计请求超预算。
  await Promise.all([
    (async () => {
      for (const row of traderCandidates) await processTrader(row);
    })(),
    (async () => {
      for (const entry of vaultCandidates) await processVault(entry);
    })(),
  ]);

  const snapshot = buildHyperliquidSnapshot(rows, { traders: leaderboard.length, vaults: vaultList.length }, Date.now(), previous);
  await writeFile(join(runDir, "snapshot.json"), JSON.stringify(snapshot));
  await writeFile(join(runDir, "manifest.json"), JSON.stringify({ startedAt, completedAt: snapshot.generatedAt, coverage: snapshot.coverage }, null, 2));
  await writeFile(join(dest, "latest.json.tmp"), JSON.stringify(snapshot));
  await rename(join(dest, "latest.json.tmp"), join(dest, "latest.json"));
  progress({ phase: "complete", message: "Hyperliquid 聪明钱采集完成，本轮新增 " + snapshot.coverage.newEvents + " 条持仓变化事件", coverage: snapshot.coverage });
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  await lock.close();
  await unlink(lockPath);
}
