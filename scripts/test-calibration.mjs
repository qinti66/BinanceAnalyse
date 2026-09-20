import test from "node:test";
import assert from "node:assert/strict";
import { tripleBarrier,roundTripCost,labelDistribution,kDiagnosis,residualTripleBarrier,classIndex,DIRECTION_CLASSES,LABEL_K_BASE,LABEL_K_CALIBRATED,labelK,SLIPPAGE_ROUND_TRIP_ASSUMED,SLIPPAGE_SENSITIVITY_ROUND_TRIP,LABEL_HORIZONS_BARS } from "../lib/indicators/labels.ts";
import { FEATURE_IDS } from "../lib/indicators/features/registry.ts";
import { walkForwardFolds,foldViolations,uniquenessWeights,effectiveN,MIN_TEST_START_MS,embargoBars } from "../lib/calibration/splits.ts";
import { brier,bss,ece,baseRates,classCounts,quantile,validForecasts } from "../lib/calibration/metrics.ts";
import { fitSoftmax,predictProba } from "../lib/calibration/softmax.ts";
import { mulberry32,shuffled,randomFeatureBaseline,leakCheck } from "../lib/calibration/controls.ts";
import { regimeTerciles,regimeCoverage } from "../lib/calibration/regime.ts";
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
const CUTS={g1:{lower:.3,upper:.7},g2:{lower:20,upper:80}};
const COV=(o={})=>({cutpoints:CUTS,g1:{low:150,high:150},g2:{low:150,high:150},...o});
const T={eceMax:.05,minClassSamples:50,regimeCutpoints:CUTS,minRegimeBinSamples:100,minFolds:3,minEffectiveN:2000,minEffectiveTestN:250,minTestSpanDays:60};
const good=(o={})=>({folds:[{bss:.05,n:900},{bss:.04,n:900},{bss:.06,n:900}],pooled:{bss:.05,residualBss:.02,ece:.03,classCounts:[300,400,300],effectiveN:2500,effectiveTestN:400,regimeCoverage:COV(),testSpanDays:75,...(o.pooled||{})},randomBaselineP95:.02,leakStatus:"clean",...o,...(o.pooled?{pooled:{bss:.05,residualBss:.02,ece:.03,classCounts:[300,400,300],effectiveN:2500,effectiveTestN:400,regimeCoverage:COV(),testSpanDays:75,...o.pooled}}:{})});
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
 for(const key of ["minFolds","minEffectiveN","minEffectiveTestN","minTestSpanDays","eceMax","minClassSamples","minRegimeBinSamples","regimeCutpoints"]){
  const missing={...T};delete missing[key];
  assert.equal(fails(good(),missing).pass,false,key+" absent");
  assert.equal(fails(good(),{...T,[key]:NaN}).pass,false,key+" NaN");
  assert.equal(fails(good(),{...T,[key]:null}).pass,false,key+" null");
  assert.equal(fails(good(),{...T,[key]:"50"}).pass,false,key+" a string");
 }
 assert.equal(fails(good(),T).pass,true,"the same report passes once every threshold is a real number");
 assert.match(fails(good(),{...T,minEffectiveTestN:undefined}).reasons.join(";"),/minEffectiveTestN not configured/);
});

test("regime terciles are computed once from history, and coverage counts effective samples per bin with inclusive edges",()=>{
 const hist=Array.from({length:300},(_,i)=>i/299);
 const t=regimeTerciles(hist);assert.ok(Math.abs(t.lower-1/3)<1e-9&&Math.abs(t.upper-2/3)<1e-9);
 assert.equal(regimeTerciles(hist.slice(0,10)),null,"too little history to define terciles");
 assert.equal(regimeTerciles(Array(100).fill(.5)),null,"a constant series has no distinct terciles");
 assert.ok(regimeTerciles([...hist,NaN,Infinity]),"non-finite values are ignored");
 const g1=[.1,.3,.5,.7,.9,NaN,.3],g2=[10,20,50,80,90,50,NaN];
 const c=regimeCoverage({g1,g2,cutpoints:CUTS});
 assert.deepEqual([c.g1.low,c.g1.high,c.g2.low,c.g2.high],[3,2,2,2],"<= lower and >= upper are inclusive; NaN is in no bin");
 assert.deepEqual(c.cutpoints,CUTS,"the coverage carries the cutpoints it was computed with");
 const w=regimeCoverage({g1,g2,weights:[1,.5,1,.25,1,1,1],cutpoints:CUTS});
 assert.deepEqual([w.g1.low,w.g1.high],[2.5,1.25],"weights are effective sample sizes");
 assert.equal(regimeCoverage({g1:[1],g2:[1,2],cutpoints:CUTS}),null,"mismatched lengths");
 assert.equal(regimeCoverage({g1:[1],g2:[1],weights:[1,2],cutpoints:CUTS}),null);
});

test("gate: regime coverage is fail-closed (unset cutpoints, no coverage, one thin bin, one axis only, different cutpoints)",()=>{
 assert.equal(CALIBRATION_GATE.regimeCutpoints,null,"the shipped gate has no cutpoints until multi-regime history exists");
 assert.equal(CALIBRATION_GATE.minRegimeBinSamples,100);
 const d=evaluateGate(good());assert.equal(d.pass,false);assert.match(d.reasons.join(";"),/regime coverage unverified: regime cutpoints not configured/);
 assert.equal(fails(good()).pass,true,"the same report passes once cutpoints are configured and every bin is covered");
 assert.equal(fails(good(),{...T,regimeCutpoints:null}).pass,false);
 assert.equal(fails(good({pooled:{regimeCoverage:null}})).pass,false);assert.match(fails(good({pooled:{regimeCoverage:null}})).reasons.join(";"),/report has no regime coverage/);
 assert.equal(fails(good({pooled:{regimeCoverage:undefined}})).pass,false);
 for(const axis of ["g1","g2"])for(const bin of ["low","high"]){
  const cov=COV({[axis]:{...COV()[axis],[bin]:0}});
  const r=fails(good({pooled:{regimeCoverage:cov}}));assert.equal(r.pass,false,axis+" "+bin+" empty");assert.match(r.reasons.join(";"),new RegExp(axis+" "+bin+" tercile has 0"));
  assert.equal(fails(good({pooled:{regimeCoverage:COV({[axis]:{...COV()[axis],[bin]:99.9}})}})).pass,false,axis+" "+bin+" just under 100");
  assert.equal(fails(good({pooled:{regimeCoverage:COV({[axis]:{...COV()[axis],[bin]:100}})}})).pass,true,axis+" "+bin+" exactly 100 passes");
  assert.equal(fails(good({pooled:{regimeCoverage:COV({[axis]:{...COV()[axis],[bin]:NaN}})}})).pass,false,axis+" "+bin+" NaN");
  assert.equal(fails(good({pooled:{regimeCoverage:COV({[axis]:{...COV()[axis],[bin]:null}})}})).pass,false,axis+" "+bin+" null");
 }
 assert.equal(fails(good({pooled:{regimeCoverage:COV({g1:{low:500,high:0}})}})).pass,false,"only one tercile of g1 is covered: a low-only test set is not multi-regime");
 assert.equal(fails(good({pooled:{regimeCoverage:COV({g2:undefined})}})).pass,false,"one axis absent");
 assert.equal(fails(good({pooled:{regimeCoverage:COV({g1:{low:1e6,high:1e6},g2:{low:1e6,high:99}})}})).pass,false,"plenty of g1 cannot make up for a thin g2 bin: each of the four bins is required on its own");
});

test("gate: regime coverage must have been computed with the gate's own cutpoints, and the threshold itself must be configured",()=>{
 const other={g1:{lower:.2,upper:.8},g2:CUTS.g2};
 const r=fails(good({pooled:{regimeCoverage:COV({cutpoints:other})}}));assert.equal(r.pass,false);assert.match(r.reasons.join(";"),/different cutpoints/);
 assert.equal(fails(good({pooled:{regimeCoverage:COV({cutpoints:undefined})}})).pass,false);
 for(const bad of [{lower:.7,upper:.3},{lower:.5,upper:.5},{lower:NaN,upper:1},{lower:0}])assert.equal(fails(good(),{...T,regimeCutpoints:{...CUTS,g1:bad}}).pass,false,JSON.stringify(bad));
 assert.equal(fails(good(),{...T,regimeCutpoints:{g1:CUTS.g1}}).pass,false,"cutpoints for one axis only");
 for(const v of [NaN,null,undefined,0,"100"])assert.equal(fails(good(),{...T,minRegimeBinSamples:v}).pass,false,"minRegimeBinSamples "+String(v));
 assert.match(fails(good(),{...T,minRegimeBinSamples:null}).reasons.join(";"),/minRegimeBinSamples not configured/);
});
