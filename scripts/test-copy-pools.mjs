import test from "node:test";
import assert from "node:assert/strict";
import {analyzeOrders,evaluateTrader,makeSnapshot,effectivePool,DAY,FRESH_MS,numeric} from "../lib/copy-trading/model.ts";
const now=Date.UTC(2026,8,17,12);
function order(side,time,qty=1,pnl=0,positionSide="LONG"){return {symbol:"BTCUSDT",quoteAsset:"USDT",side,positionSide,executedQty:qty,avgPrice:100,totalPnl:pnl,orderUpdateTime:time};}
function fixture(id="123"){
 const orders=[];for(let i=0;i<42;i++){const time=now-(60-i)*DAY;orders.push(order("BUY",time),order("SELL",time+3600000,1,i%3===0?-5:10));}
 const p={roi:15,pnl:1000,mdd:10,copierPnl:100,sharpRatio:1.5};
 return {id,observedAt:new Date(now).toISOString(),profile:{nickname:"测试员",positionShow:true,status:"ACTIVE",futuresType:"UM",startTime:now-200*DAY,marginBalance:5000},performance:{"30D":{...p},"90D":{...p}},history:{orders,total:orders.length,truncated:false,complete:true}};
}
test("null and malformed performance remain unknown",()=>{assert.equal(numeric(null),null);assert.equal(numeric(false),null);const r=fixture();r.performance["30D"].mdd=null;assert.equal(evaluateTrader(r,now).pool,"ordinary");});
test("eligible record gets automatic quality badge",()=>{const t=evaluateTrader(fixture(),now);assert.equal(t.pool,"quality");assert.equal(t.metrics.cycleCount,41);assert.equal(t.metrics.boundaryCycles,1);});
test("initial boundary is excluded; partial close is not a new cycle",()=>{
 const start=now-DAY;
 const a=analyzeOrders([order("BUY",start),order("SELL",start+1000),order("BUY",start+2000,2),order("SELL",start+3000,1,3),order("SELL",start+4000,1,4)],"x",now);
 assert.equal(a.cycleCount,1);assert.equal(a.cycles[0].pnl,7);assert.equal(a.cycles[0].holdSeconds,2);
});
test("short direction treats SELL as open and BUY as close",()=>{const a=analyzeOrders([order("SELL",1,1,0,"SHORT"),order("BUY",2,1,1,"SHORT"),order("SELL",3,1,0,"SHORT"),order("BUY",10003,1,2,"SHORT")],"x",now);assert.equal(a.cycleCount,1);assert.equal(a.cycles[0].side,"SHORT");});
test("BOTH direction cannot be inferred from zero PNL",()=>{const a=analyzeOrders([order("BUY",1,1,0,"BOTH")],"x",now);assert.equal(a.ambiguous,1);assert.equal(a.cycleCount,0);});
test("identical records are flagged rather than inventing an order ID",()=>{const r=fixture();r.history.orders.push({...r.history.orders[0]});const t=evaluateTrader(r,now);assert.equal(t.metrics.duplicates,1);assert.equal(t.pool,"ordinary");});
test("same-time same-side adds commute; opposite-side order is ambiguous",()=>{const a=analyzeOrders([order("BUY",1),order("BUY",1,2)],"x",now);assert.equal(a.sameTime,0);const b=analyzeOrders([order("BUY",1),order("SELL",1)],"x",now);assert.equal(b.sameTime,1);});
test("unmatched closes and unresolved opens are not realized profits",()=>{const a=analyzeOrders([order("SELL",1,2,1000),order("BUY",2)],"x",now);assert.equal(a.unmatched,1);assert.equal(a.unresolved.length,1);assert.equal(a.realizedPnl,null);});
test("zero losing cycles never creates infinite profit factor",()=>{const r=fixture();r.history.orders.forEach(o=>{if(o.side==="SELL")o.totalPnl=10;});const t=evaluateTrader(r,now);assert.equal(t.metrics.profitFactor,null);assert.equal(t.pool,"ordinary");});
test("history privacy and truncation prevent promotion",()=>{const r=fixture();r.history.truncated=true;assert.equal(evaluateTrader(r,now).pool,"ordinary");r.history.truncated=false;r.profile.positionShow=false;assert.equal(evaluateTrader(r,now).pool,"ordinary");});
test("missing history does not mean low anomaly risk",()=>{const r=fixture();r.history=null;const t=evaluateTrader(r,now);assert.equal(t.metrics.anomalyScore,null);assert.equal(t.pool,"ordinary");});
test("fast round trips trigger review, not a fraud verdict",()=>{const r=fixture();const first=now-DAY;r.history.orders.forEach((o,i)=>o.orderUpdateTime=first+i*1000);const t=evaluateTrader(r,now);assert.ok(t.metrics.anomalyScore>=25);assert.equal(t.pool,"ordinary");});
test("one-pool refresh retains other members and timestamp",()=>{const a=fixture("1"),b=fixture("2");b.profile.positionShow=false;const old=makeSnapshot([a,b],null,"all","test",2,now);a.performance["30D"].roi=-1;const next=makeSnapshot([a],old,"quality","test",2,now+1000);assert.equal(next.traders.length,2);assert.deepEqual(next.traders.find(t=>t.id==="2"),old.traders.find(t=>t.id==="2"));assert.equal(next.poolUpdatedAt.ordinary,old.poolUpdatedAt.ordinary);assert.equal(next.changes[0].from,"quality");assert.equal(next.changes[0].to,"ordinary");});
test("failed refresh preserves evidence but removes the quality badge",()=>{const r=fixture();r.error="fetch failed";const t=evaluateTrader(r,now);assert.equal(t.pool,"ordinary");assert.ok(t.metrics.cycleCount>0);assert.equal(t.updateError,"fetch failed");});
test("quality badges expire without network collection",()=>{const t=evaluateTrader(fixture(),now);assert.equal(effectivePool(t,now+FRESH_MS+1),"ordinary");});
test("retained history keeps its old evidence time and cannot be promoted after refresh failure",()=>{const r=fixture();r.history.observedAt=new Date(now-DAY).toISOString();r.history.error="temporary busy";const t=evaluateTrader(r,now);assert.equal(t.historyAt,r.history.observedAt);assert.equal(t.pool,"ordinary");assert.equal(t.checks.find(c=>c.key==="fresh").pass,false);});
test("unsupported quote units and future orders block quality",()=>{const r=fixture();r.history.orders[0].quoteAsset="BTC";assert.equal(evaluateTrader(r,now).pool,"ordinary");r.history.orders[0].quoteAsset="USDT";r.history.orders[0].orderUpdateTime=now+1;assert.equal(evaluateTrader(r,now).metrics.invalid,1);});
