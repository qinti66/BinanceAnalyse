// Symbol lists for the backfill scripts: "BTCUSDT,ETHUSDT" inline, or "@path/to/file" (one symbol per line or comma-separated, # comments allowed).
import { readFile } from "node:fs/promises";

const SYMBOL = /^[A-Z0-9_]{2,30}$/;

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
