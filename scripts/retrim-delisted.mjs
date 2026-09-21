import "./require-node.mjs"; // Node-version gate: keep this the FIRST import (test-entry-static-graph.mjs)
// Apply the CURRENT trimming rules to delisted-contract klines that were written by an older version of scripts/fetch-delisted.mjs. Offline: it reads and rewrites
// local files, requests nothing. Idempotent: running it twice changes nothing the second time.
//
//   node scripts/retrim-delisted.mjs <outDir>          (the same <outDir> fetch-delisted.mjs wrote to, e.g. data/calibration/delisted)
//
// Written for rule 3 (frozen bars at the very end of a series, see delisted-trim.mjs): the first batch was cut with rules 1 and 2 only. Files whose source says
// they were aggregated are refused (R1), never re-cut.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { trimDelisted } from "./delisted-trim.mjs";
import { assertNativeKlines } from "./kline-source.mjs";

const HOUR = 3600000;
const STEP = { "1h": HOUR, "4h": 4 * HOUR };
const RUN = { "1h": 24, "4h": 6 };

export function retrimFile(file) {
  assertNativeKlines(file, file.interval, "delisted " + file.interval + " file");
  const step = STEP[file.interval];
  const t = trimDelisted(file.rows, { deliveryMs: file.trim?.deliveryMs ?? NaN, stepMs: step, minRun: RUN[file.interval] });
  if (t.rows.length === file.rows.length) return { changed: false, file, dropped: 0 };
  const end = t.rows.length ? Number(t.rows.at(-1)[0]) + step : file.start;
  const trim = { ...file.trim, cutBy: file.trim?.cutBy ? file.trim.cutBy + "+" + t.cutBy : t.cutBy, cutAtTime: t.cutAtTime, retrimmedTrailing: (file.trim?.retrimmedTrailing ?? 0) + (file.rows.length - t.rows.length) };
  return { changed: true, dropped: file.rows.length - t.rows.length, file: { ...file, end, rows: t.rows, trim } };
}

if (process.argv[1] && process.argv[1].endsWith("retrim-delisted.mjs")) {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("usage: see the header of scripts/retrim-delisted.mjs");
  let files = 0;
  let changed = 0;
  for (const interval of ["1h", "4h"]) {
    let names = [];
    try {
      names = (await readdir(join(outDir, "klines", interval))).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(outDir, "klines", interval, name);
      const r = retrimFile(JSON.parse(await readFile(path, "utf8")));
      files++;
      if (r.changed) {
        await writeFile(path, JSON.stringify(r.file));
        changed++;
        console.log(`${interval} ${name.replace(/\.json$/, "")}: dropped ${r.dropped} trailing frozen bar(s)`);
      }
    }
  }
  console.log(`checked ${files} file(s), changed ${changed}`);
}
