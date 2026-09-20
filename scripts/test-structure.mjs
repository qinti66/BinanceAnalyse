import test from "node:test";
import assert from "node:assert/strict";
import { trueRange,atrSeries } from "../lib/structure/atr.ts";
import { fractals,zigzag,confirmedAt } from "../lib/structure/swings.ts";
import { clusterLevels } from "../lib/structure/levels.ts";
import { detectRange,detectRangeDetailed } from "../lib/structure/ranges.ts";
import { analyzeStructure,STRUCTURE_PARAMS,STRUCTURE_VERSION } from "../lib/structure/analyze.ts";
import { contractMetrics,HOUR } from "../lib/indicators/model.ts";

// Deterministic PRNG so failures reproduce.
const rng=(seed)=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
const bar=(i,o={})=>({t:i*HOUR,ct:i*HOUR+HOUR-1,o:100,h:101,l:99,c:100,v:1,qvUsd:1,takerBuyUsd:.5,trades:1,flow:null,...o});
const fromHL=(hl)=>hl.map(([h,l],i)=>bar(i,{h,l,c:(h+l)/2,o:(h+l)/2}));
// Oscillation around 100 with noise: produces repeated swing highs/lows, i.e. a range.
const oscillating=(n,seed=7)=>{const r=rng(seed);return Array.from({length:n},(_,i)=>{const c=100+5*Math.sin(i*2*Math.PI/40)+(r()-.5)*.6,s=.3+r()*.4;return bar(i,{o:c,h:c+s,l:c-s,c});});};
const randomFuture=(bars,from,seed)=>{const r=rng(seed);return bars.map((b,i)=>{if(i<=from)return b;const c=60+r()*80,s=r()*4;return {...b,o:c,h:c+s,l:c-s,c};});};
const params=(o={})=>({...STRUCTURE_PARAMS,...o});

test("missing inputs stay missing, never zero",()=>{
 const bars=oscillating(40);bars[20]={...bars[20],h:NaN};
 const atr=atrSeries(bars,14);
 assert.equal(atr.slice(0,13).every(v=>v===null),true);
 assert.notEqual(atr[13],null);
 // Only TR[20] is NaN (bar 21 measures against bar 20 close, which is finite): windows 20..33 contain it.
 for(let i=20;i<=33;i++)assert.equal(atr[i],null,"window with NaN true range must be null, index "+i);
 assert.notEqual(atr[34],null,"the window recovers once the NaN leaves it");
 assert.equal(fractals(bars,2).some(s=>s.index>=18&&s.index<=22),false,"windows containing a missing bar produce no swing");
 const o={atIndex:4,lookback:168,minSwings:4,tolAtr:.5,minTouches:2,maxHeightAtr:25,atrPeriod:14};
 const d=detectRangeDetailed(oscillating(5),[],o);
 assert.equal(d.range,null);assert.equal(d.state,"unavailable");assert.match(d.reason,/fewer than 168 bars/);
 assert.equal(detectRange(oscillating(200),[],{...o,atIndex:199}),null);
 const short=detectRangeDetailed(oscillating(300),[],{...o,atIndex:100});
 assert.equal(short.state,"unavailable","the lookback window is never shortened to make a range fit");
});

test("ATR matches the definition used by contractMetrics",()=>{
 const r=rng(3);const n=120,cutoff=n*HOUR;
 let c=100;const klines=Array.from({length:n},(_,i)=>{const o=c;c=o*(1+(r()-.5)*.04);const h=Math.max(o,c)*(1+r()*.01),l=Math.min(o,c)*(1-r()*.01),t=i*HOUR;
  return [t,String(o),String(h),String(l),String(c),"10",t+HOUR-1,"1000","5","4","400","0"];});
 const raw={contract:{family:"UM",symbol:"XUSDT",pair:"XUSDT",baseAsset:"X",quoteAsset:"USDT",contractType:"PERPETUAL",onboardDate:0},
  history:null,klines,openInterest:null,ticker:null,premium:null,funding:null,fundingEndpointAvailable:false,book:null,quoteUsd:1,receivedAt:""};
 const m=contractMetrics(raw,cutoff,undefined),bars=m.analysisInputs.bars,atr=atrSeries(bars,14);
 assert.equal(bars.length,n);
 const legacy=m.earlyInputs.atrPctSeries;
 assert.equal(legacy.length,n-13);
 for(let i=13;i<n;i++)assert.ok(Math.abs(atr[i]/bars[i].c*100-legacy[i-13])<1e-9,"atrPct mismatch at "+i);
 const tr=trueRange(bars);assert.equal(tr[0],bars[0].h-bars[0].l);
 assert.ok(Math.abs(m.atrPct-atr[n-1]/bars[n-1].c*100)<1e-9);
});

test("fractals are strict, need k bars on each side, and carry the confirmation lag",()=>{
 const bars=fromHL([[10,9],[11,10],[15,12],[11,10],[10,9],[9,8],[8,5],[9,6],[10,7],[11,8]]);
 const f=fractals(bars,2);
 const hi=f.find(s=>s.type==="high"),lo=f.find(s=>s.type==="low");
 assert.deepEqual([hi.index,hi.price,hi.confirmedIndex],[2,15,4]);
 assert.deepEqual([lo.index,lo.price,lo.confirmedIndex],[6,5,8]);
 assert.ok(f.every(s=>s.index>=2&&s.index<=bars.length-3&&s.confirmedIndex===s.index+2));
 const tie=fromHL([[10,9],[11,10],[15,12],[15,12],[10,9]]);
 assert.equal(fractals(tie,2).some(s=>s.type==="high"),false,"equal neighbouring highs disqualify the bar");
 assert.deepEqual(confirmedAt(f,3),[],"nothing is knowable before the confirming bar");
 assert.equal(confirmedAt(f,4).length,1);
});

test("zigzag never emits the unconfirmed last leg and confirms after the pivot",()=>{
 const path=[100,102,105,104,101,98,95,97,100,104,108,106,103];
 const base=path.slice(0,12); // ends at 106: 108 -> 106 has not reversed by 4%
 const bars=base.map((c,i)=>bar(i,{o:c,h:c+.5,l:c-.5,c}));
 const z=zigzag(bars,{mode:"pct",pct:4});
 assert.deepEqual(z.map(s=>[s.type,s.index]),[["high",2],["low",6]]);
 assert.ok(z.every(s=>s.confirmedIndex>s.index));
 assert.ok(z.every(s=>s.confirmedIndex<=bars.length-1));
 assert.ok(!z.some(s=>s.index===10),"the peak at index 10 has not reversed by 4%, so it must not appear");
 const longer=base.concat([103,100]).map((c,i)=>bar(i,{o:c,h:c+.5,l:c-.5,c}));
 const z2=zigzag(longer,{mode:"pct",pct:4});
 assert.deepEqual(z2.slice(0,z.length),z,"extending the series only appends");
 assert.ok(z2.some(s=>s.index===10&&s.type==="high"),"the peak is confirmed once the reversal arrives");
 assert.deepEqual(zigzag(bars,{mode:"atr"}),[],"missing mult ⇒ no invented threshold");
});

test("clusterLevels groups equal highs and lows within tolerance",()=>{
 const sw=(index,price,type)=>({index,time:index,price,type,confirmedIndex:index+2});
 const swings=[sw(1,100,"high"),sw(5,100.2,"high"),sw(9,110,"high"),sw(3,90,"low"),sw(7,90.1,"low"),sw(11,89.9,"low")];
 const h=clusterLevels(swings,{type:"high",tol:.5});
 assert.equal(h.length,1);assert.equal(h[0].touches,2);assert.ok(Math.abs(h[0].price-100.1)<1e-9);
 assert.deepEqual([h[0].firstIndex,h[0].lastIndex,h[0].confirmedIndex],[1,5,7]);
 const l=clusterLevels(swings,{type:"low",tol:.5});assert.equal(l[0].touches,3);
 assert.equal(h[0].high,100.2);assert.equal(h[0].low,100);assert.equal(l[0].low,89.9);assert.equal(l[0].high,90.1);
 assert.ok(h[0].price>h[0].low&&h[0].price<h[0].high,"the mean sits strictly inside the extremes");
 assert.equal(clusterLevels(swings,{type:"high",tol:.5,minTouches:1}).length,2);
 assert.deepEqual(clusterLevels(swings,{type:"high",tol:NaN}),[]);
});

test("detectRange finds a range in an oscillation and refuses a trend",()=>{
 const bars=oscillating(300);
 const swings=zigzag(bars,{mode:"atr",mult:2,atrPeriod:14});
 const opts={atIndex:299,lookback:168,minSwings:4,tolAtr:.5,minTouches:2,maxHeightAtr:25,atrPeriod:14};
 const {state,range,reason}=detectRangeDetailed(bars,confirmedAt(swings,299),opts);
 assert.equal(state,"range",String(reason));assert.equal(reason,null);
 assert.ok(range.meta.top>range.meta.bottom);
 assert.ok(range.meta.topTouches>=2&&range.meta.bottomTouches>=2);
 assert.ok(range.meta.top>100&&range.meta.bottom<100,"range should straddle the 100 mean");
 assert.ok(range.confirmedIndex<=299&&range.startIndex>299-168);
 assert.equal(range.kind,"range");
 const trend=Array.from({length:300},(_,i)=>{const c=100+i*.8+(i%7)*.3;return bar(i,{o:c,h:c+.5,l:c-.5,c});});
 const ts=zigzag(trend,{mode:"atr",mult:2,atrPeriod:14});
 const t=detectRangeDetailed(trend,confirmedAt(ts,299),opts);
 assert.equal(t.range,null);assert.notEqual(t.state,"range");assert.ok(t.reason);
});

test("three states: sufficient data without a coherent range is no_range, not missing",()=>{
 // Rising staircase with real pullbacks: enough swings to judge, but no two highs (or lows) share a level.
 const trend=Array.from({length:300},(_,i)=>{const c=100+i*.8+6*Math.sin(i*2*Math.PI/30);return bar(i,{o:c,h:c+.5,l:c-.5,c});});
 const r=analyzeStructure(trend,299);
 assert.equal(r.rangeState,"no_range","a drifting market with enough data is a real state, not an unknown");
 // Architect ruling (R6): a clean monotone drift never reverses by 2 ATR, so it has < 4 swings. For f1/f3 that is still
 // no_range (value 0): "no sweep happened" and "price respects no level" are both TRUE in a strong trend. The swing count
 // is exposed so that f2_trend_state, whose 0 ("no clear trend") would be false there, can stay missing.
 const monotone=Array.from({length:300},(_,i)=>{const c=100+i*.8;return bar(i,{o:c,h:c+.5,l:c-.5,c});});
 const mono=analyzeStructure(monotone,299);
 assert.equal(mono.rangeState,"no_range");assert.deepEqual(mono.unavailable,[]);
 assert.ok(mono.confirmedSwingCount<4,"f2 must see fewer than 4 swings and therefore be missing");
 assert.ok(r.confirmedSwingCount>=4);
 assert.deepEqual(r.unavailable,[],"no_range must not be reported as unavailable");
 assert.equal(r.findings.length,0);
 const early=analyzeStructure(oscillating(300),100);
 assert.equal(early.rangeState,"unavailable");assert.equal(early.unavailable.length,1);
 assert.equal(analyzeStructure(oscillating(300),299).rangeState,"range");
 // Enough bars and a valid ATR but no swings at all is a market state (dead flat), not missing data.
 const flat=Array.from({length:300},(_,i)=>bar(i,{o:100,h:100.5,l:99.5,c:100}));
 const f=analyzeStructure(flat,299);
 assert.equal(f.rangeState,"no_range");assert.equal(f.confirmedSwingCount,0);assert.deepEqual(f.unavailable,[]);
 // Invalid ATR is a data problem: unavailable.
 const nan=oscillating(300).map((b,i)=>i>=290?{...b,h:NaN}:b);
 assert.equal(analyzeStructure(nan,299).rangeState,"unavailable");
 // A single touch is not a level: require minTouches on each side.
 const hard=analyzeStructure(oscillating(300),299,params({rangeMinTouches:99}));
 assert.equal(hard.rangeState,"no_range");
});

test("containment is a bounded feature computed over the lookback window",()=>{
 const bars=oscillating(300),swings=confirmedAt(zigzag(bars,{mode:"atr",mult:2,atrPeriod:14}),299);
 const o={atIndex:299,lookback:168,minSwings:4,tolAtr:.5,minTouches:2,maxHeightAtr:25,atrPeriod:14};
 const m=detectRangeDetailed(bars,swings,o).range.meta;
 const win=bars.slice(299-168+1,300).map(b=>b.c);
 assert.equal(m.containment,win.filter(c=>c>=m.bottom&&c<=m.top).length/win.length);
 assert.ok(m.containment>0&&m.containment<=1);
 assert.ok(m.containment>.9,"a clean oscillation should sit almost entirely inside its own boundaries");
 const wide=detectRangeDetailed(bars,swings,{...o,maxHeightAtr:.1});
 assert.equal(wide.state,"no_range");assert.match(wide.reason,/wider than/);
});

test("prefix invariance: features at index i never see bars after i",()=>{
 const all=oscillating(400);
 let withRange=0,checked=0;
 for(let i=40;i<all.length;i+=7){
  const full=analyzeStructure(all,i),cut=analyzeStructure(all.slice(0,i+1),i);
  assert.deepEqual(full,cut,"result at "+i+" changed when future bars were removed");
  if(full.findings.length)withRange++;checked++;
 }
 assert.ok(checked>30&&withRange>5,"guard must not be vacuous: ranges found at "+withRange+"/"+checked+" points");
 for(let i=60;i<all.length;i+=25){
  const zFull=confirmedAt(zigzag(all,{mode:"atr",mult:2}),i),zCut=confirmedAt(zigzag(all.slice(0,i+1),{mode:"atr",mult:2}),i);
  assert.deepEqual(zFull,zCut,"zigzag at "+i);
  assert.deepEqual(confirmedAt(fractals(all,2),i),fractals(all.slice(0,i+1),2),"fractals at "+i);
 }
});

test("swing confirmation lag is respected",()=>{
 const all=oscillating(400);
 for(let i=50;i<all.length-1;i+=13){
  const mutated=randomFuture(all,i,i);
  assert.deepEqual(analyzeStructure(all,i),analyzeStructure(mutated,i),"structure at "+i+" depends on bars after it");
  assert.deepEqual(confirmedAt(zigzag(all,{mode:"atr",mult:2}),i),confirmedAt(zigzag(mutated,{mode:"atr",mult:2}),i),"zigzag "+i);
  assert.deepEqual(confirmedAt(fractals(all,2),i),confirmedAt(fractals(mutated,2),i),"fractals "+i);
 }
});

test("the guard has teeth: filtering swings by index instead of confirmedIndex leaks the future",()=>{
 const all=oscillating(200);let leaked=false;
 for(let i=30;i<180&&!leaked;i++){
  const naive=(b)=>fractals(b,2).filter(s=>s.index<=i);
  if(JSON.stringify(naive(all))!==JSON.stringify(naive(randomFuture(all,i,i))))leaked=true;
 }
 assert.ok(leaked,"a naive index<=i filter must be detectably wrong, otherwise the guard tests prove nothing");
});

test("structure result carries version, params and reports unavailable instead of a fake range",()=>{
 const r=analyzeStructure(oscillating(30),29);
 assert.equal(r.version,STRUCTURE_VERSION);assert.deepEqual(r.params,STRUCTURE_PARAMS);
 assert.equal(r.findings.length,0);assert.ok(r.unavailable.length>=1);assert.match(r.unavailable[0],/^range:/);assert.equal(r.rangeState,"unavailable");
 const partial=oscillating(200);partial[100]={...partial[100],h:NaN};
 const p=analyzeStructure(partial,150);assert.ok(p.coverage<1&&p.coverage>.99);
 const narrow=analyzeStructure(oscillating(300),299,params({rangeMaxHeightAtr:.1}));
 assert.equal(narrow.findings.length,0);assert.equal(narrow.rangeState,"no_range");assert.deepEqual(narrow.unavailable,[]);
 assert.equal(STRUCTURE_PARAMS.rangeMinTouches,2);assert.equal(STRUCTURE_PARAMS.rangeMaxHeightAtr,25);
 assert.equal(STRUCTURE_PARAMS.zigzagAtrMult,2);assert.equal(STRUCTURE_PARAMS.rangeTolAtr,.5);assert.equal(STRUCTURE_PARAMS.rangeLookback,168);
});

test("train/serve skew guard: structure on the last 360 bars equals structure on the full history",()=>{
 // Live scoring only has the latest 360 bars; training may run over years. ZigZag is path dependent, so this must hold
 // for the frozen params (measured 100% identical on 6100 real points, see calibration-log-v1.md T3). If a parameter change
 // breaks it, features computed in training are not the ones served live.
 const all=oscillating(1500,21);let compared=0;
 for(let i=359;i<all.length;i+=17){
  const full=analyzeStructure(all,i),win=analyzeStructure(all.slice(i-359,i+1),359);
  assert.equal(win.rangeState,full.rangeState,"state at "+i);
  assert.equal(win.confirmedSwingCount,full.confirmedSwingCount,"swing count at "+i);
  assert.deepEqual(win.findings.map(f=>f.meta),full.findings.map(f=>f.meta),"range meta at "+i);
  compared++;
 }
 assert.ok(compared>60);
});

test("range boundaries are the cluster extremes, not the cluster means",()=>{
 const bars=oscillating(300),swings=confirmedAt(zigzag(bars,{mode:"atr",mult:2,atrPeriod:14}),299);
 const o={atIndex:299,lookback:168,minSwings:4,tolAtr:.5,minTouches:2,maxHeightAtr:25,atrPeriod:14};
 const m=detectRangeDetailed(bars,swings,o).range.meta;
 const win=swings.filter(s=>s.index>299-168);
 const near=(type,price)=>win.filter(s=>s.type===type&&Math.abs(s.price-price)<=.5*m.atr*2);
 const highs=near("high",m.top).map(s=>s.price),lows=near("low",m.bottom).map(s=>s.price);
 assert.ok(highs.every(p=>p<=m.top+1e-9)&&lows.every(p=>p>=m.bottom-1e-9),"no member of the boundary cluster lies beyond the boundary");
 assert.ok(highs.some(p=>Math.abs(p-m.top)<1e-9)&&lows.some(p=>Math.abs(p-m.bottom)<1e-9),"the boundary IS one of the members (the extreme)");
});
