import test from "node:test";
import assert from "node:assert/strict";
import {evaluateEntity,buildHyperliquidSnapshot,rawEntityFromLeaderboard,rawEntityFromVault,diffPositions} from "../lib/copy-trading/hyperliquid-model.ts";
const now=Date.UTC(2026,8,19,12),stamp=new Date(now).toISOString();
const state=(positions=[])=>({assetPositions:positions.map(p=>({type:"oneWay",position:{coin:p.coin,szi:String(p.szi),entryPx:String(p.entryPx??1),leverage:{type:"cross",value:p.leverage??10},positionValue:String(p.notional??Math.abs(p.szi)*(p.entryPx??1)),unrealizedPnl:String(p.pnl??0),liquidationPx:p.liq===undefined?null:String(p.liq),marginUsed:String(p.margin??100)}})),marginSummary:{accountValue:String(50000),totalNtlPos:"0",totalRawUsd:"0",totalMarginUsed:"0"}});
const trader=(over={})=>({kind:"trader",address:"0x"+"a".repeat(40),name:null,performance:{allTime:{pnl:1000,roi:.2,vlm:1e6},day:{pnl:10,roi:.01,vlm:5000},week:{pnl:50,roi:.02,vlm:20000}},clearinghouse:state(),clearinghouseError:null,observedAt:stamp,...over});
test("missing/failed clearinghouse data keeps the account out, not silently zeroed",()=>{
 const e=evaluateEntity(trader({clearinghouse:null,clearinghouseError:"HTTP 500"}),now);
 assert.equal(e.positionCount,0);assert.equal(e.accountValue,null);assert.equal(e.checks.find(c=>c.key==="data").pass,false);assert.equal(e.pool,"ordinary");
});
test("account value, PnL and recent-activity gates all must pass for the quality pool",()=>{
 const ok=evaluateEntity(trader(),now);
 assert.equal(ok.pool,"quality");assert.equal(ok.checks.every(c=>c.pass),true);
 const poor=evaluateEntity(trader({clearinghouse:{...state(),marginSummary:{...state().marginSummary,accountValue:"5000"}}}),now);
 assert.equal(poor.checks.find(c=>c.key==="scale").pass,false);assert.equal(poor.pool,"ordinary");
 const losing=evaluateEntity(trader({performance:{...trader().performance,allTime:{pnl:-1,roi:-.01,vlm:1e6}}}),now);
 assert.equal(losing.checks.find(c=>c.key==="pnl").pass,false);
 const stale=evaluateEntity(trader({observedAt:new Date(now-13*3600000).toISOString()}),now);
 assert.equal(stale.checks.find(c=>c.key==="fresh").pass,false);
});
test("vaults get two extra gates (open for deposits, 30-day tenure); unknown allowDeposits is not penalized",()=>{
 const vault=(over={})=>evaluateEntity({kind:"vault",address:"0x"+"b".repeat(40),name:"Test Vault",leader:"0x"+"c".repeat(40),tvl:100000,createdAt:now-60*86400000,isClosed:false,allowDeposits:null,followerCount:5,leaderCommission:.1,apr:.3,performance:trader().performance,clearinghouse:state(),clearinghouseError:null,observedAt:stamp,...over},now);
 const v=vault();assert.equal(v.checks.find(c=>c.key==="open").pass,true);assert.equal(v.checks.find(c=>c.key==="tenure").pass,true);assert.equal(v.pool,"quality");
 assert.equal(vault({isClosed:true}).checks.find(c=>c.key==="open").pass,false);
 assert.equal(vault({allowDeposits:false}).checks.find(c=>c.key==="open").pass,false);
 assert.equal(vault({createdAt:now-10*86400000}).checks.find(c=>c.key==="tenure").pass,false);
});
test("positions: signed szi becomes side+size, k-less coin passthrough, notional/leverage aggregation, hedge-mode dedupe by size",()=>{
 const e=evaluateEntity(trader({clearinghouse:state([{coin:"BTC",szi:2,entryPx:60000,leverage:20,notional:120000,pnl:500},{coin:"ETH",szi:-10,entryPx:3000,leverage:5,notional:30000,pnl:-50}])}),now);
 assert.equal(e.positionCount,2);assert.equal(e.distinctCoins,2);
 assert.equal(e.positions.find(p=>p.coin==="BTC").side,"LONG");assert.equal(e.positions.find(p=>p.coin==="ETH").side,"SHORT");
 assert.equal(e.longNotional,120000);assert.equal(e.shortNotional,30000);assert.equal(e.totalNotional,150000);
 assert.equal(e.netExposurePct,60); // (120000-30000)/150000*100
 assert.equal(e.weightedLeverage,(20*120000+5*30000)/150000);
 const zeroSize=evaluateEntity(trader({clearinghouse:state([{coin:"BTC",szi:0,entryPx:1}])}),now);
 assert.equal(zeroSize.positionCount,0); // szi=0 is not a position, not a LONG-of-size-zero
});
test("rawEntityFromLeaderboard/rawEntityFromVault map official snapshot shapes without inventing fields",()=>{
 const row={ethAddress:"0x"+"d".repeat(40),accountValue:"999999",windowPerformances:[["day",{pnl:"1",roi:"0.001",vlm:"100"}],["allTime",{pnl:"5000",roi:"0.5",vlm:"9999"}]],prize:0,displayName:"Whale"};
 const rt=rawEntityFromLeaderboard(row,state(),null,stamp);
 assert.equal(rt.kind,"trader");assert.equal(rt.name,"Whale");assert.equal(rt.performance.allTime.pnl,5000);assert.equal(rt.performance.month,undefined);
 const entry={apr:0.4,pnls:[["day",["0","1","2"]],["allTime",["0","10","25"]]],summary:{name:"V","vaultAddress:":"x","vaultAddress":"0x"+"e".repeat(40),leader:"0x"+"f".repeat(40),tvl:"50000",isClosed:false,relationship:{type:"normal"},createTimeMillis:now-90*86400000}};
 const rv=rawEntityFromVault(entry,null,state(),null,stamp);
 assert.equal(rv.kind,"vault");assert.equal(rv.performance.allTime.pnl,25);assert.equal(rv.allowDeposits,null);assert.equal(rv.followerCount,null);
 const rvWithDetail=rawEntityFromVault(entry,{allowDeposits:true,followers:[{},{}],leaderCommission:.15,apr:.44},state(),null,stamp);
 assert.equal(rvWithDetail.allowDeposits,true);assert.equal(rvWithDetail.followerCount,2);assert.equal(rvWithDetail.apr,.44);
});
test("snapshot sorts quality pool first then by account value, and reports coverage without fabricating discovery counts",()=>{
 const rows=[trader({address:"0x1".padEnd(42,"1")}),trader({address:"0x2".padEnd(42,"2"),clearinghouse:{...state(),marginSummary:{...state().marginSummary,accountValue:"999999"}}}),trader({address:"0x3".padEnd(42,"3"),clearinghouse:null,clearinghouseError:"timeout"})];
 const snap=buildHyperliquidSnapshot(rows,{traders:12345,vaults:678},now);
 assert.equal(snap.schemaVersion,2);
 assert.equal(snap.coverage.discoveredTraders,12345);assert.equal(snap.coverage.discoveredVaults,678);
 assert.equal(snap.coverage.analyzed,3);assert.equal(snap.coverage.quality,2);assert.equal(snap.coverage.ordinary,1);assert.equal(snap.coverage.positionErrors,1);
 assert.equal(snap.entities[0].address,"0x2".padEnd(42,"2")); // higher account value ranks first within the quality pool
 assert.equal(snap.entities.at(-1).pool,"ordinary");
});
const pos=(coin,szi,notional,over={})=>({coin,side:szi>0?"LONG":"SHORT",size:Math.abs(szi),entryPx:1,leverage:10,leverageType:"cross",notional,unrealizedPnl:0,liquidationPx:null,marginUsed:1,...over});
const priorEntity=(address,positions,over={})=>({address,name:null,kind:"trader",positions,...over});
test("diffPositions: no baseline means no events, not a fabricated 'opened'",()=>{
 assert.deepEqual(diffPositions(null,[{address:"0xa",kind:"trader",name:null,positions:[pos("BTC",1,1000)]}],stamp),[]);
 assert.deepEqual(diffPositions([],[{address:"0xa",kind:"trader",name:null,positions:[pos("BTC",1,1000)]}],stamp),[]);
 // Address wasn't in the previous snapshot at all: still no baseline for it specifically, even if others were tracked.
 const prev=[priorEntity("0xb",[])];
 assert.deepEqual(diffPositions(prev,[{address:"0xa",kind:"trader",name:null,positions:[pos("BTC",1,1000)]}],stamp),[]);
});
test("diffPositions: opened/closed/reversed/increased/reduced are detected per coin, small moves are noise",()=>{
 const prev=[priorEntity("0xa",[pos("BTC",1,1000),pos("ETH",-1,500),pos("SOL",2,2000)])];
 const cur=[{address:"0xa",kind:"trader",name:"Alice",positions:[
  pos("BTC",1,1400), // +40% notional, same side -> increased (>=30% threshold)
  pos("ETH",1,500), // side flipped -> reversed
  // SOL closed (absent)
  pos("DOGE",1,10), // new coin -> opened
 ]}];
 const events=diffPositions(prev,cur,stamp);
 const byType=Object.fromEntries(events.map(e=>[e.coin+":"+e.type,e]));
 assert.ok(byType["BTC:increased"]);assert.equal(byType["BTC:increased"].fromNotional,1000);assert.equal(byType["BTC:increased"].toNotional,1400);
 assert.ok(byType["ETH:reversed"]);assert.equal(byType["ETH:reversed"].fromSide,"SHORT");assert.equal(byType["ETH:reversed"].toSide,"LONG");
 assert.ok(byType["SOL:closed"]);assert.equal(byType["SOL:closed"].toSide,null);
 assert.ok(byType["DOGE:opened"]);assert.equal(byType["DOGE:opened"].fromSide,null);
 assert.equal(events.every(e=>e.address==="0xa"&&e.name==="Alice"),true);
 // A small same-side notional wobble (well under the 30% threshold) shouldn't produce an event.
 const stable=diffPositions([priorEntity("0xa",[pos("BTC",1,1000)])],[{address:"0xa",kind:"trader",name:null,positions:[pos("BTC",1,1050)]}],stamp);
 assert.deepEqual(stable,[]);
});
test("buildHyperliquidSnapshot dedupes an address that shows up as both a vault and a leaderboard trader, preferring the vault identity",()=>{
 const addr="0x"+"9".repeat(40);
 const rows=[{kind:"trader",address:addr,name:null,performance:trader().performance,clearinghouse:state([{coin:"ETH",szi:1,notional:500}]),clearinghouseError:null,observedAt:stamp},{kind:"vault",address:addr,name:"Big Vault",leader:"0x"+"1".repeat(40),tvl:5e6,createdAt:now-90*86400000,isClosed:false,allowDeposits:true,followerCount:10,leaderCommission:.1,apr:.2,performance:trader().performance,clearinghouse:state([{coin:"BTC",szi:1,notional:1000}]),clearinghouseError:null,observedAt:stamp}];
 const snap=buildHyperliquidSnapshot(rows,{traders:1,vaults:1},now,null);
 assert.equal(snap.entities.length,1);
 assert.equal(snap.entities[0].kind,"vault");
 assert.equal(snap.entities[0].name,"Big Vault");
 assert.equal(snap.coverage.analyzed,1);
});
test("buildHyperliquidSnapshot threads a previous snapshot through to produce and accumulate events, capped at 500",()=>{
 const raw1=[trader({address:"0x1".padEnd(42,"1"),clearinghouse:state([{coin:"BTC",szi:1,notional:1000}])})];
 const first=buildHyperliquidSnapshot(raw1,{traders:1,vaults:0},now,null);
 assert.equal(first.events.length,0);assert.equal(first.coverage.newEvents,0); // no prior snapshot: nothing to diff against
 const raw2=[trader({address:"0x1".padEnd(42,"1"),clearinghouse:state([{coin:"BTC",szi:-1,notional:1000}])})]; // flipped to short
 const second=buildHyperliquidSnapshot(raw2,{traders:1,vaults:0},now+3600000,first);
 assert.equal(second.coverage.newEvents,1);assert.equal(second.events[0].type,"reversed");assert.equal(second.events[0].coin,"BTC");
 // A third run with no further change should add nothing new but keep the prior event in history.
 const third=buildHyperliquidSnapshot(raw2,{traders:1,vaults:0},now+7200000,second);
 assert.equal(third.coverage.newEvents,0);assert.equal(third.events.length,1);
});
