"use client";
import { useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, MessageSquare, ShieldCheck, Users, ArrowRight, AlertTriangle } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { analyzeSquare, EVIDENCE_LABELS, RULES, RULE_VERSION, STATE_LABELS, type Assessment } from "@/lib/square/model";
import { DEMO_SNAPSHOT, EMPTY_SNAPSHOT } from "@/lib/square/demo";
import "./square.css";

const money=(v:number|null|undefined)=>v==null?"未公开":new Intl.NumberFormat("zh-CN",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(v);
const pct=(v:number|null|undefined)=>v==null?"未公开":v.toFixed(1)+"%";
const time=(v:string|null|undefined)=>v?new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}):"未知";
const direction=(d:number)=>d>0?"看多":d<0?"看空":"中性";
const tone=(d:number)=>d>0?"sq-up":d<0?"sq-down":"sq-muted";
const filters:Record<string,string>={all:"全部观点",supported:"有有效仓位加分",conflict:"方向矛盾",closed:"已平仓",unverified:"截图／仅自述",late:"发帖后开仓／补证",stale:"证据过期",unknown:"证据不足"};
function Picker({label,value,onChange,items}:{label:string;value:string;onChange:(v:string)=>void;items:Record<string,string>}){
 return <div className="sq-field"><span>{label}</span><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="sq-select"><SelectValue/></SelectTrigger><SelectContent>{Object.entries(items).map(([v,l])=><SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select></div>;
}
function Distribution({title,dist}:{title:string;dist:{bull:number;bear:number;neutral:number;net:number}}){
 return <article className="sq-distribution"><div className="sq-row"><h3>{title}</h3><span className={tone(dist.net)}>净情绪 {dist.net>0?"+":""}{dist.net.toFixed(1)}</span></div><div className="sq-bar" role="img" aria-label={title+"：看多 "+dist.bull+"%，中性 "+dist.neutral+"%，看空 "+dist.bear+"%"}><span className="sq-bull-bar" style={{width:dist.bull+"%"}}/><span className="sq-neutral-bar" style={{width:dist.neutral+"%"}}/><span className="sq-bear-bar" style={{width:dist.bear+"%"}}/></div><div className="sq-legend"><span>看多 {dist.bull.toFixed(1)}%</span><span>中性 {dist.neutral.toFixed(1)}%</span><span>看空 {dist.bear.toFixed(1)}%</span></div></article>;
}
export default function SquarePage(){
 const [mode,setMode]=useState("demo"),[symbol,setSymbol]=useState("BTC"),[filter,setFilter]=useState("all");
 const [query,setQuery]=useState(""),[selected,setSelected]=useState<string|null>(null),[revision,setRevision]=useState(1);
 const [busy,setBusy]=useState(false),[status,setStatus]=useState("尚未触发任何网络采集。");
 const refreshing=useRef(false);
 const snapshot=mode==="demo"?DEMO_SNAPSHOT:EMPTY_SNAPSHOT;
 const coins=useMemo(()=>analyzeSquare(snapshot),[snapshot]),coin=coins.find(c=>c.symbol===symbol)??coins[0];
 const rows=coin?.rows.filter(r=>(filter==="all"||(filter==="supported"?r.eligible:r.state===filter))&&
   (r.post.authorName+" "+r.post.text).toLowerCase().includes(query.trim().toLowerCase()))??[];
 const current=coin?.rows.find(r=>r.post.id===selected);
 const eligible=coin?.supported??0;
 async function refresh(){
   if(refreshing.current)return;
   if(mode==="live"){setStatus("真实数据源尚未接入，未创建新快照；没有调用币安接口。");return;}
   refreshing.current=true;setBusy(true);setStatus("正在重新运行演示样本的去重与证据分析…");
   try{await new Promise(resolve=>setTimeout(resolve,550));analyzeSquare(DEMO_SNAPSHOT);setRevision(v=>v+1);setStatus("演示分析已完成；固定样本时间未改变，没有伪造新的采集时间。");}
   catch{setStatus("分析失败，保留上次可用样本。");}finally{refreshing.current=false;setBusy(false);}
 }
 const setCoin=(v:string)=>{setSymbol(v);setSelected(null);setFilter("all");setQuery("");};
 return <main className="sq">
 <header className="sq-header"><div className="sq-shell sq-row"><div className="sq-brand"><span className="sq-mark"><MessageSquare size={21}/></span><div><strong>Alpha Radar</strong><small>广场情绪 / SOURCE 01</small></div></div><a className="sq-back" href="/"><ArrowLeft size={16}/>原有融合分析</a></div></header>
 <div className="sq-shell sq-content">
 <div className="sq-row sq-heading"><div><span className="sq-eyebrow">从讨论到资金证据</span><h1>他说看多，他真的持有吗？</h1><p>把讨论热度、文本观点和仓位依据分开看。</p></div><button className="sq-button sq-primary" disabled={busy} onClick={refresh}><RefreshCw size={16} className={busy?"sq-spin":""}/>{busy?"分析中…":mode==="demo"?"重算演示样本":"检查数据接入"}</button></div>
 <div className="sq-sourcebar"><Tabs value={mode} onValueChange={v=>{setMode(v);setSelected(null);setStatus(v==="live"?"真实数据尚未接入。":"已切换至虚构演示样本。");}}><TabsList aria-label="数据模式"><TabsTrigger value="demo" disabled={busy}>演示样本</TabsTrigger><TabsTrigger value="live" disabled={busy}>真实数据 · 未接入</TabsTrigger></TabsList></Tabs><span className="sq-muted">{mode==="demo"?"虚构账户与仓位 · 非实盘":"等待合法可用的数据源"}</span></div>
 <div className="sq-notice"><AlertTriangle size={17}/><span>{snapshot.sourceNote}</span></div>
 <div className="sq-status sq-row"><span role="status" aria-live="polite">{status}</span><span>{mode==="demo"?"样本时间 "+time(snapshot.capturedAt)+"（北京时间） · 分析 v"+revision:"无可用真实快照"}</span></div>
 {!coin?<section className="sq-empty"><ShieldCheck size={32}/><h2>先有证据，再有结论。</h2><p>需要帖子正文、作者身份、发布时间，以及能对应到同一作者的仓位记录。</p><p>现有热门币买卖比例不会被当作文本情绪。没有公开仓位，不等于没有持仓。</p><button className="sq-button" onClick={()=>setMode("demo")}>查看演示交互 <ArrowRight size={16}/></button></section>:<>
 <div className="sq-coins" aria-label="选择币种">{coins.map(c=><button key={c.symbol} className={"sq-coin "+(coin.symbol===c.symbol?"active":"")} aria-pressed={coin.symbol===c.symbol} onClick={()=>setCoin(c.symbol)}><strong>{c.symbol}</strong><span>{c.authorCount} 位作者</span><small>{c.supported} 位有仓位加分</small></button>)}</div>
 <div className="sq-overview"><section className="sq-card sq-heat"><span className="sq-kicker">{coin.symbol} / 24H 讨论热度</span><strong>{coin.heat.toFixed(1)}<small>相对指数</small></strong><p>{coin.postCount} 条去重帖子 · {coin.authorCount} 位作者</p><small>仅由讨论、作者和互动计算；不是看多分数。</small></section><section className="sq-card sq-sentiment"><Distribution title="原始情绪" dist={coin.raw}/><Distribution title="仓位证据加权情绪" dist={coin.weighted}/><p className="sq-note">每位作者每币种取窗口内最新观点。有效仓位支持 {eligible}/{coin.authorCount}；权重最高 {RULES.maxWeight}×。比例是观点权重占比，不是胜率。</p></section></div>
 <div className="sq-row sq-insight"><span><ShieldCheck size={16}/> {eligible} 位有效支持</span><span><AlertTriangle size={16}/> {coin.conflicts} 位方向矛盾</span><span><Users size={16}/> 无仓位也保留原始观点</span></div>
 <section className="sq-card sq-tablecard"><div className="sq-tablehead"><div><h2>喊单与仓位</h2><p>观点是观点，仓位是证据。逐条看它们是否对得上。</p></div><div className="sq-tools"><label className="sq-field"><span>作者／观点</span><input aria-label="搜索作者或观点" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索作者或观点"/></label><Picker label="证据状态" value={filter} onChange={setFilter} items={filters}/></div></div>
 <div className="sq-scroll"><table><thead><tr><th>作者 / 发帖</th><th>观点</th><th>当前仓位</th><th>资金投入 / 规模</th><th>浮盈亏 / 已实现</th><th>证据与状态</th><th>权重</th></tr></thead><tbody>{rows.map(r=><OpinionRow key={r.post.id} row={r} selected={selected===r.post.id} onSelect={()=>setSelected(r.post.id)}/>)}</tbody></table></div>
 {!rows.length&&<div className="sq-noresults">没有符合条件的观点。<button className="sq-textbutton" onClick={()=>{setFilter("all");setQuery("");}}>清除筛选</button></div>}
 <div className="sq-tablefoot">显示 {rows.length} / {coin.authorCount} 位作者 · 未公开数值不按 0 处理 · 每条证据保留标识以供跨模块去重</div>
 </section>
 {current&&<EvidenceDetail row={current} close={()=>setSelected(null)}/>}
 <details className="sq-rules"><summary>查看加权规则与数据边界 <span>{RULE_VERSION}</span></summary><div><p>基础观点权重为 1。作者身份已关联、发帖前的仓位快照与当前仓位均同向，才获得 0.35 基础加分；实际投入、账户占比、发帖前持仓时长各最多加 0.10；已核验历史净盈利、至少 30 天 / 20 个完整周期且最大回撤不超过 20%，最多再加 0.10。总权重不超过 1.75。以上均为待回测的初版规则，不代表预测能力。</p><p>证据有效期暂定 6 小时。截图、自述、身份不匹配、未来数据、证据过期、发帖后才开仓和已平仓均不能获得当前仓位加分。高杠杆、单次浮盈和点赞数不增加方向权重。作者重复帖子去重，同一作者每币种只投一次；同一仓位证据不重复加权。</p><p>不因短时往返或盈利截图直接认定对刷。连续持仓、真实交易对手和完整历史尚不能由两次仓位快照证明；浮盈与已实现收益不是同一口径。</p></div></details>
 </>}
 <footer className="sq-footer">广场模块独立分析 · 不依赖带单模块运行 · 当前未连接交易账户，无下单功能</footer>
 </div></main>;
}
function OpinionRow({row:r,selected,onSelect}:{row:Assessment;selected:boolean;onSelect:()=>void}){
 const p=r.post,e=p.evidence;
 return <tr className={selected?"sq-selected":""}><td><button className="sq-author" aria-label={"查看 "+p.authorName+" 的证据"} aria-expanded={selected} onClick={onSelect}>{p.authorName}<ArrowRight size={14}/></button><small>{time(p.postedAt)}</small></td><td><span className={"sq-tag "+tone(p.direction)}>{direction(p.direction)}</span><small>{p.isCall?"明确喊单":"非方向性观点"}</small></td><td>{e?<><span className={tone(e.current.side)}>{e.market==="spot"?"现货":e.current.side>0?"合约多仓":"合约空仓"}</span><small>{e.current.state==="closed"?"已平仓":e.current.state==="reduced"?"已减仓":"观察时持仓"}</small><small>{e.current.state!=="closed"&&r.holdHours!==null?"仓龄 "+r.holdHours.toFixed(1)+" 小时":"仓龄未知／不适用"}</small></>:<span className="sq-muted">未公开</span>}</td><td>{e?<><span>投入 {money(e.marginUsd)}</span><small>名义 {money(e.notionalUsd)}</small><small>占账户 {pct(r.authorSharePct)} · {e.leverage??"未知"}×杠杆</small></>:<span className="sq-muted">未知</span>}</td><td>{e?<><span className={tone(e.unrealizedPnlUsd??0)}>浮动 {money(e.unrealizedPnlUsd)}</span><small>浮动收益率 {pct(e.unrealizedRoiPct)}</small><small>已实现 {money(e.realizedPnlUsd)}</small></>:<span className="sq-muted">未公开</span>}</td><td><span className={"sq-evidence-label "+(r.eligible?"sq-up":"")}>{e?EVIDENCE_LABELS[e.grade]:"无公开证据"}</span><small className={r.state==="conflict"?"sq-down":""}>{STATE_LABELS[r.state]}</small></td><td><strong>{r.weight.toFixed(2)}×</strong><button className="sq-textbutton" onClick={onSelect}>加分依据</button></td></tr>;
}
function EvidenceDetail({row:r,close}:{row:Assessment;close:()=>void}){
 const p=r.post,e=p.evidence;
 return <section className="sq-card sq-detail" aria-label="作者证据详情"><div className="sq-row"><div><span className="sq-kicker">证据追溯 / {p.symbol}</span><h2>{p.authorName}</h2></div><button className="sq-button" onClick={close}>收起明细</button></div><blockquote>“{p.text}”</blockquote><div className="sq-detailgrid"><div><h3>时间与仓位</h3><ol className="sq-timeline"><li><b>开仓</b><span>{time(e?.openedAt)}</span></li><li><b>发帖时证据</b><span>{time(e?.atPost?.observedAt)} · {e?.atPost?(e.atPost.side>0?"多":"空")+" / "+e.atPost.state:"没有可用快照"}</span></li><li><b>发表观点</b><span>{time(p.postedAt)} · {direction(p.direction)}</span></li><li><b>当前观察</b><span>{time(e?.current.observedAt)} · {STATE_LABELS[r.state]}</span></li></ol><p className="sq-note">仓龄计算到仓位观察时刻；不证明期间一直连续持仓。</p></div><div><h3>权重如何得到</h3><div className="sq-breakdown"><span>基础观点</span><b>1.00</b></div>{r.eligible&&r.bonuses.map(b=><div className="sq-breakdown" key={b.label}><span>{b.label}</span><b>+{b.value.toFixed(2)}</b></div>)}<div className="sq-breakdown sq-total"><span>最终方向权重</span><b>{r.weight.toFixed(2)}×</b></div>{r.reasons.map(reason=><p className="sq-note" key={reason}>{reason}</p>)}</div><div><h3>规模与收益口径</h3><dl className="sq-facts"><dt>开仓价</dt><dd>{money(e?.entryPrice)}</dd><dt>实际投入</dt><dd>{money(e?.marginUsd)}</dd><dt>账户权益</dt><dd>{money(e?.equityUsd)}</dd><dt>当前浮盈亏</dt><dd>{money(e?.unrealizedPnlUsd)}</dd><dt>已实现盈亏</dt><dd>{money(e?.realizedPnlUsd)}</dd><dt>已实现费用口径</dt><dd>{e?.feesIncluded===true?"已含费用":e?.feesIncluded===false?"未含费用":"未知"}</dd><dt>历史样本</dt><dd>{e?.history?e.history.days+" 天 / "+e.history.closedCycles+" 周期":"未核验"}</dd><dt>历史最大回撤</dt><dd>{pct(e?.history?.maxDrawdownPct)}</dd></dl></div></div><div className="sq-proof"><span>来源：{e?.source??"无公开仓位来源"}</span><span>证据标识：{r.evidenceId??"无"} · 身份关联：{e?.identityVerified?"样例已关联":"未完成"}</span></div></section>;
}
