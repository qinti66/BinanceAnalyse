import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSymbols, stripComments, readSymbolsArg } from "./symbols.mjs";
import { alreadyDone } from "./backfill-klines.mjs";
import { basicOk, requestedName, parseRange, createExportServer } from "./export-server.mjs";

// --- symbols
assert.deepEqual(parseSymbols("BTCUSDT,ETHUSDT\nSOLUSDT  BTCUSDT"), ["BTCUSDT", "ETHUSDT", "SOLUSDT"], "commas/newlines/spaces, deduplicated, order kept");
assert.throws(() => parseSymbols("btcusdt"), /not a symbol/);
assert.throws(() => parseSymbols("BTC/USDT"), /not a symbol/);
assert.throws(() => parseSymbols("BTCUSDT;rm"), /not a symbol/);
assert.equal(stripComments("# note about x\nBTCUSDT\n  # more\nETHUSDT"), "BTCUSDT\nETHUSDT");
const tmp = await mkdtemp(join(tmpdir(), "exp-test-"));
try {
  await writeFile(join(tmp, "s.txt"), "# USDT perpetuals of snapshot x\nBTCUSDT\nETHUSDT\n");
  assert.deepEqual(await readSymbolsArg("@" + join(tmp, "s.txt")), ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(await readSymbolsArg("SOLUSDT"), ["SOLUSDT"]);
  await writeFile(join(tmp, "empty.txt"), "# nothing\n");
  await assert.rejects(readSymbolsArg("@" + join(tmp, "empty.txt")), /no symbols/);
  await assert.rejects(readSymbolsArg("@" + join(tmp, "missing.txt")));

  // --- backfill resume check
  const f = join(tmp, "BTCUSDT.json");
  await writeFile(f, JSON.stringify({ interval: "1h", start: 1, end: 2, rows: [[1]] }));
  assert.equal(await alreadyDone(f, "1h", 1, 2), true);
  assert.equal(await alreadyDone(f, "4h", 1, 2), false, "another interval is not done");
  assert.equal(await alreadyDone(f, "1h", 1, 3), false, "another range is not done");
  await writeFile(f, JSON.stringify({ interval: "1h", start: 1, end: 2, rows: [] }));
  assert.equal(await alreadyDone(f, "1h", 1, 2), false, "an empty file is not done");
  await writeFile(f, "{ truncated");
  assert.equal(await alreadyDone(f, "1h", 1, 2), false, "a corrupt file is not done");
  assert.equal(await alreadyDone(join(tmp, "none.json"), "1h", 1, 2), false);

  // --- export server: pure helpers
  const TOKEN = "0123456789abcdef-token";
  const basic = (u, p) => "Basic " + Buffer.from(u + ":" + p).toString("base64");
  assert.equal(basicOk(basic("export", TOKEN), TOKEN), true);
  assert.equal(basicOk(basic("export", "wrong"), TOKEN), false);
  assert.equal(basicOk(basic("admin", TOKEN), TOKEN), false);
  assert.equal(basicOk(undefined, TOKEN), false);
  assert.equal(basicOk("Bearer x", TOKEN), false);
  assert.equal(basicOk(basic("export", "short"), "short"), false, "a short token never authenticates");
  assert.equal(basicOk(basic("export", ""), ""), false);
  assert.equal(requestedName("/a.tar.gz"), "a.tar.gz");
  for (const bad of ["/", "/../secret", "/a/../b", "/%2e%2e/x", "/..%2fx", "/.env", "/sub/file", "/a%5cb", "/%00", "/%zz", "x"]) assert.equal(requestedName(bad), null, bad);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=0-999", 100), { start: 0, end: 99 });
  assert.equal(parseRange(undefined, 100), null);
  for (const bad of ["bytes=100-", "bytes=5-2", "bytes=-0", "bytes=-", "items=0-1", "bytes=a-b"]) assert.equal(parseRange(bad, 100), "bad", bad);

  // --- export server: real requests on an ephemeral loopback port
  const exportDir = join(tmp, "export");
  await mkdir(join(exportDir, "subdir"), { recursive: true });
  await writeFile(join(exportDir, "data.bin"), Buffer.from("0123456789".repeat(10)));
  await writeFile(join(exportDir, ".hidden"), "secret");
  await writeFile(join(tmp, "outside.txt"), "outside");
  const server = createExportServer({ dir: exportDir, token: TOKEN });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = { authorization: basic("export", TOKEN) };
  try {
    assert.equal((await fetch(base + "/data.bin")).status, 401, "no credentials");
    assert.equal((await fetch(base + "/data.bin", { headers: { authorization: basic("export", "nope") } })).status, 401);
    const ok = await fetch(base + "/data.bin", { headers: auth });
    assert.equal(ok.status, 200);
    assert.equal((await ok.arrayBuffer()).byteLength, 100);
    const part = await fetch(base + "/data.bin", { headers: { ...auth, range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 10-19/100");
    assert.equal(await part.text(), "0123456789");
    assert.equal((await fetch(base + "/data.bin", { headers: { ...auth, range: "bytes=500-" } })).status, 416);
    const head = await fetch(base + "/data.bin", { method: "HEAD", headers: auth });
    assert.equal(head.headers.get("content-length"), "100");
    assert.equal((await fetch(base + "/nope", { headers: auth })).status, 404);
    assert.equal((await fetch(base + "/.hidden", { headers: auth })).status, 404, "dot files are never served");
    assert.equal((await fetch(base + "/subdir", { headers: auth })).status, 404, "directories are not served");
    assert.equal((await fetch(base + "/..%2foutside.txt", { headers: auth })).status, 404, "encoded traversal");
    assert.equal((await fetch(base + "/data.bin", { method: "POST", headers: auth })).status, 405);
    const list = await (await fetch(base + "/", { headers: auth })).text();
    assert.equal(list, "data.bin\t100\n", "listing shows regular non-dot files only");
    // Raw-path traversal that fetch would normalise away: send it verbatim.
    const raw = await new Promise((resolveP) => {
      import("node:net").then(({ createConnection }) => {
        const s = createConnection(server.address().port, "127.0.0.1", () => s.write(`GET /../outside.txt HTTP/1.1\r\nHost: x\r\nAuthorization: ${auth.authorization}\r\nConnection: close\r\n\r\n`));
        let buf = "";
        s.on("data", (d) => (buf += d));
        s.on("end", () => resolveP(buf.split("\r\n")[0]));
      });
    });
    assert.match(raw, /404/, "raw ../ path");
  } finally {
    await new Promise((r) => server.close(r));
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log("export-server and symbols tests ok");
