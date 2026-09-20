import test from "node:test";
import assert from "node:assert/strict";
import { toBars,candleFlow } from "../lib/structure/bars.ts";
import { HOUR } from "../lib/indicators/model.ts";
const cutoff=10*HOUR;
// [openTime,o,h,l,c,vol,closeTime,quoteVol,trades,takerBuyBase,takerBuyQuote,ignore]
const row=(i,o={})=>{const t=i*HOUR;return [t,"10","12","9","11","5",t+HOUR-1,"55","7","2","22","0"].map((v,j)=>o[j]!==undefined?o[j]:v);};
const rows=()=>Array.from({length:10},(_,i)=>row(i));
test("missing inputs stay missing, never zero",()=>{
 const r=toBars([row(0,{7:null,10:null,8:"",2:null})],"UM",1,null,cutoff,HOUR);
 assert.equal(r.bars.length,1);
 const b=r.bars[0];
 assert.equal(b.flow,null);assert.equal(b.qvUsd,null);assert.equal(b.takerBuyUsd,null);assert.equal(b.trades,null);
 assert.ok(Number.isNaN(b.h));
});
test("UM uses quote columns, CM uses contract columns times contractSize",()=>{
 const k=row(0);
 assert.deepEqual(candleFlow(k,"UM",2,null),{inflow:44,outflow:66,net:-22,total:110});
 assert.deepEqual(candleFlow(k,"CM",null,100),{inflow:200,outflow:300,net:-100,total:500});
 assert.equal(candleFlow(k,"CM",2,null),null);
});
test("toBars keeps OHLC, sorts oldest-first and reports contiguity",()=>{
 const r=toBars(rows().reverse(),"UM",1,null,cutoff,HOUR);
 assert.equal(r.bars.length,10);assert.equal(r.contiguous,true);assert.equal(r.coverage,1);
 assert.deepEqual([r.bars[0].o,r.bars[0].h,r.bars[0].l,r.bars[0].c],[10,12,9,11]);
 assert.ok(r.bars.every((b,i)=>i===0||b.t>r.bars[i-1].t));
});
test("a gap, a stale last bar, or an invalid close breaks or drops correctly",()=>{
 const gap=rows();gap.splice(4,1);
 assert.equal(toBars(gap,"UM",1,null,cutoff,HOUR).contiguous,false);
 assert.equal(toBars(rows().slice(0,9),"UM",1,null,cutoff,HOUR).contiguous,false);
 const bad=rows();bad[3]=row(3,{4:"0"});
 const r=toBars(bad,"UM",1,null,cutoff,HOUR);
 assert.equal(r.bars.length,9);assert.equal(r.coverage,0.9);
 assert.equal(toBars([],"UM",1,null,cutoff,HOUR).coverage,0);
});
test("bars closing at or after cutoff are excluded",()=>{
 const r=toBars([...rows(),row(10)],"UM",1,null,cutoff,HOUR);
 assert.equal(r.bars.length,10);
});
