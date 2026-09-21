import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSymbols, stripComments, readSymbolsArg } from "./symbols.mjs";
import { alreadyDone } from "./backfill-klines.mjs";
import { basicOk, requestedName, parseRange, createExportServer } from "./export-server.mjs";

// --- symbols
assert.deepEqual(parseSymbols("BTCUSDT,ETHUSDT\nSOLUSDT  BTCUSDT"), ["BTCUSDT", "ETHUSDT", "SOLUSDT"], "commas/newlines/spaces, deduplicated, order kept");
assert.deepEqual(parseSymbols("哈基米USDT,币安人生USDT,BTCUSDT"), ["哈基米USDT", "币安人生USDT", "BTCUSDT"], "non-ASCII perpetual names are real symbols");
for (const bad of ["BTC/USDT", "a b", "..", "a&symbol=X", "a=b", "a?b", "a#b", "a%20b", "a.json", "a'b", "x", "\u0000ab"]) assert.throws(() => parseSymbols(bad), /not a symbol/, bad);
assert.deepEqual(parseSymbols("btcusdt"), ["btcusdt"], "letters of any case are syntactically fine; the exchange decides whether the symbol exists");
{
  // The request URL must carry the encoded symbol, or https.request rejects the non-ASCII path.
  const { fetchKlinesRange } = await import("./backfill-klines.mjs");
  const { fetchFundingRange } = await import("./backfill-funding.mjs");
  const { RateLimiter } = await import("./rate-limit.mjs");
  const urls = [];
  const get = async (u) => (urls.push(u), { status: 200, headers: {}, text: "[]", json: () => [] });
  await fetchKlinesRange(get, new RateLimiter(), "哈基米USDT", "1h", 0, 3600000, {});
  await fetchFundingRange(get, "哈基米USDT", 0, 3600000, { sleep: async () => {}, paceMs: 0 });
  assert.equal(urls.length, 2);
  for (const u of urls) {
    assert.match(u, /symbol=%E5%93%88%E5%9F%BA%E7%B1%B3USDT&/, u);
    assert.doesNotMatch(u, /[^\x00-\x7F]/, "the URL is pure ASCII");
  }
}
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

// --- backfill range planning: moving the end forward fetches only the tail
{
  const { planRange, mergeRows, gapsOf, endIsAligned } = await import("./backfill-range.mjs");
  const H = 3600000;
  const file = (o = {}) => ({ interval: "1h", start: 0, end: 10 * H, rows: [[0], [H]], ...o });
  assert.deepEqual(planRange(null, { interval: "1h", start: 0, end: 10 * H }), { action: "fetch-all" });
  assert.deepEqual(planRange(file(), { interval: "1h", start: 0, end: 10 * H }), { action: "skip" }, "same request");
  assert.deepEqual(planRange(file(), { interval: "1h", start: 0, end: 5 * H }), { action: "skip" }, "the file already covers a shorter request");
  assert.deepEqual(planRange(file(), { interval: "1h", start: 0, end: 20 * H }), { action: "extend", from: 10 * H }, "a later end asks only for the tail");
  assert.deepEqual(planRange(file(), { interval: "1h", start: H, end: 20 * H }), { action: "fetch-all" }, "another start is a different file");
  assert.deepEqual(planRange(file(), { interval: "4h", start: 0, end: 20 * H }), { action: "fetch-all" }, "another interval");
  assert.deepEqual(planRange(file({ rows: [] }), { interval: "1h", start: 0, end: 10 * H }), { action: "fetch-all" }, "an empty file (listed later) is asked again");
  assert.deepEqual(planRange({ start: 0, end: 10 * H, rows: [{ time: 1 }] }, { start: 0, end: 20 * H }), { action: "extend", from: 10 * H }, "funding files have no interval");
  assert.deepEqual(planRange({ start: 0, rows: [{ time: 1 }] }, { start: 0, end: 20 * H }), { action: "fetch-all" }, "no end recorded: do not guess");
  assert.equal(await alreadyDone(join(tmpdir(), "no-such-file.json"), "1h", 0, H), false);
  // merge: exact seam, overlap deduplicated, order kept
  assert.deepEqual(mergeRows([[0], [H]], [[2 * H], [3 * H]], (r) => r[0]), [[0], [H], [2 * H], [3 * H]]);
  assert.deepEqual(mergeRows([[0, "old"], [H]], [[H, "new"], [2 * H]], (r) => r[0]), [[0, "old"], [H, "new"], [2 * H]], "a row in both keeps the new value");
  assert.deepEqual(mergeRows([{ time: 2 }], [{ time: 1 }, { time: 3 }], (r) => r.time), [{ time: 1 }, { time: 2 }, { time: 3 }]);
  // gaps include the seam
  assert.deepEqual(gapsOf([[0], [H], [3 * H]], H), [{ after: H, next: 3 * H }]);
  assert.deepEqual(gapsOf([[0], [H], [2 * H]], H), []);
  assert.equal(endIsAligned(Date.UTC(2026, 8, 21), 14400000), true);
  assert.equal(endIsAligned(Date.UTC(2026, 8, 21, 1), 14400000), false, "01:00 is not a 4h boundary");
  assert.equal(endIsAligned(NaN, H), false);
}

// --- the whole per-symbol flow with a fake exchange: first run, rerun, then the end moves forward
{
  const { backfillSymbol } = await import("./backfill-klines.mjs");
  const { backfillFundingSymbol } = await import("./backfill-funding.mjs");
  const { RateLimiter } = await import("./rate-limit.mjs");
  const { readFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "bf-test-"));
  try {
    const H = 3600000;
    const bar = (t) => [t, "1", "1", "1", "1", "1", t + H - 1, "1", 1, "1", "1", "0"];
    const asked = [];
    const get = async (url) => {
      const q = new URL(url).searchParams;
      const from = Number(q.get("startTime"));
      const to = Number(q.get("endTime"));
      asked.push([from, to]);
      const out = [];
      for (let t = from; t <= to && out.length < Number(q.get("limit") ?? 1000); t += H) out.push(url.includes("klines") ? bar(t) : { fundingTime: t, fundingRate: "0.0001" });
      return { status: 200, headers: {}, text: "", json: () => out };
    };
    const args = { get, limiter: new RateLimiter(), target: join(dir, "X.json"), symbol: "X", interval: "1h", start: 0, end: 10 * H, limit: 500 };
    const a = await backfillSymbol(args);
    assert.equal(a.action, "fetch-all");
    assert.equal(a.rows.length, 10);
    assert.equal((await backfillSymbol(args)).action, "skip", "the same request again does nothing");
    asked.length = 0;
    const b = await backfillSymbol({ ...args, end: 15 * H });
    assert.equal(b.action, "extend");
    assert.equal(b.rows.length, 15, "10 old bars plus 5 new ones");
    assert.equal(b.added, 5, "only the tail was fetched");
    assert.deepEqual(asked, [[10 * H, 15 * H - 1]], "the request starts exactly at the old end and nowhere earlier");
    assert.deepEqual(b.gaps, [], "no hole at the seam");
    assert.deepEqual(b.rows.map((r) => r[0]), [...Array(15).keys()].map((i) => i * H));
    const saved = JSON.parse(await readFile(join(dir, "X.json"), "utf8"));
    assert.equal(saved.end, 15 * H);
    assert.equal(saved.rows.length, 15);
    // funding: the same three steps
    const f = { get, file: join(dir, "F.json"), symbol: "F", start: 0, end: 4 * H, sleep: async () => {}, paceMs: 0 };
    assert.equal((await backfillFundingSymbol(f)).action, "fetch-all");
    assert.equal((await backfillFundingSymbol(f)).action, "skip");
    asked.length = 0;
    const fx = await backfillFundingSymbol({ ...f, end: 6 * H });
    assert.equal(fx.action, "extend");
    assert.deepEqual(fx.rows.map((r) => r.time), [0, 1, 2, 3, 4, 5].map((i) => i * H));
    assert.equal(asked[0][0], 4 * H, "funding tail starts at the old end");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- a reused keep-alive socket must not collect "connect" listeners (MaxListenersExceededWarning)
{
  const { onConnected } = await import("./binance-net.mjs");
  const { EventEmitter } = await import("node:events");
  const connected = Object.assign(new EventEmitter(), { connecting: false });
  let calls = 0;
  for (let i = 0; i < 50; i++) onConnected(connected, () => calls++);
  assert.equal(calls, 50, "an already connected socket calls back at once");
  assert.equal(connected.listenerCount("connect"), 0, "and adds no listener");
  const connecting = Object.assign(new EventEmitter(), { connecting: true });
  let late = 0;
  onConnected(connecting, () => late++);
  assert.equal(late, 0);
  connecting.emit("connect");
  assert.equal(late, 1, "a connecting socket is waited on");
  assert.equal(connecting.listenerCount("connect"), 0, "once, then the listener is gone");
}
console.log("export-server and symbols tests ok");
