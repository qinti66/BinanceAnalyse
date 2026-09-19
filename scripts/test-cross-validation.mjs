import test from "node:test";
import assert from "node:assert/strict";
import {buildCross,verdict} from "../lib/cross-validation/model.ts";
import {classify,normalizeSquare} from "../lib/square/normalize.ts";
const now=Date.UTC(2026,8,17,12),stamp=new Date(now).toISOString();
const signal=(direction,available=true)=>({direction,available,at:now,count:3,summary:"",links:[]});
test("all four combinations and missing/neutral/conflict verdicts",()=>{
 for(const n of [2,3]){assert.equal(verdict(Array.from({length:n},()=>signal(1)),false),"信号同向偏多");assert.equal(verdict(Array.from({length:n},()=>signal(-1)),true),"历史方向同向偏空");}
 assert.equal(verdict([signal(1),signal(-1)],false),"信号冲突");
 assert.equal(verdict([signal(1),signal(1,false)],false),"证据不足");
 assert.equal(verdict([signal(1),signal(0)],true),"尚未形成共识");
});
const raw=()=>[1,2,3].map(id=>({id:String(id),squareAuthorId:"author"+id,authorName:"author"+id,date:now/1000-600,content:"BTC bullish",tradingPairs:[{code:"BTC"}],likeCount:10,commentCount:2}));
const square=()=>normalizeSquare(raw(),stamp,new Set(["BTC"]));
const coin={token:"BTC",representative:"BTCUSDT",contracts:[{symbol:"BTCUSDT",type:"PERPETUAL"}],quality:true,liquid:true,priceChange:{h4:2},ioNetRatio4h:10,oi:{h4:5},contractCount:1,warnings:[],attention:50,volumeRatio:1.6,rsi:60,atrPct:2,spreadBps:5,oiCapPct:10,fundingDaily:.02,trend:"多头排列"};
const indicator={cutoff:now,coins:[coin]};
test("real square and indicators agree; demo never leaks",()=>{
 const s={square:square(),indicators:indicator,copy:null};
 assert.equal(buildCross(s,["square","indicators"],"quality",now).rows[0].state,"信号同向偏多");
 s.square.mode="demo";assert.equal(buildCross(s,["square","indicators"],"quality",now).rows[0].state,"证据不足");
});
test("stale, future, too few authors, deselection, historical cutoffs",()=>{
 const s={square:square(),indicators:indicator,copy:null};
 assert.equal(buildCross(s,["square"],"quality",now).rows[0].state,"至少选择两个模块");
 assert.equal(buildCross(s,["square","indicators"],"quality",now+7*3600000).rows[0].state,"证据不足");
 s.square.posts=s.square.posts.slice(0,1);assert.equal(buildCross(s,["square","indicators"],"quality",now).rows[0].state,"证据不足");
 s.square=square();s.square.posts.forEach(p=>p.postedAt=new Date(now+1).toISOString());assert.equal(buildCross(s,["square","indicators"],"quality",now).rows[0].state,"证据不足");
});
test("Hyperliquid live positions are current-snapshot votes; distinct addresses required, k-prefixed meme coins normalized",()=>{
 const entity=(address,coin="BTC",side="LONG",overrides={})=>({address,name:address,kind:"trader",pool:"quality",fresh:true,error:null,observedAt:stamp,positions:[{coin,side,notional:1000}],...overrides});
 const copy={generatedAt:stamp,entities:[entity("a"),entity("b")]};
 let result=buildCross({square:square(),indicators:indicator,copy},["square","indicators","copy"],"quality",now);
 assert.equal(result.rows[0].state,"信号同向偏多");
 assert.equal(buildCross({square:square(),indicators:indicator,copy},["square","copy"],"quality",now+300000).rows[0].state,"信号同向偏多");
 // Only one distinct address votes: below the "at least 2" threshold, so no direction.
 copy.entities[1].address="a";assert.equal(buildCross({square:null,indicators:indicator,copy},["indicators","copy"],"quality",now).rows[0].state,"证据不足");
 copy.entities[1].address="b";
 // Non-fresh or errored entities are excluded from voting even if their positions would otherwise agree.
 copy.entities[1].fresh=false;
 assert.equal(buildCross({square:null,indicators:indicator,copy},["indicators","copy"],"quality",now).rows[0].state,"证据不足");
 copy.entities[1].fresh=true;copy.entities[1].error="stale";
 assert.equal(buildCross({square:null,indicators:indicator,copy},["indicators","copy"],"quality",now).rows[0].state,"证据不足");
 // "kBTC" doesn't exist, but the k-prefix normalization should still map a real 1000x meme coin (kPEPE) onto the plain PEPE token.
 copy.entities[1].error=null;copy.entities[0].positions=[{coin:"kPEPE",side:"SHORT",notional:500}];copy.entities[1].positions=[{coin:"kPEPE",side:"SHORT",notional:500}];
 const pepeIndicator={cutoff:now,coins:[{...coin,token:"PEPE"}]};
 const pepeResult=buildCross({square:null,indicators:pepeIndicator,copy},["indicators","copy"],"quality",now);
 assert.equal(pepeResult.rows[0].token,"PEPE");assert.equal(pepeResult.rows[0].signals.copy.summary.includes("空 2"),true);
 // Selecting a pool that neither entity belongs to (both are "quality") yields no votes for that pool.
 assert.equal(buildCross({square:null,indicators:indicator,copy},["indicators","copy"],"ordinary",now).rows.some(r=>r.signals.copy.available),false);
});
test("hidden amounts, duplicate posts, conditional/negative language and unmapped coins",()=>{
 const rows=raw();rows[0].shareTrading={futuresTrading:{baseAsset:"BTC",positionSide:"LONG",showAmount:false,isShowPNL:false,positionSize:"10000",pnl:"500",positionCreateTime:now-3600000}};
 const s=normalizeSquare([...rows,rows[0]],stamp,new Set(["BTC"]));assert.equal(s.posts.length,3);
 assert.equal(s.posts[0].sharedPosition.notionalUsd,null);assert.equal(s.posts[0].sharedPosition.pnlUsd,null);assert.equal(s.posts[0].evidence,null);
 for(const text of ["not bullish","if BTC falls buy","不要做多","buy or sell?"])assert.equal(classify(text).direction,0);
 assert.equal(normalizeSquare(rows,stamp,new Set(["ETH"])).posts.length,0);
});
