import test from "node:test";
import assert from "node:assert/strict";
import { fetchKlinesRange,INTERVAL_MS } from "./backfill-klines.mjs";
import { RateLimiter,RateLimitAbort } from "./rate-limit.mjs";

const H=3600000;
const kline=(t)=>[t,"10","12","9","11","5",t+H-1,"55","7","2","22","0"];
const resp=(body,status=200,headers={})=>({status,headers,text:JSON.stringify(body),json:()=>body});
const clock=()=>{let t=1e9;return {now:()=>t,sleep:async(ms)=>{t+=ms;},get t(){return t;}};};
const mkLimiter=(c=clock())=>({c,rl:new RateLimiter({now:c.now,sleep:c.sleep})});
// A fake exchange: serves 1h bars from `from` on, honouring startTime, endTime and limit.
const exchange=(from,n,{gapAt=-1}={})=>{const all=Array.from({length:n},(_,i)=>from+i*H).filter((_,i)=>i!==gapAt).map(kline);const calls=[];
 return {calls,get:async(url)=>{const q=new URL(url).searchParams;const s=Number(q.get("startTime")),e=Number(q.get("endTime")),l=Number(q.get("limit"));calls.push({s,e,l});
  return resp(all.filter(k=>k[0]>=s&&k[0]<=e).slice(0,l));}};};

test("pagination by startTime returns every bar once, in order, using the requested limit",async()=>{
 const ex=exchange(1e12,3500),{rl}=mkLimiter();
 const {rows,gaps,requests}=await fetchKlinesRange(ex.get,rl,"X","1h",1e12,1e12+3500*H,{limit:1500});
 assert.equal(rows.length,3500);assert.equal(requests,3,"1500 + 1500 + 500");assert.deepEqual(gaps,[]);
 assert.ok(rows.every((k,i)=>k[0]===1e12+i*H));assert.ok(ex.calls.every(c=>c.l===1500));
 assert.ok(ex.calls[1].s===ex.calls[0].s+1500*H,"each page starts right after the last bar of the previous one");
 assert.equal(ex.calls[0].e,1e12+3500*H-1,"endTime is inclusive so the range is [start, end)");
});

test("an exact multiple of the limit needs one more request to learn it is finished",async()=>{
 const ex=exchange(1e12,1500),{rl}=mkLimiter();
 const {rows,requests}=await fetchKlinesRange(ex.get,rl,"X","1h",1e12,1e12+1500*H,{limit:1500});
 assert.equal(rows.length,1500);assert.ok(requests<=2);
});

test("a hole in the exchange's data is reported as a gap, never filled",async()=>{
 const ex=exchange(1e12,100,{gapAt:40}),{rl}=mkLimiter();
 const {rows,gaps}=await fetchKlinesRange(ex.get,rl,"X","1h",1e12,1e12+100*H,{limit:1500});
 assert.equal(rows.length,99);assert.deepEqual(gaps,[{after:1e12+39*H,next:1e12+41*H}]);
});

test("every request is charged to the umMarket budget by its klines weight",async()=>{
 const ex=exchange(1e12,3500),{rl}=mkLimiter();
 await fetchKlinesRange(ex.get,rl,"X","1h",1e12,1e12+3500*H,{limit:1500});
 assert.equal(rl.used("umMarket"),30,"three requests of weight 10");
 const ex2=exchange(1e12,1000),{rl:rl2}=mkLimiter();
 await fetchKlinesRange(ex2.get,rl2,"X","1h",1e12,1e12+1000*H,{limit:500});
 assert.equal(rl2.used("umMarket"),2*(ex2.calls.length),"limit 500 is weight 2 per request, cheaper per bar than limit 1500");
});

test("the server's used-weight header feeds back and halves the pace above 80%",async()=>{
 const {rl}=mkLimiter();
 const get=async()=>resp([],200,{"x-mbx-used-weight-1m":"2200"});
 await fetchKlinesRange(get,rl,"X","1h",1e12,1e12+H,{limit:500});
 assert.equal(rl.effectiveLimit("umMarket"),1000,"2200 of 2400 is 92%");
});

test("429 waits out Retry-After and retries, but only a few times; 418 aborts; other errors are loud",async()=>{
 const {c,rl}=mkLimiter();let n=0;const t0=c.t;
 const get=async()=>{n++;return n===1?resp({code:-1003},429,{"retry-after":"20"}):resp([kline(1e12)]);};
 const {rows}=await fetchKlinesRange(get,rl,"X","1h",1e12,1e12+H,{limit:500});
 assert.equal(rows.length,1);assert.ok(c.t-t0>=20000,"it really waited for Retry-After");
 const always=async()=>resp({},429,{"retry-after":"1"});
 await assert.rejects(fetchKlinesRange(always,mkLimiter().rl,"X","1h",1e12,1e12+H,{limit:500}),/429 after 3 retries/);
 const ban=mkLimiter().rl;
 await assert.rejects(fetchKlinesRange(async()=>resp({},418),ban,"X","1h",1e12,1e12+H,{limit:500}),RateLimitAbort);
 await assert.rejects(ban.acquire("umMarket",1),RateLimitAbort,"after a 418 the limiter refuses any further request");
 await assert.rejects(fetchKlinesRange(async()=>resp("no",500),mkLimiter().rl,"X","1h",1e12,1e12+H,{limit:500}),/HTTP 500/);
 await assert.rejects(fetchKlinesRange(async()=>resp({a:1}),mkLimiter().rl,"X","1h",1e12,1e12+H,{limit:500}),/unexpected response/);
});

test("a 403 web-firewall response aborts the run and blocks every later request",async()=>{
 const rl=mkLimiter().rl;
 await assert.rejects(fetchKlinesRange(async()=>resp("<html>403 Forbidden</html>",403),rl,"X","1h",1e12,1e12+H,{limit:500}),e=>e instanceof RateLimitAbort&&e.status===403);
 await assert.rejects(rl.acquire("umMarket",1),/web application firewall/);
});

test("bad arguments and a stuck cursor fail instead of looping",async()=>{
 const {rl}=mkLimiter();
 await assert.rejects(fetchKlinesRange(async()=>resp([]),rl,"X","7h",0,1,{}),/unsupported interval/);
 await assert.rejects(fetchKlinesRange(async()=>resp([]),rl,"X","1h",0,1,{limit:2000}),/limit must be/);
 await assert.rejects(fetchKlinesRange(async()=>resp(Array.from({length:500},()=>kline(1e12))),rl,"X","1h",1e12,1e12+10*H,{limit:500}),/did not advance/);
 assert.equal(INTERVAL_MS["4h"],4*H);
});
