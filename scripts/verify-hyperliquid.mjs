// Phase 0 可行性验证：确认 Hyperliquid /info 接口可用，打印指定地址的实时持仓。
// 不接入 UI、不接入数据库、不做地址发现或定时任务。
// 用法：node scripts/verify-hyperliquid.mjs 0x你要查询的地址 [0x另一个地址 ...]
// 若不传参数，则使用下面 ADDRESSES 占位数组；请把你想验证的地址填进去（保持为空则仅打印用法提示，不发起请求）。
const ADDRESSES = [
  // 例："0x0000000000000000000000000000000000000000",
];
const ENDPOINT = "https://api.hyperliquid.xyz/info";

async function post(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function verify(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("地址格式无效，应为 0x 开头的40位十六进制地址");
  console.log(JSON.stringify({ phase: "querying", address }));
  const state = await post({ type: "clearinghouseState", user: address });
  const positions = (state.assetPositions ?? []).map((p) => ({
    coin: p.position?.coin,
    szi: p.position?.szi,
    entryPx: p.position?.entryPx,
    leverage: p.position?.leverage,
    unrealizedPnl: p.position?.unrealizedPnl,
    liquidationPx: p.position?.liquidationPx,
    marginUsed: p.position?.marginUsed,
  }));
  console.log(
    JSON.stringify(
      {
        phase: "result",
        address,
        accountValue: state.marginSummary?.accountValue ?? null,
        totalMarginUsed: state.marginSummary?.totalMarginUsed ?? null,
        positionCount: positions.length,
        positions,
      },
      null,
      2
    )
  );
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ADDRESSES;
if (!targets.length) {
  console.log(
    "用法：node scripts/verify-hyperliquid.mjs 0x地址1 [0x地址2 ...]\n" +
      "或者编辑本文件顶部的 ADDRESSES 数组，填入你想验证的 0x 地址。未提供地址时不会发起任何网络请求。"
  );
  process.exit(0);
}
let ok = 0,
  failed = 0;
for (const address of targets) {
  try {
    await verify(address);
    ok++;
  } catch (e) {
    failed++;
    console.log(JSON.stringify({ phase: "error", address, error: String(e) }));
  }
}
console.log(JSON.stringify({ phase: "complete", verified: ok, failed }));
