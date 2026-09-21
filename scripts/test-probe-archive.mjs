import assert from "node:assert/strict";
import { parseListing, symbolOf, isUsdtPerpetual, monthsOf, classify, ROOT_PREFIX } from "./probe-archive-symbols.mjs";

const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>data.binance.vision</Name><Prefix>${ROOT_PREFIX}</Prefix><Marker></Marker><IsTruncated>true</IsTruncated><NextMarker>${ROOT_PREFIX}ETHUSDT/</NextMarker><CommonPrefixes><Prefix>${ROOT_PREFIX}BTCUSDT/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>${ROOT_PREFIX}ETHUSDT/</Prefix></CommonPrefixes></ListBucketResult>`;
const p = parseListing(xml);
assert.deepEqual(p.prefixes.map(symbolOf), ["BTCUSDT", "ETHUSDT"]);
assert.equal(p.truncated, true);
assert.equal(p.next, ROOT_PREFIX + "ETHUSDT/");
assert.equal(parseListing("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").truncated, false);
assert.deepEqual(parseListing("<ListBucketResult></ListBucketResult>").prefixes, []);

const files = `<ListBucketResult><Contents><Key>a/BTCUSDT-1h-2025-03.zip</Key><Size>1</Size></Contents><Contents><Key>a/BTCUSDT-1h-2025-03.zip.CHECKSUM</Key></Contents><Contents><Key>a/BTCUSDT-1h-2024-11.zip</Key></Contents></ListBucketResult>`;
const k = parseListing(files);
assert.equal(k.keys.length, 3);
assert.deepEqual(monthsOf(k.keys), ["2024-11", "2025-03"], "checksum files are not months; months are sorted");

assert.equal(isUsdtPerpetual("BTCUSDT"), true);
assert.equal(isUsdtPerpetual("BTCUSDT_260327"), false, "a delivery contract");
assert.equal(isUsdtPerpetual("BTCUSDC"), false);
assert.equal(isUsdtPerpetual("哈基米USDT"), true);

const c = classify(["BTCUSDT", "LUNAUSDT", "BTCUSDT_260327", "ETHUSDC", "FTTUSDT", "哈基米USDT"], ["BTCUSDT", "哈基米USDT"]);
assert.deepEqual(c, { total: 6, current: 2, candidates: ["LUNAUSDT", "FTTUSDT"], delivery: 1, otherQuote: 1 });
console.log("probe-archive tests ok");
