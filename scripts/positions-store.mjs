// T2 layer (docs/p2-collection-plan-v1.md): topLongShortPositionRatio has no consumer today, but /futures/data/ keeps only ~30 days, so it can be
// thinned out, never stopped. One file per contract, points deduplicated by timestamp, fetched only when the last fetch is older than REFETCH_MS.
// limit=500 of 1h points covers ~20.8 days, so a refetch interval under that leaves no gap.
export const REFETCH_MS = 10 * 86400000;
export const HOUR_MS = 3600000;
export const T2_LIMIT = 500;

export const isDue = (store, now) => !store || !Number.isFinite(store.lastFetchedAt) || now - store.lastFetchedAt >= REFETCH_MS;

/** Merge fetched points into a store. Later fetches win on the same timestamp. Reports a gap when the new points start more than one period after the stored ones end. */
export function mergeSeries(store, incoming, now) {
  const byTime = new Map((store?.points ?? []).map((p) => [Number(p.timestamp), p]));
  const prevEnd = store?.points?.length ? Math.max(...store.points.map((p) => Number(p.timestamp))) : null;
  const fresh = incoming.filter((p) => Number.isFinite(Number(p.timestamp)));
  const firstNew = fresh.length ? Math.min(...fresh.map((p) => Number(p.timestamp))) : null;
  for (const p of fresh) byTime.set(Number(p.timestamp), p);
  const points = [...byTime.values()].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const gap = prevEnd !== null && firstNew !== null && firstNew - prevEnd > HOUR_MS ? { from: prevEnd, to: firstNew } : null;
  return { store: { lastFetchedAt: now, points, gaps: gap ? [...(store?.gaps ?? []), gap] : (store?.gaps ?? []) }, gap };
}
