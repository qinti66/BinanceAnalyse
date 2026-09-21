// What a backfill should do with a symbol's existing file, so that moving the end date forward fetches only the new tail instead of everything again.
//
//   skip       the file already covers the requested range (same start, same interval, and it ends at or after the requested end, with data)
//   extend     same start and interval, the file ends earlier and has data: fetch [file.end, end) and append
//   fetch-all  no usable file, a different start or interval, or an empty file (a symbol listed after the range began is asked again: one cheap request)
//
// The seam is exact: a file's rows all have time < its end, and the tail is requested from exactly that end, so nothing is fetched twice and nothing is skipped.

export function planRange(existing, { interval, start, end }) {
  if (!existing || !Array.isArray(existing.rows) || existing.start !== start) return { action: "fetch-all" };
  if (interval !== undefined && existing.interval !== interval) return { action: "fetch-all" };
  if (!existing.rows.length || !Number.isFinite(existing.end)) return { action: "fetch-all" };
  if (existing.end >= end) return { action: "skip" };
  return { action: "extend", from: existing.end };
}

/** Old rows followed by the new tail, deduplicated on `key` (a row present in both keeps its new value), oldest first. */
export function mergeRows(oldRows, newRows, key) {
  const byKey = new Map();
  for (const r of oldRows) byKey.set(key(r), r);
  for (const r of newRows) byKey.set(key(r), r);
  return [...byKey.values()].sort((a, b) => key(a) - key(b));
}

/** Places where consecutive open times are not exactly one step apart (a hole in the data, reported and never filled). */
export function gapsOf(rows, step) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i - 1][0] !== step) gaps.push({ after: rows[i - 1][0], next: rows[i][0] });
  return gaps;
}

/** The end of a kline range must sit on a bar boundary, otherwise the last bar would be a candle that has not closed yet. */
export function endIsAligned(end, step) {
  return Number.isFinite(end) && end % step === 0;
}
