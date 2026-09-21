// The Node-version gate (scripts/require-node.mjs) only works if the entry's STATIC import graph holds no .ts file: on a Node too old to strip types, a
// static .ts import fails at load time, before any module body (the gate) runs. This test reads files and parses import statements; it never runs a script.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const ENTRIES = [
  "check-binance-net.mjs",
  "collect-indicators.mjs",
  "backfill-funding.mjs",
  "backfill-klines.mjs",
  "fetch-archive.mjs",
  "import-archive-funding.mjs",
];
// Static specifiers only: `import x from "..."`, `import "..."`, `export ... from "..."`. Dynamic import() is deliberately not followed.
const STATIC = /(?:^|[\n;])\s*(?:import\s+(?:[^"'();]*?\s+from\s+)?|export\s+[^"'();]*?\s+from\s+)["']([^"']+)["']/g;

/** Remove comments and blank the inside of template literals, so text that only LOOKS like an import is not matched. Quotes are tracked so "//" inside a string is not a comment. */
function stripNoise(src) {
  const NL = "\n";
  const blank = (t) => t.replace(/[^\n]/g, " ");
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== NL) i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      out += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== NL) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
      out += "`" + blank(src.slice(i + 1, j)) + "`";
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const staticSpecifiers = (src) => [...stripNoise(src).matchAll(STATIC)].map((m) => m[1]);
const staticImports = (file) => staticSpecifiers(readFileSync(file, "utf8"));

function walk(entry) {
  const seen = new Set();
  const tsFiles = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (extname(file) === ".ts") {
      tsFiles.push(file);
      return; // its own imports are irrelevant: it already fails to load
    }
    for (const spec of staticImports(file)) {
      if (!spec.startsWith(".")) continue; // node: builtins and packages
      const target = resolve(dirname(file), spec);
      assert.ok(existsSync(target), `${relative(scriptsDir, file)} imports ${spec}, which does not exist`);
      visit(target);
    }
  };
  visit(entry);
  return { seen, tsFiles };
}

// 1. Real entries.
for (const name of ENTRIES) {
  const entry = resolve(scriptsDir, name);
  const { seen, tsFiles } = walk(entry);
  assert.deepEqual(tsFiles.map((f) => relative(scriptsDir, f)), [], `${name}: a static .ts import defeats the Node-version gate (move it behind a dynamic import() after the gate)`);
  assert.ok(seen.has(resolve(scriptsDir, "require-node.mjs")), `${name}: must import ./require-node.mjs`);
  assert.equal(staticImports(entry)[0], "./require-node.mjs", `${name}: the gate must be the FIRST import`);
}

// 2. Parser fixtures. Every static form must be found (a miss is a hole in the guard); text that only looks like an import must not be (a test that
// is always red gets skipped).
const found = (src) => staticSpecifiers("\n" + src + "\n");
const POSITIVE = [
  "import d from './a.ts'",
  "import { x } from './a.ts'",
  "import * as ns from './a.ts'",
  "import './a.ts'",
  "export { x } from './a.ts'",
  "export * from './a.ts'",
  "export * as q from './a.ts'",
  "import d, { x } from './a.ts'",
  "import {\n  x,\n  y,\n} from './a.ts'",
  "import type { T } from './a.ts'",
  'import d from "./a.ts"',
  "import x from './a.ts';import y from './b.ts'",
];
for (const src of POSITIVE) assert.ok(found(src).includes("./a.ts"), "not detected: " + JSON.stringify(src));
assert.deepEqual(found("import x from './a.ts';import y from './b.ts'"), ["./a.ts", "./b.ts"], "two statements on one line");
const NEGATIVE = [
  "// import x from './fake.ts'",
  "/* import x from './fake.ts' */",
  "/*\nimport x from './fake.ts'\n*/",
  'const s = "import x from \'./fake.ts\'"',
  "const s = `\nimport x from './fake.ts'\n`",
  "await import('./dyn.ts')",
  "const m = import('./dyn.ts')",
  "const u = 'http://x.test/a.ts'; // import y from './fake.ts'",
];
for (const src of NEGATIVE) assert.deepEqual(found(src), [], "false positive: " + JSON.stringify(src));
assert.deepEqual(found("const u = 'http://x.test';\nimport a from './real.ts'"), ["./real.ts"]);
assert.deepEqual(found("/* c */\nimport a from './real.ts' // trailing"), ["./real.ts"]);

// 3. Positive control: the walk from a real entry must reach its known dependencies. A walk that stops early or swallows a missing file would
// pass everything above without verifying anything.
const collector = walk(resolve(scriptsDir, "collect-indicators.mjs")).seen;
for (const dep of ["require-node.mjs", "rate-limit.mjs", "collector-cost.mjs", "positions-store.mjs"]) {
  assert.ok(collector.has(resolve(scriptsDir, dep)), "the walk from collect-indicators.mjs did not reach " + dep + " (the walk is not traversing)");
}
assert.ok(walk(resolve(scriptsDir, "check-binance-net.mjs")).seen.has(resolve(scriptsDir, "binance-net.mjs")), "the walk from check-binance-net.mjs did not reach binance-net.mjs");
// And it does find a .ts where there is one: measure-joint-coverage statically imports lib .ts files.
assert.ok(walk(resolve(scriptsDir, "measure-joint-coverage.mjs")).tsFiles.length > 0, "the walk found no .ts under an entry known to import .ts");
console.log("entry static-graph tests ok:", ENTRIES.length, "entries");
