import type { Bar, BarsResult, CandleFlow, ContractFamily } from "./types.ts";

export const toNumber = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * USD flow of one raw kline row. Column indices differ by family:
 *   UM: total = k[7] (quote turnover),  buy = k[10], fx = quoteUsd
 *   CM: total = k[5] (contract count),  buy = k[9],  fx = contractSize
 * The single source of this conversion; `toBars` and the legacy indicators both go through it.
 */
export function candleFlow(k: unknown[], family: ContractFamily, quoteUsd: number | null, contractSize: number | null): CandleFlow | null {
  const total = family === "UM" ? toNumber(k[7]) : toNumber(k[5]);
  const buy = family === "UM" ? toNumber(k[10]) : toNumber(k[9]);
  const fx = family === "UM" ? quoteUsd : contractSize;
  if (total === null || buy === null || fx === null || fx <= 0 || total < 0 || buy < 0 || buy > total * 1.000001) return null;
  return { inflow: buy * fx, outflow: Math.max(0, total - buy) * fx, net: (2 * buy - total) * fx, total: total * fx };
}

/**
 * The only entry point from raw klines to `Bar[]` — training scripts and live analysis must both call it.
 * Keeps only rows that closed before `cutoff`, have closeTime >= openTime and a positive close; oldest first.
 */
export function toBars(
  klines: unknown[][],
  family: ContractFamily,
  quoteUsd: number | null,
  contractSize: number | null,
  cutoff: number,
  intervalMs: number,
): BarsResult {
  const rows = klines
    .filter((k) => {
      const close = toNumber(k[4]);
      return Number(k[6]) < cutoff && Number(k[6]) >= Number(k[0]) && close !== null && close > 0;
    })
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const bars: Bar[] = rows.map((k) => {
    const flow = candleFlow(k, family, quoteUsd, contractSize);
    return {
      t: Number(k[0]),
      ct: Number(k[6]),
      o: toNumber(k[1]) ?? NaN,
      h: toNumber(k[2]) ?? NaN,
      l: toNumber(k[3]) ?? NaN,
      c: Number(k[4]),
      v: toNumber(k[5]),
      qvUsd: flow ? flow.total : null,
      takerBuyUsd: flow ? flow.inflow : null,
      trades: toNumber(k[8]),
      flow,
    };
  });
  const contiguous =
    bars.length > 0 &&
    bars[bars.length - 1].ct === cutoff - 1 &&
    bars.every((b, i) => i === 0 || b.t - bars[i - 1].t === intervalMs);
  return { bars, contiguous, coverage: klines.length ? bars.length / klines.length : 0 };
}
