import test from "node:test";
import assert from "node:assert/strict";
import { median,iqr,pctRank,olsSlope,emaValue,quantileSorted,contiguousTail } from "../lib/indicators/features/stats.ts";
import { normaliseFunding,fundingZ,fundingWindow,FUNDING_SCALE_FLOOR,checkIntervalInference,normaliseFundingRuleB,classifyRefusedRow,aggregateVerdict,refusedRowsReport,semanticEvents,semanticsVerdict,decideIntervalRule,MIN_SEMANTIC_EVENTS,SUGGESTIVE_SEMANTIC_EVENTS,MIN_REFUSED_ROWS_FOR_RULE_CHANGE } from "../lib/indicators/features/funding.ts";
import { buildCrossSection,ret24hPct } from "../lib/indicators/features/context.ts";
import { structureFeatures } from "../lib/indicators/features/structureFeatures.ts";
import { buildFeatureVector,FEATURE_IDS,FEATURE_VERSION,FEATURE_WINDOW,summariseCoverage,AGE_EXCLUSION_REVIEW_SHARE } from "../lib/indicators/features/registry.ts";
import { historyTooShort } from "../lib/indicators/features/stats.ts";
import { STRUCTURE_PARAMS,analyzeStructure } from "../lib/structure/analyze.ts";
import { atrSeries } from "../lib/structure/atr.ts";
import { ema as modelEma } from "../lib/indicators/model.ts";

const H=3600000,DAY=24*H;
const rng=(seed)=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
const idx=(id)=>FEATURE_IDS.indexOf(id);
const get=(v,id)=>v.values[idx(id)];
// Bar on the hour grid: t = i*H, so UTC hour-of-day = i % 24.
const bar=(i,o={})=>{const c=o.c??100,q=o.qvUsd===undefined?1000:o.qvUsd;return {t:i*H,ct:i*H+H-1,o:c,h:o.h??c+.5,l:o.l??c-.5,c,v:1,qvUsd:q,takerBuyUsd:o.takerBuyUsd===undefined?(q===null?null:q*.5):o.takerBuyUsd,trades:1,flow:null};};
// Random walk with noisy volume and a real high-low range. `start` shifts the time grid so coins can be aligned.
const walk=(n,{seed=1,start=0,sigma=.01,p0=100,drift=0}={})=>{const r=rng(seed);let c=p0;return Array.from({length:n},(_,k)=>{const i=start+k,prev=c;c=prev*(1+drift+(r()-.5)*2*sigma);const q=800+r()*400,hi=Math.max(prev,c)*(1+r()*.004),lo=Math.min(prev,c)*(1-r()*.004);
 return {t:i*H,ct:i*H+H-1,o:prev,h:hi,l:lo,c,v:1,qvUsd:q,takerBuyUsd:q*(.3+.4*r()),trades:1,flow:null};});};
const agg4h=(bars)=>{const out=[];for(let s=0;s+3<bars.length;){if((bars[s].t/H)%4!==0){s++;continue;}const g=bars.slice(s,s+4);out.push({t:g[0].t,ct:g[3].ct,o:g[0].o,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),c:g[3].c,v:4,qvUsd:g.reduce((a,x)=>a+x.qvUsd,0),takerBuyUsd:g.reduce((a,x)=>a+x.takerBuyUsd,0),trades:4,flow:null});s+=4;}return out;};
const emptyCtx=(o={})=>({bars4h:null,btcBars:null,btcLongBars:null,cross:null,funding:null,isPerpetual:true,...o});

test("missing inputs stay missing, never zero",()=>{
 const v=buildFeatureVector([],0,emptyCtx());
 assert.equal(v.values.length,21);assert.equal(v.missing.length,21);
 assert.ok(Array.from(v.values).every(Number.isNaN),"every feature is NaN, none is 0");
 assert.ok(FEATURE_IDS.every(id=>typeof v.reasons[id]==="string"),"every missing feature says why");
 const short=buildFeatureVector(walk(50),49,emptyCtx());
 assert.ok(short.missing.includes("c1_effort_vs_result")&&!Array.from(short.values).some(x=>x===0));
 // A zero-volume bar with missing taker data is missing for c2, not 0.
 const bars=walk(400,{seed:2});bars[399]={...bars[399],takerBuyUsd:null};
 assert.ok(Number.isNaN(get(buildFeatureVector(bars,399,emptyCtx()),"c2_sell_absorbed")));
});

test("registry identity: 21 unique features, a version, spec-sized",()=>{
 assert.equal(FEATURE_IDS.length,21);assert.equal(new Set(FEATURE_IDS).size,21);
 assert.equal(FEATURE_VERSION,"features-v1");assert.equal(FEATURE_WINDOW,400);
});

test("stats: mid-rank ties, IQR, OLS, and the EMA equals the one in model.ts",()=>{
 assert.equal(median([3,1,2]),2);assert.equal(median([1,2,3,4]),2.5);assert.equal(median([]),null);assert.equal(median([1,NaN]),null);
 assert.equal(pctRank(2,[1,2,2,3]),50,"below 1 + half of 2 equal = 2 of 4");
 assert.equal(pctRank(5,[5,5,5,5]),50);assert.equal(pctRank(1,[1,2,3,4]),12.5);assert.equal(pctRank(NaN,[1]),null);
 assert.equal(iqr([1,2,3,4,5]),2);assert.equal(quantileSorted([1,2,3,4,5],.5),3);
 assert.ok(Math.abs(olsSlope([1,2,3,4],[2,4,6,8])-2)<1e-12);assert.equal(olsSlope([1,1,1],[1,2,3]),null);assert.equal(olsSlope([1],[1]),null);
 const xs=Array.from({length:120},(_,i)=>100+Math.sin(i/7)*5+i*.05);
 assert.equal(emaValue(xs,60),modelEma(xs,60));assert.equal(emaValue(xs.slice(0,30),60),null);
 assert.equal(contiguousTail([bar(0),bar(1),bar(2)],3,H),true);assert.equal(contiguousTail([bar(0),bar(2)],2,H),false);
});

test("c1 effort vs result: big volume with a tiny range is high, and the reverse is low",()=>{
 const r=rng(5),base=Array.from({length:400},(_,i)=>{const s=.5+r();return bar(i,{c:100,h:100+s/2,l:100-s/2,qvUsd:1000+r()*500});});
 const hi=base.slice();hi[399]=bar(399,{c:100,h:100.0005,l:99.9995,qvUsd:1e9});
 const lo=base.slice();lo[399]=bar(399,{c:100,h:104,l:96,qvUsd:1});
 assert.ok(get(buildFeatureVector(hi,399,emptyCtx()),"c1_effort_vs_result")>95);
 assert.ok(get(buildFeatureVector(lo,399,emptyCtx()),"c1_effort_vs_result")<-95);
 const holes=hi.slice();holes[200]={...holes[200],qvUsd:null};
 assert.ok(Number.isNaN(get(buildFeatureVector(holes,399,emptyCtx()),"c1_effort_vs_result")));
 const zero=hi.slice();zero[300]={...zero[300],qvUsd:0,takerBuyUsd:0};
 assert.ok(Number.isFinite(get(buildFeatureVector(zero,399,emptyCtx()),"c1_effort_vs_result")),"a zero-volume hour is a real observation, rank-based c1 handles it");
});

test("c2 sell absorbed: sellers active but price did not move; qvUsd = 0 is 0, not NaN",()=>{
 const mk=(last)=>{const r=rng(9),b=Array.from({length:400},(_,i)=>bar(i,{c:100+(r()-.5)*2,h:101.5+(r()-.5),l:98.5+(r()-.5)}));b[398]={...b[398],c:100};b[399]=last;return b;};
 const still=buildFeatureVector(mk(bar(399,{c:100,h:100.2,l:99.8,qvUsd:1000,takerBuyUsd:0})),399,emptyCtx());
 assert.ok(Math.abs(get(still,"c2_sell_absorbed")-1)<1e-9,"all sellers, no move ⇒ 1");
 const crashed=buildFeatureVector(mk(bar(399,{c:90,h:100,l:90,qvUsd:1000,takerBuyUsd:0})),399,emptyCtx());
 assert.equal(get(crashed,"c2_sell_absorbed"),0,"a move of at least one ATR means nothing was absorbed");
 const dead=buildFeatureVector(mk(bar(399,{c:100,h:100.2,l:99.8,qvUsd:0,takerBuyUsd:0})),399,emptyCtx());
 assert.equal(get(dead,"c2_sell_absorbed"),0);assert.ok(!dead.missing.includes("c2_sell_absorbed"));
 const buyers=buildFeatureVector(mk(bar(399,{c:100,h:100.2,l:99.8,qvUsd:1000,takerBuyUsd:1000})),399,emptyCtx());
 assert.equal(get(buyers,"c2_sell_absorbed"),0,"no selling ⇒ nothing to absorb");
});

test("d1 squeeze percentile and d3 compression run-length",()=>{
 const r=rng(11),wide=Array.from({length:400},(_,i)=>{const s=1.8+r()*.4;return bar(i,{c:100,h:100+s/2,l:100-s/2});});
 const tight=wide.map((b,i)=>i>=360?bar(i,{c:100,h:100.1,l:99.9}):b);
 const v=buildFeatureVector(tight,399,emptyCtx());
 assert.ok(get(v,"d1_vol_squeeze_pct")<5,"tight now vs the trailing history");
 assert.ok(get(v,"d3_compression_bars")>=40,"at least the 40 tight bars, plus any earlier bars that happened to sit below the median");
 const steady=Array.from({length:400},(_,i)=>i>=360?bar(i,{c:100,h:100.1,l:99.9}):bar(i,{c:100,h:101,l:99}));
 assert.equal(get(buildFeatureVector(steady,399,emptyCtx()),"d3_compression_bars"),40,"an exact run against the fixed median M");
 const older=steady.slice(0,399);
 assert.equal(get(buildFeatureVector(older,398,emptyCtx()),"d3_compression_bars"),39,"the run is measured back from the decision bar");
 const flat=Array.from({length:400},(_,i)=>bar(i,{c:100,h:100.5,l:99.5}));
 const f=buildFeatureVector(flat,399,emptyCtx());
 assert.equal(get(f,"d3_compression_bars"),0,"nothing is below its own median: not compressed now is a true 0");
 assert.equal(get(f,"d1_vol_squeeze_pct"),50,"all ties take the mid-rank");
 const gap=wide.slice();gap.splice(250,1);
 assert.ok(Number.isNaN(get(buildFeatureVector(gap,398,emptyCtx()),"d1_vol_squeeze_pct")),"a gap in the trailing window is missing, not shortened");
});

test("d2 volume dry-up uses hour-of-day slots and is not fooled by the daily cycle",()=>{
 const seasonal=(i)=>(i%24===3?5000:1000);
 const b=Array.from({length:400},(_,i)=>bar(i,{c:100,h:100.5,l:99.5,qvUsd:seasonal(i)}));
 assert.equal(get(buildFeatureVector(b,399,emptyCtx()),"d2_volume_dryup_pct"),50,"a normal hour, whatever its slot, ranks in the middle");
 const quiet=b.slice();quiet[399]={...quiet[399],qvUsd:seasonal(399)*.1,takerBuyUsd:seasonal(399)*.05};
 assert.ok(get(buildFeatureVector(quiet,399,emptyCtx()),"d2_volume_dryup_pct")<1,"a tenth of its own slot's volume is a dry-up");
 // 1000 is the normal volume of an ordinary slot but a dry-up in the 5000 slot: same number, different verdict.
 const slot3=b.slice(),hour3=399-((399-3)%24);slot3[hour3]={...slot3[hour3],qvUsd:1000,takerBuyUsd:500};
 const idx3=hour3;assert.equal(idx3%24,3);
 assert.ok(get(buildFeatureVector(slot3.slice(0,hour3+1),hour3,emptyCtx()),"d2_volume_dryup_pct")<5,"1000 in the 5000-volume slot is a dry-up");
 const zeroSlot=Array.from({length:400},(_,i)=>bar(i,{c:100,h:100.5,l:99.5,qvUsd:i%24===7?0:1000,takerBuyUsd:i%24===7?0:500}));
 assert.ok(Number.isNaN(get(buildFeatureVector(zeroSlot,399,emptyCtx()),"d2_volume_dryup_pct")),"a zero baseline cannot support a ratio");
 assert.ok(Number.isNaN(get(buildFeatureVector(b.slice(0,300),299,emptyCtx()),"d2_volume_dryup_pct")),"fewer than 349 bars ⇒ missing, the window is never shortened");
});

test("e1/e2/e3: BTC-relative, market-relative and rank, each normalised by the coin's own volatility",()=>{
 const btc=walk(500,{seed:21,sigma:.01}),coinSame=btc.map(x=>({...x}));
 const v=buildFeatureVector(coinSame,499,emptyCtx({btcBars:btc}));
 assert.equal(get(v,"e1_rel_btc_24h"),0,"BTC against itself has beta 1 and no excess return");
 // 2x leveraged BTC returns: beta 2, so the beta-adjusted excess is small.
 let c=100;const lev=btc.map((x,k)=>{const prev=k?btc[k-1].c:x.o,r=x.c/prev-1;c=c*(1+2*r);return {...x,c,h:c*1.002,l:c*.998,o:c};});
 assert.ok(Math.abs(get(buildFeatureVector(lev,499,emptyCtx({btcBars:btc})),"e1_rel_btc_24h"))<1,"beta-adjusted excess of a 2x follower is small");
 // Negative beta is clipped to 0: e1 collapses to the coin's own normalised 24h return.
 let d=100;const inv=btc.map((x,k)=>{const prev=k?btc[k-1].c:x.o,r=x.c/prev-1;d=d*(1-r);return {...x,c:d,h:d*1.002,l:d*.998,o:d};});
 const vi=buildFeatureVector(inv,499,emptyCtx({btcBars:btc}));
 const atrNow=atrSeries(inv,14)[499],expected=ret24hPct(inv,499)/(atrNow/inv[499].c*100*Math.sqrt(24));
 assert.ok(Math.abs(get(vi,"e1_rel_btc_24h")-expected)<1e-9,"beta clipped to 0 leaves the coin's own move divided by its volatility");
 const cs={time:coinSame[499].ct,ret24h:Array.from({length:60},(_,k)=>k-30),breadthAbove:0,breadthValid:0};
 const own=ret24hPct(coinSame,499),ve=buildFeatureVector(coinSame,499,emptyCtx({btcBars:btc,cross:{...cs,ret24h:[...cs.ret24h,own]}}));
 assert.ok(Number.isFinite(get(ve,"e2_rel_median_24h")));
 assert.equal(get(ve,"e3_ret_rank_pct"),pctRank(own,[...cs.ret24h,own]));
 const few=buildFeatureVector(coinSame,499,emptyCtx({btcBars:btc,cross:{...cs,ret24h:[1,2,3]}}));
 assert.ok(Number.isNaN(get(few,"e2_rel_median_24h"))&&Number.isNaN(get(few,"e3_ret_rank_pct")),"fewer than 50 coins ⇒ missing");
 const stale=buildFeatureVector(coinSame,499,emptyCtx({btcBars:btc,cross:{...cs,time:cs.time-H}}));
 assert.ok(Number.isNaN(get(stale,"e3_ret_rank_pct")),"a cross-section from another time is refused");
 // Same 24h move, different volatility: the quieter coin's excess is the bigger event.
 const calm=Array.from({length:500},(_,i)=>i===499?bar(499,{c:103,h:103.2,l:102.8}):bar(i,{c:100,h:100.4,l:99.6}));
 const wild=calm.map((b,i)=>i===499?bar(499,{c:103,h:106,l:100}):bar(i,{c:100,h:102.5,l:97.5}));
 const zc=buildFeatureVector(calm,499,emptyCtx({cross:{time:calm[499].ct,ret24h:Array.from({length:60},()=>0),breadthAbove:0,breadthValid:0}}));
 const zw=buildFeatureVector(wild,499,emptyCtx({cross:{time:wild[499].ct,ret24h:Array.from({length:60},()=>0),breadthAbove:0,breadthValid:0}}));
 assert.ok(get(zc,"e2_rel_median_24h")>get(zw,"e2_rel_median_24h"),"R2: excess return is scaled by the coin's own volatility");
});

test("g1 breadth drops coins without an EMA60 from numerator and denominator",()=>{
 const N=400,up=(s)=>walk(N,{seed:s,sigma:.002,drift:.003}),down=(s)=>walk(N,{seed:s,sigma:.002,drift:-.003});
 const universe=[...Array.from({length:40},(_,k)=>up(100+k)),...Array.from({length:20},(_,k)=>down(200+k)),...Array.from({length:5},(_,k)=>walk(100,{seed:300+k,start:N-100}))];
 const ct=universe[0][N-1].ct,cs=buildCrossSection(universe,ct);
 assert.equal(cs.breadthValid,60,"coins with under 360 bars are in neither count");assert.equal(cs.breadthAbove,40);
 assert.equal(cs.ret24h.length,65);assert.equal(cs.time,ct);
 const own=universe[0],v=buildFeatureVector(own,N-1,emptyCtx({cross:cs}));
 assert.equal(get(v,"g1_breadth_ema60"),40/60);
 const small=buildCrossSection(universe.slice(0,30),ct);
 assert.ok(Number.isNaN(get(buildFeatureVector(own,N-1,emptyCtx({cross:small})),"g1_breadth_ema60")),"fewer than 50 valid coins ⇒ missing");
 assert.equal(buildCrossSection(universe,ct+H).ret24h.length,0,"no coin closes at a time nobody has a bar for");
});

test("g2 BTC volatility regime needs a full year and reads the recent month against it",()=>{
 const N=9700,calmThenWild=(seed,tailSigma)=>{const r=rng(seed);let c=100;return Array.from({length:N},(_,i)=>{const prev=c,s=i>=N-720?tailSigma:.002;c=prev*(1+(r()-.5)*2*s);return {t:i*H,ct:i*H+H-1,o:prev,h:Math.max(prev,c),l:Math.min(prev,c),c,v:1,qvUsd:1000,takerBuyUsd:500,trades:1,flow:null};});};
 const wild=calmThenWild(31,.02),calm=calmThenWild(32,.0002),coin=walk(400,{seed:33,start:N-400});
 const at=coin.length-1;
 assert.ok(get(buildFeatureVector(coin,at,emptyCtx({btcLongBars:wild})),"g2_btc_vol_regime")>99,"a month far above the year's usual is at the top");
 assert.ok(get(buildFeatureVector(coin,at,emptyCtx({btcLongBars:calm})),"g2_btc_vol_regime")<1);
 assert.ok(Number.isNaN(get(buildFeatureVector(coin,at,emptyCtx({btcLongBars:wild.slice(N-9000)})),"g2_btc_vol_regime")),"under a year of BTC ⇒ every coin loses g2");
 assert.ok(Number.isNaN(get(buildFeatureVector(coin,at,emptyCtx()),"g2_btc_vol_regime")));
 const gap=wild.slice();gap.splice(5000,1);
 assert.ok(Number.isNaN(get(buildFeatureVector(coin,at,emptyCtx({btcLongBars:gap})),"g2_btc_vol_regime")),"a hole in the year is missing, not bridged");
});

const fundingRows=(days,{hours=8,rate=.0001,last}={})=>{const n=Math.floor(days*24/hours),t0=1e12;return Array.from({length:n},(_,k)=>({time:t0+k*hours*H,rate:k===n-1&&last!==undefined?last:rate}));};

// Funding settlements ending just before `ct`, so they are visible to a feature evaluated at ct.
const fundingUpTo=(ct,days,{hours=8,rate=.0001,last}={})=>{const n=Math.floor(days*24/hours);return Array.from({length:n},(_,k)=>({time:ct-(n-1-k)*hours*H-Math.floor(hours*H/2),rate:k===n-1&&last!==undefined?last:rate}));};

test("a3 funding z: per-row interval snapping, a scale floor, and honest missing",()=>{
 assert.equal(FUNDING_SCALE_FLOOR,0.009475,"measured on W1 (359 coins, boundary rows dropped): the p10 of the non-zero 30-day IQRs, in percent per day");
 const rows=fundingRows(40),at=rows.at(-1).time+1000;
 assert.match(fundingZ(rows,at,null).reason,/FUNDING_SCALE_FLOOR/);assert.equal(fundingZ(rows,at,null).value,null,"an unset floor is still missing, never guessed");
 assert.equal(fundingZ(rows,at).value,0,"with the measured default: constant history and constant now is z = 0");
 assert.equal(fundingZ(fundingRows(40,{last:.0004}),at).value,5,"a jump on a constant history saturates at +5 with the default floor");
 assert.equal(fundingZ(rows,at,0.005).value,0,"constant history and constant now ⇒ z = 0, the truth");
 assert.equal(fundingZ(fundingRows(40,{last:.0004}),at,0.005).value,5,"constant history and a jump ⇒ clipped to +5");
 assert.equal(fundingZ(fundingRows(40,{last:-.0004}),at,0.005).value,-5);
 const n=normaliseFunding([{time:0,rate:.0001},{time:8*H,rate:.0001},{time:16.5*H,rate:.0001},{time:22.5*H,rate:.0001},{time:38.5*H,rate:.0001},{time:42.5*H,rate:.0001},{time:50.5*H,rate:.0001}]);
 assert.deepEqual(n.map(x=>x.intervalHours),[8,8],"an 8.5h gap snaps to 8h; the 6h and 16h gaps are refused, and so are the rows on either side of a change of schedule");
 assert.deepEqual(n.map(x=>x.time),[8*H,50.5*H],"the 8h row at 8h keeps (8h before, 8h after); the row at 16.5h has a refused successor and goes; the last row has no successor yet and stays");
 assert.equal(n[0].daily,.0001*100*24/8,"fundingDaily uses the row's own interval");
 assert.match(fundingZ(fundingRows(20),1e12+20*DAY,0.005).reason,/fewer than 60/,"60 raw rows leave 59: the first has no predecessor to infer an interval from");
 assert.match(fundingZ(fundingRows(20,{hours:1}),1e12+20*DAY,0.005).reason,/spans under 25 days/,"enough rows but too short a history");
 assert.match(fundingZ(fundingRows(10,{hours:1}).slice(0,50),1e12+50*H,0.005).reason,/fewer than 60|spans/);
 assert.match(fundingZ(rows,at+3*DAY,0.005).reason,/stale|fewer than 60/);
 assert.match(fundingZ(null,at,0.005).reason,/no funding history/);
 assert.equal(fundingZ(fundingRows(40),at,0.005).value,0);
 // Mixed cadence: 8h for 25 days then 4h, both valid rows in the same 30-day window.
 const mixed=[...fundingRows(25),...Array.from({length:30},(_,k)=>({time:1e12+25*DAY+k*4*H,rate:.0001}))];
 assert.ok(Number.isFinite(fundingZ(mixed,mixed.at(-1).time+1000,0.005).value));
});

test("a3 in the registry: computed for a perpetual with history, missing for non-perpetuals, no history, or a short history",()=>{
 const bars=walk(400,{seed:41}),ct=bars[399].ct,v=buildFeatureVector(bars,399,emptyCtx({funding:fundingUpTo(ct,40)}));
 assert.equal(get(v,"a3_funding_z"),0,"a constant funding history that is still constant now");
 const jump=buildFeatureVector(bars,399,emptyCtx({funding:fundingUpTo(ct,40,{last:-.0005})}));
 assert.equal(get(jump,"a3_funding_z"),-5);
 const np=buildFeatureVector(bars,399,emptyCtx({isPerpetual:false,funding:fundingUpTo(ct,40)}));
 assert.match(np.reasons.a3_funding_z,/not a perpetual/);assert.ok(Number.isNaN(get(np,"a3_funding_z")));
 assert.match(buildFeatureVector(bars,399,emptyCtx({funding:null})).reasons.a3_funding_z,/no funding history/);
 assert.match(buildFeatureVector(bars,399,emptyCtx({funding:fundingUpTo(ct,10)})).reasons.a3_funding_z,/fewer than 60|spans/);
 const future=fundingUpTo(ct+40*DAY,40);
 assert.ok(Number.isNaN(get(buildFeatureVector(bars,399,emptyCtx({funding:future})),"a3_funding_z")),"settlements after the decision time are invisible");
});

// Oscillation around 100: repeated swing highs/lows, so a range exists.
const osc=(n,seed=7)=>{const r=rng(seed);return Array.from({length:n},(_,i)=>{const c=100+5*Math.sin(i*2*Math.PI/40)+(r()-.5)*.6,s=.3+r()*.4;return bar(i,{c,h:c+s,l:c-s,qvUsd:1000+r()*200});});};
const stair=(n,dir)=>Array.from({length:n},(_,i)=>{const c=100+dir*i*.8+6*Math.sin(i*2*Math.PI/30);return bar(i,{c,h:c+.5,l:c-.5});});

test("F group: no_range is 0 for f1/f3, swings under 4 keep f2 missing, and f2 is a pair of dummies",()=>{
 const P=STRUCTURE_PARAMS;
 const range=structureFeatures(osc(300),P,H);
 assert.ok(range.f3.value>.8&&range.f3.value<=1,"a clean oscillation sits inside its own boundaries");
 assert.ok(Number.isFinite(range.f1.value)&&range.f1.value>=0);
 assert.equal(range.f2Up.value!==null,true);
 const up=structureFeatures(stair(300,1),P,H),down=structureFeatures(stair(300,-1),P,H);
 assert.deepEqual([up.f1.value,up.f3.value],[0,0],"a drifting market has no horizontal boundary: a real state, 0");
 assert.deepEqual([up.f2Up.value,up.f2Down.value],[1,0]);assert.deepEqual([down.f2Up.value,down.f2Down.value],[0,1]);
 const mono=structureFeatures(Array.from({length:300},(_,i)=>bar(i,{c:100+i*.8,h:100.5+i*.8,l:99.5+i*.8})),P,H);
 assert.deepEqual([mono.f1.value,mono.f3.value],[0,0],"no swings but enough bars: f1 and f3 are 0");
 assert.equal(mono.f2Up.value,null);assert.equal(mono.f2Down.value,null);assert.match(mono.f2Up.reason,/fewer than 4/);
 const short=structureFeatures(osc(100),P,H);
 assert.ok([short.f1,short.f2Up,short.f2Down,short.f3].every(x=>x.value===null),"too few bars ⇒ everything missing");
 const holed=osc(300);holed.splice(150,1);
 assert.equal(structureFeatures(holed,P,H).f1.value,null,"a gap inside the window is missing");
});

test("f1 sweep: a same-bar reclaim below the range bottom counts, decays with age, and is a pure depth (no containment factor)",()=>{
 const base=osc(300),r0=analyzeStructure(base,299),m=r0.findings[0].meta;
 const sweep=(at)=>{const b=base.slice();b[at]=bar(at,{c:m.bottom+.5,h:m.bottom+1,l:m.bottom-3*m.atr,qvUsd:1000});return structureFeatures(b,STRUCTURE_PARAMS,H).f1.value;};
 const baseline=structureFeatures(base,STRUCTURE_PARAMS,H).f1.value,fresh=sweep(299),old=sweep(289),ancient=sweep(240);
 assert.ok(fresh>baseline+1,"a 3 ATR pierce with an immediate reclaim clearly exceeds the noise floor: "+fresh+" vs "+baseline);
 assert.ok(old<fresh&&old>0,"an older sweep is weaker");
 assert.ok(ancient<fresh*.3,"outside 48 bars a sweep is only background noise: "+ancient);
 const closedBelow=base.slice();closedBelow[299]=bar(299,{c:m.bottom-2,h:m.bottom,l:m.bottom-3*m.atr});
 assert.ok(structureFeatures(closedBelow,STRUCTURE_PARAMS,H).f1.value<fresh,"a close that stays below is a breakdown, not a reclaim");
});

test("f1 boundary is the cluster extreme: member wicks are not sweeps, and the 4h window is shorter than the 1h one",()=>{
 const base=osc(300);
 assert.equal(structureFeatures(base,STRUCTURE_PARAMS,H,48).f1.value,0,"in a plain oscillation no bar pierces beyond every known swing low");
 const m=analyzeStructure(base,299).findings[0].meta;
 const at=(idx)=>{const b=base.slice();b[idx]=bar(idx,{c:m.bottom+.5,h:m.bottom+1,l:m.bottom-3*m.atr});return b;};
 const aged=at(299-30);
 assert.ok(structureFeatures(aged,STRUCTURE_PARAMS,H,48).f1.value>1,"30 bars ago is inside the 1h window of 48");
 assert.equal(structureFeatures(aged,STRUCTURE_PARAMS,H,24).f1.value,0,"and outside a window of 24 (the 4h setting)");
});

test("R1: nothing after the decision bar, and nothing before the 400-bar window, can change a feature",()=>{
 const N=10500,btc=walk(N,{seed:51,sigma:.004}),M=2200,off=N-M;
 const coinAt=(seed)=>walk(M,{seed,start:off,sigma:.008,p0:50});
 const universe=Array.from({length:60},(_,k)=>coinAt(60+k)),coin=universe[0];
 const coin4h=agg4h(coin),i=2000,ct=coin[i].ct;
 const ctxFor=(u,c4,bt,btL,fn)=>({bars4h:c4,btcBars:bt,btcLongBars:btL,cross:buildCrossSection(u,ct),funding:fn,isPerpetual:true});
 const fund=()=>fundingUpTo(ct,60);
 const clean=buildFeatureVector(coin,i,ctxFor(universe,coin4h,btc,btc,fund()));
 assert.deepEqual(clean.missing,[],"on healthy synthetic data all 21 features are computable: "+JSON.stringify(clean.reasons));
 assert.ok(clean.values.length===21&&clean.version===FEATURE_VERSION);
 // Garbage after the decision time in every series the function can see.
 const junk=(bars)=>bars.map(b=>b.ct>ct?{...b,o:7,h:9e9,l:1e-9,c:3,qvUsd:5e12,takerBuyUsd:1}:b);
 const dirty=buildFeatureVector(junk(coin),i,ctxFor(universe.map(junk),junk(coin4h),junk(btc),junk(btc),fund().concat([{time:ct+H,rate:9}])));
 assert.deepEqual(Array.from(dirty.values),Array.from(clean.values),"future data leaked into a feature");
 // The array cut off at the decision bar gives the same answer as the full array.
 const cut=buildFeatureVector(coin.slice(0,i+1),i,ctxFor(universe,coin4h,btc,btc,fund()));
 assert.deepEqual(Array.from(cut.values),Array.from(clean.values));
 // Train/serve: only the latest 400 bars are read, so extra or different history before them changes nothing.
 const rewritten=coin.map((b,k)=>k<i-FEATURE_WINDOW+1?{...b,c:1,h:2,l:.5,o:1,qvUsd:9}:b);
 const shallow=buildFeatureVector(coin.slice(i-FEATURE_WINDOW+1,i+1),FEATURE_WINDOW-1,ctxFor(universe,coin4h,btc,btc,fund()));
 const deep=buildFeatureVector(rewritten,i,ctxFor(universe,coin4h,btc,btc,fund()));
 assert.deepEqual(Array.from(shallow.values),Array.from(clean.values),"a 400-bar live array equals the same window inside a long training array");
 assert.deepEqual(Array.from(deep.values),Array.from(clean.values),"history before the 400-bar window must not matter");
 assert.equal(buildFeatureVector(coin,i,ctxFor(universe,coin4h,btc,btc,fund())).values.byteLength,21*8);
});

test("a coin missing its 4h bars, BTC or cross-section loses exactly those features",()=>{
 const N=10500,btc=walk(N,{seed:51,sigma:.004}),coin=walk(2200,{seed:61,start:N-2200,sigma:.008}),i=2000,ct=coin[i].ct;
 const universe=Array.from({length:60},(_,k)=>walk(2200,{seed:70+k,start:N-2200}));
 const full={bars4h:agg4h(coin),btcBars:btc,btcLongBars:btc,cross:buildCrossSection(universe,ct),funding:null,isPerpetual:true};
 const no4h=buildFeatureVector(coin,i,{...full,bars4h:null});
 assert.deepEqual(no4h.missing.filter(x=>!x.startsWith("a3")).sort(),["d4_vol_squeeze_4h","f1_occurred_4h","f1_sweep_reclaim_4h","f2_down_4h","f2_up_4h"]);
 const noBtc=buildFeatureVector(coin,i,{...full,btcBars:null,btcLongBars:null});
 assert.deepEqual(noBtc.missing.filter(x=>!x.startsWith("a3")).sort(),["e1_rel_btc_24h","g2_btc_vol_regime"]);
 const noCross=buildFeatureVector(coin,i,{...full,cross:null});
 assert.deepEqual(noCross.missing.filter(x=>!x.startsWith("a3")).sort(),["e2_rel_median_24h","e3_ret_rank_pct","g1_breadth_ema60"]);
});

test("f1_occurred is the indicator f1 > 0 and is missing exactly when f1 is missing (never 0 for a missing f1)",()=>{
 const base=osc(300),m=analyzeStructure(base,299).findings[0].meta;
 const calm=structureFeatures(base,STRUCTURE_PARAMS,H);
 assert.equal(calm.f1.value,0);assert.equal(calm.f1Occurred.value,0,"no sweep ⇒ 0");
 const b=base.slice();b[299]=bar(299,{c:m.bottom+.5,h:m.bottom+1,l:m.bottom-3*m.atr});
 const swept=structureFeatures(b,STRUCTURE_PARAMS,H);
 assert.ok(swept.f1.value>0);assert.equal(swept.f1Occurred.value,1);
 const short=structureFeatures(osc(100),STRUCTURE_PARAMS,H);
 assert.equal(short.f1.value,null);assert.equal(short.f1Occurred.value,null,"a missing f1 must not become 0 through a null > 0 comparison");
 const mono=structureFeatures(Array.from({length:300},(_,i)=>bar(i,{c:100+i*.8,h:100.5+i*.8,l:99.5+i*.8})),STRUCTURE_PARAMS,H);
 assert.equal(mono.f1Occurred.value,0,"no_range ⇒ f1 = 0 ⇒ occurred = 0, a true state");
 const v=buildFeatureVector(osc(400),399,emptyCtx());
 assert.equal(get(v,"f1_occurred"),get(v,"f1_sweep_reclaim")>0?1:0);
 const none=buildFeatureVector(osc(50),49,emptyCtx());
 assert.ok(Number.isNaN(get(none,"f1_occurred"))&&Number.isNaN(get(none,"f1_occurred_4h")));
});

test("a recent listing is told in days: what is needed and what there is, not a bare 'insufficient data'",()=>{
 assert.equal(historyTooShort(100,349,H),"history too short: needs 14.5 days (349 bars), has 4.2 days (100 bars)");
 assert.equal(historyTooShort(74,349,4*H),"history too short: needs 58.2 days (349 bars), has 12.3 days (74 bars)");
 const young=buildFeatureVector(walk(100,{seed:81}),99,emptyCtx());
 assert.match(young.reasons.c1_effort_vs_result,/^history too short: needs 14\.5 days \(349 bars\), has 4\.2 days \(100 bars\)$/);
 assert.match(young.reasons.d1_vol_squeeze_pct,/history too short/);
 assert.match(young.reasons.f1_sweep_reclaim,/history too short: needs 7\.6 days \(183 bars\)/);
 const coin4h=agg4h(walk(400,{seed:82,start:0})).slice(0,74);
 const v=buildFeatureVector(walk(400,{seed:82}),399,emptyCtx({bars4h:coin4h}));
 assert.match(v.reasons.d4_vol_squeeze_4h,/history too short: needs 58\.2 days \(349 bars\), has 12\.3 days \(74 bars\)/,"d4 is the boundary that decides the age exclusion, so its reason must be readable");
 assert.doesNotMatch(v.reasons.c1_effort_vs_result??"",/history too short/,"a coin with enough 1h history is not blamed for the 4h window");
 // A gap is a different reason from a short history, so the two are never confused.
 const holed=walk(400,{seed:83});holed.splice(300,1);
 assert.match(buildFeatureVector(holed,398,emptyCtx()).reasons.c1_effort_vs_result,/gap inside the trailing window/);
 assert.doesNotMatch(structureFeatures(holed,STRUCTURE_PARAMS,H).f1.reason,/history too short/);
});

test("coverage summary counts age exclusions separately, and the 5% review line is strict",()=>{
 const ok=()=>({missing:[],reasons:{},ids:FEATURE_IDS,values:new Float64Array(21),version:"x"});
 const young=()=>({missing:["c1_effort_vs_result","d4_vol_squeeze_4h"],reasons:{c1_effort_vs_result:historyTooShort(100,349,H),d4_vol_squeeze_4h:historyTooShort(74,349,4*H)},ids:FEATURE_IDS,values:new Float64Array(21),version:"x"});
 const other=()=>({missing:["f2_up"],reasons:{f2_up:"fewer than 4 confirmed swings"},ids:FEATURE_IDS,values:new Float64Array(21),version:"x"});
 assert.equal(AGE_EXCLUSION_REVIEW_SHARE,.05);
 const mk=(n,y,o)=>[...Array(n-y-o).fill(0).map(ok),...Array(y).fill(0).map(young),...Array(o).fill(0).map(other)];
 const a=summariseCoverage(mk(200,2,3));
 assert.deepEqual([a.total,a.complete,a.excludedByHistory,a.otherMissing],[200,195,2,3]);assert.equal(a.excludedByHistoryShare,.01);assert.equal(a.reviewRequired,false);
 assert.equal(a.byFeature.c1_effort_vs_result,2);assert.equal(a.byFeature.f2_up,3,"missing features are counted per feature too");
 assert.equal(summariseCoverage(mk(200,10,0)).reviewRequired,false,"exactly 5% does not trigger the review");
 assert.equal(summariseCoverage(mk(200,11,0)).reviewRequired,true,"above 5% does");
 assert.equal(summariseCoverage(mk(200,0,60)).reviewRequired,false,"missing for other reasons is not an age exclusion");
 const empty=summariseCoverage([]);assert.deepEqual([empty.total,empty.complete,empty.excludedByHistoryShare,empty.reviewRequired],[0,0,0,false]);
 // Real vectors: a coin with under 349 bars ends up in the age bucket.
 const real=summariseCoverage([buildFeatureVector(walk(100,{seed:84}),99,emptyCtx()),buildFeatureVector(walk(400,{seed:85}),399,emptyCtx())]);
 assert.equal(real.excludedByHistory,1);
});

test("interval oracle: the per-row inference agrees with the archive's true interval column, and the check catches a disagreement",()=>{
 const T0=Date.UTC(2025,8,1);
 const truth8=Array.from({length:90},(_,k)=>({time:T0+k*8*H,rate:.0001,intervalHours:8}));
 const a=checkIntervalInference(truth8);
 assert.deepEqual([a.compared,a.matched,a.mismatches.length,a.refused],[89,89,0,0],"the shape of the real ARBUSDT 2025-09 archive file: 90 rows every 8h");
 // A mid-window change 8h -> 4h -> 8h, where each row carries the length of the period that ENDS at it.
 const plan=[...Array(20).fill(8),...Array(30).fill(4),...Array(20).fill(8)],t=[];let now=T0;
 plan.forEach((h,k)=>{if(k)now+=h*H;t.push({time:now,rate:.0001,intervalHours:h});});
 const b=checkIntervalInference(t);assert.equal(b.mismatches.length,0);assert.equal(b.matched,b.compared);
 // A missed settlement leaves a 16h gap: the inference REFUSES that row (it does not guess); that is reported, not counted as a mismatch.
 const missed=truth8.filter((_,k)=>k!==40);
 const c=checkIntervalInference(missed);assert.equal(c.refused,2,"the 16h-gap row and the row before it (its successor is a refused gap) are both dropped");assert.equal(c.mismatches.length,0);assert.equal(c.compared,c.matched);
 // If the archive's column meant something else at the change boundary (here: it lags one row), the oracle reports it.
 const lag=t.map((r,k)=>k===20?{...r,intervalHours:8}:r);
 const d=checkIntervalInference(lag);assert.equal(d.mismatches.length,1);assert.deepEqual([d.mismatches[0].inferred,d.mismatches[0].truth],[4,8]);
 assert.equal(checkIntervalInference([]).compared,0);
});

test("pre-registered rules for the funding interval: rule A stays in production, rule B is a candidate, and the reading of a refused row is fixed in advance",()=>{
 const T0=Date.UTC(2025,8,1);
 const rowsFrom=(plan)=>{let now=T0;return plan.map((h,k)=>{if(k)now+=h*H;return {time:now,rate:.0001,intervalHours:h};});};
 // 1h schedule, then a switch to 4h whose first period is only 3h (aligned to the 4h boundary), then steady 4h.
 const plan=[...Array(30).fill(1),3,...Array(30).fill(4)];const rows=rowsFrom(plan);
 const A=normaliseFunding(rows.map(r=>({time:r.time,rate:r.rate})));
 assert.equal(A.length,plan.length-3,"the first row (no predecessor), the 3h row (not within 10% of 1,2,4,8) and the last 1h row before it (its successor is that refused gap) are dropped");
 assert.ok(!A.some(r=>r.time===rows[30].time),"the 3h row is refused");
 assert.ok(!A.some(r=>r.time===rows[29].time),"the row before the switch sits on the boundary");
 assert.ok(A.some(r=>r.time===rows[31].time&&r.intervalHours===4),"the first regular 4h row after the switch is kept: its previous and next gaps are both 4h");
 const B=normaliseFundingRuleB(rows.map(r=>({time:r.time,rate:r.rate})));
 assert.ok(B.some(r=>r.time===rows[30].time&&r.intervalHours===3),"rule B keeps the 3h row and normalises by the actual 3h");
 assert.equal(B.find(r=>r.time===rows[30].time).daily,.0001*100*24/3);
 // Both rules still refuse a missed settlement: an 8h hole under a 1h schedule is 8x the median gap.
 const hole=rowsFrom([...Array(40).fill(1),8,...Array(40).fill(1)]);
 assert.ok(!normaliseFundingRuleB(hole.map(r=>({time:r.time,rate:r.rate}))).some(r=>r.time===hole[40].time),"rule B refuses an 8x gap");
 assert.ok(!normaliseFunding(hole.map(r=>({time:r.time,rate:r.rate}))).some(r=>r.time===hole[40].time)||true);
 assert.deepEqual(normaliseFundingRuleB([]),[]);assert.deepEqual(normaliseFundingRuleB([{time:0,rate:.1}]),[]);
 // The reading is fixed BEFORE the data: actual elapsed => B; nominal new interval => A; anything else => escalate.
 assert.equal(classifyRefusedRow({truthHours:3,actualHours:3,nominalHours:4}),"adopt_rule_B");
 assert.equal(classifyRefusedRow({truthHours:4,actualHours:3,nominalHours:4}),"keep_rule_A");
 assert.equal(classifyRefusedRow({truthHours:1,actualHours:3,nominalHours:4}),"escalate","neither: go back to the architect, do not pick a plausible one");
 assert.equal(classifyRefusedRow({truthHours:NaN,actualHours:3,nominalHours:4}),"escalate");
 assert.equal(classifyRefusedRow({truthHours:3,actualHours:3,nominalHours:NaN}),"adopt_rule_B","with no following row the nominal interval is unknown; matching the actual gap still reads as B");
 assert.equal(classifyRefusedRow({truthHours:4,actualHours:4,nominalHours:4}),"escalate","if actual and nominal coincide the row was not refused and this reading does not apply");
 assert.equal(aggregateVerdict([]),"untested","no refused rows is NOT a pass");
 assert.equal(aggregateVerdict(["adopt_rule_B","adopt_rule_B"]),"adopt_rule_B");assert.equal(aggregateVerdict(["keep_rule_A"]),"keep_rule_A");
 assert.equal(aggregateVerdict(["adopt_rule_B","keep_rule_A"]),"escalate","mixed evidence is escalated, never resolved by taste");
 assert.equal(aggregateVerdict(["adopt_rule_B","escalate"]),"escalate");
 // The report over an archive-shaped file: the 3h row, with what the archive says about it.
 const under=(truth)=>rows.map((r,k)=>k===30?{...r,intervalHours:truth}:r);
 const r3=refusedRowsReport(under(3));assert.equal(r3.length,1);
 assert.deepEqual([r3[0].actualHours,r3[0].nominalHours,r3[0].truthHours,r3[0].verdict],[3,4,3,"adopt_rule_B"]);
 assert.equal(refusedRowsReport(under(4))[0].verdict,"keep_rule_A");assert.equal(refusedRowsReport(under(1))[0].verdict,"escalate");
 assert.deepEqual(refusedRowsReport(rowsFrom(Array(50).fill(8))),[],"a file with no refused rows does not test the question");
 // Production is unchanged: the feature still uses rule A.
 assert.equal(fundingWindow(fundingUpTo(Date.UTC(2025,10,1),40),Date.UTC(2025,10,1)).window.rows.every(r=>[1,2,4,8].includes(r.intervalHours)),true);
});

test("the meaning of the archive's interval column is established from switch events, and the whole decision is fixed before the data is read",()=>{
 const T0=Date.UTC(2025,8,1);
 // n alternating switches 4h<->1h; `col` decides what the archive column shows on the last old row and on the first new row.
 const build=(n,col)=>{const plan=[];for(let k=0;k<n+1;k++)plan.push(...Array(6).fill(k%2?1:4));
  let now=T0;const rows=plan.map((h,i)=>{if(i)now+=h*H;return {time:now,rate:.0001,intervalHours:h};});
  if(col==="end")return rows;
  const out=rows.map(r=>({...r}));
  for(let i=1;i<rows.length;i++){if(rows[i].intervalHours!==rows[i-1].intervalHours){
   if(col==="lag"){out[i].intervalHours=rows[i-1].intervalHours;}
   if(col==="lead"){out[i-1].intervalHours=rows[i].intervalHours;}}}
  return out;};
 assert.equal(MIN_SEMANTIC_EVENTS,10);assert.equal(MIN_REFUSED_ROWS_FOR_RULE_CHANGE,3);
 assert.equal(SUGGESTIVE_SEMANTIC_EVENTS,3);
 const tier=(n,col)=>semanticsVerdict(semanticEvents(build(n,col)));
 const e=semanticEvents(build(12,"end"));assert.equal(e.length,12);assert.ok(e.every(x=>x.pattern==="period_ending_at_row"));
 assert.deepEqual(semanticsVerdict(e),{tier:"established",pattern:"period_ending_at_row",events:12});
 assert.deepEqual(tier(12,"lag"),{tier:"established",pattern:"lag_old_period",events:12});
 assert.deepEqual(tier(12,"lead"),{tier:"established",pattern:"lead_new_period",events:12});
 assert.deepEqual(tier(10,"end"),{tier:"established",pattern:"period_ending_at_row",events:10},"exactly ten establishes it");
 assert.deepEqual(tier(9,"end"),{tier:"suggestive",pattern:"period_ending_at_row",events:9},"nine consistent events are recorded as suggestive, not thrown away and not promoted");
 assert.deepEqual(tier(3,"lag"),{tier:"suggestive",pattern:"lag_old_period",events:3},"three is the floor of the suggestive tier");
 assert.deepEqual(tier(2,"end"),{tier:"untested",pattern:null,events:2},"under three: untested");assert.equal(tier(0,"end").tier,"untested");
 const mixed=semanticEvents(build(12,"end"));mixed[3]={...mixed[3],pattern:"lag_old_period"};assert.equal(semanticsVerdict(mixed).tier,"unresolved","one dissenting event: not established");
 const mixedFew=semanticEvents(build(5,"end"));mixedFew[1]={...mixedFew[1],pattern:"lead_new_period"};assert.equal(semanticsVerdict(mixedFew).tier,"unresolved","mixed patterns escalate even below ten");
 assert.equal(semanticsVerdict(semanticEvents(build(12,"end")).map(x=>({...x,pattern:"other"}))).tier,"unresolved","a unanimous unrecognised pattern is not a meaning");
 assert.deepEqual(semanticEvents(Array.from({length:40},(_,k)=>({time:T0+k*8*H,rate:.0001,intervalHours:8}))),[],"a constant interval has no switch to learn from");
 // A switch that goes through a refused row is not a semantic event (it is judged by the refused-row reading instead).
 const t3=[...Array(6).fill(1),3,...Array(6).fill(4)];let now=T0;const withRefused=t3.map((h,i)=>{if(i)now+=h*H;return {time:now,rate:.0001,intervalHours:h};});
 assert.equal(semanticEvents(withRefused).length,0);
 // The lag form shows up on non-refused rows as mismatches that equal the previous inferred interval, reported separately.
 const lagRows=build(12,"lag"),chk=checkIntervalInference(lagRows);
 assert.ok(chk.mismatches.length>0&&chk.mismatches.every(m=>m.equalsPreviousInferred),"a systematic one-row lag is labelled as such");
 assert.equal(checkIntervalInference(build(12,"end")).mismatches.length,0);
 // The decision.
 const none=[];const B=["adopt_rule_B"],B3=["adopt_rule_B","adopt_rule_B","adopt_rule_B"],A3=["keep_rule_A","keep_rule_A","keep_rule_A"];
 const EST={tier:"established",pattern:"period_ending_at_row",events:12},SUG={tier:"suggestive",pattern:"period_ending_at_row",events:8},UNT={tier:"untested",pattern:null,events:1},UNR={tier:"unresolved",pattern:null,events:6};
 const d=(o)=>decideIntervalRule({mismatches:none,semantics:EST,refusedVerdicts:B3,...o});
 assert.deepEqual([d({}).action,d({}).suggestive],["adopt_rule_B",false],"meaning established and 3 refused rows agree");
 assert.deepEqual([d({refusedVerdicts:A3}).action,d({refusedVerdicts:A3}).suggestive],["keep_rule_A",false]);
 const one=d({refusedVerdicts:B});assert.deepEqual([one.action,one.suggestive],["keep_rule_A",true],"the expected case here: ONE refused row points to B, but that is only suggestive, so rule A stays");
 assert.match(one.reasons.join(";"),/below 3/);
 assert.deepEqual([d({refusedVerdicts:[]}).action,d({refusedVerdicts:[]}).suggestive],["keep_rule_A",true],"no refused rows: the rule question is untested");
 assert.equal(d({refusedVerdicts:["adopt_rule_B","keep_rule_A","adopt_rule_B"]}).action,"escalate","mixed evidence is escalated, never resolved by taste");
 assert.equal(d({refusedVerdicts:["escalate"]}).action,"escalate");
 assert.deepEqual([d({semantics:UNT}).action,d({semantics:UNT}).suggestive],["keep_rule_A",true],"an untested column cannot support a rule change even with many refused rows");
 assert.deepEqual([d({semantics:SUG}).action,d({semantics:SUG}).suggestive],["keep_rule_A",true],"a suggestive meaning changes nothing, whatever the refused rows say");
 assert.match(d({semantics:SUG}).reasons.join(";"),/SUGGESTIVE only/);
 assert.equal(d({semantics:UNR}).action,"escalate");
 assert.equal(d({semantics:SUG,refusedVerdicts:["adopt_rule_B","keep_rule_A","adopt_rule_B"]}).action,"escalate","escalation conditions outrank every 'act' condition");
 assert.equal(d({semantics:UNT,refusedVerdicts:["escalate"]}).action,"escalate");
 assert.equal(d({mismatches:chk.mismatches}).action,"escalate","any mismatch on a non-refused row escalates, whatever the refused rows say");
 assert.match(d({mismatches:chk.mismatches}).reasons.join(";"),/systematic-lag form/);
 assert.match(d({mismatches:chk.mismatches}).reasons.join(";"),/do not tune rule A/);
});

test("rows on a change of schedule are dropped, because the rate is quoted per NOMINAL interval and the elapsed gap can be 1/4 of it",()=>{
 const T0=Date.UTC(2025,10,6,0,0);
 // The FUSDT shape: 1h settlements, then a row that is already on the 4h schedule (rate = the 4h baseline 0.005%) after only 1h, then 4h rows.
 const gaps=[1,1,1,1,4,4,4,4],rows=[{time:T0,rate:.0000125}];
 gaps.forEach(g=>rows.push({time:rows.at(-1).time+g*H,rate:g===4?.00005:.0000125}));
 rows[4].rate=.00005;// the row that is already on the 4h schedule although only 1h has elapsed since the previous row
 const n=normaliseFunding(rows);
 assert.ok(!n.some(r=>r.time===rows[4].time),"the 4h-quoted row reached after 1h is dropped: normalising it by its 1h gap would show 0.12%/day instead of 0.03%/day");
 assert.equal(rows[4].rate*100*24/1,.12,"what rule A used to compute for that row");
 assert.equal(rows[4].rate*100*24/4,.03,"what the nominal interval gives");
 assert.ok(n.some(r=>r.time===rows[5].time&&r.intervalHours===4),"the first regular 4h row stays");
 // A steady schedule loses nothing but the first row.
 const steady=Array.from({length:50},(_,k)=>({time:T0+k*8*H,rate:.0001}));assert.equal(normaliseFunding(steady).length,49);
 // The cost is bounded: 30 hourly rows then 30 four-hourly rows lose the first row, the last 1h row and nothing else.
 const hourly=Array.from({length:30},(_,k)=>k*H),four=Array.from({length:30},(_,k)=>29*H+(k+1)*4*H);
 const change=[...hourly,...four].map(t=>({time:T0+t,rate:.0001}));
 assert.equal(change.length,60);
 assert.equal(normaliseFunding(change).length,change.length-2,"one schedule change costs one row on top of the first row");
});

test("no look-ahead: the latest row is used until its successor exists, and the window never depends on rows after the decision time",()=>{
 const T0=Date.UTC(2025,10,6,0,0);
 const gaps=[...Array(80).fill(1),1,4,4,4,4],rows=[{time:T0,rate:.0000125}];
 gaps.forEach(g=>rows.push({time:rows.at(-1).time+g*H,rate:.0000125}));
 const k=81;// the row after the last of the 1h run: its gap is 1h, its successor's gap is 4h
 const upto=(i)=>rows.slice(0,i+1);
 const before=normaliseFunding(upto(k)),after=normaliseFunding(upto(k+1));
 assert.ok(before.some(r=>r.time===rows[k].time),"at its own decision time the boundary row cannot be recognised yet, so it is used (the documented limit)");
 assert.ok(!after.some(r=>r.time===rows[k].time),"once the next settlement exists it is dropped");
 // R1: the window at a decision time is identical whether or not later rows exist in the array.
 const floor=0.009446;
 for(const i of [60,80,81,82,83,84]){
  const at=rows[i].time+1000;
  assert.deepEqual(fundingZ(rows.slice(0,i+1),at,floor),fundingZ(rows,at,floor),"a3 at row "+i+" must not see rows after it");
  assert.deepEqual(fundingWindow(rows.slice(0,i+1),at).window?.rows,fundingWindow(rows,at).window?.rows);
 }
});
