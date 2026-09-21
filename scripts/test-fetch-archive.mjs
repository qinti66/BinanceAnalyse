import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { months,parseKlinesCsv,parseFundingCsv,checksumMatches } from "./fetch-archive.mjs";

test("months() is inclusive and crosses year ends",()=>{
 assert.deepEqual(months("2025-06","2025-06"),["2025-06"]);
 assert.deepEqual(months("2025-06","2025-11"),["2025-06","2025-07","2025-08","2025-09","2025-10","2025-11"]);
 assert.deepEqual(months("2024-11","2025-02"),["2024-11","2024-12","2025-01","2025-02"]);
 assert.equal(months("2024-08","2025-11").length,16);
 assert.deepEqual(months("2025-06","2025-05"),[],"an inverted range is empty, not a wrap-around");
 for(const bad of [["2025-13","2025-14"],["x","2025-01"],["2025-00","2025-01"]])assert.throws(()=>months(...bad));
});

test("kline CSV parsing skips the header, keeps 12 raw columns, and rejects non-millisecond timestamps",()=>{
 const csv="open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n1756684800000,10,12,9,11,5,1756688399999,55,7,2,22,0\r\n1756688400000,11,13,10,12,6,1756691999999,66,8,3,33,0\n";
 const r=parseKlinesCsv(csv);
 assert.equal(r.length,2);assert.equal(r[0].length,12);assert.deepEqual([r[0][0],r[0][1],r[0][6],r[0][8]],[1756684800000,"10",1756688399999,7]);
 assert.equal(parseKlinesCsv("1756684800,1,2,3,4,5,6,7,8,9,10,0\n").length,0,"10-digit (seconds) or 16-digit (microsecond) timestamps are refused, never silently rescaled");
 assert.deepEqual(parseKlinesCsv(""),[]);assert.deepEqual(parseKlinesCsv("a,b,c"),[]);
});

test("fundingRate CSV parsing",()=>{
 const r=parseFundingCsv("calc_time,funding_interval_hours,last_funding_rate\n1756713600000,8,0.00010000\n1756742400000,8,-0.00002500\n");
 assert.deepEqual(r,[{time:1756713600000,intervalHours:8,rate:.0001},{time:1756742400000,intervalHours:8,rate:-.000025}]);
 assert.deepEqual(parseFundingCsv("x\n"),[]);
});

test("checksum verification accepts only the exact digest",()=>{
 const buf=Buffer.from("hello archive"),h=createHash("sha256").update(buf).digest("hex");
 assert.equal(checksumMatches(buf,h+"  file.zip\n"),true);assert.equal(checksumMatches(buf,h.toUpperCase()+" file.zip"),true);
 assert.equal(checksumMatches(buf,"0".repeat(64)+"  file.zip"),false);assert.equal(checksumMatches(buf,""),false);assert.equal(checksumMatches(Buffer.from("tampered"),h),false);
});
