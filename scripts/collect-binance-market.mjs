import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const symbols = ["ZECUSDT", "DOTUSDT", "ARBUSDT", "1000PEPEUSDT", "SOLUSDT", "XRPUSDT"];
const base = "https://fapi.binance.com";

async function json(path) {
  const response = await fetch(base + path, { headers: { accept: "application/json", "user-agent": "AlphaRadar/1.0" } });
  if (!response.ok) throw new Error(path + " returned " + response.status);
  return response.json();
}

async function collect(symbol) {
  const q = encodeURIComponent(symbol);
  const [ticker, premium, interest, longShort, taker] = await Promise.all([
    json("/fapi/v1/ticker/24hr?symbol=" + q),
    json("/fapi/v1/premiumIndex?symbol=" + q),
    json("/fapi/v1/openInterest?symbol=" + q),
    json("/futures/data/globalLongShortAccountRatio?symbol=" + q + "&period=5m&limit=1"),
    json("/futures/data/takerlongshortRatio?symbol=" + q + "&period=5m&limit=1"),
  ]);
  return {
    symbol,
    lastPrice: Number(ticker.lastPrice),
    priceChangePercent: Number(ticker.priceChangePercent),
    quoteVolume: Number(ticker.quoteVolume),
    markPrice: Number(premium.markPrice),
    fundingRate: Number(premium.lastFundingRate),
    openInterest: Number(interest.openInterest),
    longShortRatio: longShort[0] ? Number(longShort[0].longShortRatio) : null,
    takerBuySellRatio: taker[0] ? Number(taker[0].buySellRatio) : null,
  };
}

const capturedAt = new Date().toISOString();
const settled = await Promise.allSettled(symbols.map(collect));
const markets = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
const errors = settled.flatMap((result, index) => result.status === "rejected" ? [{ symbol: symbols[index], error: String(result.reason) }] : []);
const snapshot = { source: "Binance official USD-M Futures public API", capturedAt, markets, errors };
const directory = resolve("data", "market");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "latest.json"), JSON.stringify(snapshot, null, 2) + "\n", "utf8");
await appendFile(resolve(directory, "snapshots.ndjson"), JSON.stringify(snapshot) + "\n", "utf8");
console.log(JSON.stringify({ capturedAt, markets: markets.length, errors }));
if (!markets.length) process.exitCode = 1;
