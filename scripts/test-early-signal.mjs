import test from "node:test";
import assert from "node:assert/strict";
import {computeEarlySignal,computeNetRatioStreak,computeOiAccel,computeObvDivergence,computeTopShortDivergence,percentileRank} from "../lib/indicators/earlySignal.ts";
const H=3600000;
const inputs=(o={})=>({atrPctSeries:[],avgTradeSizeSeries:[],oiQtyHourly:[],netRatioHourly:[],topRatioSeries:[],globalRatioSeries:[],closeSeries:[],quoteVolumeSeries:[],fundingDaily:null,...o});
const ctx={oi4:null,p4:null,netRatio4h:null};
test("missing inputs stay missing, never zero",()=>{
 const e=computeEarlySignal(inputs(),ctx);
 assert.equal(e.netRatioStreak,null);assert.equal(e.volSqueezePct,null);assert.equal(e.earlyScore,null);assert.equal(e.earlyScoreCoverage,0);assert.equal(e.earlyCandidate,false);
 assert.equal(computeNetRatioStreak([5,null]),null);
 assert.equal(percentileRank([1,2,3],2),null);
 assert.equal(computeOiAccel([100,null,100,100,100,100]),null);
 assert.equal(computeObvDivergence(Array(25).fill(1),[...Array(24).fill(1),NaN]),null);
});
test("streak counts same-sign hours from latest and truncates on gaps",()=>{
 assert.equal(computeNetRatioStreak([-3,null,2,4,6]),3);
 assert.equal(computeNetRatioStreak([2,-1,-2]),-2);
 assert.equal(computeNetRatioStreak([2,0]),0);
});
test("oi acceleration and top-account divergence",()=>{
 assert.equal(computeOiAccel([100,101,102,103,104,110]),Number((((110/104-1)*100)-((104/103-1)+(103/102-1)+(102/101-1)+(101/100-1))*25).toFixed(3)));
 const pts=v=>v.map((value,i)=>({time:i*H,value}));
 assert.equal(computeTopShortDivergence(pts([1,1.06]),pts([1,1])),0.06);
 assert.equal(computeTopShortDivergence(pts([1]),pts([1,1])),null);
});
test("early score follows doc formula, needs 2/4 coverage, funding only discounts",()=>{
 const atr=[...Array(20).fill(2),0.5];// latest is tightest → percentile 0
 const trade=[...Array(20).fill(100),200];// latest above all history → percentile 100
 const one=computeEarlySignal(inputs({atrPctSeries:atr}),ctx);
 assert.equal(one.earlyScore,null);assert.equal(one.earlyScoreCoverage,1);
 const two=computeEarlySignal(inputs({atrPctSeries:atr,avgTradeSizeSeries:trade}),ctx);
 assert.equal(two.volSqueezePct,0);assert.equal(two.avgTradeSizePct,100);assert.equal(two.earlyScore,45);
 const streak=computeEarlySignal(inputs({atrPctSeries:atr,avgTradeSizeSeries:trade,netRatioHourly:[1,2,3]}),ctx);
 assert.equal(streak.earlyScore,Number((45+Math.min(25,3/12*100)).toFixed(1)));
 const funded=computeEarlySignal(inputs({atrPctSeries:atr,avgTradeSizeSeries:trade,fundingDaily:-0.1}),ctx);
 assert.equal(funded.fundingLag,0.1);assert.equal(funded.earlyScore,38.3);
});
test("early candidate requires consolidation build-up, looser inflow and squeeze",()=>{
 const atr=[...Array(20).fill(2),0.5];
 const ok={oi4:3,p4:0.5,netRatio4h:5};
 assert.equal(computeEarlySignal(inputs({atrPctSeries:atr}),ok).earlyCandidate,true);
 assert.equal(computeEarlySignal(inputs({atrPctSeries:atr}),{...ok,p4:1}).earlyCandidate,false);
 assert.equal(computeEarlySignal(inputs({atrPctSeries:atr}),{...ok,netRatio4h:4.9}).earlyCandidate,false);
 assert.equal(computeEarlySignal(inputs({atrPctSeries:[...Array(20).fill(1),5]}),ok).earlyCandidate,false);
 assert.equal(computeEarlySignal(inputs(),ok).earlyCandidate,false);
});
