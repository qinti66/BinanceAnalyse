import { analyzeSquare, type SquareSnapshot } from "../square/model.ts";
import { effectivePool, type Snapshot } from "../copy-trading/model.ts";
import type { IndicatorSnapshot } from "../indicators/model";

export type Module = "square" | "indicators" | "copy";
export const LABELS: Record<Module,string> = {square:"广场情绪",indicators:"合约指标",copy:"带单聪明钱"};
export const MODULES: Module[] = ["square","indicators","copy"];
export type Signal = { available:boolean; direction:-1|0|1; summary:string; at:number|null; count:number; links:{label:string;url:string}[] };
export type Sources = {square:SquareSnapshot|null;indicators:IndicatorSnapshot|null;copy:Snapshot|null};
const HOUR=3600000;
const fresh=(at:number,now:number)=>Number.isFinite(at)&&at<=now+60000&&now-at<=6*HOUR;
const empty=(summary:string,at:number|null=null):Signal=>({available:false,direction:0,summary,at,count:0,links:[]});
const sign=(v:number,threshold:number):-1|0|1=>v>=threshold?1:v<=-threshold?-1:0;
export function verdict(signals:Signal[],historical:boolean){
 if(signals.length<2)return "至少选择两个模块";
 if(signals.some(s=>!s.available))return "证据不足";
 const positive=signals.some(s=>s.direction===1),negative=signals.some(s=>s.direction===-1);
 if(positive&&negative)return historical?"与历史交易方向冲突":"信号冲突";
 if(signals.some(s=>s.direction===0))return "尚未形成共识";
 return (historical?"历史方向":"信号")+(positive?"同向偏多":"同向偏空");
}
export function buildCross(sources:Sources,selected:Module[],pool:"quality"|"ordinary"|"all"="quality",now=Date.now()){
 const chosen=MODULES.filter(m=>selected.includes(m));
 const snapshotTimes=[...(chosen.includes("square")&&sources.square?[Date.parse(sources.square.capturedAt)]:[]),...(chosen.includes("copy")&&sources.copy?[Date.parse(sources.copy.generatedAt)]:[])].filter(t=>Number.isFinite(t)&&t<=now);
 const anchor=chosen.includes("indicators")&&sources.indicators&&Number.isFinite(sources.indicators.cutoff)?sources.indicators.cutoff:Math.floor(Math.min(now,...snapshotTimes)/HOUR)*HOUR;
 const tokens=new Set<string>(),mapping=new Map<string,string>();
 for(const c of sources.indicators?.coins??[])for(const contract of c.contracts)mapping.set(contract.symbol,c.token);
 const square=sources.square?.mode==="live"?sources.square:null;
 // Only original text opinions participate, not position bonuses: avoid reusing money evidence as an independent vote.
 const squareRows=square?analyzeSquare({...square,capturedAt:new Date(anchor).toISOString(),windowHours:24}):[];
 const sq=new Map(squareRows.map(c=>[c.symbol,c]));
 const indicators=new Map((sources.indicators?.coins??[]).map(c=>[c.token,c]));
 type Vote={id:string;name:string;side:string;closedAt:number;hold:number;pnl:number|null;observedAt:number;url:string};
 const votes=new Map<string,Map<string,Vote>>();
 let unmapped=0;
 for(const t of sources.copy?.traders??[]){
  if(pool!=="all"&&effectivePool(t,now)!==pool)continue;
  const at=Date.parse(t.historyAt??t.observedAt);
  if(t.updateError||!t.positionShow||!fresh(at,now)||!fresh(Date.parse(t.observedAt),now)||at<anchor||!t.checks.find(c=>c.key==="public")?.pass||!t.checks.find(c=>c.key==="integrity")?.pass||(t.metrics.anomalyScore??100)>=25)continue;
  for(const c of t.metrics.cycles){
   if(c.closedAt>anchor||c.closedAt<anchor-24*HOUR)continue;
   const token=mapping.get(c.symbol);if(!token){unmapped++;continue;}
   const byTrader=votes.get(token)??new Map<string,Vote>();
   const prev=byTrader.get(t.id);
   if(!prev||c.closedAt>prev.closedAt)byTrader.set(t.id,{id:t.id,name:t.name,side:c.side,closedAt:c.closedAt,hold:c.holdSeconds,pnl:c.pnl,observedAt:at,url:t.sourceUrl});
   votes.set(token,byTrader);
  }
 }
 if(chosen.includes("square"))for(const c of squareRows)tokens.add(c.symbol);
 if(chosen.includes("indicators"))for(const c of sources.indicators?.coins??[])tokens.add(c.token);
 if(chosen.includes("copy"))for(const token of votes.keys())tokens.add(token);
 const rows=[...tokens].map(token=>{
  const s=sq.get(token),i=indicators.get(token),v=[...(votes.get(token)?.values()??[])];
  let ss=empty(square?"该币种没有24h内可归属的帖子":"真实广场快照缺失；演示数据不参与");
  if(s&&square){
   const at=Date.parse(square.capturedAt),directional=s.rows.filter(r=>r.post.direction!==0).length;
   ss={available:fresh(at,now)&&at>=anchor&&s.authorCount>=3&&directional>=2,direction:sign(s.raw.net,15),
    summary:s.authorCount+" 位作者 / "+s.postCount+" 条帖子；明确方向 "+directional+" 位；净情绪 "+s.raw.net.toFixed(1)+"%；样本热度 "+s.heat.toFixed(1),
    at,count:s.authorCount,links:s.rows.slice(0,5).flatMap(r=>r.post.sourceUrl?[{label:r.post.authorName,url:r.post.sourceUrl}]:[])};
   if(!ss.available)ss.summary+="；样本少于3位作者/2位明确方向，或快照过期/早于分析时点";
  }
  let is=empty("该币种无合约指标数据");
  if(i&&sources.indicators){
   const p=i.priceChange.h4,io=i.ioNetRatio4h,at=sources.indicators.cutoff;
   is={available:i.quality&&i.liquid&&fresh(at,now),direction:p!==null&&io!==null?(p>=1&&io>=8?1:p<=-1&&io<=-8?-1:0):0,
    summary:"4h 价格 "+(p?.toFixed(2)??"—")+"%；主动净流比 "+(io?.toFixed(2)??"—")+"%；OI "+(i.oi.h4?.toFixed(2)??"—")+"%",
    at,count:i.contractCount,links:[{label:"查看指标",url:"/indicators"}]};
   if(!is.available)is.summary+="；完整性、流动性或6h时效未达标";
  }
  const long=v.filter(x=>x.side==="LONG").length,short=v.filter(x=>x.side==="SHORT").length;
  const cs:Signal={available:v.length>=2,direction:v.length?sign((long-short)/v.length,0.34):0,
   summary:v.length+" 位带单员：最近已平仓方向 多 "+long+" / 空 "+short+"；"+(v.length<2?"至少需要2位；":"")+"不是当前持仓",
   at:v.length?Math.min(...v.map(x=>x.observedAt)):null,count:v.length,links:v.slice(0,5).map(x=>({label:x.name,url:x.url}))};
  const signals={square:ss,indicators:is,copy:cs},used=chosen.map(m=>signals[m]);
  const state=verdict(used,chosen.includes("copy"));
  return {token,signals,state,coverage:used.filter(x=>x.available).length,heat:s?.heat??null,attention:i?.attention??null,
   warnings:[...(i?.warnings??[]),...(chosen.includes("copy")?["仅比较过去24h已平仓交易方向，不代表当前聪明钱仓位。"]:[]),
    ...(chosen.includes("copy")&&chosen.includes("square")?["广场作者与带单员尚未完成跨平台身份去重，不声称证据相互独立。"]:[])],
   traders:v};
 }).sort((a,b)=>b.coverage-a.coverage||(b.heat??0)-(a.heat??0)||(b.attention??0)-(a.attention??0)||a.token.localeCompare(b.token));
 return {rows,anchor,unmapped,selected:chosen};
}
