import test from "node:test";
import assert from "node:assert/strict";
import { tripleBarrier,roundTripCost,labelDistribution,kDiagnosis,residualTripleBarrier,classIndex,DIRECTION_CLASSES,LABEL_K_BASE,LABEL_K_CALIBRATED,labelK,SLIPPAGE_ROUND_TRIP_ASSUMED,SLIPPAGE_SENSITIVITY_ROUND_TRIP,LABEL_HORIZONS_BARS } from "../lib/indicators/labels.ts";
import { FEATURE_IDS } from "../lib/indicators/features/registry.ts";
import { walkForwardFolds,foldViolations,uniquenessWeights,effectiveN,MIN_TEST_START_MS,embargoBars } from "../lib/calibration/splits.ts";
import { brier,bss,ece,baseRates,classCounts,quantile,validForecasts } from "../lib/calibration/metrics.ts";
import { fitSoftmax,predictProba } from "../lib/calibration/softmax.ts";
import { mulberry32,shuffled,randomFeatureBaseline,leakCheck } from "../lib/calibration/controls.ts";
import { regimeTerciles,regimeCoverage,FROZEN_REGIME_CUTPOINTS,REGIME_PROVENANCE,regimeNotes } from "../lib/calibration/regime.ts";
import { evaluateGate,CALIBRATION_GATE,deriveMinEffectiveN,freeParameters,MIN_EFFECTIVE_TEST_N,ECE_MIN_BIN_SAMPLES,ECE_MIN_BINS } from "../lib/calibration/gate.ts";

const H=3600000;
const bar=(i,o={})=>{const c=o.c??100;return {t:i*H,ct:i*H+H-1,o:c,h:o.h??c+.1,l:o.l??c-.1,c,v:1,qvUsd:1,takerBuyUsd:.5,trades:1,flow:null};};
// 1% ATR on a price of 100, so k=1 with zero cost puts the barriers at 101 / 99.
const flatBars=(n)=>Array.from({length:n},(_,i)=>bar(i));
const ATR=(n)=>Array.from({length:n},()=>1);
const opts=(o={})=>({horizonBars:4,k:1,cost:0,...o});
const withBar=(bars,i,o)=>bars.map((b,j)=>j===i?bar(i,o):b);

test("missing inputs stay missing, never a default class",()=>{
 const b=flatBars(20),a=ATR(20);
 assert.equal(tripleBarrier(b,0,a,opts({cost:null})).label,null,"no cost ⇒ no label");
 assert.equal(roundTripCost({spreadBps:null,slippagePct:.0002}),null,"a missing spread is not a zero spread");
 assert.equal(roundTripCost({spreadBps:5,slippagePct:null}),null,"a missing slippage estimate is not zero either");
 assert.equal(tripleBarrier(b,0,ATR(20).map(()=>null),opts()).label,null);
 assert.equal(tripleBarrier(b,17,a,opts()).label,null,"forward window incomplete");
 assert.match(tripleBarrier(b,17,a,opts()).reason,/incomplete/);
 const gap=b.filter((_,i)=>i!==3);
 assert.equal(tripleBarrier(gap,0,ATR(19),opts()).label,null,"a gap in the forward window");
 assert.equal(tripleBarrier(withBar(b,2,{h:NaN}),0,a,opts()).label,null);
 assert.equal(tripleBarrier(b,-1,a,opts()).label,null);
});

test("cost is 2 × taker + spread + slippage",()=>{
 assert.ok(Math.abs(roundTripCost({spreadBps:5,slippagePct:.0002})-(0.001+0.0005+0.0002))<1e-15);
 assert.equal(roundTripCost({spreadBps:-1,slippagePct:0}),null);
});

test("triple barrier: first touch decides, no touch is flat, and the label window ends at t + horizon",()=>{
 const b=flatBars(20),a=ATR(20);
 const up=tripleBarrier(withBar(b,2,{c:100.5,h:101.2,l:100}),0,a,opts());
 assert.deepEqual([up.label,up.touchIndex,up.endIndex,up.ambiguous],["up",2,4,false]);
 assert.equal(tripleBarrier(withBar(b,3,{c:99.5,h:100,l:98.8}),0,a,opts()).label,"down");
 const flat=tripleBarrier(b,0,a,opts());assert.deepEqual([flat.label,flat.touchIndex,flat.endIndex],["flat",null,4]);
 const first=withBar(withBar(b,1,{h:101.5}),3,{l:98});
 assert.equal(tripleBarrier(first,0,a,opts()).label,"up","the earlier touch wins even if the other barrier is hit later");
 assert.equal(tripleBarrier(withBar(b,5,{h:110}),0,a,opts()).label,"flat","a touch after the horizon does not count");
});

test("both barriers inside one bar: the unfavourable outcome by default, or refuse to guess",()=>{
 const b=withBar(flatBars(20),2,{h:101.5,l:98.5}),a=ATR(20);
 const d=tripleBarrier(b,0,a,opts());assert.deepEqual([d.label,d.ambiguous],["down",true]);
 const f=tripleBarrier(b,0,a,opts({sameBar:"flat"}));assert.deepEqual([f.label,f.ambiguous],["flat",true]);
});

test("cost widens the barriers: a gross move that does not clear the cost is not a win",()=>{
 const b=withBar(flatBars(20),2,{c:101,h:101.05,l:100.9}),a=ATR(20);
 assert.equal(tripleBarrier(b,0,a,opts({cost:0})).label,"up","gross: 101.05 reaches the 101 barrier");
 assert.equal(tripleBarrier(b,0,a,opts({cost:roundTripCost({spreadBps:5,slippagePct:.0002})})).label,"flat","net of a 0.17% cost the barrier is 101.17");
});

test("a label uses only bars up to t + horizon and the ATR known at t",()=>{
 const b=withBar(flatBars(40),2,{h:101.4}),a=ATR(40);
 const before=tripleBarrier(b,0,a,opts());
 const scrambled=b.map((x,i)=>i>4?bar(i,{c:1,h:1e9,l:1e-9}):x);
 assert.deepEqual(tripleBarrier(scrambled,0,a,opts()),before,"bars after the horizon are irrelevant");
 const a2=a.map((v,i)=>i===0?v:999);
 assert.deepEqual(tripleBarrier(b,0,a2,opts()),before,"only atr[t] is read");
});

test("label distribution and the rule for k (no class under 15% or over 60%)",()=>{
 const mk=(d,f,u)=>[...Array(d).fill("down"),...Array(f).fill("flat"),...Array(u).fill("up")];
 assert.equal(kDiagnosis(labelDistribution(mk(30,40,30))).ok,true);
 const skew=kDiagnosis(labelDistribution(mk(10,80,10)));
 assert.equal(skew.ok,false);assert.deepEqual(skew.offenders.map(o=>o.problem).sort(),["over 60%","under 15%","under 15%"]);
 assert.equal(kDiagnosis(labelDistribution(mk(15,25,60))).ok,true,"exactly 15% and exactly 60% are inside the band");
 assert.equal(kDiagnosis(labelDistribution(mk(14,26,60))).ok,false);
 assert.equal(kDiagnosis(labelDistribution([])).ok,false,"nothing to judge is not ok");
 const d=labelDistribution(["up",null,"flat",null]);assert.deepEqual([d.n,d.nNull],[2,2]);
 assert.deepEqual(DIRECTION_CLASSES.map(classIndex),[0,1,2]);
});

test("k scales with the square root of the horizon, from one base value",()=>{
 assert.equal(LABEL_K_BASE,1);assert.equal(LABEL_K_CALIBRATED,true);
 assert.equal(labelK(4),1);assert.ok(Math.abs(labelK(24)-Math.sqrt(6))<1e-12);assert.ok(Math.abs(labelK(24)-2.449489743)<1e-8);
 assert.ok(Math.abs(labelK(24)/labelK(4)-Math.sqrt(6))<1e-12,"one parameter and a rule, not two free ks");
 assert.deepEqual([...LABEL_HORIZONS_BARS],[4,24]);
 assert.equal(SLIPPAGE_ROUND_TRIP_ASSUMED,.001,"0.05% per side, a deliberately conservative assumption");
 assert.deepEqual([...SLIPPAGE_SENSITIVITY_ROUND_TRIP],[.0004,.001,.002],"0.02% / 0.05% / 0.10% per side");
 assert.ok(Math.abs(roundTripCost({spreadBps:0,slippagePct:SLIPPAGE_ROUND_TRIP_ASSUMED})-.002)<1e-15,"total round trip cost is 0.20% plus the spread");
});

test("residual barrier: a coin that just follows BTC has no residual move",()=>{
 const btc=Array.from({length:30},(_,i)=>100*(1+.02*i)),coin=btc.map((v)=>100*(1+2*(v/100-1)));
 const base={btcCloses:btc,t:0,horizonBars:10,k:1,atrPct:.01,cost:0,beta:2};
 assert.equal(residualTripleBarrier({...base,coinCloses:coin}),"flat");
 assert.equal(residualTripleBarrier({...base,coinCloses:coin,beta:0}),"up","the raw coin move is large");
 assert.equal(residualTripleBarrier({...base,coinCloses:coin,cost:null}),null);
 assert.equal(residualTripleBarrier({...base,coinCloses:coin.slice(0,5),btcCloses:btc.slice(0,5)}),null,"window incomplete");
});

const span=(group,t,h=4)=>({group,time:t*H,endTime:(t+h)*H});

test("walk-forward folds: by time, purged and embargoed, and never before the consumed window",()=>{
 const start=MIN_TEST_START_MS/H,end=start+30*24,horizon=4;
 const samples=[];for(const g of ["A","B","C"])for(let t=start-24*60;t<end;t+=2)samples.push(span(g,t,horizon));
 const o={nFolds:3,horizonBars:horizon,barMs:H,testStart:start*H,testEnd:end*H};
 const folds=walkForwardFolds(samples,o);
 assert.equal(folds.length,3);
 for(const f of folds){assert.deepEqual(foldViolations(samples,f,o),[]);assert.ok(f.trainIdx.length>0&&f.testIdx.length>0);assert.ok(f.purged>0,"labels reaching into the gap are removed");}
 assert.equal(embargoBars(4),28);assert.equal(embargoBars(24),48);
 const groupsInFold=new Set(folds[0].testIdx.map(i=>samples[i].group));assert.equal(groupsInFold.size,3,"every coin is tested in the same time block");
 assert.ok(folds[1].trainIdx.length>folds[0].trainIdx.length,"training is expanding");
 const cover=folds.flatMap(f=>f.testIdx);assert.equal(new Set(cover).size,cover.length,"test blocks do not overlap");
 assert.throws(()=>walkForwardFolds(samples,{...o,testStart:MIN_TEST_START_MS-H}),/consumed window/);
 assert.throws(()=>walkForwardFolds(samples,{...o,nFolds:0}));assert.throws(()=>walkForwardFolds(samples,{...o,testEnd:o.testStart}));
});

test("foldViolations catches a leaky fold",()=>{
 const start=MIN_TEST_START_MS/H,samples=[span("A",start-3),span("A",start+1),span("A",start-200)];
 const o={horizonBars:4,barMs:H};
 const leaky={index:0,testStart:start*H,testEnd:(start+10)*H,trainIdx:[0,2],testIdx:[1],purged:0};
 const bad=foldViolations(samples,leaky,o);
 assert.equal(bad.length,1);assert.match(bad[0],/train sample 0/,"a label ending 1 bar before the test start violates the 28-bar embargo");
});

test("uniqueness weights: overlapping labels share credit, groups are independent",()=>{
 const w=uniquenessWeights([span("A",0,3),span("A",2,3)],H);
 assert.ok(Math.abs(w[0]-0.75)<1e-12&&Math.abs(w[1]-0.75)<1e-12);
 assert.deepEqual(Array.from(uniquenessWeights([span("A",0,3),span("A",10,3)],H)),[1,1]);
 assert.deepEqual(Array.from(uniquenessWeights([span("A",0,3),span("B",0,3)],H)),[1,1],"different coins do not dilute each other");
 const dense=uniquenessWeights(Array.from({length:200},(_,t)=>span("A",t,23)),H);
 assert.ok(dense[100]<0.06&&dense[100]>0.03,"a 24-bar label with 23 neighbours carries about 1/24 of an observation: "+dense[100]);
 assert.ok(effectiveN(dense)<20*24,"200 samples are worth roughly 200/24 independent ones ");
 assert.equal(effectiveN([]),0);
});

test("brier and BSS against the training base rates",()=>{
 const y=[0,1,2,1],perfect=y.map(c=>[0,1,2].map(k=>k===c?1:0));
 assert.equal(brier(perfect,y),0);
 const rates=baseRates(y,3);assert.deepEqual(rates,[.25,.5,.25]);
 assert.equal(bss(perfect,y,rates),1);
 assert.ok(Math.abs(bss(y.map(()=>rates),y,rates))<1e-12,"forecasting the base rates has skill 0");
 assert.ok(bss(y.map(()=>[.9,.05,.05]),y,rates)<0,"a confident wrong forecast is worse than the base rates");
 assert.ok(Math.abs(brier([[.5,.25,.25]],[0])-(.25+.0625+.0625))<1e-12);
 assert.equal(brier(perfect,y,[1,1,1,0])!==null,true);
 assert.deepEqual(classCounts([0,0,2,1,2,2],3),[2,1,3]);
 assert.equal(quantile([1,2,3,4,5],.5),3);assert.equal(quantile([],.5),null);
});

test("metrics return null on invalid input instead of a plausible number",()=>{
 assert.equal(brier([[.5,.4]],[0]),null,"probabilities must sum to 1");
 assert.equal(brier([[NaN,1]],[0]),null);assert.equal(brier([[.5,.5]],[2]),null,"label out of range");
 assert.equal(brier([],[]),null);assert.equal(brier([[1,0]],[0,1]),null);
 assert.equal(bss([[.5,.5]],[0],[.7,.2]),null,"base rates must sum to 1");
 assert.equal(baseRates([],3),null);assert.equal(baseRates([0,3],3),null);
 assert.equal(validForecasts([[1]],[0]),false,"a single class is not a classification");
 assert.equal(ece([[.5,.5]],[0]),null,"too few samples for any calibration bin");
});

test("ECE: a calibrated forecaster scores low, an overconfident one high, and thin bins are refused",()=>{
 const rand=mulberry32(5),N=4000,probs=[],y=[];
 for(let i=0;i<N;i++){const a=.3+.6*rand(),b=(1-a)*.6,p=[a,b,1-a-b];probs.push(p);const r=rand();y.push(r<p[0]?0:r<p[0]+p[1]?1:2);}
 const good=ece(probs,y);assert.ok(good.ece<.05,"calibrated: "+good.ece);
 assert.equal(good.bins.length,10);assert.ok(good.bins.every(b=>b.n>=50));
 const over=probs.map(p=>{const k=p.indexOf(Math.max(...p));return p.map((_,c)=>c===k?.98:.01);});
 assert.ok(ece(over,y).ece>.2,"overconfident forecasts are caught");
 assert.equal(ece(probs.slice(0,120),y.slice(0,120)).bins.length,2,"120 samples allow only 2 bins of >= 50");
 assert.equal(ece(probs.slice(0,99),y.slice(0,99)),null);
});

// Three classes with means separated along feature 0.
const blobs=(n,seed,sep=2)=>{const r=mulberry32(seed),g=()=>{const u=Math.max(r(),1e-12);return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*r());};
 const X=[],y=[];for(let i=0;i<n;i++){const c=i%3;X.push([ (c-1)*sep+g(),g(),g() ]);y.push(c);}return {X,y};};

test("softmax learns a separable problem, rows sum to 1, and it refuses incomplete rows",()=>{
 const tr=blobs(600,1),te=blobs(300,2),m=fitSoftmax(tr.X,tr.y,3,{l2:.01});
 const p=predictProba(m,te.X);
 assert.ok(p.every(r=>Math.abs(r.reduce((a,b)=>a+b,0)-1)<1e-9));
 const acc=p.filter((r,i)=>r.indexOf(Math.max(...r))===te.y[i]).length/p.length;assert.ok(acc>.75,"accuracy "+acc);
 assert.ok(bss(p,te.y,baseRates(tr.y,3))>.2);
 assert.throws(()=>fitSoftmax([[1,NaN]],[0],2,{l2:0}),/missing value/);
 assert.throws(()=>predictProba(m,[[1,2,NaN]]),/missing value/);
 assert.throws(()=>fitSoftmax(tr.X,tr.y.map(()=>5),3,{l2:0}),/label out of range/);
 assert.throws(()=>fitSoftmax(tr.X,tr.y,3,{l2:0,sampleWeights:tr.y.map(()=>0)}),/sum to zero/);
 assert.deepEqual(fitSoftmax(tr.X,tr.y,3,{l2:.01}).weights,m.weights,"deterministic");
 const strong=fitSoftmax(tr.X,tr.y,3,{l2:100}),norm=(mm)=>mm.weights.slice(0,-1).flat().reduce((a,v)=>a+v*v,0);
 assert.ok(norm(strong)<norm(m),"a heavier L2 penalty shrinks the weights");
});

test("random-feature baseline: noise earns about nothing, a real signal clears its 95th percentile, and it reproduces",()=>{
 const tr=blobs(400,3),te=blobs(300,4);
 const base=randomFeatureBaseline({trainY:tr.y,testY:te.y,k:3,nFeatures:3,l2:.05,draws:30,seed:11,maxIter:60});
 assert.equal(base.n,30);assert.ok(base.p95<.06,"pure-noise features: p95 "+base.p95);assert.ok(base.mean<.02);
 const m=fitSoftmax(tr.X,tr.y,3,{l2:.05,maxIter:60}),real=bss(predictProba(m,te.X),te.y,baseRates(tr.y,3));
 assert.ok(real>base.p95,"a real signal beats the luck bar: "+real+" vs "+base.p95);
 const again=randomFeatureBaseline({trainY:tr.y,testY:te.y,k:3,nFeatures:3,l2:.05,draws:30,seed:11,maxIter:60});
 assert.equal(again.p95,base.p95);
 assert.equal(randomFeatureBaseline({trainY:[],testY:te.y,k:3,nFeatures:3,l2:.05}),null);
 assert.equal(randomFeatureBaseline({trainY:tr.y,testY:te.y,k:3,nFeatures:0,l2:.05}),null);
});

test("shuffled labels destroy the score, and a leaking pipeline would not be destroyed",()=>{
 const tr=blobs(400,3),te=blobs(300,4),rates=baseRates(tr.y,3);
 const fitScore=(ytr,yte)=>{const m=fitSoftmax(tr.X,ytr,3,{l2:.05,maxIter:60});return bss(predictProba(m,te.X),yte,baseRates(ytr,3));};
 const real=fitScore(tr.y,te.y),shuf=fitScore(shuffled(tr.y,7),shuffled(te.y,8));
 assert.ok(real>.2&&shuf<.05,"real "+real+", shuffled "+shuf);
 const p=shuffled([1,2,3,4,5,6],3);assert.deepEqual([...p].sort(),[1,2,3,4,5,6]);assert.deepEqual(p,shuffled([1,2,3,4,5,6],3));
 assert.equal(rates.length,3);
 assert.equal(leakCheck({realBss:.3,shuffledBss:.01,randomP95:.03}).status,"clean");
 assert.equal(leakCheck({realBss:.3,shuffledBss:.2,randomP95:.03}).status,"leak_suspected","no collapse ⇒ leak");
 assert.equal(leakCheck({realBss:.02,shuffledBss:.0,randomP95:.03}).status,"inconclusive","no signal to destroy");
 assert.equal(leakCheck({realBss:.3,shuffledBss:.03,randomP95:.03}).status,"clean","exactly at the bar is not above it");
 for(const bad of [{realBss:null},{shuffledBss:NaN},{randomP95:undefined}])assert.equal(leakCheck({realBss:.3,shuffledBss:.0,randomP95:.03,...bad}).status,"inconclusive");
});

// ---- the gate ----
const CUTS={trend:{lower:.3,upper:.7},vol:{lower:20,upper:80}};
const COV=(o={})=>({cutpoints:CUTS,trend:{low:60,high:60},vol:{low:60,high:60},...o});
const T={eceMax:.05,minClassSamples:50,regimeCutpoints:CUTS,minRegimeBinDays:30,minDelistedCoverage:.9,minFolds:3,minEffectiveN:2000,minEffectiveTestN:250,minTestSpanDays:60};
const good=(o={})=>({folds:[{bss:.05,n:900},{bss:.04,n:900},{bss:.06,n:900}],pooled:{bss:.05,residualBss:.02,ece:.03,classCounts:[300,400,300],effectiveN:2500,effectiveTestN:400,regimeCoverage:COV(),testSpanDays:75,...(o.pooled||{})},randomBaselineP95:.02,leakStatus:"clean",universe:{identifiedDelisted:121,obtainedDelisted:121,unobtained:[]},...o,...(o.pooled?{pooled:{bss:.05,residualBss:.02,ece:.03,classCounts:[300,400,300],effectiveN:2500,effectiveTestN:400,regimeCoverage:COV(),testSpanDays:75,...o.pooled}}:{})});
const fails=(r,t=T)=>evaluateGate(r,t);

test("gate: a complete, configured, passing report passes",()=>{
 const r=evaluateGate(good(),T);assert.equal(r.pass,true,r.reasons.join("; "));assert.deepEqual(r.reasons,[]);
});

test("gate is fail-closed: unset thresholds, no report, and the default config never pass",()=>{
 assert.equal(evaluateGate(good()).pass,false,"the shipped default has no ECE or class-floor threshold, so it cannot pass");
 assert.match(evaluateGate(good()).reasons.join(";"),/ECE threshold not configured/);
 assert.match(evaluateGate(good()).reasons.join(";"),/per-class sample floor not configured/);
 assert.equal(CALIBRATION_GATE.eceMax,null);assert.equal(CALIBRATION_GATE.minClassSamples,null);
 for(const empty of [null,undefined,{},{folds:[]},{pooled:{}},"x",42])assert.equal(evaluateGate(empty,T).pass,false);
 assert.equal(evaluateGate({folds:[],pooled:{classCounts:[],bss:null,residualBss:null,ece:null,effectiveN:null,testSpanDays:null},randomBaselineP95:null,leakStatus:null},T).pass,false);
 assert.equal(fails(good(),{...T,eceMax:null}).pass,false);assert.equal(fails(good(),{...T,minClassSamples:null}).pass,false);
 assert.equal(fails(good(),{...T,eceMax:NaN}).pass,false);assert.equal(fails(good(),{...T,minClassSamples:0}).pass,false,"a floor of 0 is not a floor");
 const throwing={get pooled(){throw new Error("boom");}};assert.equal(evaluateGate(throwing,T).pass,false);assert.match(evaluateGate(throwing,T).reasons[0],/evaluation error/);
});

test("gate boundaries: exactly on a threshold, NaN, a zero class, and a random baseline above the model",()=>{
 assert.equal(fails(good({pooled:{ece:.05}})).pass,false,"ECE exactly at the threshold fails (must be strictly below)");
 assert.equal(fails(good({pooled:{ece:.0499999}})).pass,true);
 assert.equal(fails(good({pooled:{bss:.02},randomBaselineP95:.02})).pass,false,"BSS exactly at the random p95 fails");
 assert.equal(fails(good({pooled:{bss:.0201},randomBaselineP95:.02})).pass,true);
 assert.equal(fails(good({pooled:{bss:.05},randomBaselineP95:.08})).pass,false,"the random baseline beats the real model");
 assert.equal(fails(good({pooled:{bss:0},randomBaselineP95:-.03})).pass,false,"with a negative random p95 the bar is still 0, and 0 is not above 0");
 assert.equal(fails(good({pooled:{bss:.001},randomBaselineP95:-.03})).pass,true);
 assert.equal(fails(good({pooled:{residualBss:0}})).pass,false,"residual BSS must be above 0");
 assert.equal(fails(good({pooled:{residualBss:-.01}})).pass,false);
 for(const k of ["bss","residualBss","ece","effectiveN","effectiveTestN","testSpanDays"])assert.equal(fails(good({pooled:{[k]:NaN}})).pass,false,k+" NaN");
 for(const k of ["bss","residualBss","ece","effectiveN","effectiveTestN","testSpanDays"])assert.equal(fails(good({pooled:{[k]:null}})).pass,false,k+" null");
 assert.equal(fails(good({randomBaselineP95:NaN})).pass,false);assert.equal(fails(good({randomBaselineP95:null})).pass,false);
 assert.equal(fails(good({pooled:{classCounts:[300,0,300]}})).pass,false,"a class with zero samples");
 assert.match(fails(good({pooled:{classCounts:[300,0,300]}})).reasons.join(";"),/no test samples/);
 assert.equal(fails(good({pooled:{classCounts:[300,49,300]}})).pass,false);assert.equal(fails(good({pooled:{classCounts:[300,50,300]}})).pass,true,"exactly the floor passes");
 assert.equal(fails(good({pooled:{classCounts:[300,NaN,300]}})).pass,false);assert.equal(fails(good({pooled:{classCounts:[]}})).pass,false);
});

test("gate: folds, effective sample size, test span and the shuffled-label control",()=>{
 assert.equal(fails(good({folds:[{bss:.05,n:1},{bss:.05,n:1}]})).pass,false,"two folds is not enough");
 assert.equal(fails(good({folds:[{bss:.05,n:1},{bss:.05,n:1},{bss:0,n:1}]})).pass,false,"a fold that does not beat the base rates fails the whole head");
 assert.equal(fails(good({folds:[{bss:.05,n:1},{bss:.05,n:1},{bss:null,n:1}]})).pass,false);
 assert.equal(fails(good({pooled:{effectiveN:1999.9}})).pass,false);assert.equal(fails(good({pooled:{effectiveN:2000}})).pass,true);
 assert.equal(fails(good({pooled:{testSpanDays:59}})).pass,false);assert.equal(fails(good({pooled:{testSpanDays:60}})).pass,true);
 for(const s of ["leak_suspected","inconclusive",null,undefined,"CLEAN"])assert.equal(fails(good({leakStatus:s})).pass,false,String(s));
 const all=evaluateGate(good({pooled:{ece:.9,bss:-1,residualBss:-1,classCounts:[0,0,0]},leakStatus:"leak_suspected",folds:[]}),T);
 assert.equal(all.pass,false);assert.ok(all.reasons.length>=6,"every failure is listed, not just the first: "+all.reasons.length);
});

test("sufficiency thresholds: minEffectiveN is derived from the feature set, and the test side is counted separately",()=>{
 assert.equal(freeParameters(21),44,"(3 classes - 1) x (21 features + 1)");
 assert.equal(deriveMinEffectiveN(21),880,"20 effective samples per free parameter");
 assert.equal(CALIBRATION_GATE.minEffectiveN,deriveMinEffectiveN(FEATURE_IDS.length),"follows the registry, so adding a feature raises the bar by itself");
 assert.equal(FEATURE_IDS.length,21);assert.equal(CALIBRATION_GATE.minEffectiveN,880);
 assert.equal(deriveMinEffectiveN(30),1240,"a 30-feature model would need more evidence");
 assert.equal(MIN_EFFECTIVE_TEST_N,ECE_MIN_BIN_SAMPLES*ECE_MIN_BINS);assert.equal(CALIBRATION_GATE.minEffectiveTestN,250);
 assert.equal(fails(good({pooled:{effectiveTestN:249.9}})).pass,false,"just under 250");assert.equal(fails(good({pooled:{effectiveTestN:250}})).pass,true,"exactly 250 passes");
 assert.match(fails(good({pooled:{effectiveTestN:100}})).reasons.join(";"),/effective test sample size/);
 assert.equal(fails(good({pooled:{effectiveN:879}}),{...T,minEffectiveN:880}).pass,false);assert.equal(fails(good({pooled:{effectiveN:880}}),{...T,minEffectiveN:880}).pass,true);
 assert.equal(fails(good({pooled:{effectiveN:1e6,effectiveTestN:10}})).pass,false,"plenty of training data cannot make up for a thin test set");
});

test("gate: a threshold object with a missing or non-finite field fails instead of silently skipping that check",()=>{
 for(const key of ["minFolds","minEffectiveN","minEffectiveTestN","minTestSpanDays","eceMax","minClassSamples","minRegimeBinDays","minDelistedCoverage","regimeCutpoints"]){
  const missing={...T};delete missing[key];
  assert.equal(fails(good(),missing).pass,false,key+" absent");
  assert.equal(fails(good(),{...T,[key]:NaN}).pass,false,key+" NaN");
  assert.equal(fails(good(),{...T,[key]:null}).pass,false,key+" null");
  assert.equal(fails(good(),{...T,[key]:"50"}).pass,false,key+" a string");
 }
 assert.equal(fails(good(),T).pass,true,"the same report passes once every threshold is a real number");
 assert.match(fails(good(),{...T,minEffectiveTestN:undefined}).reasons.join(";"),/minEffectiveTestN not configured/);
});

test("regime terciles are computed once from history, and coverage counts distinct DAYS per bin with inclusive edges",()=>{
 const hist=Array.from({length:300},(_,i)=>i/299);
 const t=regimeTerciles(hist);assert.ok(Math.abs(t.lower-1/3)<1e-9&&Math.abs(t.upper-2/3)<1e-9);
 assert.equal(regimeTerciles(hist.slice(0,10)),null,"too little history to define terciles");
 assert.equal(regimeTerciles(Array(100).fill(.5)),null,"a constant series has no distinct terciles");
 assert.ok(regimeTerciles([...hist,NaN,Infinity]),"non-finite values are ignored");
 const trend=[.1,.3,.5,.7,.9,NaN,.3],vol=[10,20,50,80,90,50,NaN],days=[1,2,3,4,5,6,7];
 const c=regimeCoverage({trend,vol,days,cutpoints:CUTS});
 assert.deepEqual([c.trend.low,c.trend.high,c.vol.low,c.vol.high],[3,2,2,2],"<= lower and >= upper are inclusive; NaN is in no bin");
 assert.deepEqual(c.cutpoints,CUTS,"the coverage carries the cutpoints it was computed with");
 // 500 coins on the same day are ONE observation of that day's regime, not 500
 const many=(x,y,d,n)=>({trend:Array(n).fill(x),vol:Array(n).fill(y),days:Array(n).fill(d)});
 const a=many(.1,10,1,500),b=many(.9,90,2,500);
 const two=regimeCoverage({trend:[...a.trend,...b.trend],vol:[...a.vol,...b.vol],days:[...a.days,...b.days],cutpoints:CUTS});
 assert.deepEqual([two.trend.low,two.trend.high,two.vol.low,two.vol.high],[1,1,1,1],"1000 samples on 2 days are 2 days");
 assert.equal(regimeCoverage({trend:[.1,.2],vol:[10,10],days:[1,1],cutpoints:CUTS}),null,"the same day with two different trend values: the inputs are not what they claim");
 assert.equal(regimeCoverage({trend:[.1,.1],vol:[10,10],days:[1,1.5],cutpoints:CUTS}),null,"a day must be an integer");
 assert.equal(regimeCoverage({trend:[1],vol:[1,2],days:[1],cutpoints:CUTS}),null,"mismatched lengths");
 assert.equal(regimeCoverage({trend:[1],vol:[1],days:[1,2],cutpoints:CUTS}),null);
});

test("gate: regime coverage is fail-closed (unset cutpoints, no coverage, one thin bin, one axis only, different cutpoints)",()=>{
 assert.deepEqual(CALIBRATION_GATE.regimeCutpoints,FROZEN_REGIME_CUTPOINTS,"the shipped gate carries the frozen cutpoints");
 assert.equal(CALIBRATION_GATE.minRegimeBinDays,30,"a judgement value, counted in days");
 assert.equal(CALIBRATION_GATE.minDelistedCoverage,0.9,"a judgement value: 90% of the identified delisted contracts");
 const d=evaluateGate(good());assert.equal(d.pass,false);assert.match(d.reasons.join(";"),/regime coverage unverified: it was computed with different cutpoints than the gate's/,"the shipped default judges coverage with the FROZEN cutpoints, so a coverage computed with any others is refused");
 assert.equal(fails(good()).pass,true,"the same report passes once cutpoints are configured and every bin is covered");
 assert.equal(fails(good(),{...T,regimeCutpoints:null}).pass,false);
 assert.equal(fails(good({pooled:{regimeCoverage:null}})).pass,false);assert.match(fails(good({pooled:{regimeCoverage:null}})).reasons.join(";"),/report has no regime coverage/);
 assert.equal(fails(good({pooled:{regimeCoverage:undefined}})).pass,false);
 for(const axis of ["trend","vol"])for(const bin of ["low","high"]){
  const cov=COV({[axis]:{...COV()[axis],[bin]:0}});
  const r=fails(good({pooled:{regimeCoverage:cov}}));assert.equal(r.pass,false,axis+" "+bin+" empty");assert.match(r.reasons.join(";"),new RegExp(axis+" "+bin+" tercile has 0"));
  assert.equal(fails(good({pooled:{regimeCoverage:COV({[axis]:{...COV()[axis],[bin]:29}})}})).pass,false,axis+" "+bin+" 29 days, one under 30");
  assert.equal(fails(good({pooled:{regimeCoverage:COV({[axis]:{...COV()[axis],[bin]:30}})}})).pass,true,axis+" "+bin+" exactly 30 days passes");
  assert.equal(fails(good({pooled:{regimeCoverage:COV({[axis]:{...COV()[axis],[bin]:NaN}})}})).pass,false,axis+" "+bin+" NaN");
  assert.equal(fails(good({pooled:{regimeCoverage:COV({[axis]:{...COV()[axis],[bin]:null}})}})).pass,false,axis+" "+bin+" null");
 }
 assert.equal(fails(good({pooled:{regimeCoverage:COV({trend:{low:500,high:0}})}})).pass,false,"only one tercile of trend is covered: a low-only test set is not multi-regime");
 assert.equal(fails(good({pooled:{regimeCoverage:COV({vol:undefined})}})).pass,false,"one axis absent");
 assert.equal(fails(good({pooled:{regimeCoverage:COV({trend:{low:1e6,high:1e6},vol:{low:1e6,high:29}})}})).pass,false,"plenty of trend cannot make up for a thin vol bin: each of the four bins is required on its own");
});

test("gate: regime coverage must have been computed with the gate's own cutpoints, and the threshold itself must be configured",()=>{
 const other={trend:{lower:.2,upper:.8},vol:CUTS.vol};
 const r=fails(good({pooled:{regimeCoverage:COV({cutpoints:other})}}));assert.equal(r.pass,false);assert.match(r.reasons.join(";"),/different cutpoints/);
 assert.equal(fails(good({pooled:{regimeCoverage:COV({cutpoints:undefined})}})).pass,false);
 for(const bad of [{lower:.7,upper:.3},{lower:.5,upper:.5},{lower:NaN,upper:1},{lower:0}])assert.equal(fails(good(),{...T,regimeCutpoints:{...CUTS,trend:bad}}).pass,false,JSON.stringify(bad));
 assert.equal(fails(good(),{...T,regimeCutpoints:{trend:CUTS.trend}}).pass,false,"cutpoints for one axis only");
 for(const v of [NaN,null,undefined,0,"30"])assert.equal(fails(good(),{...T,minRegimeBinDays:v}).pass,false,"minRegimeBinDays "+String(v));
 assert.match(fails(good(),{...T,minRegimeBinDays:null}).reasons.join(";"),/minRegimeBinDays not configured/);
});

test("gate: survivors-only training is a failure, mechanically (unset threshold, no statement, coverage, unrecorded reasons)",()=>{
 assert.equal(CALIBRATION_GATE.minDelistedCoverage,0.9);
 // the shipped default refuses a survivors-only universe, whatever else is in the report
 const survivors={identifiedDelisted:121,obtainedDelisted:0,unobtained:Array.from({length:121},(_,k)=>({symbol:"D"+k,reason:"not yet downloaded"}))};
 const shipped=evaluateGate(good({universe:survivors}));assert.equal(shipped.pass,false);assert.match(shipped.reasons.join(";"),/训练集仅含存活合约，未补入已下架合约/);
 const reasonsOf=(r,t=T)=>evaluateGate(r,t).reasons.join(";");
 const U=(identified,obtained,unobtained)=>({identifiedDelisted:identified,obtainedDelisted:obtained,unobtained:unobtained??Array.from({length:identified-obtained},(_,k)=>({symbol:"X"+k,reason:"not in the archive"}))});
 assert.equal(fails(good()).pass,true,"a complete report with full coverage passes");
 assert.match(reasonsOf(good(),{...T,minDelistedCoverage:null}),/训练集仅含存活合约，未补入已下架合约.*minDelistedCoverage not configured/);
 for(const v of [NaN,undefined,0,-1,1.1,"0.9"])assert.equal(fails(good(),{...T,minDelistedCoverage:v}).pass,false,"minDelistedCoverage "+String(v));
 assert.equal(fails(good(),{...T,minDelistedCoverage:1}).pass,true,"a coverage of exactly 1 is a valid threshold");
 for(const universe of [null,undefined,"x",42])assert.equal(fails(good({universe})).pass,false,"universe "+String(universe));
 assert.match(reasonsOf(good({universe:null})),/does not state the training universe/);
 // survivors only: nothing identified, or nothing obtained
 assert.equal(fails(good({universe:U(0,0)})).pass,false,"nothing identified is survivors only");
 const s=fails(good({universe:U(121,0)}));assert.equal(s.pass,false);assert.match(s.reasons.join(";"),/训练集仅含存活合约，未补入已下架合约/);
 // coverage
 assert.equal(fails(good({universe:U(100,89)})).pass,false,"89 of 100 is under 0.9");
 assert.match(reasonsOf(good({universe:U(100,89)})),/89 of 100 identified delisted contracts \(0\.890\), need 0\.9/);
 assert.equal(fails(good({universe:U(100,90)})).pass,true,"exactly 90 of 100 passes");
 assert.equal(fails(good({universe:U(200,180)})).pass,true,"a bigger identified set needs proportionally more, not a fixed count");
 assert.equal(fails(good({universe:U(200,170)})).pass,false,"170 would satisfy a fixed count of 100 but is 85% of 200");
 // consistency of the counts
 for(const bad of [{identifiedDelisted:121,obtainedDelisted:122,unobtained:[]},{identifiedDelisted:121.5,obtainedDelisted:100,unobtained:[]},{identifiedDelisted:NaN,obtainedDelisted:1,unobtained:[]},{identifiedDelisted:121,obtainedDelisted:-1,unobtained:[]},{identifiedDelisted:121},{obtainedDelisted:121}])assert.equal(fails(good({universe:bad})).pass,false,JSON.stringify(bad));
 // every contract not obtained needs a recorded reason
 assert.equal(fails(good({universe:U(100,95,[{symbol:"A",reason:"x"},{symbol:"B",reason:"x"},{symbol:"C",reason:"x"},{symbol:"D",reason:"x"},{symbol:"E",reason:"x"}])})).pass,true);
 assert.match(reasonsOf(good({universe:U(100,95,[{symbol:"A",reason:"x"}])})),/not all listed \(1 listed, 5 expected\)/,"the list must match the count");
 assert.equal(fails(good({universe:U(100,95,Array.from({length:5},(_,k)=>({symbol:"S"+k,reason:k?"archive has no file":""})))})).pass,false,"one blank reason fails");
 assert.match(reasonsOf(good({universe:U(100,95,Array.from({length:5},(_,k)=>({symbol:"S"+k,reason:k?"archive has no file":"  "})))})),/has no recorded reason/);
 assert.equal(fails(good({universe:U(100,95,Array.from({length:5},()=>({symbol:"",reason:"r"})))})).pass,false,"a blank symbol name");
 assert.equal(fails(good({universe:{identifiedDelisted:100,obtainedDelisted:95}})).pass,false,"the list of contracts not obtained is required");
 // the epistemic boundary is part of every result, pass or fail
 for(const res of [evaluateGate(good(),T),evaluateGate(good({universe:U(121,0)}),T),evaluateGate(null,T),evaluateGate(good())]){
  assert.ok(res.notes.some((n)=>/已识别的集合/.test(n)&&/不是「全部下架合约」/.test(n)),"the note about the identified set is always there");
 }
});

test("persistence ruler: run lengths, and the ruler itself is checked against a known-bad and a known-good series",async()=>{
 const {regimeRuns,persistsAsRegime,MIN_MEDIAN_RUN_DAYS,binOf,btcTrailingReturnPct}=await import("../lib/calibration/regime.ts");
 const C={lower:.3,upper:.7};
 assert.equal(MIN_MEDIAN_RUN_DAYS,14);
 assert.equal(binOf(.3,C),"low");assert.equal(binOf(.7,C),"high");assert.equal(binOf(.5,C),"mid");assert.equal(binOf(NaN,C),null);
 const r=regimeRuns([.1,.1,.1,.5,.5,.9,.1,.1],C);
 assert.deepEqual(r.runs,[3,2,1,2]);assert.equal(r.median,2);assert.equal(r.mean,2);
 assert.deepEqual([r.byBin.low.days,r.byBin.mid.days,r.byBin.high.days],[5,2,1]);
 assert.equal(r.byBin.low.median,2.5,"low runs are 3 and 2");
 assert.deepEqual(regimeRuns([.1,.1,NaN,.1,.1],C).runs,[2,2],"a missing day ends a run and joins nothing");
 assert.deepEqual(regimeRuns([],C).runs,[]);assert.equal(regimeRuns([],C).median,null);
 assert.equal(persistsAsRegime(regimeRuns([],C)),false,"no runs is not persistence");
 // KNOWN BAD: a series that flips bins every day or two (the breadth feature g1 behaves like this). It must fail the ruler.
 let seed=12345;const rnd=()=>{seed=(seed*1664525+1013904223)%4294967296;return seed/4294967296;};
 const noisy=Array.from({length:360},()=>rnd());
 const bad=regimeRuns(noisy,{lower:1/3,upper:2/3});
 assert.ok(bad.median>=1&&bad.median<=3,"a memoryless series has a median run of 1 to 3 days, got "+bad.median);
 assert.equal(persistsAsRegime(bad),false,"the known-bad series does not pass the ruler");
 // KNOWN GOOD: month-long blocks of low, mid and high. It must pass the ruler.
 const blocks=Array.from({length:360},(_,i)=>[.1,.5,.9][Math.floor(i/30)%3]);
 const good=regimeRuns(blocks,C);
 assert.equal(good.median,30);assert.equal(persistsAsRegime(good),true);
 // day-weighted median: a random DAY is likelier to sit in a long stretch. Runs 1,1,1 and 10: per-stretch median 1, per-day median 10.
 const skew=regimeRuns([.1,.9,.1,...Array(10).fill(.5)],C);
 assert.deepEqual(skew.runs,[1,1,1,10]);assert.equal(skew.median,1);assert.equal(skew.dayWeightedMedian,10);
 assert.equal(persistsAsRegime(skew),false,"by stretch it does not persist");
 assert.equal(persistsAsRegime(regimeRuns([...Array(14).fill(.5),.1,.9,.1],C),"dayWeighted"),true,"by day it does: 14 of 17 days sit in a 14-day stretch");
 assert.equal(persistsAsRegime(regimeRuns([],C),"dayWeighted"),false);
 // the known-bad series fails BOTH statistics, and sits far below the bar under the new one (the goalpost check)
 const { KNOWN_BAD_MAX_MEDIAN_DAYS }=await import("../lib/calibration/regime.ts");
 assert.equal(KNOWN_BAD_MAX_MEDIAN_DAYS,7);
 assert.ok(bad.dayWeightedMedian<=KNOWN_BAD_MAX_MEDIAN_DAYS,"day-weighted median of the memoryless series is "+bad.dayWeightedMedian);
 assert.equal(persistsAsRegime(bad,"dayWeighted"),false);
 assert.equal(good.dayWeightedMedian,30);
 // just under and at the bar
 assert.equal(persistsAsRegime(regimeRuns([...Array(13).fill(.1),...Array(13).fill(.9),...Array(13).fill(.1)],C)),false,"13 days");
 assert.equal(persistsAsRegime(regimeRuns([...Array(14).fill(.1),...Array(14).fill(.9),...Array(14).fill(.1)],C)),true,"14 days");
 // BTC trailing return: exact bars only
 const H=3600000,D=24*H;
 const bars=Array.from({length:800},(_,i)=>({ct:i*H,c:100+i}));
 const ct=799*H;
 assert.ok(Math.abs(btcTrailingReturnPct(bars,ct,30)-((100+799)/(100+799-720)-1)*100)<1e-9);
 assert.equal(btcTrailingReturnPct(bars,ct,40),null,"not enough history: null, not a shorter window");
 assert.equal(btcTrailingReturnPct(bars,ct+1,30),null,"no bar at that closeTime: null");
 const holey=bars.filter((b)=>b.ct!==(799-720)*H);
 assert.equal(btcTrailingReturnPct(holey,ct,30),null,"a missing start bar: null, no nearest-bar substitute");
 void D;
});

test("frozen regime cutpoints: fixed constants, valid axes, provenance stated, and the fragile points are in every gate result",()=>{
 assert.deepEqual(FROZEN_REGIME_CUTPOINTS,{trend:{lower:-2.6411486578998353,upper:5.965780629414542},vol:{lower:43.242009132420094,upper:63.6986301369863}},"a change to these is a new freeze and needs the ledger");
 for(const a of ["trend","vol"])assert.ok(FROZEN_REGIME_CUTPOINTS[a].lower<FROZEN_REGIME_CUTPOINTS[a].upper);
 assert.equal(REGIME_PROVENANCE.bar,14);
 assert.equal(REGIME_PROVENANCE.vol.stretches,21);assert.equal(REGIME_PROVENANCE.vol.perStretchMedian,14);
 const text=regimeNotes().join("\n");
 assert.match(text,/按天加权/);
 assert.match(text,/vol 轴.*按段中位数恰为 14\.0（擦线）.*21 段.*增减一段即可改变/s,"the fragile vol axis is stated as fragile");
 assert.match(text,/trend 轴.*仅在按天加权的统计下合格/s,"the trend axis passes only under the day-weighted statistic, and says so");
 assert.match(text,/相对整个两年窗口/);
 for(const res of [evaluateGate(good(),T),evaluateGate(null,T),evaluateGate(good())]){
  assert.ok(res.notes.some((n)=>/vol 轴.*擦线/s.test(n)),"every gate result carries the vol fragility");
  assert.ok(res.notes.some((n)=>/已识别的集合/.test(n)));
 }
 // the frozen cutpoints are what the shipped gate uses, and a coverage must have been computed with exactly them
 const cov=regimeCoverage({trend:[0,10,-10],vol:[10,90,50],days:[1,2,3],cutpoints:FROZEN_REGIME_CUTPOINTS});
 assert.deepEqual([cov.trend.low,cov.trend.high,cov.vol.low,cov.vol.high],[1,1,1,1]);
 assert.equal(regimeCoverage({trend:[0],vol:[0],days:[1],cutpoints:{trend:{lower:-1,upper:1},vol:{lower:1,upper:2}}}).cutpoints.vol.upper,2);
});

test("blockShiftLabels keeps the time structure and breaks only the feature-label alignment",async()=>{
 const {blockShiftLabels}=await import("../lib/calibration/controls.ts");
 // two coins, labels arranged in long blocks (a strongly autocorrelated label series, like overlapping windows)
 const samples=[],labels=[];
 for(const g of ["A","B"])for(let i=0;i<120;i++){samples.push({group:g,time:i*86400000});labels.push(Math.floor(i/10)%3);}
 // shuffle the array order so the function must sort by time itself
 const perm=samples.map((_,i)=>i).sort((a,b)=>((a*7919)%251)-((b*7919)%251));
 const S=perm.map(i=>samples[i]),Lb=perm.map(i=>labels[i]);
 const r=blockShiftLabels(S,Lb,5);
 assert.equal(r.shifted,240);assert.equal(r.unshifted,0);
 const ms=(xs)=>[0,1,2].map(c=>xs.filter(x=>x===c).length).join(",");
 for(const g of ["A","B"]){
  const idx=S.map((s,i)=>i).filter(i=>S[i].group===g).sort((a,b)=>S[a].time-S[b].time);
  const before=idx.map(i=>Lb[i]),after=idx.map(i=>r.labels[i]);
  assert.equal(ms(before),ms(after),"the label multiset of a coin is unchanged");
  const seams=(xs)=>xs.slice(1).filter((x,i)=>x!==xs[i]).length;
  assert.ok(Math.abs(seams(before)-seams(after))<=1,"label runs are kept: at most one new seam per coin ("+seams(before)+" vs "+seams(after)+")");
  assert.ok(after.some((x,i)=>x!==before[i]),"the alignment with the features is broken");
  let same=0;for(let i=0;i<after.length;i++)if(after[i]===before[i])same++;
  assert.ok(same<after.length*0.6,"most samples got a label from another time: "+same+" of "+after.length+" unchanged");
 }
 // the plain permutation, for contrast, destroys the run structure
 const plain=shuffled(Lb,5);
 const idxA=S.map((s,i)=>i).filter(i=>S[i].group==="A").sort((a,b)=>S[a].time-S[b].time);
 const seams=(xs)=>xs.slice(1).filter((x,i)=>x!==xs[i]).length;
 assert.ok(seams(idxA.map(i=>plain[i]))>seams(idxA.map(i=>Lb[i]))*3,"a whole-set permutation shreds the label runs, which is why it is not used for the leak control");
 // deterministic, and a different seed gives a different rotation
 assert.deepEqual(blockShiftLabels(S,Lb,5).labels,r.labels);
 assert.notDeepEqual(blockShiftLabels(S,Lb,6).labels,r.labels);
 // short groups are left in place and counted, never silently shuffled
 const tiny=blockShiftLabels([{group:"X",time:1},{group:"X",time:2}],[0,1],1);
 assert.deepEqual(tiny.labels,[0,1]);assert.equal(tiny.unshifted,2);
 assert.throws(()=>blockShiftLabels([{group:"X",time:1}],[0,1],1),/line up/);
});
