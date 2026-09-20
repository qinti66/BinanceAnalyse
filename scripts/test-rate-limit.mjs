import test from "node:test";
import assert from "node:assert/strict";
import { RateLimiter,klinesWeight,FAMILY_LIMITS,RateLimitAbort,THROTTLE_HIGH,THROTTLE_LOW } from "./rate-limit.mjs";

// A fake clock: sleeping advances time, so nothing really waits.
const clock=()=>{let t=1_000_000;return {now:()=>t,sleep:async(ms)=>{t+=ms;},advance:(ms)=>{t+=ms;},get t(){return t;}};};
const make=(limits,c=clock())=>({c,rl:new RateLimiter({limits,now:c.now,sleep:c.sleep})});
const small={a:{limit:5,windowMs:1000,official:10},b:{limit:3,windowMs:1000,official:10}};

test("requests inside the window budget are not delayed",async()=>{
 const {c,rl}=make(small);const t0=c.t;
 for(let i=0;i<5;i++)await rl.acquire("a");
 assert.equal(c.t,t0,"5 of 5 fit without waiting");
});

test("the request that does not fit waits exactly until the oldest one leaves the window",async()=>{
 const {c,rl}=make(small);const t0=c.t;
 await rl.acquire("a");c.advance(300);
 for(let i=0;i<4;i++)await rl.acquire("a");
 const before=c.t;
 await rl.acquire("a");
 assert.equal(c.t-t0,1000+0,"waits until t0 + windowMs, when the first event expires");
 assert.equal(before-t0,300);
});

test("families are independent budgets",async()=>{
 const {c,rl}=make(small);const t0=c.t;
 for(let i=0;i<5;i++)await rl.acquire("a");
 for(let i=0;i<3;i++)await rl.acquire("b");
 assert.equal(c.t,t0,"exhausting a leaves b untouched");
 await rl.acquire("b");assert.ok(c.t>t0,"b then waits on its own window");
});

test("weights count: a heavy request takes several slots",async()=>{
 const {c,rl}=make(small);const t0=c.t;
 await rl.acquire("a",3);await rl.acquire("a",2);assert.equal(c.t,t0);
 await rl.acquire("a",1);assert.equal(c.t-t0,1000,"5 weight already used, so it has to wait a full window");
 assert.equal(klinesWeight(1),1);assert.equal(klinesWeight(100),1);assert.equal(klinesWeight(101),2);assert.equal(klinesWeight(500),2);
 assert.equal(klinesWeight(501),5);assert.equal(klinesWeight(1000),5);assert.equal(klinesWeight(1001),10);assert.equal(klinesWeight(1500),10);
});

test("the shipped limits keep headroom under the official caps",()=>{
 for(const [k,v] of Object.entries(FAMILY_LIMITS))assert.ok(v.limit<=v.official*0.9+1e-9,k+" leaves at least 10% headroom");
 assert.equal(FAMILY_LIMITS.futuresData.windowMs,300000,"/futures/data/ is counted per 5 minutes");
 assert.equal(FAMILY_LIMITS.futuresData.limit,900);
});

test("a request that can never fit is an error, not an infinite wait",async()=>{
 const {rl}=make(small);
 await assert.rejects(rl.acquire("a",6),/can never fit/);await assert.rejects(rl.acquire("zzz"),/unknown rate limit family/);await assert.rejects(rl.acquire("a",0),/positive/);
});

test("server feedback halves the pace above 80% of the official cap and restores it below 50%",async()=>{
 const {rl}=make(small);
 assert.equal(rl.effectiveLimit("a"),5);
 rl.feedback("a",9);assert.equal(rl.effectiveLimit("a"),2.5,"90% of the official 10");
 rl.feedback("a",6.5);assert.equal(rl.effectiveLimit("a"),2.5,"between the two thresholds it stays throttled (hysteresis)");
 rl.feedback("a",4);assert.equal(rl.effectiveLimit("a"),5,"40% restores it");
 rl.feedback("a",NaN);assert.equal(rl.effectiveLimit("a"),5,"a missing header changes nothing");
 assert.equal(THROTTLE_HIGH,.8);assert.equal(THROTTLE_LOW,.5);
 rl.feedback("a",9);
 const {c,rl:r2}=make(small);r2.feedback("a",9);const t0=c.t;
 await r2.acquire("a");await r2.acquire("a");await r2.acquire("a");
 assert.ok(c.t>t0,"with the pace halved the third request in a window has to wait");
});

test("429 blocks every family until Retry-After; 418 aborts the run for good",async()=>{
 const {c,rl}=make(small);const t0=c.t;
 assert.equal(rl.onStatus(200),false);assert.equal(rl.onStatus(429,30),true);
 await rl.acquire("b");assert.equal(c.t-t0,30000,"the other family waited too");
 assert.equal(rl.onStatus(429),true,"no Retry-After header still waits at least a second");
 assert.throws(()=>rl.onStatus(418),RateLimitAbort);
 await assert.rejects(rl.acquire("a"),RateLimitAbort,"after an abort nothing more is sent");
 await assert.rejects(rl.acquire("b"),/banned or blocked/);
});

test("403 (web firewall) aborts like a ban and says so",async()=>{
 const {rl}=make(small);
 assert.throws(()=>rl.onStatus(403),e=>e instanceof RateLimitAbort&&e.status===403&&/web application firewall/.test(e.message));
 await assert.rejects(rl.acquire("a"),/web application firewall/,"nothing more is sent after a 403");
});

test("used() only counts what is still inside the window",async()=>{
 const {c,rl}=make(small);
 await rl.acquire("a",2);c.advance(600);await rl.acquire("a",1);assert.equal(rl.used("a"),3);
 c.advance(500);assert.equal(rl.used("a"),1,"the first event has expired");
 c.advance(600);assert.equal(rl.used("a"),0);
});
