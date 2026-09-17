"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, BarChart3, CheckCircle2, Clock3, Coins,
  Database, ExternalLink, EyeOff, Flame, Gauge, Search, ShieldCheck,
  Target, TrendingDown, TrendingUp, Users
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";
import rawData from "@/lib/dashboard-data.json";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Participant={traderId:string;name:string;score:number;risk:number;currentSide:"LONG"|"SHORT"|"NONE";recentFlow:number};
type FusionCoin={
  token:string;fusionRank:number;hotRank:number|null;heatRank:number;heatScore:number;squareSentimentScore:number;
  squareSentimentLabel:string;smartMoneyScore:number;smartMoneyConfidence:number;marketConfirmationScore:number;
  fusionScore:number;decisionScore:number;currentConsensus:number;recentFlowSignal:number;recentPerformanceSignal:number;
  strictTraderCount:number;currentPositionTraderCount:number;recentTraderCount:number;recentOrderCount:number;
  recentCycleCount:number;currentLongNotional:number;currentShortNotional:number;recentNetDirectionalNotional:number;
  priceChangePct:number;takerBuySellRatio:number|null;fundingRate:number|null;topParticipants:Participant[];
  existingFlags:string[];label:string;stance:string;reason:string
};
type Trader={
  id:string;name:string;url:string;tier:string;score:number;tenureDays:number;
  performance:{roi:number;mdd:number;copierPnl:number;sharpRatio:number|null};
  metrics:{completeCycleCount:number;medianHoldSeconds:number|null;washRiskScore:number;confidence:number;coverageDays:number}
};
type Data={
  capturedAt:string;coverage:{rankedUniqueProfiles:number;publicOrderHistories:number;hiddenProfiles:number;totalOrders:number;reconstructedCompleteCycles:number};
  traders:Trader[];
  fusion:{coverage:{strictSmartMoneyTraders:number;hotCoins:number;lookbackHours:number};methodology:Record<string,string>;coins:FusionCoin[]}
};
const data=rawData as Data;
const fusion=data.fusion.coins;
const strictTraders=data.traders.filter(t=>t.tier==="严格候选");

function money(v:number){
  const a=Math.abs(v),text=a>=1_000_000?(a/1_000_000).toFixed(2)+"M":a>=1_000?(a/1_000).toFixed(1)+"K":a.toFixed(0);
  return (v>0?"+":v<0?"−":"")+"$"+text;
}
function duration(v:number|null){
  if(v==null)return "—";if(v<60)return Math.round(v)+"秒";if(v<3600)return (v/60).toFixed(1)+"分钟";
  if(v<86400)return (v/3600).toFixed(1)+"小时";return (v/86400).toFixed(1)+"天";
}
function verdictClass(label:string){
  if(label.includes("偏多")||label.includes("吸筹")||label.includes("确认度"))return "good";
  if(label.includes("偏空"))return "bad";
  if(label.includes("缺少")||label.includes("未确认"))return "muted";
  return "watch";
}
function scoreTone(v:number){return v>=60?"text-emerald-300":v>=45?"text-amber-300":"text-rose-300";}

export default function Home(){
  const early=fusion.filter(c=>c.label.includes("聪明钱偏多"));
  const unconfirmed=fusion.filter(c=>c.label.includes("缺少聪明钱")).sort((a,b)=>b.heatScore-a.heatScore);
  const bearish=fusion.filter(c=>c.label.includes("方向偏空"));
  const evidence=fusion.filter(c=>c.smartMoneyConfidence>=20);
  const [selected,setSelected]=useState<FusionCoin>(fusion.find(c=>c.token==="SOL")||fusion[0]);
  const [query,setQuery]=useState("");
  const [filter,setFilter]=useState("全部");
  const shown=useMemo(()=>fusion.filter(c=>
    (filter==="全部"||c.stance===filter||filter==="有聪明钱证据"&&c.smartMoneyConfidence>=20||filter==="高热未确认"&&c.label.includes("缺少"))&&
    c.token.toLowerCase().includes(query.toLowerCase())
  ),[filter,query]);
  const snapshot=new Date(data.capturedAt).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
  const chartData=fusion.slice(0,12).map(c=>({token:c.token,广场热度:c.heatScore,聪明钱:c.smartMoneyScore,市场确认:c.marketConfirmationScore,决策分:c.decisionScore}));

  return <main className="min-h-screen bg-[#07101d] text-slate-100">
    <header className="sticky top-0 z-30 border-b border-white/8 bg-[#07101d]/92 backdrop-blur-xl">
      <div className="mx-auto flex min-h-16 max-w-[1540px] items-center justify-between gap-4 px-4 py-3 sm:px-7">
        <div className="flex items-center gap-3"><div className="logo"><Target size={19}/></div><div><b>Alpha Radar</b><p>广场热度 × 合约聪明钱</p></div></div>
        <div className="flex flex-wrap items-center gap-3"><a href="/indicators" className="text-sm text-amber-200 underline underline-offset-4">全市场合约指标</a><a href="/square" className="text-sm text-amber-200 underline underline-offset-4">广场情绪 · 仓位证据</a><div className="snapshot-pill"><i/>一次性完整快照 · {snapshot}</div></div>
      </div>
    </header>

    <div className="mx-auto max-w-[1540px] px-4 py-6 sm:px-7">
      <section className="fusion-hero">
        <div>
          <span className="eyebrow amber"><ShieldCheck size={14}/>融合结论</span>
          <h1>广场最热，<br/>不等于聪明钱正在买。</h1>
          <p>先用讨论热度发现币种，再用 16 位低风险带单高手的真实持仓、近 24 小时方向性订单和已平仓收益验证，最后结合价格与主动成交给出结论。</p>
        </div>
        <div className="hero-verdicts">
          <VerdictMini icon={<TrendingUp/>} label="提前观察" value={early.map(c=>c.token).join(" · ")||"暂无"} tone="green"/>
          <VerdictMini icon={<EyeOff/>} label="高热未确认" value={unconfirmed.slice(0,3).map(c=>c.token).join(" · ")} tone="amber"/>
          <VerdictMini icon={<TrendingDown/>} label="聪明钱偏空" value={bearish.map(c=>c.token).join(" · ")||"暂无"} tone="rose"/>
        </div>
      </section>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<Users/>} label="聪明钱池" value={String(data.fusion.coverage.strictSmartMoneyTraders)} meta="仅严格低风险高手" color="blue"/>
        <Stat icon={<Coins/>} label="交叉币种" value={String(data.fusion.coverage.hotCoins)} meta="全部热门币样本" color="amber"/>
        <Stat icon={<CheckCircle2/>} label="有聪明钱证据" value={String(evidence.length)} meta="置信度 ≥ 20" color="green"/>
        <Stat icon={<AlertTriangle/>} label="高热未确认" value={String(unconfirmed.filter(c=>c.heatScore>=55).length)} meta="禁止直接视为看多" color="violet"/>
      </div>

      <Tabs defaultValue="fusion" className="space-y-5">
        <TabsList className="tabs">
          <TabsTrigger value="fusion">融合结论</TabsTrigger>
          <TabsTrigger value="matrix">31 币信号矩阵</TabsTrigger>
          <TabsTrigger value="pool">聪明钱池</TabsTrigger>
          <TabsTrigger value="method">计算口径</TabsTrigger>
        </TabsList>

        <TabsContent value="fusion" className="space-y-5">
          <section className="insight-grid">
            <InsightCard title="提前观察" tone="green" icon={<TrendingUp/>} text="聪明钱偏多，但广场热度尚未完全启动。" coins={early} onSelect={setSelected}/>
            <InsightCard title="高热未确认" tone="amber" icon={<Flame/>} text="广场讨论很热，但严格候选没有公开订单确认。" coins={unconfirmed.slice(0,6)} onSelect={setSelected}/>
            <InsightCard title="方向偏空" tone="rose" icon={<TrendingDown/>} text="聪明钱证据充分，但当前持仓与订单整体偏空。" coins={bearish} onSelect={setSelected}/>
          </section>

          <div className="grid gap-5 xl:grid-cols-[1.18fr_.82fr]">
            <Panel title="四层证据链" eyebrow={"当前币种 · "+selected.token} side={<Badge className={"status "+verdictClass(selected.label)}>{selected.stance}</Badge>}>
              <SignalChain coin={selected}/>
              <div className="conclusion-box">
                <div className={"decision-score "+verdictClass(selected.label)}><strong>{selected.decisionScore}</strong><span>证据折减后决策分</span></div>
                <div><b>{selected.label}</b><p>{selected.reason}</p></div>
              </div>
              {selected.existingFlags.length>0&&<div className="warning"><AlertTriangle size={16}/><span>市场侧附加提示：{selected.existingFlags.join("；")}</span></div>}
            </Panel>
            <SmartEvidence coin={selected}/>
          </div>

          <Panel title="广场、聪明钱与市场确认对比" eyebrow="决策优先排序 · 前 12" side={<BarChart3 size={18} className="text-slate-500"/>}>
            <div className="h-[360px]"><ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <BarChart data={chartData} margin={{top:18,right:10,left:-18,bottom:5}}>
                <CartesianGrid stroke="#ffffff0b" vertical={false}/><XAxis dataKey="token" tick={{fill:"#78879b",fontSize:12}} axisLine={false} tickLine={false}/>
                <YAxis domain={[0,100]} tick={{fill:"#647287",fontSize:12}} axisLine={false} tickLine={false}/>
                <Tooltip cursor={{fill:"#ffffff06"}} contentStyle={{background:"#0b1828",border:"1px solid #ffffff18",borderRadius:12}}/>
                <Legend wrapperStyle={{fontSize:12,color:"#8491a5"}}/>
                <Bar dataKey="广场热度" fill="#f5c451" radius={[4,4,0,0]} maxBarSize={18}/>
                <Bar dataKey="聪明钱" fill="#41d6c3" radius={[4,4,0,0]} maxBarSize={18}/>
                <Bar dataKey="市场确认" fill="#7aa7ff" radius={[4,4,0,0]} maxBarSize={18}/>
              </BarChart>
            </ResponsiveContainer></div>
          </Panel>
        </TabsContent>

        <TabsContent value="matrix" className="space-y-5">
          <Panel title="融合信号矩阵" eyebrow="按聪明钱证据折减后排序" side={<div className="filters"><label className="search"><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索币种"/></label><Select value={filter} onValueChange={setFilter}><SelectTrigger className="filter-select"><SelectValue/></SelectTrigger><SelectContent className="select-menu"><SelectItem value="全部">全部结论</SelectItem><SelectItem value="有聪明钱证据">有聪明钱证据</SelectItem><SelectItem value="高热未确认">高热未确认</SelectItem><SelectItem value="提前观察">提前观察</SelectItem><SelectItem value="偏空">偏空</SelectItem></SelectContent></Select></div>} flush>
            <FusionTable rows={shown} selected={selected.token} onSelect={setSelected}/>
          </Panel>
          <div className="grid gap-5 xl:grid-cols-[1.18fr_.82fr]"><Panel title="四层证据链" eyebrow={"当前币种 · "+selected.token}><SignalChain coin={selected}/><div className="conclusion-box compact"><div className={"decision-score "+verdictClass(selected.label)}><strong>{selected.decisionScore}</strong><span>决策分</span></div><div><b>{selected.label}</b><p>{selected.reason}</p></div></div></Panel><SmartEvidence coin={selected}/></div>
        </TabsContent>

        <TabsContent value="pool" className="space-y-5">
          <Panel title="参与融合计算的聪明钱池" eyebrow="16 位严格低风险候选" side={<Badge className="badge amber">风险分 &lt; 25</Badge>} flush>
            <div className="table-scroll"><table className="trader-table smart-pool-table"><thead><tr><th>带单员</th><th>综合分</th><th>真实性风险</th><th>中位持仓</th><th>完整周期</th><th>覆盖天数</th><th>ROI</th><th>MDD</th><th>跟单者 PnL</th><th></th></tr></thead><tbody>
              {strictTraders.map(t=><tr key={t.id}><td><b>{t.name}</b><small>样本置信度 {(t.metrics.confidence*100).toFixed(0)}%</small></td><td className={scoreTone(t.score)}>{t.score}</td><td className="pos">{t.metrics.washRiskScore}</td><td>{duration(t.metrics.medianHoldSeconds)}</td><td>{t.metrics.completeCycleCount}</td><td>{t.metrics.coverageDays}</td><td className="pos">{t.performance.roi.toFixed(1)}%</td><td>{t.performance.mdd.toFixed(1)}%</td><td className="pos">{money(t.performance.copierPnl)}</td><td><a href={t.url} target="_blank" rel="noreferrer" aria-label={"打开 "+t.name+" 币安页面"}><ExternalLink size={15}/></a></td></tr>)}
            </tbody></table></div>
          </Panel>
          <div className="notice"><ShieldCheck size={16}/><span><b>不是把所有榜单高手都叫作聪明钱</b>只有公开订单、样本充分、跟单者盈利为正、回撤合格且真实性风险低于 25 的账户，才参与币种方向投票。</span></div>
        </TabsContent>

        <TabsContent value="method" className="space-y-5">
          <Panel title="融合模型" eyebrow="从讨论热度到数据结论" side={<Database size={19} className="text-sky-300"/>}>
            <div className="method-flow">
              <MethodNode n="25%" title="广场热度" text="热门榜位、搜索、成交额与波动"/>
              <ArrowRight/>
              <MethodNode n="20%" title="广场情绪" text="头部交易者与大户买卖倾向"/>
              <ArrowRight/>
              <MethodNode n="40%" title="聪明钱验证" text="真实持仓、24h订单、方向收益"/>
              <ArrowRight/>
              <MethodNode n="15%" title="市场确认" text="价格动量与主动买卖比"/>
            </div>
          </Panel>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="聪明钱内部权重" eyebrow="避免榜单收益掩盖行为异常">
              <div className="weight-list"><Weight label="当前未平仓方向" value={48}/><Weight label="最近 24h 方向订单" value={36}/><Weight label="最近 24h 方向收益" value={16}/></div>
            </Panel>
            <Panel title="证据边界" eyebrow="一次性快照">
              <div className="evidence-list"><span><CheckCircle2/>每位高手按综合分、真实性和样本置信度加权</span><span><CheckCircle2/>无聪明钱订单的热门币会被降低决策分</span><span><CheckCircle2/>多空结论展示实际参与人数与名义敞口</span><span><EyeOff/>隐藏持仓账户不参与聪明钱投票</span></div>
            </Panel>
          </div>
        </TabsContent>
      </Tabs>

      <footer><span>Alpha Radar · 研究工具，不构成投资建议</span><span>广场热度 × 16 位低风险带单高手 × 官方合约行情 · {snapshot} 一次性快照</span></footer>
    </div>
  </main>;
}

function Panel({title,eyebrow,side,children,flush=false}:{title:string;eyebrow:string;side?:React.ReactNode;children:React.ReactNode;flush?:boolean}){
  return <section className={"panel "+(flush?"flush":"")}><div className="panel-head"><div><p>{eyebrow}</p><h2>{title}</h2></div>{side}</div>{children}</section>;
}
function Stat({icon,label,value,meta,color}:{icon:React.ReactNode;label:string;value:string;meta:string;color:string}){
  return <article className={"stat "+color}><div>{icon}</div><strong>{value}</strong><b>{label}</b><small>{meta}</small></article>;
}
function VerdictMini({icon,label,value,tone}:{icon:React.ReactNode;label:string;value:string;tone:string}){
  return <div className={"verdict-mini "+tone}><span>{icon}{label}</span><b>{value}</b></div>;
}
function InsightCard({title,tone,icon,text,coins,onSelect}:{title:string;tone:string;icon:React.ReactNode;text:string;coins:FusionCoin[];onSelect:(c:FusionCoin)=>void}){
  return <article className={"insight-card "+tone}><div className="insight-title"><span>{icon}</span><div><h2>{title}</h2><p>{text}</p></div></div><div className="coin-chips">{coins.length?coins.map(c=><button key={c.token} onClick={()=>onSelect(c)}><b>{c.token}</b><span>{c.smartMoneyConfidence>0?"聪明钱 "+c.smartMoneyScore:"热度 "+c.heatScore}</span></button>):<em>暂无</em>}</div></article>;
}
function SignalChain({coin:c}:{coin:FusionCoin}){
  return <div className="signal-chain">
    <SignalNode label="广场热度" score={c.heatScore} meta={c.hotRank?"热门榜 #"+c.hotRank:"扩展样本"} tone="amber"/>
    <ArrowRight/>
    <SignalNode label="广场情绪" score={c.squareSentimentScore} meta={c.squareSentimentLabel} tone="violet"/>
    <ArrowRight/>
    <SignalNode label="聪明钱" score={c.smartMoneyScore} meta={c.smartMoneyConfidence+"% 置信"} tone="green"/>
    <ArrowRight/>
    <SignalNode label="市场确认" score={c.marketConfirmationScore} meta={(c.priceChangePct>0?"+":"")+c.priceChangePct+"% / 24h"} tone="blue"/>
  </div>;
}
function SignalNode({label,score,meta,tone}:{label:string;score:number;meta:string;tone:string}){
  return <div className={"signal-node "+tone}><span>{label}</span><strong>{score}</strong><small>{meta}</small><Progress value={score}/></div>;
}
function SmartEvidence({coin:c}:{coin:FusionCoin}){
  const side=c.currentLongNotional>c.currentShortNotional?"净多":c.currentShortNotional>c.currentLongNotional?"净空":"无持仓";
  return <aside className="panel smart-evidence">
    <div className="panel-head"><div><p>聪明钱证据</p><h2>{c.token} · {c.smartMoneyConfidence}% 置信</h2></div><Gauge size={19} className="text-slate-500"/></div>
    <div className="smart-metrics"><Metric label="参与高手" value={String(c.strictTraderCount)} tone="text-sky-300"/><Metric label="当前持仓账户" value={String(c.currentPositionTraderCount)} tone="text-emerald-300"/><Metric label="24h 活跃账户" value={String(c.recentTraderCount)} tone="text-violet-300"/><Metric label="24h 订单" value={String(c.recentOrderCount)} tone="text-amber-300"/></div>
    <div className="exposure"><div><span>当前多头</span><b>{money(c.currentLongNotional)}</b></div><div><span>当前空头</span><b>{money(c.currentShortNotional)}</b></div><div className={side==="净多"?"long":side==="净空"?"short":""}><span>净方向</span><b>{side}</b></div></div>
    <div className="participant-list">{c.topParticipants.length?c.topParticipants.map(p=><div key={p.traderId}><span className={"side-dot "+(p.currentSide==="LONG"?"long":p.currentSide==="SHORT"?"short":"flat")}/><div><b>{p.name}</b><small>综合 {p.score} · 风险 {p.risk}</small></div><em>{p.currentSide==="LONG"?"持多":p.currentSide==="SHORT"?"持空":p.recentFlow>0?"近期买入":"近期卖出"}</em></div>):<div className="empty-evidence"><EyeOff/><b>严格候选中没有该币的公开订单</b><p>这不是看空，而是无法用聪明钱证明广场热度。</p></div>}</div>
  </aside>;
}
function Metric({label,value,tone}:{label:string;value:string;tone:string}){return <div><strong className={tone}>{value}</strong><small>{label}</small></div>;}
function FusionTable({rows,selected,onSelect}:{rows:FusionCoin[];selected:string;onSelect:(c:FusionCoin)=>void}){
  return <div className="table-scroll"><table className="fusion-table"><thead><tr><th>币种</th><th>决策分</th><th>广场热度</th><th>广场情绪</th><th>聪明钱</th><th>证据置信</th><th>当前多 / 空</th><th>24h 方向流</th><th>数据结论</th></tr></thead><tbody>{rows.map(c=><tr key={c.token} onClick={()=>onSelect(c)} className={selected===c.token?"selected":""}><td><b>{c.token}</b><small>#{c.fusionRank}</small></td><td className={scoreTone(c.decisionScore)}>{c.decisionScore}</td><td>{c.heatScore}</td><td>{c.squareSentimentScore}</td><td className={scoreTone(c.smartMoneyScore)}>{c.smartMoneyScore}</td><td><div className="confidence-cell"><Progress value={c.smartMoneyConfidence}/><span>{c.smartMoneyConfidence}%</span></div></td><td><span className="pos">{money(c.currentLongNotional)}</span> / <span className="neg">{money(-c.currentShortNotional)}</span></td><td className={c.recentNetDirectionalNotional>=0?"pos":"neg"}>{money(c.recentNetDirectionalNotional)}</td><td><Badge className={"status "+verdictClass(c.label)}>{c.label}</Badge></td></tr>)}</tbody></table></div>;
}
function MethodNode({n,title,text}:{n:string;title:string;text:string}){return <div className="method-node"><strong>{n}</strong><h3>{title}</h3><p>{text}</p></div>;}
function Weight({label,value}:{label:string;value:number}){return <div><span>{label}<b>{value}%</b></span><Progress value={value}/></div>;}
