import { analyzeSquare, type SquareSnapshot } from "../square/model.ts";
import type { Snapshot as HyperliquidSnapshot } from "../copy-trading/hyperliquid-model.ts";
import type { IndicatorSnapshot } from "../indicators/model";
import {analyzeDirection} from "../indicators/direction.ts";

export type Module = "square" | "indicators" | "copy";
export const LABELS: Record<Module,string> = {square:"广场情绪",indicators:"合约指标",copy:"Hyperliquid 聪明钱"};
export const MODULES: Module[] = ["square","indicators","copy"];
export type Signal = { available:boolean; direction:-1|0|1; summary:string; at:number|null; count:number; links:{label:string;url:string}[] };
export type Sources = {square:SquareSnapshot|null;indicators:IndicatorSnapshot|null;copy:HyperliquidSnapshot|null};
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
 const tokens=new Set<string>();
 const square=sources.square?.mode==="live"?sources.square:null;
 // Only original text opinions participate, not position bonuses: avoid reusing money evidence as an independent vote.
 const squareRows=square?analyzeSquare({...square,capturedAt:new Date(anchor).toISOString(),windowHours:24}):[];
 const sq=new Map(squareRows.map(c=>[c.symbol,c]));
 const indicators=new Map((sources.indicators?.coins??[]).map(c=>[c.token,c]));
 // Hyperliquid 的 coin 代码本身就是代币标识（无需像币安合约符号那样反查 baseAsset）；
 // 唯一的例外是 k 前缀的1000倍化 meme 币种（kPEPE/kSHIB/kBONK/kLUNC/kFLOKI/kDOGS/kNEIRO，来自官方 /info meta 接口核实），去掉前缀后与其余模块的 token 命名对齐。
 const hlToken=(coin:string)=>/^k[A-Z]/.test(coin)?coin.slice(1):coin;
 type Vote={address:string;name:string;side:string;notional:number;observedAt:number;url:string};
 const votes=new Map<string,Map<string,Vote>>();
 const unmapped=0; // Hyperliquid 币种代码不需要额外映射表；保留字段是为了不破坏页面既有展示。
 for(const e of sources.copy?.entities??[]){
  if(pool!=="all"&&e.pool!==pool)continue;
  if(e.error||!e.fresh)continue;
  const observedAt=Date.parse(e.observedAt);
  // 每个地址要有互不相同的链接：个人交易员没有官方"按地址查业绩"的页面，用官方区块浏览器的按地址交易记录页代替；
  // 之前误用了同一个排行榜页面链接给所有个人交易员，导致跨模块结果表格里出现重复的 React key。
  const url=e.kind==="vault"?"https://app.hyperliquid.xyz/vaults/"+e.address:"https://app.hyperliquid.xyz/explorer/address/"+e.address;
  for(const p of e.positions){
   const token=hlToken(p.coin);
   const byEntity=votes.get(token)??new Map<string,Vote>();
   const prev=byEntity.get(e.address);
   // 同一地址同一币种理论上只有一个方向的仓位；万一出现对冲模式的双向仓位，取名义价值更大的一侧作为该地址的票。
   if(!prev||(p.notional??0)>prev.notional)byEntity.set(e.address,{address:e.address,name:e.name??e.address,side:p.side,notional:p.notional??0,observedAt,url});
   votes.set(token,byEntity);
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
   const at=sources.indicators.cutoff,a=analyzeDirection(i,at,now);
   is={available:a.usable,direction:a.direction,
    summary:a.label+"："+a.summary,
    at,count:i.contractCount,links:[{label:"查看指标",url:"/indicators"}]};
   if(a.risks.length)is.summary+=" 风险："+a.risks.slice(0,2).join("；");
  }
  const long=v.filter(x=>x.side==="LONG").length,short=v.filter(x=>x.side==="SHORT").length;
  const cs:Signal={available:v.length>=2,direction:v.length?sign((long-short)/v.length,0.34):0,
   summary:v.length+" 个地址：当前公开持仓方向 多 "+long+" / 空 "+short+"；"+(v.length<2?"至少需要2位；":"")+"查询时刻快照，随时可能变化",
   at:v.length?Math.min(...v.map(x=>x.observedAt)):null,count:v.length,links:v.slice(0,5).map(x=>({label:x.name,url:x.url}))};
  const signals={square:ss,indicators:is,copy:cs},used=chosen.map(m=>signals[m]);
  // 三个来源现在都是"当前/近窗口"快照（Hyperliquid 持仓也是实时查询，不再是重建的历史已平仓周期），不再需要 verdict() 的历史措辞分支。
  const state=verdict(used,false);
  return {token,signals,state,coverage:used.filter(x=>x.available).length,heat:s?.heat??null,attention:i?.attention??null,
   warnings:[...(i?.warnings??[]),...(chosen.includes("copy")?["Hyperliquid 持仓是查询时刻快照，可能在你查看结果之前已经变化。"]:[]),
    ...(chosen.includes("copy")&&chosen.includes("square")?["广场作者与 Hyperliquid 地址尚未完成跨平台身份去重，不声称证据相互独立。"]:[])],
   traders:v};
 }).sort((a,b)=>b.coverage-a.coverage||(b.heat??0)-(a.heat??0)||(b.attention??0)-(a.attention??0)||a.token.localeCompare(b.token));
 return {rows,anchor,unmapped,selected:chosen};
}
