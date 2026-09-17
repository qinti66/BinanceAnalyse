export const RULE_VERSION="copy-pools-v1";
export const DAY=86400000;
export const FRESH_MS=48*3600000;
export type Pool="quality"|"ordinary";
export type RawOrder={symbol?:string;quoteAsset?:string;side?:string;positionSide?:string;executedQty?:unknown;avgPrice?:unknown;totalPnl?:unknown;orderTime?:unknown;orderUpdateTime?:unknown};
export type Performance={roi:unknown;pnl:unknown;mdd:unknown;copierPnl:unknown;sharpRatio:unknown;winRate?:unknown;aum?:unknown};
export type RawTrader={id:string;observedAt:string;profile:Record<string,unknown>|null;performance:Record<string,Performance>;history:{orders:RawOrder[];total:number|null;truncated:boolean;complete:boolean;error?:string;observedAt?:string}|null;error?:string};
export const numeric=(v:unknown):number|null=>v===null||v===undefined||v===""||typeof v==="boolean"?null:Number.isFinite(Number(v))?Number(v):null;
const percent=(a:number,b:number)=>b?a/b*100:null;
const sum=(a:number[])=>a.reduce((s,x)=>s+x,0);
const median=(a:number[])=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
type Cycle={evidenceId:string;symbol:string;side:string;openedAt:number;closedAt:number;holdSeconds:number;turnover:number;pnl:number|null;openNotional:number;adds:number};
export function analyzeOrders(orders:RawOrder[],id:string,asOf:number){
 const valid:({symbol:string;side:string;direction:string;quantity:number;price:number;time:number;pnl:number|null;quote:string})[]=[];
 let invalid=0,ambiguous=0,duplicates=0;
 const signatures=new Set<string>();
 for(const o of orders){
  const quantity=numeric(o.executedQty),price=numeric(o.avgPrice),time=numeric(o.orderUpdateTime??o.orderTime);
  if(!o.symbol||!["BUY","SELL"].includes(o.side??"")||quantity===null||quantity<=0||price===null||price<=0||time===null||time<=0||time>asOf){invalid++;continue;}
  if(!["LONG","SHORT"].includes(o.positionSide??"")){ambiguous++;continue;}
  // No order IDs are exposed: identical records are ambiguous, not silently deduplicated.
  const signature=JSON.stringify(o);if(signatures.has(signature))duplicates++;signatures.add(signature);
  valid.push({symbol:o.symbol,side:o.side!,direction:o.positionSide!,quantity,price,time,pnl:numeric(o.totalPnl),quote:o.quoteAsset??""});
 }
 valid.sort((a,b)=>a.time-b.time);
 type State={symbol:string;side:string;quantity:number;openedAt:number;openNotional:number;turnover:number;pnl:number|null;adds:number;trusted:boolean};
 const states=new Map<string,State>(),flat=new Set<string>(),cycles:Cycle[]=[];
 let boundaryCycles=0,unmatched=0,matchedCloses=0,repeat=0,comparable=0,sameTime=0;
 const lastOrder=new Map<string,typeof valid[number]>(),lastKeyTime=new Map<string,{time:number;side:string}>();
 const supported=valid.every(o=>o.quote==="USDT"||o.quote==="USDC");
 for(const o of valid){
  const key=o.symbol+"|"+o.direction,open=o.direction==="LONG"?o.side==="BUY":o.side==="SELL";
  const prior=lastKeyTime.get(key);
  if(prior?.time===o.time&&prior.side!==o.side)sameTime++;
  lastKeyTime.set(key,{time:o.time,side:o.side});
  const prev=lastOrder.get(key+"|"+o.side);
  if(prev&&o.time-prev.time<=300000){comparable++;if(Math.abs(o.quantity/prev.quantity-1)<=.001)repeat++;}
  lastOrder.set(key+"|"+o.side,o);
  let s=states.get(key);
  if(open){
   if(!s)s={symbol:o.symbol,side:o.direction,quantity:0,openedAt:o.time,openNotional:0,turnover:0,pnl:0,adds:0,trusted:flat.has(key)};
   s.quantity+=o.quantity;s.openNotional+=o.quantity*o.price;s.turnover+=o.quantity*o.price;s.adds++;
   states.set(key,s);continue;
  }
  if(!s){unmatched++;continue;}
  const tolerance=Math.max(1e-9,s.quantity*1e-8);
  if(o.quantity>s.quantity+tolerance){unmatched++;states.delete(key);flat.delete(key);continue;}
  matchedCloses++;s.quantity-=o.quantity;s.turnover+=o.quantity*o.price;s.pnl=s.pnl!==null&&o.pnl!==null?s.pnl+o.pnl:null;
  if(s.quantity<=tolerance){
   if(s.trusted)cycles.push({evidenceId:id+":"+key+":"+s.openedAt+":"+o.time,symbol:s.symbol,side:s.side,openedAt:s.openedAt,closedAt:o.time,holdSeconds:(o.time-s.openedAt)/1000,turnover:s.turnover,pnl:s.pnl,openNotional:s.openNotional,adds:s.adds});
   else boundaryCycles++;
   states.delete(key);flat.add(key);
  }
 }
 const closed=[...cycles].sort((a,b)=>a.openedAt-b.openedAt),lastCycle=new Map<string,Cycle>();
 let reopen=0,reverse=0,overlap=0;
 for(const c of closed){
  const p=lastCycle.get(c.symbol+"|"+c.side),op=lastCycle.get(c.symbol+"|"+(c.side==="LONG"?"SHORT":"LONG"));
  if(p&&c.openedAt>=p.closedAt&&c.openedAt-p.closedAt<=60000)reopen++;
  if(op&&c.openedAt>=op.closedAt&&c.openedAt-op.closedAt<=60000)reverse++;
  if(op&&c.openedAt<op.closedAt)overlap++;
  lastCycle.set(c.symbol+"|"+c.side,c);
 }
 const holds=cycles.map(c=>c.holdSeconds),wins=cycles.filter(c=>c.pnl!==null&&c.pnl>0),losses=cycles.filter(c=>c.pnl!==null&&c.pnl<0);
 const grossProfit=sum(wins.map(c=>c.pnl!)),grossLoss=-sum(losses.map(c=>c.pnl!));
 const pnlComplete=cycles.length>0&&cycles.every(c=>c.pnl!==null)&&supported;
 const shortPct=percent(holds.filter(s=>s<300).length,cycles.length),ultraPct=percent(holds.filter(s=>s<60).length,cycles.length);
 const nearZero=percent(cycles.filter(c=>c.pnl!==null&&Math.abs(c.pnl/c.openNotional)<=.0002).length,cycles.length);
 const rapidPct=percent(reopen,Math.max(0,cycles.length-1)),reversePct=percent(reverse,Math.max(0,cycles.length-1)),repeatPct=percent(repeat,comparable);
 const flags:{code:string;label:string;points:number}[]=[];
 if(cycles.length>=10){
  if((ultraPct??0)>=30)flags.push({code:"ultra",label:"一分钟内平仓占比较高",points:25});
  if((shortPct??0)>=60)flags.push({code:"short",label:"五分钟内平仓占比较高",points:15});
  if((rapidPct??0)>=25)flags.push({code:"reopen",label:"一分钟内同向重开频繁",points:20});
  if((reversePct??0)>=20)flags.push({code:"reverse",label:"一分钟内反向开仓频繁",points:15});
  if((repeatPct??0)>=60&&(nearZero??0)>=40)flags.push({code:"repeat",label:"等量重复且近零收益回转较多",points:25});
 }
 const coverageDays=valid.length>1?(valid.at(-1)!.time-valid[0].time)/DAY:0;
 return {orderCount:orders.length,validOrders:valid.length,invalid,ambiguous,duplicates,sameTime,unmatched,matchedCloses,boundaryCycles,
  cycles,cycleCount:cycles.length,coverageDays,medianHoldSeconds:median(holds),under60sPct:ultraPct,under5mPct:shortPct,
  rapidReopenPct:rapidPct,oppositeReversalPct:reversePct,repeatedQuantityPct:repeatPct,nearZeroPct:nearZero,overlapCount:overlap,
  profitFactor:pnlComplete&&grossLoss>0?grossProfit/grossLoss:null,lossCycles:losses.length,
  topProfitPct:grossProfit>0?Math.max(...wins.map(c=>c.pnl!))/grossProfit*100:null,
  realizedPnl:pnlComplete?sum(cycles.map(c=>c.pnl!)):null,winRate:pnlComplete?percent(wins.length,cycles.length):null,
  totalTurnover:supported?sum(valid.map(o=>o.quantity*o.price)):null,supportedQuotes:supported,
  anomalyScore:cycles.length>=10?Math.min(100,sum(flags.map(f=>f.points))):null,flags,
  unresolved:[...states.values()].map(s=>({symbol:s.symbol,side:s.side,quantity:s.quantity,openedAt:s.openedAt,ageSeconds:Math.max(0,(asOf-s.openedAt)/1000),boundaryUncertain:!s.trusted})),
  lastOrderAt:valid.at(-1)?.time??null};
}
export function evaluateTrader(raw:RawTrader,now=Date.now()){
 const p=raw.profile??{},age=numeric(p.startTime),tenure=age!==null?Math.max(0,(Date.parse(raw.observedAt)-age)/DAY):null;
 const normalize=(key:string)=>{const d=raw.performance[key];return {roi:numeric(d?.roi),pnl:numeric(d?.pnl),mdd:numeric(d?.mdd),copierPnl:numeric(d?.copierPnl),sharpe:numeric(d?.sharpRatio),winRate:numeric(d?.winRate)};};
 const p30=normalize("30D"),p90=normalize("90D"),h=raw.history;
 const historyAt=h?.observedAt??raw.observedAt;
 const m=analyzeOrders(h?.orders??[],raw.id,Date.parse(historyAt));
 const fresh=Number.isFinite(Date.parse(raw.observedAt))&&now-Date.parse(raw.observedAt)<=FRESH_MS&&Date.parse(raw.observedAt)<=now+300000&&now-Date.parse(historyAt)<=FRESH_MS&&!raw.error&&!h?.error;
 const checks=[
  {key:"fresh",label:"资料更新在48小时内，且本次读取成功",pass:fresh},
  {key:"public",label:"活跃 U 本位组合，订单公开且本次分页完整",pass:p.status==="ACTIVE"&&p.futuresType==="UM"&&p.positionShow===true&&h?.complete===true&&!h?.truncated&&!h?.error},
  {key:"tenure",label:"带单运行至少90天",pass:tenure!==null&&tenure>=90},
  {key:"pnl",label:"30天与90天 ROI、PNL 及跟随者 PNL 均为正",pass:[p30.roi,p90.roi,p30.pnl,p90.pnl,p30.copierPnl,p90.copierPnl].every(v=>v!==null&&v>0)},
  {key:"drawdown",label:"30天回撤≤25%，90天回撤≤35%",pass:p30.mdd!==null&&p30.mdd>=0&&p30.mdd<=25&&p90.mdd!==null&&p90.mdd>=0&&p90.mdd<=35},
  {key:"sharpe",label:"30天夏普比率≥0.5",pass:p30.sharpe!==null&&p30.sharpe>=.5},
  {key:"sample",label:"至少30个可重建完整周期、14天订单跨度、3个亏损周期",pass:m.cycleCount>=30&&m.coverageDays>=14&&m.lossCycles>=3},
  {key:"integrity",label:"方向与金额单位可核验，未匹配平仓≤5%，无重复或同刻顺序歧义",pass:m.invalid===0&&m.ambiguous===0&&m.duplicates===0&&m.sameTime===0&&m.supportedQuotes&&m.unmatched/Math.max(1,m.unmatched+m.matchedCloses)<=.05},
  {key:"holding",label:"持仓中位数≥5分钟，5分钟内平仓≤30%",pass:m.medianHoldSeconds!==null&&m.medianHoldSeconds>=300&&m.under5mPct!==null&&m.under5mPct<=30},
  {key:"profitQuality",label:"样本利润因子≥1.2，单周期盈利贡献≤35%",pass:m.profitFactor!==null&&m.profitFactor>=1.2&&m.topProfitPct!==null&&m.topProfitPct<=35},
  {key:"anomaly",label:"异常筛查分<25，快速同向重开≤25%",pass:m.anomalyScore!==null&&m.anomalyScore<25&&m.rapidReopenPct!==null&&m.rapidReopenPct<=25}
 ].map(c=>({...c,pass:Boolean(c.pass)}));
 const eligible=checks.every(c=>c.pass),score=Math.round(checks.filter(c=>c.pass).length/checks.length*100);
 return {id:raw.id,name:String(p.nickname??raw.id),observedAt:raw.observedAt,historyAt,ruleVersion:RULE_VERSION,pool:(eligible?"quality":"ordinary") as Pool,
  autoTag:eligible?"优质聪明钱 · 候选":!checks.find(c=>c.key==="public")?.pass?"资料待核验":(m.anomalyScore??0)>=25?"异常需复核":"普通观察",
  score,checks,tenureDays:tenure,performance:{"30D":p30,"90D":p90},marginBalance:numeric(p.marginBalance),aum:numeric(p.aumAmount),
  metrics:m,fresh,updateError:raw.error??h?.error??null,positionShow:p.positionShow===true,
  sourceUrl:"https://www.binance.com/en/copy-trading/lead-details/"+encodeURIComponent(raw.id),
  reasons:checks.filter(c=>!c.pass).map(c=>c.label),
  mixedAssets:Array.isArray(p.tagItemVos)&&p.tagItemVos.some((x:Record<string,unknown>)=>x.tagName==="Tradfi"),
  positionEvidence:"未接入独立当前仓位接口；未闭合订单仅为历史残留，不代表当前实仓"};
}
export type Trader=ReturnType<typeof evaluateTrader>;
export type Snapshot={schemaVersion:1;ruleVersion:string;generatedAt:string;source:string;scope:string;traders:Trader[];poolUpdatedAt:Record<Pool,string|null>;changes:{id:string;name:string;from:Pool|null;to:Pool;at:string;reason:string}[];coverage:{discovered:number;analyzed:number;publicHistories:number;orders:number;quality:number;ordinary:number;errors:number};notes:string[]};
export function effectivePool(t:Trader,now=Date.now()):Pool{return t.pool==="quality"&&now-Date.parse(t.observedAt)<=FRESH_MS&&now-Date.parse(t.historyAt??t.observedAt)<=FRESH_MS&&!t.updateError?"quality":"ordinary";}
export function makeSnapshot(rows:RawTrader[],previous:Snapshot|null,scope:Pool|"all",source:string,discovered:number,now=Date.now()):Snapshot{
 const map=new Map((previous?.traders??[]).map(t=>[t.id,t])),changes:Snapshot["changes"]=[];
 for(const raw of rows){const t=evaluateTrader(raw,now),prev=map.get(t.id);if(prev?.pool!==t.pool)changes.push({id:t.id,name:t.name,from:prev?.pool??null,to:t.pool,at:new Date(now).toISOString(),reason:t.pool==="quality"?"全部质量门槛通过":t.reasons.slice(0,3).join("；")});map.set(t.id,t);}
 const traders=[...map.values()].sort((a,b)=>Number(b.pool==="quality")-Number(a.pool==="quality")||b.score-a.score);
 const updated={quality:previous?.poolUpdatedAt.quality??null,ordinary:previous?.poolUpdatedAt.ordinary??null};
 if(scope==="all"||scope==="quality")updated.quality=new Date(now).toISOString();
 if(scope==="all"||scope==="ordinary")updated.ordinary=new Date(now).toISOString();
 const quality=traders.filter(t=>effectivePool(t,now)==="quality").length;
 return {schemaVersion:1,ruleVersion:RULE_VERSION,generatedAt:new Date(now).toISOString(),source,scope,traders,poolUpdatedAt:updated,changes:[...changes,...(previous?.changes??[])].slice(0,500),
  coverage:{discovered,analyzed:traders.length,publicHistories:traders.filter(t=>t.positionShow&&t.metrics.orderCount>0).length,orders:sum(traders.map(t=>t.metrics.orderCount)),quality,ordinary:traders.length-quality,errors:traders.filter(t=>t.updateError).length},
  notes:["优质池是可解释的研究候选，不是收益保证；默认门槛未回测。普通池不等于表现差，也包含不公开或资料不足的组合。",
   "没有对手账户和撮合级数据，不能证明或排除对刷；短持仓、重开、等量回转等仅作异常筛查。",
   "订单聚合重建持仓时间，非逐笔成交精确持仓时长；每个品种/方向的首个周期按左边界不明排除，未闭合周期不纳入已平仓收益。",
   "USDT与USDC按近似美元计；订单PNL未确认包含全部手续费和资金费，不称为净收益。无亏损样本的利润因子为缺失，不用无穷大加分。",
   "30/90天是平台滚动指标，彼此重叠，不是独立两段业绩。持仓时间长短本身不能证明交易优劣。",
   "只更新选定池的原有成员；升降池按新证据自动处理。发现新成员需更新两个池并刷新候选榜单。每位带单员保留自己的数据时间。",
   "超过48小时的优质标记暂停生效，重新核验后恢复。周期设置只保存偏好，自动更新关闭，没有调度器。"]};
}
