import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// LISTING ONLY. Which USDT perpetuals exist in Binance's public archive (data.binance.vision) but are not in our current 526? These are the
// candidates for delisted contracts (survivorship bias). It lists directories; it downloads no data file.
//
//   node scripts/probe-archive-symbols.mjs [--max-requests N] [--from YYYY-MM]
//
// Approved by the user (2026-09-21, option B): UM perpetuals, USDT quote, listing only. Requests: 1 for the symbol directory (a few more if the
// listing is paginated), then one small listing per candidate symbol to see which months of 1h klines exist. The run stops before the per-symbol
// step if there are more candidates than --max-requests allows, and stops at once on 403, 418, 429 or 451 (limits and regional blocks are obeyed,
// never worked around). Result: data/calibration/archive-symbols.json (git-ignored).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The site root is an HTML page; the archive's documented directory listing is the S3 bucket endpoint behind it.
export const BUCKET = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
export const ROOT_PREFIX = "data/futures/um/monthly/klines/";

/** Pull the directory names, file keys and paging state out of an S3 ListObjects XML page. */
export function parseListing(xml) {
  const tags = (re) => [...xml.matchAll(re)].map((m) => m[1]);
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>\s*<\/CommonPrefixes>/g)].map((m) => m[1]);
  return {
    prefixes,
    keys: tags(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<\/Contents>/g),
    truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml),
    next: (xml.match(/<NextMarker>([^<]*)<\/NextMarker>/) ?? [])[1] ?? null,
  };
}

/** "data/futures/um/monthly/klines/BTCUSDT/" -> "BTCUSDT" */
export const symbolOf = (prefix) => prefix.slice(ROOT_PREFIX.length).replace(/\/$/, "");

/** Perpetual USDT symbols only: quote USDT, no _YYMMDD delivery suffix, no other quote. */
export const isUsdtPerpetual = (s) => /USDT$/.test(s) && !/_\d{6}$/.test(s);

/** Months ("2025-03") of 1h kline files in a listing of <SYMBOL>/1h/. */
export function monthsOf(keys) {
  return keys.map((k) => (k.match(/-(\d{4}-\d{2})\.zip$/) ?? [])[1]).filter(Boolean).sort();
}

export function classify(allSymbols, current) {
  const cur = new Set(current);
  const out = { total: allSymbols.length, current: 0, candidates: [], delivery: 0, otherQuote: 0 };
  for (const s of allSymbols) {
    if (cur.has(s)) out.current++;
    else if (/_\d{6}$/.test(s)) out.delivery++;
    else if (!/USDT$/.test(s)) out.otherQuote++;
    else out.candidates.push(s);
  }
  return out;
}

class StopRun extends Error {}

async function list(url, state) {
  state.requests++;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (r.status === 451) throw new StopRun("HTTP 451: a regional block. Stopping; not routing around it.");
  if ([403, 418, 429].includes(r.status)) throw new StopRun(`HTTP ${r.status}: stopping and not retrying; report to the user.`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  return parseListing(await r.text());
}

async function listAll(prefix, state) {
  const out = { prefixes: [], keys: [] };
  let marker = null;
  for (let page = 0; page < 20; page++) {
    const q = `${BUCKET}?delimiter=/&prefix=${encodeURIComponent(prefix)}${marker ? "&marker=" + encodeURIComponent(marker) : ""}`;
    const p = await list(q, state);
    out.prefixes.push(...p.prefixes);
    out.keys.push(...p.keys);
    if (!p.truncated) return out;
    marker = p.next ?? (p.prefixes.at(-1) || p.keys.at(-1));
    if (!marker) return out;
  }
  throw new Error("listing did not finish in 20 pages");
}

async function main() {
  const argv = process.argv.slice(2);
  const maxIdx = argv.indexOf("--max-requests");
  const maxRequests = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 250;
  const fromIdx = argv.indexOf("--from");
  const from = fromIdx >= 0 ? argv[fromIdx + 1] : "2024-09";
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const symText = await readFile(join(root, "data", "calibration", "symbols.txt"), "utf8");
  const current = symText.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  const state = { requests: 0 };
  const top = await listAll(ROOT_PREFIX, state);
  const all = top.prefixes.map(symbolOf);
  const c = classify(all, current);
  console.log(`archive: ${c.total} symbols under klines | ${c.current} are in our current ${current.length} | ${c.delivery} delivery contracts | ${c.otherQuote} other quotes | ${c.candidates.length} USDT perpetuals NOT in our current list | ${state.requests} request(s) so far`);
  const result = { probedAt: new Date().toISOString(), from, currentCount: current.length, counts: { total: c.total, current: c.current, delivery: c.delivery, otherQuote: c.otherQuote, candidates: c.candidates.length }, candidates: [] };
  const outFile = join(root, "data", "calibration", "archive-symbols.json");
  await mkdir(dirname(outFile), { recursive: true });
  if (c.candidates.length + state.requests > maxRequests) {
    await writeFile(outFile, JSON.stringify({ ...result, note: "per-symbol listing not done: too many candidates for --max-requests", candidateSymbols: c.candidates }, null, 1));
    console.log(`STOPPED before the per-symbol step: ${c.candidates.length} candidates would need ${c.candidates.length} more requests, over --max-requests ${maxRequests}. Names saved to ${outFile}. Report to the user.`);
    return;
  }
  for (const s of c.candidates) {
    const l = await listAll(`${ROOT_PREFIX}${s}/1h/`, state);
    const months = monthsOf(l.keys);
    result.candidates.push({ symbol: s, months: months.length, first: months[0] ?? null, last: months.at(-1) ?? null, inRange: months.filter((m) => m >= from).length });
    await new Promise((r) => setTimeout(r, 250));
  }
  await writeFile(outFile, JSON.stringify(result, null, 1));
  const inRange = result.candidates.filter((x) => x.inRange > 0);
  const ended = inRange.filter((x) => x.last < "2026-08");
  console.log(`per symbol: ${result.candidates.length} listed | ${inRange.length} have 1h months from ${from} on | ${ended.length} of those end before 2026-08 (delisted or settled in range) | ${state.requests} requests in total`);
  console.log("saved:", outFile);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error((e instanceof StopRun ? "STOPPED: " : "FAILED: ") + e.message);
    process.exitCode = 1;
  });
}
