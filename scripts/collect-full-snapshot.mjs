import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const capturedAt = new Date().toISOString();
const stamp = capturedAt.replace(/[:.]/g, "-");
const runDir = process.argv[2] || join(root, "data", "full-snapshots", stamp);
await mkdir(runDir, { recursive: true });

const headers = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 (Alpha Radar research snapshot)",
  clienttype: "web",
  lang: "en",
  "bnc-location": "GLOBAL",
};
const bapi = "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade";

async function fetchJson(url, options = {}, label = url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      if (!response.ok) throw new Error(label + " HTTP " + response.status + ": " + text.slice(0, 180));
      const json = JSON.parse(text);
      if (json && json.success === false) throw new Error(label + " API " + json.code + ": " + json.message);
      return json;
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 350 * attempt));
    }
  }
  throw last;
}

async function pool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        output[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        output[index] = { ok: false, error: String(error), item: items[index] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return output;
}

async function postBapi(path, body) {
  return fetchJson(bapi + path, { method: "POST", headers, body: JSON.stringify(body) }, path);
}

const hotCoins = JSON.parse(await readFile(join(runDir, "hot-coins.json"), "utf8"));
const marketOverview = JSON.parse(await readFile(join(runDir, "market-overview.json"), "utf8"));
const timeRanges = ["7D", "30D", "90D", "180D"];
const dataTypes = ["ROI", "PNL", "AUM", "COPIER_PNL", "SHARP_RATIO", "MDD", "WIN_RATE"];
const leaderboardRequests = dataTypes.flatMap(dataType =>
  timeRanges.map(timeRange => ({ dataType, timeRange, order: dataType === "MDD" ? "ASC" : "DESC" }))
);
const leaderboardResults = await pool(leaderboardRequests, 4, async request => {
  const response = await postBapi("/home-page/query-list", {
    pageNumber: 1, pageSize: 50, timeRange: request.timeRange, dataType: request.dataType,
    favoriteOnly: false, hideFull: false, nickname: "", order: request.order, apiKeyOnly: false,
  });
  return { request, total: response.data?.total ?? 0, list: response.data?.list ?? [] };
});
const leaderboards = leaderboardResults.filter(x => x.ok).map(x => x.value);
const leaderboardErrors = leaderboardResults.filter(x => !x.ok);
await writeFile(join(runDir, "copy-trader-leaderboards.json"), JSON.stringify({ capturedAt, leaderboards, errors: leaderboardErrors }, null, 2) + "\n");

const seen = new Map();
for (const board of leaderboards) {
  board.list.forEach((trader, index) => {
    const id = trader.leadPortfolioId;
    const entry = seen.get(id) || { trader, rankHits: 0, bestRank: 999, ranks: [] };
    entry.rankHits++;
    entry.bestRank = Math.min(entry.bestRank, index + 1);
    entry.ranks.push({ dataType: board.request.dataType, timeRange: board.request.timeRange, rank: index + 1 });
    seen.set(id, entry);
  });
}
const now = Date.now();
const quality = [...seen.values()].filter(({ trader }) => {
  const ageDays = trader.startTime ? (now - trader.startTime) / 86400000 : 0;
  return ageDays >= 7 && Number(trader.pnl) > 0 && Number(trader.copierPnl) > 0 &&
    Number(trader.aum) >= 1000 && Number(trader.mdd) <= 50;
});
quality.sort((a, b) => b.rankHits - a.rankHits || a.bestRank - b.bestRank ||
  Number(b.trader.copierPnl) - Number(a.trader.copierPnl));
const selected = new Map();
for (const board of leaderboards) for (const trader of board.list.slice(0, 10)) selected.set(trader.leadPortfolioId, seen.get(trader.leadPortfolioId));
for (const entry of quality.slice(0, 120)) selected.set(entry.trader.leadPortfolioId, entry);
const selectedEntries = [...selected.values()].slice(0, 180);

const profileResults = await pool(selectedEntries, 6, async entry => {
  const id = entry.trader.leadPortfolioId;
  const response = await fetchJson(bapi + "/lead-portfolio/detail?portfolioId=" + encodeURIComponent(id), { headers }, "profile " + id);
  return { id, ranking: { rankHits: entry.rankHits, bestRank: entry.bestRank, ranks: entry.ranks }, data: response.data };
});
const profiles = profileResults.filter(x => x.ok).map(x => x.value);
const profileErrors = profileResults.filter(x => !x.ok);
await writeFile(join(runDir, "copy-trader-profiles.json"), JSON.stringify({ capturedAt, profiles, errors: profileErrors }, null, 2) + "\n");

async function collectOrders(profile) {
  if (!profile.data?.positionShow) return { id: profile.id, nickname: profile.data?.nickname, positionShow: false, total: null, orders: [] };
  const pageSize = 100, orders = [];
  let pageNumber = 1, total = null, indexValue = null;
  while (pageNumber <= 100) {
    const response = await postBapi("/lead-portfolio/order-history", { portfolioId: profile.id, pageNumber, pageSize });
    const data = response.data || {};
    if (total == null) total = Number(data.total || 0);
    if (indexValue == null) indexValue = data.indexValue ?? null;
    const page = data.list || [];
    orders.push(...page);
    if (!page.length || orders.length >= total) break;
    pageNumber++;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return { id: profile.id, nickname: profile.data?.nickname, positionShow: true, total, returned: orders.length, indexValue, truncated: total != null && orders.length < total, orders };
}
const publicProfiles = profiles.filter(p => p.data?.positionShow);
const orderResults = await pool(publicProfiles, 4, collectOrders);
const orderHistories = orderResults.filter(x => x.ok).map(x => x.value);
const orderErrors = orderResults.filter(x => !x.ok);
await writeFile(join(runDir, "copy-trader-order-history.json"), JSON.stringify({ capturedAt, histories: orderHistories, errors: orderErrors }, null, 2) + "\n");

const tokenSet = new Set(["ZEC", "DOT", "ARB", "PEPE", "SOL", "XRP"]);
for (const coin of hotCoins.coins || []) if (coin.token) tokenSet.add(coin.token);
for (const rows of Object.values(hotCoins.rankTypeData || {})) for (const coin of rows || []) if (coin.token) tokenSet.add(coin.token);
for (const token of marketOverview.hotTokens || []) if (token.symbol) tokenSet.add(token.symbol);
const tokens = [...tokenSet];
const [futuresExchange, spotExchange] = await Promise.all([
  fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo", {}, "futures exchangeInfo"),
  fetchJson("https://api.binance.com/api/v3/exchangeInfo", {}, "spot exchangeInfo"),
]);
const futuresSymbols = new Set((futuresExchange.symbols || []).filter(x => x.status === "TRADING" && x.contractType === "PERPETUAL").map(x => x.symbol));
const spotSymbols = new Set((spotExchange.symbols || []).filter(x => x.status === "TRADING").map(x => x.symbol));
function futureSymbol(token) {
  const direct = token + "USDT";
  if (futuresSymbols.has(direct)) return direct;
  const thousand = "1000" + token + "USDT";
  if (futuresSymbols.has(thousand)) return thousand;
  return null;
}
const mapping = tokens.map(token => ({ token, futuresSymbol: futureSymbol(token), spotSymbol: spotSymbols.has(token + "USDT") ? token + "USDT" : null }));

async function collectFuture(item) {
  if (!item.futuresSymbol) return { ...item, supported: false };
  const s = encodeURIComponent(item.futuresSymbol);
  const urls = {
    ticker24h: "https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=" + s,
    markPrice: "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=" + s,
    openInterest: "https://fapi.binance.com/fapi/v1/openInterest?symbol=" + s,
    globalLongShort15m: "https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=" + s + "&period=5m&limit=30",
    topAccounts15m: "https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=" + s + "&period=5m&limit=30",
    topPositions15m: "https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=" + s + "&period=5m&limit=30",
    taker15m: "https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=" + s + "&period=5m&limit=30",
    klines24h: "https://fapi.binance.com/fapi/v1/klines?symbol=" + s + "&interval=15m&limit=96",
  };
  const entries = await Promise.all(Object.entries(urls).map(async ([key, url]) => [key, await fetchJson(url, {}, item.futuresSymbol + " " + key)]));
  return { ...item, supported: true, data: Object.fromEntries(entries) };
}
async function collectSpot(item) {
  if (!item.spotSymbol) return { ...item, supported: false };
  const s = encodeURIComponent(item.spotSymbol);
  const [ticker24h, klines24h] = await Promise.all([
    fetchJson("https://api.binance.com/api/v3/ticker/24hr?symbol=" + s, {}, item.spotSymbol + " ticker"),
    fetchJson("https://api.binance.com/api/v3/klines?symbol=" + s + "&interval=15m&limit=96", {}, item.spotSymbol + " klines"),
  ]);
  return { ...item, supported: true, data: { ticker24h, klines24h } };
}
const [futureResults, spotResults] = await Promise.all([pool(mapping, 3, collectFuture), pool(mapping, 4, collectSpot)]);
await writeFile(join(runDir, "hot-coin-market-data.json"), JSON.stringify({ capturedAt, mapping, futures: futureResults, spot: spotResults }, null, 2) + "\n");

const orderCount = orderHistories.reduce((sum, x) => sum + x.orders.length, 0);
const manifest = {
  schemaVersion: 1, capturedAt, completedAt: new Date().toISOString(),
  scope: { leaderboardSlices: leaderboardRequests.length, rowsPerSlice: 50, selectedTraderProfiles: selectedEntries.length, hotTokens: tokens.length },
  results: {
    leaderboardSlicesSucceeded: leaderboards.length, leaderboardSlicesFailed: leaderboardErrors.length,
    uniqueRankedTraders: seen.size, profilesSucceeded: profiles.length, profilesFailed: profileErrors.length,
    profilesWithPublicPositions: publicProfiles.length, orderHistoriesSucceeded: orderHistories.length,
    orderHistoriesFailed: orderErrors.length, publicOrdersCollected: orderCount,
    futuresSymbolsSucceeded: futureResults.filter(x => x.ok && x.value.supported).length,
    futuresSymbolsUnsupported: futureResults.filter(x => x.ok && !x.value.supported).length,
    futuresSymbolsFailed: futureResults.filter(x => !x.ok).length,
    spotSymbolsSucceeded: spotResults.filter(x => x.ok && x.value.supported).length,
    spotSymbolsUnsupported: spotResults.filter(x => x.ok && !x.value.supported).length,
    spotSymbolsFailed: spotResults.filter(x => !x.ok).length,
  },
  files: ["hot-coins.json","market-overview.json","copy-trader-leaderboards.json","copy-trader-profiles.json","copy-trader-order-history.json","hot-coin-market-data.json"],
  sourceNotes: {
    binanceHotCoin: "Connected Binance official market-data tool", marketOverview: "Connected Binance official market-data tool",
    futuresAndSpot: "Official public REST market-data endpoints", copyTrading: "Binance public web BAPI used by public copy-trading pages",
    limitation: "Orders are available only when the lead trader exposes positions; hidden portfolios are explicitly marked positionShow=false.",
  },
};
await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(join(root, "data", "full-snapshots", "latest.json"), JSON.stringify({ runDir, ...manifest }, null, 2) + "\n");
console.log(JSON.stringify({ runDir, ...manifest.results }));
