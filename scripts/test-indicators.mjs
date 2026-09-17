import test from "node:test";
import assert from "node:assert/strict";
import { buildIndicators,candleFlow,tokenIdentity,ema,rsi,HOUR,number } from "../lib/indicators/model.ts";
const cutoff=Date.parse("2026-09-17T11:00:00Z");
function contract(family="UM",symbol="AAAUSDT",base="AAA"){
 const c={family,symbol,pair:"AAAUSD",baseAsset:base,quoteAsset:family==="UM"?"USDT":"USD",contractType:"PERPETUAL",contractSize:100,onboardDate:cutoff-300*24*HOUR};
 const history=Array.from({length:25},(_,i)=>({timestamp:cutoff-(24-i)*HOUR,sumOpenInterest:String(1e6+i*1e4),sumOpenInterestValue:String((1e6+i*1e4)*(family==="UM"?100:1)),CMCCirculatingSupply:"100000000"}));
 const klines=Array.from({length:200},(_,i)=>{const t=cutoff-(200-i)*HOUR;return [t,"100","101","99","100","100000",t+HOUR-1,"10000000",100,"60000","6000000",0]});
 return {contract:c,history,klines,openInterest:{openInterest:"1240000",time:cutoff},ticker:{},premium:{markPrice:"100",indexPrice:"100",lastFundingRate:"0.0001"},funding:null,fundingEndpointAvailable:true,book:{bidPrice:"99.99",askPrice:"100.01"},quoteUsd:1,receivedAt:new Date(cutoff).toISOString()};
}
const raw=(contracts=[contract()])=>({id:"fixture",startedAt:new Date(cutoff).toISOString(),completedAt:new Date(cutoff+1000).toISOString(),cutoff,contracts,excluded:[],marketCaps:[],errors:[],spotPrices:{AAA:{priceUsd:100,time:cutoff,symbol:"AAAUSDT"},PEPE:{priceUsd:.1,time:cutoff,symbol:"PEPEUSDT"}},coverage:{um:contracts.filter(c=>c.contract.family==="UM").length,cm:contracts.filter(c=>c.contract.family==="CM").length,allListed:contracts.length,allTrading:contracts.length},fxNote:"fixture"});
test("IO is buy minus sell; totals conserve volume",()=>{
 const f=candleFlow(contract().klines[0],"UM",1,null);
 assert.deepEqual(f,{inflow:6000000,outflow:4000000,net:2000000,total:10000000});
 assert.equal(f.inflow+f.outflow,f.total);
});
test("COIN-M flow uses contracts times USD face value, not base-asset quote field",()=>{
 const f=candleFlow(contract("CM").klines[0],"CM",1,100);
 assert.equal(f.total,10000000);assert.equal(f.inflow,6000000);
});
test("invalid taker volume / missing conversion remains unknown",()=>{
 const k=contract().klines[0];k[10]="20000000";assert.equal(candleFlow(k,"UM",1,null),null);
 assert.equal(candleFlow(contract().klines[0],"UM",null,null),null);
 assert.equal(number(null),null);assert.equal(number(""),null);assert.equal(number("0"),0);
});
test("OI increase is independent of derivative price increase",()=>{
 const c=contract();c.history.forEach((h,i)=>{h.sumOpenInterest="1000000";h.sumOpenInterestValue=String(1000000*(100+i));});
 const coin=buildIndicators(raw([c])).coins[0];assert.equal(coin.oi.h4,0);assert.equal(coin.oi.h24,0);
});
test("COIN-M position value uses face value, not coin-denominated OI value",()=>{
 const coin=buildIndicators(raw([contract("CM","AAAUSD_PERP")])).coins[0];
 assert.equal(coin.oiValue,124000000);
});
test("multiplied-token identity normalizes without stripping 1INCH",()=>{
 assert.deepEqual(tokenIdentity("1000PEPE"),{token:"PEPE",multiplier:1000});
 assert.deepEqual(tokenIdentity("1MBABYDOGE"),{token:"BABYDOGE",multiplier:1000000});
 assert.deepEqual(tokenIdentity("1INCH"),{token:"1INCH",multiplier:1});
});
test("scaled CMC supply is not multiplied or divided twice",()=>{
 const c=contract("UM","1000PEPEUSDT","1000PEPE");
 const coin=buildIndicators(raw([c])).coins[0];
 assert.equal(coin.marketCap,10000000000);assert.equal(coin.price,.1);
});
test("all same-token contracts aggregate once into a single coin",()=>{
 const snapshot=buildIndicators(raw([contract(),contract("CM","AAAUSD_PERP")]));
 assert.equal(snapshot.coins.length,1);assert.equal(snapshot.coins[0].oiValue,248000000);
});
test("a missing constituent prevents complete aggregate IO and OI ratios",()=>{
 const a=contract(),b=contract("CM","AAAUSD_PERP");b.history=null;b.klines=null;
 const coin=buildIndicators(raw([a,b])).coins[0];
 assert.equal(coin.oi.h4,null);assert.equal(coin.flows.h4,null);assert.equal(coin.oiCapPct,null);assert.equal(coin.candidate,false);
});
test("future/incomplete candles cannot enter IO",()=>{
 const c=contract();c.klines.push([cutoff,"100","120","90","110","10",cutoff+HOUR-1,"1000",10,"6","600",0]);
 assert.equal(buildIndicators(raw([c])).coins[0].flows.h1.total,10000000);
});
test("funding is normalized by actual interval",()=>{
 const c=contract();c.funding={fundingIntervalHours:4};
 assert.equal(buildIndicators(raw([c])).coins[0].fundingDaily,.06);
 c.fundingEndpointAvailable=false;assert.equal(buildIndicators(raw([c])).coins[0].fundingDaily,null);
});
test("equal symbol cannot force an ambiguous market-cap match",()=>{
 const c=contract();c.history.forEach(h=>delete h.CMCCirculatingSupply);
 const s=raw([c]);s.marketCaps=[{symbol:"AAA",market_cap:1e9,current_price:100,last_updated:new Date(cutoff).toISOString()},{symbol:"AAA",market_cap:1e6,current_price:100,last_updated:new Date(cutoff).toISOString()}];
 assert.equal(buildIndicators(s).coins[0].marketCap,null);
});
test("missing/zero market cap is not infinity or zero crowding",()=>{
 const c=contract();c.history.forEach(h=>h.CMCCirculatingSupply="0");
 assert.equal(buildIndicators(raw([c])).coins[0].oiCapPct,null);
});
test("no aligned spot price cannot be replaced by derivative price",()=>{
 const s=raw();s.spotPrices={};assert.equal(buildIndicators(s).coins[0].marketCap,null);
 const t=raw();t.spotPrices.AAA.time+=HOUR;assert.equal(buildIndicators(t).coins[0].marketCap,null);
});
test("RSI and EMA obey warmup and flat-series semantics",()=>{
 assert.equal(ema([1,2],20),null);assert.equal(ema(Array(30).fill(100),20),100);
 assert.equal(rsi(Array(30).fill(100)),50);assert.equal(rsi(Array.from({length:30},(_,i)=>i)),100);
});
test("OI period requires an exact time boundary",()=>{
 const c=contract();c.history=c.history.filter(h=>h.timestamp!==cutoff-4*HOUR);
 assert.equal(buildIndicators(raw([c])).coins[0].oi.h4,null);
});
