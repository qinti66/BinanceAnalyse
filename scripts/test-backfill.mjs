import test from "node:test";
import assert from "node:assert/strict";
import { fetchFundingRange,population,RateLimitedError,PACE_MS } from "./backfill-funding.mjs";

const H=3600000;
const resp=(rows,status=200,headers={})=>({status,headers,text:JSON.stringify(rows),json:()=>rows});
const row=(t,rate=".0001")=>({symbol:"X",fundingTime:t,fundingRate:rate});
const noSleep=async()=>{};

test("fetchFundingRange paginates by startTime until a short page, without duplicates",async()=>{
 const all=Array.from({length:2300},(_,i)=>row(1e12+i*4*H));
 const calls=[];
 const get=async(url)=>{const q=new URL(url).searchParams;calls.push([Number(q.get("startTime")),Number(q.get("endTime")),Number(q.get("limit"))]);
  const from=Number(q.get("startTime")),to=Number(q.get("endTime"));return resp(all.filter(r=>r.fundingTime>=from&&r.fundingTime<=to).slice(0,1000));};
 const rows=await fetchFundingRange(get,"X",1e12,1e12+2300*4*H,{sleep:noSleep});
 assert.equal(rows.length,2300);assert.equal(calls.length,3,"1000 + 1000 + 300");
 assert.ok(calls.every(c=>c[2]===1000));assert.ok(calls[1][0]>calls[0][0]&&calls[2][0]>calls[1][0],"the cursor advances");
 assert.equal(new Set(rows.map(r=>r.time)).size,2300);assert.ok(rows.every((r,i)=>i===0||r.time>rows[i-1].time),"oldest first");
 assert.equal(calls[0][1],1e12+2300*4*H-1,"endTime is inclusive, so the range is [start, end)");
});

test("a page that returns exactly the limit triggers one more request, and an empty range is fine",async()=>{
 let n=0;const get=async()=>{n++;return resp(n===1?Array.from({length:1000},(_,i)=>row(1e12+i*H)):[]);};
 const rows=await fetchFundingRange(get,"X",1e12,1e13,{sleep:noSleep});assert.equal(rows.length,1000);assert.equal(n,2);
 assert.deepEqual(await fetchFundingRange(async()=>resp([]),"X",1e12,2e12,{sleep:noSleep}),[]);
});

test("values are numbers, junk rows are dropped, and duplicates across pages collapse",async()=>{
 const get=async()=>resp([row(1e12,"0.00010000"),row(1e12,"0.00010000"),{fundingTime:"x",fundingRate:"1"},row(1e12+8*H,"abc"),row(1e12+16*H,"-0.0002")]);
 const rows=await fetchFundingRange(get,"X",1e12,2e12,{sleep:noSleep});
 assert.deepEqual(rows,[{time:1e12,rate:.0001},{time:1e12+16*H,rate:-.0002}]);
});

test("a rate limit stops the run and is never retried past; other errors are loud too",async()=>{
 for(const status of [418,429,403]){
  let calls=0;const get=async()=>{calls++;return resp({code:-1003},status,{"retry-after":"60"});};
  await assert.rejects(fetchFundingRange(get,"X",1e12,2e12,{sleep:noSleep}),e=>e instanceof RateLimitedError&&e.status===status&&/Retry-After 60/.test(e.message));
  assert.equal(calls,1,"exactly one request: no retry after a "+status);
 }
 await assert.rejects(fetchFundingRange(async()=>resp("nope",500),"X",1e12,2e12,{sleep:noSleep}),/HTTP 500/);
 await assert.rejects(fetchFundingRange(async()=>resp({not:"an array"}),"X",1e12,2e12,{sleep:noSleep}),/unexpected response/);
 await assert.rejects(fetchFundingRange(async()=>resp(Array.from({length:1000},()=>row(1e12))),"X",1e12,2e12,{sleep:noSleep}),/did not advance/);
});

test("pacing stays inside the fundingRate budget of 500 requests per 5 minutes",()=>{
 assert.ok(300000/PACE_MS<500,"at this pace "+(300000/PACE_MS)+" requests fit in 5 minutes");
 assert.equal(PACE_MS,1500,"halved after the observed 403 (was 800 ms)");
});

test("a 403 web-firewall page is a stop, named as such, and is never retried",async()=>{
 let calls=0;
 await assert.rejects(fetchFundingRange(async()=>{calls++;return resp("<html><h1>403 Forbidden</h1></html>",403);},"X",1e12,2e12,{sleep:noSleep}),e=>e instanceof RateLimitedError&&e.status===403&&/web firewall limit/.test(e.message));
 assert.equal(calls,1);
});

test("the population is UM USDT perpetuals listed at least 30 days before the window",()=>{
 const start=Date.UTC(2025,8,1);
 const c=(symbol,over={})=>({contract:{family:"UM",quoteAsset:"USDT",contractType:"PERPETUAL",onboardDate:start-60*24*H,symbol,...over}});
 const raw={contracts:[c("BBB"),c("AAA"),c("NEW",{onboardDate:start-10*24*H}),c("CM",{family:"CM"}),c("Q",{contractType:"CURRENT_QUARTER"}),c("BUSD",{quoteAsset:"BUSD"})]};
 assert.deepEqual(population(raw,start),["AAA","BBB"],"sorted, and only what has a full trailing 30 days");
});
