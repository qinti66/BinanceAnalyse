import test from "node:test";
import assert from "node:assert/strict";
import {analyzeDirection} from "../lib/indicators/direction.ts";
const now=Date.UTC(2026,8,17,13);
const fixture=()=>({quality:true,liquid:true,priceChange:{h4:2},ioNetRatio4h:10,oi:{h4:4},volumeRatio:1.6,rsi:60,atrPct:2,spreadBps:5,oiCapPct:10,fundingDaily:.02,trend:"多头排列",representative:"AAAUSDT",contracts:[{symbol:"AAAUSDT",type:"PERPETUAL"}],warnings:[],attention:100});
const analyze=c=>analyzeDirection(c,now,now+3600000);
test("long, short and inconsistent signals",()=>{
 assert.equal(analyze(fixture()).state,"long");
 const c=fixture();c.priceChange.h4=-2;c.ioNetRatio4h=-10;c.trend="空头排列";c.rsi=40;assert.equal(analyze(c).state,"short");
 c.ioNetRatio4h=10;assert.equal(analyze(c).state,"wait");
});
test("OI alone and high attention cannot imply direction",()=>{
 const c=fixture();c.priceChange.h4=0;c.ioNetRatio4h=0;c.oi.h4=100;assert.equal(analyze(c).direction,0);
 c.priceChange.h4=2;c.ioNetRatio4h=10;c.trend="震荡";assert.equal(analyze(c).direction,0);
});
test("missing, expired, future or illiquid evidence cannot give a side",()=>{
 for(const key of ["rsi","atrPct","volumeRatio","fundingDaily","spreadBps"]){const c=fixture();c[key]=null;assert.equal(analyze(c).state,"missing",key);}
 assert.equal(analyzeDirection(fixture(),now,now+7*3600000).state,"stale");
 assert.equal(analyzeDirection(fixture(),now+120000,now).state,"stale");
 assert.equal(analyze({...fixture(),liquid:false}).direction,0);
});
test("overheating, funding, crowding, shrinking OI and volatility lead to wait, not reversal",()=>{
 for(const changes of [{rsi:75},{fundingDaily:.1},{oiCapPct:50},{atrPct:5},{oi:{h4:-3}},{oi:{h4:0},volumeRatio:1}]){
  const a=analyze({...fixture(),...changes});assert.equal(a.direction,0);assert.equal(a.bias,1);assert.ok(a.risks.length);
 }
});
test("missing cap is not zero; absent perpetual funding only exempt for delivery",()=>{
 const a=analyze({...fixture(),oiCapPct:null});assert.equal(a.direction,1);assert.ok(a.risks.some(x=>x.includes("市值比例缺失")));
 const c=fixture();c.contracts[0].type="CURRENT_QUARTER";c.fundingDaily=null;assert.equal(analyze(c).direction,1);
});
