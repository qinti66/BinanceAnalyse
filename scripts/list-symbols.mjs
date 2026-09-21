import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// The USDT perpetuals of the latest complete snapshot (data/indicators/latest.json), for the backfill scripts. Reads local files only: no network.
//
//   node scripts/list-symbols.mjs                 write data/calibration/symbols.txt and print how many
//   node scripts/list-symbols.mjs --raw-path      print the path of the snapshot's raw.json (backfill-funding takes it)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pointer = JSON.parse(await readFile(join(root, "data", "indicators", "latest.json"), "utf8"));
const rawPath = join(pointer.path, "raw.json");
if (process.argv.includes("--raw-path")) {
  console.log(rawPath);
} else {
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  const symbols = raw.contracts
    .map((c) => c.contract)
    .filter((c) => c.family === "UM" && c.contractType === "PERPETUAL" && c.quoteAsset === "USDT")
    .map((c) => c.symbol)
    .sort();
  if (!symbols.length) throw new Error("no USDT perpetuals in " + rawPath);
  const out = join(root, "data", "calibration", "symbols.txt");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, "# USDT perpetuals of snapshot " + (raw.id ?? "?") + "\n" + symbols.join("\n") + "\n");
  console.log(`${symbols.length} symbols written to ${out} (snapshot ${raw.id})`);
}
