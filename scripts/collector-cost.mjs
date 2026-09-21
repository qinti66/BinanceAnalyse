// Which rate-limit family and how much weight a collector request costs. Weights are Binance's documented request weights; when one is not known
// it is over-estimated rather than under-estimated. Returns null for hosts outside the Binance families (CoinGecko keeps its own pacing).
import { klinesWeight } from "./rate-limit.mjs";

export function classifyRequest(url) {
  const u = new URL(url);
  const path = u.pathname;
  if (u.hostname === "api.binance.com") return { family: "spot", cost: 4 };
  const family = u.hostname === "fapi.binance.com" ? "umMarket" : u.hostname === "dapi.binance.com" ? "cmMarket" : null;
  if (!family) return null;
  if (path.startsWith("/futures/data/")) return { family: "futuresData", cost: 1 };
  if (path.endsWith("/klines")) return { family, cost: klinesWeight(Number(u.searchParams.get("limit")) || 500) };
  const bySymbol = u.searchParams.has("symbol") || u.searchParams.has("pair");
  if (path.endsWith("/ticker/24hr")) return { family, cost: bySymbol ? 1 : 40 };
  if (path.endsWith("/premiumIndex")) return { family, cost: bySymbol ? 1 : 10 };
  if (path.endsWith("/ticker/bookTicker")) return { family, cost: bySymbol ? 2 : 5 };
  if (path.endsWith("/exchangeInfo")) return { family, cost: 10 };
  return { family, cost: 1 };
}
