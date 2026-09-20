import type { Swing } from "./types.ts";

export interface Level {
  type: "high" | "low";
  price: number; // mean of the member swings
  /** Highest / lowest member swing price. A range boundary is the extreme, not the mean: stops rest beyond ALL known swings. */
  high: number;
  low: number;
  touches: number;
  swingIndices: number[];
  firstIndex: number;
  lastIndex: number;
  /** Knowable once the last member swing is confirmed. */
  confirmedIndex: number;
}

/**
 * Clusters swings of one side into price levels (equal highs / equal lows, i.e. where stops rest).
 * Sorted by price, a swing joins the current cluster while it lies within `tol` of the cluster's previous member.
 * `tol` is an absolute price distance chosen by the caller (typically k × ATR at the decision bar), so the
 * function itself reads no bars and cannot look ahead. Levels with fewer than `minTouches` swings are dropped.
 */
export function clusterLevels(swings: Swing[], opts: { type: "high" | "low"; tol: number; minTouches?: number }): Level[] {
  const minTouches = opts.minTouches ?? 2;
  if (!(opts.tol >= 0) || !Number.isFinite(opts.tol)) return [];
  const side = swings.filter((s) => s.type === opts.type && Number.isFinite(s.price)).sort((a, b) => a.price - b.price);
  const groups: Swing[][] = [];
  for (const s of side) {
    const g = groups[groups.length - 1];
    if (g && s.price - g[g.length - 1].price <= opts.tol) g.push(s);
    else groups.push([s]);
  }
  return groups
    .filter((g) => g.length >= minTouches)
    .map((g) => ({
      type: opts.type,
      price: g.reduce((a, s) => a + s.price, 0) / g.length,
      high: Math.max(...g.map((s) => s.price)),
      low: Math.min(...g.map((s) => s.price)),
      touches: g.length,
      swingIndices: g.map((s) => s.index).sort((a, b) => a - b),
      firstIndex: Math.min(...g.map((s) => s.index)),
      lastIndex: Math.max(...g.map((s) => s.index)),
      confirmedIndex: Math.max(...g.map((s) => s.confirmedIndex)),
    }));
}
