import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// Read-only summary of the downloaded data under data/calibration (and data/indicators/positions). No network, nothing is written.
//
//   node scripts/summarize-data.mjs [dataDir]        (default: <project>/data)
//
// Klines per interval: files, symbols with bars, total bars, symbols with gaps, empty files (listed after the range), bars with an impossible
// price or volume, files that stop short of the requested end, earliest and latest bar. Funding: files, rows, empty files, earliest and latest.
// Positions: files, points, recorded gaps. A "problem" line is printed only when the count is not zero.
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gapsOf } from "./backfill-range.mjs";

const STEP = { "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16) + "Z" : "-");

async function jsonFiles(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return null;
  }
}

/** Facts about one kline file: pure, so it can be tested without a directory. */
export function klineFacts(file, step) {
  const rows = Array.isArray(file.rows) ? file.rows : [];
  let bad = 0;
  let unordered = 0;
  for (let i = 0; i < rows.length; i++) {
    const [t, o, h, l, c, v] = [Number(rows[i][0]), Number(rows[i][1]), Number(rows[i][2]), Number(rows[i][3]), Number(rows[i][4]), Number(rows[i][5])];
    if (!(o > 0 && h > 0 && l > 0 && c > 0) || h < l || h < Math.max(o, c) - 1e-12 * h || l > Math.min(o, c) + 1e-12 * h || !(v >= 0) || !Number.isFinite(t)) bad++;
    if (i > 0 && !(t > Number(rows[i - 1][0]))) unordered++;
  }
  const first = rows.length ? Number(rows[0][0]) : NaN;
  const last = rows.length ? Number(rows[rows.length - 1][0]) : NaN;
  return {
    bars: rows.length,
    first,
    last,
    gaps: rows.length ? gapsOf(rows, step).length : 0,
    bad,
    unordered,
    // The last bar of a complete file opens one step before the requested end.
    shortOfEnd: rows.length > 0 && Number.isFinite(file.end) && last !== file.end - step,
  };
}

export function fundingFacts(file) {
  const rows = Array.isArray(file.rows) ? file.rows : [];
  let bad = 0;
  let unordered = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!Number.isFinite(rows[i].time) || !Number.isFinite(rows[i].rate)) bad++;
    if (i > 0 && !(rows[i].time > rows[i - 1].time)) unordered++;
  }
  return { rows: rows.length, first: rows.length ? rows[0].time : NaN, last: rows.length ? rows[rows.length - 1].time : NaN, bad, unordered };
}

async function summariseKlines(dir, interval, out) {
  const files = await jsonFiles(dir);
  if (!files) return out.push(`klines ${interval}: no directory`);
  const step = STEP[interval];
  let withBars = 0, empty = 0, bars = 0, gapFiles = 0, badBars = 0, unorderedFiles = 0, short = 0, unreadable = 0;
  let first = Infinity, last = -Infinity;
  const ranges = new Set();
  const gapNames = [];
  for (const f of files) {
    let file;
    try {
      file = JSON.parse(await readFile(join(dir, f), "utf8"));
    } catch {
      unreadable++;
      continue;
    }
    const k = klineFacts(file, step);
    ranges.add(`${iso(file.start)}..${iso(file.end)}`);
    if (!k.bars) {
      empty++;
      continue;
    }
    withBars++;
    bars += k.bars;
    first = Math.min(first, k.first);
    last = Math.max(last, k.last);
    if (k.gaps) {
      gapFiles++;
      if (gapNames.length < 5) gapNames.push(f.replace(/\.json$/, ""));
    }
    badBars += k.bad;
    if (k.unordered) unorderedFiles++;
    if (k.shortOfEnd) short++;
  }
  out.push(`klines ${interval}: ${files.length} files | ${withBars} with bars | ${bars} bars | ${iso(first)} .. ${iso(last)} | requested ${[...ranges].join(" ; ")}`);
  const problems = [];
  if (empty) problems.push(`${empty} empty (listed after the range)`);
  if (gapFiles) problems.push(`${gapFiles} with gaps (e.g. ${gapNames.join(", ")})`);
  if (badBars) problems.push(`${badBars} bars with impossible prices/volume`);
  if (unorderedFiles) problems.push(`${unorderedFiles} files out of order`);
  if (short) problems.push(`${short} stop before the requested end (delisted or stale)`);
  if (unreadable) problems.push(`${unreadable} unreadable`);
  if (ranges.size > 1) problems.push("files disagree on the requested range");
  out.push(problems.length ? "  problems: " + problems.join("; ") : "  problems: none");
}

async function summariseFunding(dir, out) {
  const files = await jsonFiles(dir);
  if (!files) return out.push("funding: no directory");
  let withRows = 0, empty = 0, rows = 0, badFiles = 0, unorderedFiles = 0, unreadable = 0;
  let first = Infinity, last = -Infinity;
  const ranges = new Set();
  for (const f of files) {
    let file;
    try {
      file = JSON.parse(await readFile(join(dir, f), "utf8"));
    } catch {
      unreadable++;
      continue;
    }
    ranges.add(`${iso(file.start)}..${iso(file.end)}`);
    const k = fundingFacts(file);
    if (!k.rows) {
      empty++;
      continue;
    }
    withRows++;
    rows += k.rows;
    first = Math.min(first, k.first);
    last = Math.max(last, k.last);
    if (k.bad) badFiles++;
    if (k.unordered) unorderedFiles++;
  }
  out.push(`funding: ${files.length} files | ${withRows} with rows | ${rows} rows | ${iso(first)} .. ${iso(last)} | requested ${[...ranges].join(" ; ")}`);
  const problems = [];
  if (empty) problems.push(`${empty} empty`);
  if (badFiles) problems.push(`${badFiles} files with non-numeric rows`);
  if (unorderedFiles) problems.push(`${unorderedFiles} files out of order`);
  if (unreadable) problems.push(`${unreadable} unreadable`);
  if (ranges.size > 1) problems.push("files disagree on the requested range");
  out.push(problems.length ? "  problems: " + problems.join("; ") : "  problems: none");
}

/** Points of one positions file: how many, their time span in hours, and how many consecutive points are not exactly one hour apart. */
export function positionFacts(store) {
  const times = (Array.isArray(store.points) ? store.points : []).map((x) => Number(x.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  let holes = 0;
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] !== 3600000) holes++;
  return { points: times.length, first: times[0] ?? NaN, last: times[times.length - 1] ?? NaN, holes, spanHours: times.length ? (times[times.length - 1] - times[0]) / 3600000 : 0 };
}

async function summarisePositions(dir, out) {
  const files = await jsonFiles(dir);
  if (!files) return out.push("positions: no directory");
  let points = 0, gaps = 0, unreadable = 0, holeFiles = 0, maxPoints = 0;
  let first = Infinity, last = -Infinity;
  const wide = [];
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(await readFile(join(dir, f), "utf8"));
    } catch {
      unreadable++;
      continue;
    }
    const p = Array.isArray(s.points) ? s.points : [];
    const facts = positionFacts(s);
    maxPoints = Math.max(maxPoints, facts.points);
    if (facts.holes) {
      holeFiles++;
      if (wide.length < 5) wide.push(`${f.replace(/.json$/, "")} (${facts.points} points over ${Math.round(facts.spanHours)}h, ${facts.holes} holes)`);
    }
    points += p.length;
    gaps += Array.isArray(s.gaps) ? s.gaps.length : 0;
    for (const x of p) {
      const t = Number(x.timestamp);
      if (Number.isFinite(t)) {
        first = Math.min(first, t);
        last = Math.max(last, t);
      }
    }
  }
  out.push(`positions: ${files.length} files | ${points} points | ${iso(first)} .. ${iso(last)} | recorded gaps ${gaps} | most points in one file ${maxPoints}${unreadable ? " | " + unreadable + " unreadable" : ""}`);
  if (holeFiles) out.push(`  hourly holes inside the exchange data: ${holeFiles} files (e.g. ${wide.join("; ")})`);
}

export async function summarise(dataDir) {
  const out = [];
  const cal = join(dataDir, "calibration");
  for (const interval of ["1h", "4h"]) await summariseKlines(join(cal, "klines", interval), interval, out);
  await summariseFunding(join(cal, "funding"), out);
  await summarisePositions(join(dataDir, "indicators", "positions"), out);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dataDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data");
  for (const line of await summarise(dataDir)) console.log(line);
}
