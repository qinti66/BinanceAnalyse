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
const coin={token:"BTC",contracts:[{symbol:"BTCUSDT"}],quality:true,liquid:true,priceChange:{h4:2},ioNetRatio4h:10,oi:{h4:5},contractCount:1,warnings:[],attention:50};
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
test("closed trades are historical, distinct people required; unmapped excluded",()=>{
 const trader=id=>({id,name:id,pool:"quality",observedAt:stamp,historyAt:stamp,positionShow:true,checks:[{key:"public",pass:true},{key:"integrity",pass:true}],sourceUrl:"https://www.binance.com/",metrics:{anomalyScore:0,cycles:[{symbol:"BTCUSDT",side:"LONG",closedAt:now-1000,holdSeconds:500,pnl:1}]}});
 const copy={generatedAt:stamp,traders:[trader("a"),trader("b")]};
 let result=buildCross({square:square(),indicators:indicator,copy},["square","indicators","copy"],"quality",now);
 assert.equal(result.rows[0].state,"历史方向同向偏多");
 assert.equal(buildCross({square:square(),indicators:indicator,copy},["square","copy"],"quality",now+300000).rows[0].state,"历史方向同向偏多");
 copy.traders[1].id="a";assert.equal(buildCross({square:null,indicators:indicator,copy},["indicators","copy"],"quality",now).rows[0].state,"证据不足");
 copy.traders[1].id="b";copy.traders[1].metrics.cycles[0].symbol="GOLDUSDT";
 assert.equal(buildCross({square:null,indicators:indicator,copy},["indicators","copy"],"quality",now).unmapped,1);
});
test("hidden amounts, duplicate posts, conditional/negative language and unmapped coins",()=>{
 const rows=raw();rows[0].shareTrading={futuresTrading:{baseAsset:"BTC",positionSide:"LONG",showAmount:false,isShowPNL:false,positionSize:"10000",pnl:"500",positionCreateTime:now-3600000}};
 const s=normalizeSquare([...rows,rows[0]],stamp,new Set(["BTC"]));assert.equal(s.posts.length,3);
 assert.equal(s.posts[0].sharedPosition.notionalUsd,null);assert.equal(s.posts[0].sharedPosition.pnlUsd,null);assert.equal(s.posts[0].evidence,null);
 for(const text of ["not bullish","if BTC falls buy","不要做多","buy or sell?"])assert.equal(classify(text).direction,0);
 assert.equal(normalizeSquare(rows,stamp,new Set(["ETH"])).posts.length,0);
});
