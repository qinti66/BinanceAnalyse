import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { marketSnapshots } from "../../../db/schema";

const SYMBOLS = ["ZECUSDT", "DOTUSDT", "ARBUSDT", "1000PEPEUSDT", "SOLUSDT", "XRPUSDT"];
const FAPI = "https://fapi.binance.com";

async function readJson(path: string) {
  const response = await fetch(FAPI + path, {
    headers: { accept: "application/json", "user-agent": "AlphaRadar/1.0" },
    cf: { cacheTtl: 0 },
  } as RequestInit);
  if (!response.ok) throw new Error(path + " returned " + response.status);
  return response.json();
}

async function collectSymbol(symbol: string, capturedAt: Date) {
  const encoded = encodeURIComponent(symbol);
  const [ticker, premium, interest, longShort, taker] = await Promise.all([
    readJson("/fapi/v1/ticker/24hr?symbol=" + encoded),
    readJson("/fapi/v1/premiumIndex?symbol=" + encoded),
    readJson("/fapi/v1/openInterest?symbol=" + encoded),
    readJson("/futures/data/globalLongShortAccountRatio?symbol=" + encoded + "&period=5m&limit=1"),
    readJson("/futures/data/takerlongshortRatio?symbol=" + encoded + "&period=5m&limit=1"),
  ]) as [Record<string,string>,Record<string,string>,Record<string,string>,Array<Record<string,string>>,Array<Record<string,string>>];

  return {
    capturedAt,
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

export async function POST() {
  const capturedAt = new Date();
  const results = await Promise.allSettled(SYMBOLS.map((symbol) => collectSymbol(symbol, capturedAt)));
  const rows = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const errors = results.flatMap((result, index) => result.status === "rejected" ? [{ symbol: SYMBOLS[index], error: String(result.reason) }] : []);
  if (!rows.length) return Response.json({ error: "Binance market collection failed", errors }, { status: 502 });

  const db = getDb();
  await db.insert(marketSnapshots).values(rows);
  return Response.json({ capturedAt: capturedAt.toISOString(), markets: rows, errors }, { status: 201 });
}

export async function GET() {
  const db = getDb();
  const rows = await db.select().from(marketSnapshots).orderBy(desc(marketSnapshots.capturedAt), desc(marketSnapshots.id)).limit(60);
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!latest.has(row.symbol)) latest.set(row.symbol, row);
  return Response.json({ markets: [...latest.values()] });
}
