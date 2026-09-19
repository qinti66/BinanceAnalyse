import {computeEarlySignal,type EarlySignalInputs,type RatioPoint} from "./earlySignal.ts";
export const INDICATOR_RULE="indicators-v1";
export const HOUR=3600000;
export interface RawContract {
 contract:{family:"UM"|"CM";symbol:string;pair:string;baseAsset:string;quoteAsset:string;contractType:string;contractSize?:number;onboardDate:number};
 history:Record<string,unknown>[]|null;klines:unknown[][]|null;
 openInterest:Record<string,unknown>|null;ticker:Record<string,unknown>|null;premium:Record<string,unknown>|null;
 funding:Record<string,unknown>|null;fundingEndpointAvailable:boolean;book:Record<string,unknown>|null;quoteUsd:number|null;receivedAt:string;
 // 早期信号体系新增：顶级账户与全市场账户多空比历史（/futures/data/ 系列，免鉴权）；缺失时早期信号相关字段保持缺失，不按0填充。
 topAccountRatio?:Record<string,unknown>[]|null;topPositionRatio?:Record<string,unknown>[]|null;globalAccountRatio?:Record<string,unknown>[]|null;
}
export interface RawSnapshot {
 id:string;startedAt:string;completedAt:string;cutoff:number;contracts:RawContract[];
 excluded:{family:string;symbol:string;reason:string}[];marketCaps:Record<string,unknown>[];
 errors:{url:string;error:string}[];coverage:{um:number;cm:number;allListed:number;allTrading:number};fxNote:string;
 spotPrices?:Record<string,{priceUsd:number;time:number;symbol:string}>;
}
export const number=(v:unknown):number|null=>v===null||v===undefined||v===""?null:Number.isFinite(Number(v))?Number(v):null;
const positive=(v:unknown)=>{const n=number(v);return n!==null&&n>0?n:null;};
const round=(v:number|null,n=4)=>v===null?null:Math.round(v*10**n)/10**n;
const change=(a:number|null,b:number|null)=>a!==null&&b!==null&&b>0?(a/b-1)*100:null;
export function tokenIdentity(base:string){const m=base.match(/^(1000000|1000|1M)([A-Z][A-Z0-9]*)$/);return {token:m?m[2]:base,multiplier:m?(m[1]==="1M"?1e6:Number(m[1])):1};}
export function ema(values:number[],period:number){if(values.length<period)return null;let e=values.slice(0,period).reduce((a,b)=>a+b,0)/period;for(const v of values.slice(period))e+=2/(period+1)*(v-e);return e;}
export function rsi(values:number[],period=14){
 if(values.length<=period)return null;let gain=0,loss=0;
 for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gain+=Math.max(0,d)/period;loss+=Math.max(0,-d)/period;}
 for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];gain=(gain*(period-1)+Math.max(0,d))/period;loss=(loss*(period-1)+Math.max(0,-d))/period;}
 return loss===0?(gain===0?50:100):100-100/(1+gain/loss);
}
export function candleFlow(k:unknown[],family:"UM"|"CM",quoteUsd:number|null,contractSize:number|null){
 const total=family==="UM"?number(k[7]):number(k[5]),buy=family==="UM"?number(k[10]):number(k[9]);
 const fx=family==="UM"?quoteUsd:contractSize;
 if(total===null||buy===null||fx===null||fx<=0||total<0||buy<0||buy>total*1.000001)return null;
 return {inflow:buy*fx,outflow:Math.max(0,total-buy)*fx,net:(2*buy-total)*fx,total:total*fx};
}
function contractMetrics(raw:RawContract,cutoff:number,spotPrices:RawSnapshot["spotPrices"]){
 const c=raw.contract,{token,multiplier}=tokenIdentity(c.baseAsset),fx=positive(raw.quoteUsd);
 const history=(raw.history??[]).filter(h=>number(h.timestamp)!==null&&Number(h.timestamp)<=cutoff).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp));
 const exact=(t:number)=>history.find(h=>Number(h.timestamp)===t);
 const qty=(h:Record<string,unknown>|undefined)=>h?number(h.sumOpenInterest):null;
 const val=(h:Record<string,unknown>|undefined)=>!h?null:c.family==="CM"?(qty(h)!==null&&positive(c.contractSize)?Number(qty(h))*Number(c.contractSize):null):(number(h.sumOpenInterestValue)!==null&&fx!==null?Number(h.sumOpenInterestValue)*fx:null);
 const point=exact(cutoff),q=qty(point),value=val(point);
 const k=(raw.klines??[]).filter(k=>Number(k[6])<cutoff&&Number(k[6])>=Number(k[0])&&positive(k[4])!==null).sort((a,b)=>Number(a[0])-Number(b[0]));
 const contiguous=k.length>0&&Number(k.at(-1)?.[6])===cutoff-1&&k.every((x,i)=>i===0||Number(x[0])-Number(k[i-1][0])===HOUR);
 const close=k.map(x=>Number(x[4])),last=close.at(-1)??null;
 const price=(hours:number)=>contiguous?change(last,close.at(-hours-1)??null):null;
 const flow=(hours:number)=>{
   if(!contiguous||k.length<hours)return null;
   const flows=k.slice(-hours).map(x=>candleFlow(x,c.family,fx,positive(c.contractSize)));
   if(flows.some(x=>x===null))return null;
   return flows.reduce<{inflow:number;outflow:number;net:number;total:number}>((a,b)=>({inflow:a.inflow+b!.inflow,outflow:a.outflow+b!.outflow,net:a.net+b!.net,total:a.total+b!.total}),{inflow:0,outflow:0,net:0,total:0});
 };
 const flows={h1:flow(1),h4:flow(4),h24:flow(24)};
 const last4=flows.h4?.total??null;
 const prev24=contiguous&&k.length>=28?k.slice(-28,-4).map(x=>candleFlow(x,c.family,fx,positive(c.contractSize))):[];
 const baseline=prev24.length===24&&prev24.every(Boolean)?prev24.reduce((s,x)=>s+x!.total,0)/6:null;
 const volumeRatio=last4!==null&&baseline!==null&&baseline>0?last4/baseline:null;
 const e20=contiguous?ema(close,20):null,e60=contiguous?ema(close,60):null;
 const trs=k.map((x,i)=>Math.max(Number(x[2])-Number(x[3]),i?Math.abs(Number(x[2])-close[i-1]):0,i?Math.abs(Number(x[3])-close[i-1]):0));
 const atr=contiguous&&trs.length>=14&&last?trs.slice(-14).reduce((a,b)=>a+b,0)/14/last*100:null;
 const fundingRate=c.contractType==="PERPETUAL"?number(raw.premium?.lastFundingRate):null;
 // Only assume standard 8h if the adjustment endpoint succeeded.
 const fundingHours=c.contractType==="PERPETUAL"&&raw.fundingEndpointAvailable?(positive(raw.funding?.fundingIntervalHours)??8):null;
 const fundingDaily=fundingRate!==null&&fundingHours!==null?fundingRate*100*24/fundingHours:null;
 const bid=positive(raw.book?.bidPrice),ask=positive(raw.book?.askPrice);
 const spread=bid!==null&&ask!==null&&ask>=bid?(ask-bid)/((ask+bid)/2)*10000:null;
 const mark=positive(raw.premium?.markPrice),index=positive(raw.premium?.indexPrice);
 const currentQ=number(raw.openInterest?.openInterest),currentTime=number(raw.openInterest?.time);
 const currentValue=currentQ===null?null:c.family==="CM"?(positive(c.contractSize)?currentQ*Number(c.contractSize):null):(mark!==null&&fx!==null?currentQ*mark*fx:null);
 // Binance's CMC supply is in the instrument base unit, including multiplied contracts.
 const supply=point?positive(point.CMCCirculatingSupply):null;
 const spot=spotPrices?.[token];
 const estimatedCap=c.family==="UM"&&supply!==null&&spot?.time===cutoff&&spot.priceUsd>0?supply*multiplier*spot.priceUsd:null;
 const oi={h1:change(q,qty(exact(cutoff-HOUR))),h4:change(q,qty(exact(cutoff-4*HOUR))),h24:change(q,qty(exact(cutoff-24*HOUR)))};
 const previousValues={h1:val(exact(cutoff-HOUR)),h4:val(exact(cutoff-4*HOUR)),h24:val(exact(cutoff-24*HOUR))};
 // 早期信号原始序列：仅在主合约上使用（见 buildIndicators），不聚合多合约，保持可解释。
 const flowAt=(i:number)=>candleFlow(k[i],c.family,fx,positive(c.contractSize));
 const atrPctSeries=contiguous&&trs.length>=22?trs.map((_,i)=>i<13?null:trs.slice(i-13,i+1).reduce((a,b)=>a+b,0)/14/close[i]*100).filter((v):v is number=>v!==null):[];
 const avgTradeSizeSeries=contiguous?k.map((x,i)=>{const f=flowAt(i),trades=number(x[8]);return f&&trades&&trades>0?f.total/trades:null;}).filter((v):v is number=>v!==null):[];
 // 与 close 逐小时对齐用于 OBV：缺失记为 NaN（不按0填充），窗口内有缺失时 OBV 背离整体缺失。
 const quoteVolumeSeries=contiguous?k.map((_,i)=>flowAt(i)?.total??NaN):[];
 const oiQtyHourly=[5,4,3,2,1,0].map(i=>qty(exact(cutoff-i*HOUR)));
 const netRatioHourly=contiguous?k.slice(-24).map((_,idx,arr)=>{const i=k.length-arr.length+idx,f=flowAt(i);return f&&f.total>0?f.net/f.total*100:null;}):[];
 const ratioPoints=(list:Record<string,unknown>[]|null|undefined):RatioPoint[]=>(list??[]).map(r=>({time:number(r.timestamp)??NaN,value:number(r.longShortRatio)??NaN}))
   .filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.value)&&p.time<=cutoff).sort((a,b)=>a.time-b.time);
 const earlyInputs:EarlySignalInputs={atrPctSeries,avgTradeSizeSeries,oiQtyHourly,netRatioHourly,
   topRatioSeries:ratioPoints(raw.topAccountRatio??raw.topPositionRatio),globalRatioSeries:ratioPoints(raw.globalAccountRatio),
   closeSeries:contiguous?close:[],quoteVolumeSeries,fundingDaily:fundingRate!==null&&fundingHours!==null?fundingRate*100*24/fundingHours:null};
 return {symbol:c.symbol,family:c.family,token,multiplier,type:c.contractType,quote:c.quoteAsset,contractSize:c.contractSize??null,
   cutoff,oiQty:q,oiValue:value,oi,previousValues,currentValue,currentTime,price:last!==null&&fx!==null?last*fx/multiplier:null,
   priceChange:{h1:price(1),h4:price(4),h24:price(24)},flows,volumeRatio,ema20:e20,ema60:e60,
   trend:e20!==null&&e60!==null&&last!==null?(last>e20&&e20>e60?"多头排列":last<e20&&e20<e60?"空头排列":"震荡"):"不足",
   rsi:contiguous?rsi(close):null,atrPct:atr,fundingRate:fundingRate!==null?fundingRate*100:null,fundingHours,fundingDaily,
   basisPct:mark!==null&&index!==null?change(mark,index):null,spreadBps:spread,estimatedCap,
   candleCount:k.length,contiguous,onboardDate:c.onboardDate,hasOI:point!==undefined,hasCurrent:currentQ!==null,
   chart:k.slice(-48).map(x=>({time:Number(x[6]),price:fx!==null?Number(x[4])*fx/multiplier:null})),
   oiChart:history.map(h=>({time:Number(h.timestamp),quantity:qty(h),value:val(h)})),earlyInputs};
}
type ContractMetric=ReturnType<typeof contractMetrics>;
type WindowKey="h1"|"h4"|"h24";
// 早期信号原始序列只用于币种级计算，不随合约明细发给前端，避免体积膨胀。
const withoutEarlyInputs=(c:ContractMetric)=>{const {earlyInputs,...rest}=c;void earlyInputs;return rest;};
export function buildIndicators(raw:RawSnapshot){
 const metrics=raw.contracts.map(c=>contractMetrics(c,raw.cutoff,raw.spotPrices)),groups=new Map<string,ContractMetric[]>();
 for(const m of metrics){if(!groups.has(m.token))groups.set(m.token,[]);groups.get(m.token)!.push(m);}
 const coins=[...groups].map(([token,contracts])=>{
   const reps=contracts.slice().sort((a,b)=>(b.flows.h24?.total??0)-(a.flows.h24?.total??0)),rep=reps[0];
   const available=contracts.filter(c=>c.oiValue!==null),oiValue=available.reduce((s,c)=>s+c.oiValue!,0);
   const currentAvailable=contracts.filter(c=>c.currentValue!==null),currentValue=currentAvailable.reduce((s,c)=>s+c.currentValue!,0);
   const aggregateOi=(w:WindowKey)=>{
     if(contracts.some(c=>c.oi[w]===null||c.previousValues[w]===null))return null;
     const denominator=contracts.reduce((s,c)=>s+c.previousValues[w]!,0);
     return denominator>0?contracts.reduce((s,c)=>s+c.previousValues[w]!*(1+c.oi[w]!/100),0)/denominator*100-100:null;
   };
   const aggregateFlow=(w:WindowKey)=>{
     if(contracts.some(c=>c.flows[w]===null))return null;
     return contracts.reduce((s,c)=>({inflow:s.inflow+c.flows[w]!.inflow,outflow:s.outflow+c.flows[w]!.outflow,
       net:s.net+c.flows[w]!.net,total:s.total+c.flows[w]!.total}),{inflow:0,outflow:0,net:0,total:0});
   };
   const flows={h1:aggregateFlow("h1"),h4:aggregateFlow("h4"),h24:aggregateFlow("h24")};
   const oi={h1:round(aggregateOi("h1")),h4:round(aggregateOi("h4")),h24:round(aggregateOi("h24"))};
   const warnings:string[]=[];
   const caps=reps.filter(c=>c.estimatedCap!==null&&c.estimatedCap>0);
   let marketCap=caps[0]?.estimatedCap??null,capSource=marketCap!==null?"币安 CMC 流通量 × 同整点币安现货收盘价（估算）":"缺失";
   if(marketCap!==null&&caps.some(c=>Math.abs(c.estimatedCap!/marketCap!-1)>.25)){marketCap=null;capSource="不同合约流通市值估算冲突";warnings.push("流通市值口径冲突");}
   const cgCandidates=raw.marketCaps.filter(c=>String(c.symbol).toUpperCase()===token);
   const cg=cgCandidates.length===1?cgCandidates[0]:null;
   const cgPrice=positive(cg?.current_price),cgCap=positive(cg?.market_cap),cgTime=cg?Date.parse(String(cg.last_updated)):NaN;
   const cgMatched=cg&&cgPrice!==null&&rep.price!==null&&Math.abs(cgPrice/rep.price-1)<.15&&Math.abs(cgTime-raw.cutoff)<3*HOUR;
   if(cgMatched&&cgCap!==null){
     if(marketCap!==null&&Math.abs(cgCap/marketCap-1)>.25){warnings.push("CoinGecko 与币安市值差异超过25%");marketCap=null;capSource="跨源市值冲突，暂不计算比值";}
     else if(marketCap===null&&!caps.length){marketCap=cgCap;capSource="CoinGecko 流通市值（唯一符号+价格交叉校验，非身份保证）";}
     else capSource+=" · CoinGecko 交叉校验";
   }
   if(marketCap===null)warnings.push("流通市值缺失／待核验");
   if(available.length!==contracts.length)warnings.push("整点持仓市值覆盖不完整");
   if(currentAvailable.length!==contracts.length)warnings.push("最新持仓市值覆盖不完整");
   if(oi.h24===null)warnings.push("24h OI 历史不足");
   if(flows.h24===null)warnings.push("24h 成交资金流覆盖不足");
   if(rep.candleCount<60||!rep.contiguous)warnings.push("主合约连续 K 线不足");
   const p4=rep.priceChange.h4,oi4=oi.h4,io4=flows.h4,netRatio=io4&&io4.total>0?io4.net/io4.total*100:null;
   const oiCap=marketCap!==null&&marketCap>0&&available.length===contracts.length?oiValue/marketCap*100:null;
   if(oiCap!==null&&oiCap>=20)warnings.push("持仓市值／流通市值偏高");
   if(rep.fundingDaily!==null&&Math.abs(rep.fundingDaily)>=.1)warnings.push("归一化资金费率偏高");
   if(rep.spreadBps!==null&&rep.spreadBps>25)warnings.push("买卖价差较大");
   if(rep.rsi!==null&&(rep.rsi>=75||rep.rsi<=25))warnings.push("RSI 处于极端区间");
   if(raw.cutoff-rep.onboardDate<7*24*HOUR)warnings.push("上市不足7天");
   const quality=available.length===contracts.length&&oi4!==null&&p4!==null&&flows.h24!==null&&io4!==null&&rep.contiguous&&rep.candleCount>=60;
   const liquid=flows.h24!==null&&flows.h24.total>=5e6&&oiValue>=1e6&&rep.spreadBps!==null&&rep.spreadBps<=25;
   const tags:string[]=[];
   if(oi4!==null&&p4!==null){
     if(oi4>=3&&p4>=1)tags.push("上涨增仓");
     if(oi4>=3&&Math.abs(p4)<1)tags.push("盘整增仓");
     if(oi4>=3&&p4<=-1)tags.push("下跌增仓");
     if(oi4<=-3&&Math.abs(p4)>=1)tags.push("减仓波动");
   }
   if(netRatio!==null&&netRatio>=8)tags.push("主动净流入");
   if(netRatio!==null&&netRatio<=-8)tags.push("主动净流出");
   if(rep.volumeRatio!==null&&rep.volumeRatio>=1.5)tags.push("成交放量");
   if((oiCap!==null&&oiCap>=20)||(rep.fundingDaily!==null&&Math.abs(rep.fundingDaily)>=.1))tags.push("拥挤风险");
   // 走势强度分（原“关注分”）：事后确认型，衡量已经发生的变化幅度，不是早期信号，详情区展示。
   const strengthScore=quality?Math.min(100,Math.min(35,Math.abs(oi4!)*4)+Math.min(25,Math.abs(netRatio??0)*2)+Math.min(20,Math.max(0,(rep.volumeRatio??1)-1)*15)+Math.min(20,Math.abs(p4!)*3)):null;
   const candidate=quality&&liquid&&tags.length>=2;
   // 早期信号：使用主合约（成交最活跃）的原始序列，不聚合多合约；数据覆盖不足时相关字段与分数保持缺失，不按0填充。
   const early=computeEarlySignal(rep.earlyInputs,{oi4,p4,netRatio4h:netRatio});
   if(early.earlyCandidate)tags.push("疑似启动");
   return {token,representative:rep.symbol,contractCount:contracts.length,oiCoverage:available.length,currentCoverage:currentAvailable.length,
     price:round(rep.price,10),priceChange:rep.priceChange,oiValue:available.length?round(oiValue,0):null,currentValue:currentAvailable.length?round(currentValue,0):null,
     oi,flows,ioNetRatio4h:round(netRatio),marketCap:round(marketCap,0),capSource,oiCapPct:round(oiCap),volumeRatio:round(rep.volumeRatio),
     fundingDaily:round(rep.fundingDaily,5),fundingRate:rep.fundingRate,fundingHours:rep.fundingHours,basisPct:round(rep.basisPct),
     rsi:round(rep.rsi,1),atrPct:round(rep.atrPct,2),trend:rep.trend,spreadBps:round(rep.spreadBps,2),
     quality,liquid,candidate,attention:round(strengthScore,1),strengthScore:round(strengthScore,1),
     earlyScore:early.earlyScore,earlyCandidate:early.earlyCandidate,earlySignal:early,tags,warnings,
     contracts:contracts.map(withoutEarlyInputs),chart:rep.chart,
     reason:!quality?"数据不完整，暂不入选":!liquid?"成交、持仓或价差未达流动性门槛":tags.length<2?"异常信号不足":tags.join(" + ")};
 }).sort((a,b)=>(b.earlyScore??-1)-(a.earlyScore??-1)||Number(b.candidate)-Number(a.candidate)||(b.attention??-1)-(a.attention??-1));
 return {schemaVersion:1,ruleVersion:INDICATOR_RULE,id:raw.id,startedAt:raw.startedAt,completedAt:raw.completedAt,cutoff:raw.cutoff,
   coverage:{...raw.coverage,contracts:metrics.length,tokens:coins.length,oiContracts:metrics.filter(c=>c.hasOI).length,
     candleContracts:metrics.filter(c=>c.contiguous&&c.candleCount>=60).length,marketCapTokens:coins.filter(c=>c.marketCap!==null).length,
     candidates:coins.filter(c=>c.candidate).length,errors:raw.errors.length},coins,errors:raw.errors,excluded:raw.excluded,
   notes:["IO（主动成交口径）=主动买入额−主动卖出额，不是交易所充值提现或真实净入金。",
     "持仓市值=未平仓合约名义价值，只计一侧，不把多空双倍相加。它不是保证金或代币流通市值。",
     "聚合 OI 增减按各合约期初持仓市值固定加权，减少价格上涨造成的假增仓；不代表净多资金。",
     "OI、IO 与价格对齐到同一整点；最新持仓记录另列。趋势、量比、价差和费率来自成交最活跃主合约。",
     raw.fxNote,"资金费率按实际结算周期折算24h，仅为可比尺度，不是未来费用预测。",
     "走势强度分（原“关注分”）是事后确认型的异常程度，不是收益预测；空头压力和拥挤风险也可能入选。",
     "早期分（earlyScore）用主合约原始序列计算，子项覆盖不足2/4时为缺失；不因缺失按0计分，也不能跨币种在覆盖度不同时直接比较。早期信号规则未回测，是研究性启发式排序，不构成买卖建议。"]};
}
export type IndicatorSnapshot=ReturnType<typeof buildIndicators>;
export type IndicatorCoin=IndicatorSnapshot["coins"][number];
