// One-line answer to "can we reach Binance, and by which path?". Run before any collection.
//   node scripts/check-binance-net.mjs
import { preflight } from "./binance-net.mjs";

try {
  const { report } = await preflight();
  for (const line of report) console.log(line);
} catch (e) {
  for (const line of e.report ?? [String(e)]) console.log(line);
  process.exitCode = 1;
}
