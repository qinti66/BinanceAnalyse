// Symbol lists for the backfill scripts: "BTCUSDT,ETHUSDT" inline, or "@path/to/file" (one symbol per line or comma-separated, # comments allowed).
import { readFile } from "node:fs/promises";

// Binance lists perpetuals with non-ASCII names (e.g. 哈基米USDT), so letters and digits of any script are allowed. Anything that could change a URL or a
// file path (slashes, spaces, dots, quotes, & = ? # %) is not. Requests must still encodeURIComponent the symbol.
const SYMBOL = /^[\p{L}\p{N}_]{2,40}$/u;

export function parseSymbols(text) {
  const out = [];
  const seen = new Set();
  for (const raw of text.split(/[\s,]+/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    if (!SYMBOL.test(s)) throw new Error("not a symbol: " + JSON.stringify(s.slice(0, 40)));
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** Comment lines are dropped before splitting, so "# note about x" does not turn words into symbols. */
export const stripComments = (text) => text.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n");

export async function readSymbolsArg(arg) {
  const symbols = arg.startsWith("@") ? parseSymbols(stripComments(await readFile(arg.slice(1), "utf8"))) : parseSymbols(arg);
  if (!symbols.length) throw new Error("no symbols given");
  return symbols;
}
