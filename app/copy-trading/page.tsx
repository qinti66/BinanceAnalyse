"use client";
import { ModuleNav } from "@/components/module-nav";
import {useEffect,useMemo,useState} from "react";
import {ShieldCheck,Users,RefreshCw,Star,AlertTriangle,ExternalLink,Check,Minus} from "lucide-react";
import {Tabs,TabsList,TabsTrigger} from "@/components/ui/tabs";
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from "@/components/ui/select";
import {effectivePool,type Snapshot,type Trader,type Pool} from "@/lib/copy-trading/model";
import "../square/square.css";
import "./pools.css";
const SERVICE="http://127.0.0.1:8792",PREFS="alpha-copy-pools-preferences-v1";
type Preferences={qualityHours:number;ordinaryHours:number;stars:string[]};
type Job={state:string;message:string;scope?:string;error?:string};
const defaults:Preferences={qualityHours:4,ordinaryHours:24,stars:[]};
const cash=(n:number|null|undefined)=>n==null?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",notation:"compact",maximumFractionDigits:2}).format(n);
const num=(n:number|null|undefined,d=1)=>n==null?"—":n.toFixed(d);
const pct=(n:number|null|undefined)=>n==null?"—":n.toFixed(2)+"%";
const date=(s:string|number|null)=>s===null?"尚未更新":new Date(s).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
const duration=(s:number|null)=>s===null?"—":s<60?Math.round(s)+"秒":s<3600?num(s/60)+"分钟":s<86400?num(s/3600)+"小时":num(s/86400)+"天";
function Picker({label,value,onChange,options}:{label:string;value:string;onChange:(v:string)=>void;options:Record<string,string>}){
 return <label className="sq-field"><span>{label}</span><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="sq-select"><SelectValue/></SelectTrigger><SelectContent>{Object.entries(options).map(([v,l])=><SelectItem value={v} key={v}>{l}</SelectItem>)}</SelectContent></Select></label>;
}
export default function CopyTrading(){
 const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(""),[status,setStatus]=useState("读取带单快照…");
 const [pool,setPool]=useState<Pool>("quality"),[query,setQuery]=useState(""),[filter,setFilter]=useState("all"),[sort,setSort]=useState("score"),[selected,setSelected]=useState<string|null>(null);
 const [prefs,setPrefs]=useState<Preferences>(defaults),[prefReady,setPrefReady]=useState(false),[busy,setBusy]=useState(false),[local,setLocal]=useState(false),[clock,setClock]=useState(Date.now());
 async function load(){
  const r=await fetch("/copy-trading/latest.json?t="+Date.now(),{cache:"no-store"});if(!r.ok)throw Error("暂无带单快照，请先启动本地服务并更新。");
  const j=await r.json() as Snapshot;if(j.schemaVersion!==1||!Array.isArray(j.traders))throw Error("快照格式不正确，旧数据保留。");
  setData(j);setError("");setClock(Date.now());
 }
 useEffect(()=>{
  load().catch(e=>setError(e.message));
  const isLocal=["127.0.0.1","localhost"].includes(window.location.hostname);setLocal(isLocal);
  try{const p=JSON.parse(localStorage.getItem(PREFS)??"null");if(p&&[1,4,12,24,168].includes(p.qualityHours)&&[1,4,12,24,168].includes(p.ordinaryHours)&&Array.isArray(p.stars))setPrefs({...p,stars:p.stars.filter((s:unknown)=>typeof s==="string")});}catch{/* defaults; never start a timer */}
  setPrefReady(true);
  if(isLocal)fetch(SERVICE+"/status",{signal:AbortSignal.timeout(2000)}).then(r=>r.json() as Promise<Job>).then(j=>{setStatus(j.message);if(j.state==="running")setBusy(true);}).catch(()=>setStatus("本地更新服务未启动，仍可浏览已保存快照。"));
  else setStatus("只读快照；手动更新仅在本地服务运行时可用。");
  const onFocus=()=>setClock(Date.now());window.addEventListener("focus",onFocus);
  // Re-evaluate badge expiry only; this interval never collects remote data.
  const expiry=setInterval(onFocus,60000);
  return()=>{window.removeEventListener("focus",onFocus);clearInterval(expiry);};
 },[]);
 useEffect(()=>{
  if(!busy)return;let stopped=false,inFlight=false;
  const t=setInterval(async()=>{if(inFlight)return;inFlight=true;try{
   const r=await fetch(SERVICE+"/status",{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();
   const j=await r.json() as Job;if(stopped)return;setStatus(j.message);
   if(j.state==="complete"){await load();if(!stopped)setBusy(false);}
   if(j.state==="failed"||j.state==="idle")setBusy(false);
  }catch{if(!stopped){setStatus("更新连接中断，保留旧快照；重新打开页面可检查任务。");setBusy(false);}}finally{inFlight=false;}},1500);
  return()=>{stopped=true;clearInterval(t);};
 },[busy]);
 function save(p:Preferences){try{localStorage.setItem(PREFS,JSON.stringify(p));setPrefs(p);setStatus("标记与周期偏好已保存到本机浏览器；自动更新仍关闭。");}catch{setStatus("浏览器不允许保存设置，本次改动未保存。");}}
 async function update(scope:Pool|"all"){
  if(busy)return;setStatus("正在连接本地带单采集服务…");
  try{const r=await fetch(SERVICE+"/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({scope}),signal:AbortSignal.timeout(5000)});
   const j=await r.json() as Job;if(r.status!==202&&r.status!==409)throw Error(j.error??"启动失败");setBusy(true);setStatus(j.message);
  }catch(e){setStatus("未启动更新："+(e as Error).message+"。请启动本地带单服务；旧数据未改变。");}
 }
 const totals=useMemo(()=>({quality:data?.traders.filter(t=>effectivePool(t,clock)==="quality").length??0,ordinary:data?.traders.filter(t=>effectivePool(t,clock)==="ordinary").length??0}),[data,clock]);
 const rows=useMemo(()=>{
  const key=(t:Trader)=>sort==="roi"?t.performance["30D"].roi:sort==="hold"?t.metrics.medianHoldSeconds:sort==="risk"?t.metrics.anomalyScore:t.score;
  return (data?.traders??[]).filter(t=>effectivePool(t,clock)===pool&&(t.name+" "+t.id).toLowerCase().includes(query.trim().toLowerCase())&&(filter==="all"||filter==="star"&&prefs.stars.includes(t.id)||filter==="risk"&&(t.metrics.anomalyScore??0)>=25||filter==="missing"&&t.reasons.length>0)).sort((a,b)=>{const av=key(a),bv=key(b);return av===null?bv===null?0:1:bv===null?-1:bv-av;});
 },[data,clock,pool,query,filter,sort,prefs.stars]);
 const trader=rows.find(t=>t.id===selected)??rows[0];
 return <main className="sq cp"><header className="sq-header"><div className="sq-shell sq-row"><div className="sq-brand"><span className="sq-mark"><ShieldCheck size={22}/></span><div><strong>Alpha Radar</strong><small>带单聪明钱 / SOURCE 03</small></div></div><ModuleNav current="/copy-trading"/></div></header>
 <div className="sq-shell sq-content"><div className="sq-row cp-heading"><div><h1>带单双池</h1><p>先核验交易质量，再标记聪明钱。系统评级与个人关注分开保留。</p></div><div className="cp-actions"><button className="sq-button" disabled={busy} onClick={()=>load().catch(e=>setError(e.message))}>读取保存快照</button><button className="sq-button sq-primary" disabled={!local||busy} onClick={()=>update("all")}><RefreshCw size={16} className={busy?"sq-spin":""}/>{busy?"采集进行中…":"更新两个池"}</button></div></div>
 <div className="sq-status sq-row"><span role="status" aria-live="polite">{status}</span><span>自动更新关闭 · 无跟单、无下单</span></div>
 {error&&<div className="sq-notice" role="alert">{error}</div>}
 <div className="cp-pools">{(["quality","ordinary"] as const).map(p=><section className={"sq-card cp-pool "+(pool===p?"active":"")} key={p}><div className="sq-row"><h2>{p==="quality"?<ShieldCheck size={20}/>:<Users size={20}/>} {p==="quality"?"优质池":"普通池"}</h2><strong>{totals[p]} <small>位</small></strong></div><p>{p==="quality"?"自动标记「优质聪明钱 · 候选」，全部质量门槛通过。":"保留未达标、资料不足或异常待复核的带单组合。"}</p><div className="cp-poolbottom"><span>上次处理：{date(data?.poolUpdatedAt[p]??null)}</span><button className="sq-button" disabled={busy||!local||!data||totals[p]===0} onClick={()=>update(p)}>{p==="quality"?"更新优质池":"更新普通池"}</button></div></section>)}</div>
 <div className="sq-notice"><AlertTriangle size={17}/><span>“聪明钱”是本工具的候选标记，不是币安官方认证。公开数据不能证明或排除对刷；资料缺失不视为低风险，历史残留订单也不等于当前实仓。</span></div>
 {data&&<><div className="cp-meta">来源：{data.source} · 候选榜单发现 {data.coverage.discovered} 位，分析 {data.traders.length} 位 · 公开订单样本 {data.coverage.orders.toLocaleString()} 条 · 非全平台全集</div>
 {data.coverage.errors>0&&<div className="sq-notice cp-errors"><AlertTriangle size={17}/><span>{data.coverage.errors} 位的本次资料获取不完整，已暂停其优质资格。有历史证据的保留原时间，无历史证据的明确显示缺失；请在详情核对订单证据时间。</span></div>}
 <section className="sq-card cp-list"><div className="sq-tablehead"><Tabs value={pool} onValueChange={v=>{setPool(v as Pool);setSelected(null);}}><TabsList aria-label="带单池"><TabsTrigger value="quality">优质池</TabsTrigger><TabsTrigger value="ordinary">普通池</TabsTrigger></TabsList></Tabs><div className="sq-tools"><label className="sq-field"><span>带单员</span><input aria-label="搜索带单员" placeholder="昵称或组合 ID" value={query} onChange={e=>{setQuery(e.target.value);setSelected(null);}}/></label><Picker label="筛选标记" value={filter} onChange={setFilter} options={{all:"全部",star:"我的关注",risk:"异常需复核",missing:"尚有未通过门槛"}}/><Picker label="排序" value={sort} onChange={setSort} options={{score:"质量门槛通过率",roi:"30天 ROI",hold:"持仓中位数",risk:"异常筛查分"}}/></div></div>
 <div className="sq-scroll"><table><thead><tr><th>带单员 / 标记</th><th>30天 ROI / PNL</th><th>30天回撤 / 夏普</th><th>跟随者 PNL / 30天</th><th>持仓中位数</th><th>样本 / 订单跨度</th><th>异常筛查</th><th>门槛 / 数据时间</th><th>个人标记</th></tr></thead><tbody>{rows.map(t=><tr key={t.id} className={trader?.id===t.id?"sq-selected":""}><td><button className="sq-author" aria-label={"查看 "+t.name+" 详情"} onClick={()=>setSelected(t.id)}>{t.name} →</button><small className={effectivePool(t,clock)==="quality"?"sq-up":""}>{t.pool==="quality"&&effectivePool(t,clock)!=="quality"?"标记过期 · 待复核":t.autoTag}</small></td><td>{pct(t.performance["30D"].roi)}<small>{cash(t.performance["30D"].pnl)}</small></td><td>{pct(t.performance["30D"].mdd)}<small>夏普 {num(t.performance["30D"].sharpe,2)}</small></td><td>{cash(t.performance["30D"].copierPnl)}</td><td>{duration(t.metrics.medianHoldSeconds)}<small>5分钟内 {pct(t.metrics.under5mPct)}</small></td><td>{t.metrics.cycleCount} 个完整周期<small>{num(t.metrics.coverageDays)} 天 · 已排除边界周期</small></td><td>{t.metrics.anomalyScore===null?"样本不足":num(t.metrics.anomalyScore,0)+" / 100"}<small>{t.metrics.flags[0]?.label??"未触发不等于无风险"}</small></td><td>{t.checks.filter(c=>c.pass).length}/{t.checks.length} 项<small>{date(t.observedAt)}</small>{t.updateError&&<small className="sq-down">更新失败 · 保留旧证据</small>}</td><td><button className="cp-star" aria-label={(prefs.stars.includes(t.id)?"取消关注 ":"关注 ")+t.name} aria-pressed={prefs.stars.includes(t.id)} disabled={!prefReady} onClick={()=>save({...prefs,stars:prefs.stars.includes(t.id)?prefs.stars.filter(id=>id!==t.id):[...prefs.stars,t.id]})}><Star size={18} fill={prefs.stars.includes(t.id)?"currentColor":"none"}/></button></td></tr>)}</tbody></table></div>
 {!rows.length&&<div className="sq-noresults"><h3>{pool==="quality"?"暂无符合全部条件的优质候选":"没有符合筛选条件的带单员"}</h3><p>不会为了填满池子降低数据核验要求。</p><button className="sq-button" onClick={()=>{setPool("ordinary");setQuery("");setFilter("all");}}>查看普通池</button></div>}<div className="sq-tablefoot">显示 {rows.length} 位 · 质量门槛通过率不代表收益概率 · 个人星标不会改变优质评级</div></section>
 {trader&&<Detail t={trader} clock={clock}/>}
 <details className="sq-rules"><summary>入池与降级记录（最近500条）</summary><div className="cp-events">{data.changes.slice(0,30).map((c,i)=><p key={c.id+c.at+i}>{date(c.at)} · {c.name} · {c.from===null?"新纳入":c.from==="quality"?"优质池":"普通池"} → {c.to==="quality"?"优质池":"普通池"}<br/><span className="sq-muted">{c.reason}</span></p>)}</div></details></>}
 <section className="sq-card cp-settings"><div><h2>周期设置</h2><p>仅保存更新频率偏好，未启用调度；关闭页面后不会采集。</p></div><div className="sq-tools"><Picker label="优质池更新周期" value={String(prefs.qualityHours)} onChange={v=>save({...prefs,qualityHours:Number(v)})} options={{"1":"每1小时","4":"每4小时","12":"每12小时","24":"每天","168":"每周"}}/><Picker label="普通池更新周期" value={String(prefs.ordinaryHours)} onChange={v=>save({...prefs,ordinaryHours:Number(v)})} options={{"1":"每1小时","4":"每4小时","12":"每12小时","24":"每天","168":"每周"}}/><div className="cp-disabled"><strong>自动更新：关闭</strong><span>按你的要求，当前不提供启用开关</span></div></div></section>
 <details className="sq-rules"><summary>评级口径与数据局限</summary>{data?.notes.map(n=><p key={n}>{n}</p>)}<p>币安公开网页接口不是稳定的正式开放 API，字段或权限变化时暂停采集；不会绕过登录或限制。候选来自多个周期、多个榜单的前50名并集，存在选择偏差。</p><p><a href="https://www.binance.com/en/support/faq/detail/54aa6d3b43bc4f6eb4a3a6e3aea40acd" target="_blank" rel="noreferrer">币安合约带单业绩指标说明</a> · 规则 copy-pools-v1 · 周期与星标只存于本机浏览器</p></details>
 <footer className="sq-footer">带单模块独立维护，不自动改写广场或指标模块。更新两个池会重新发现候选；单池更新只复核现有成员。</footer></div></main>;
}
function Detail({t,clock}:{t:Trader;clock:number}){
 const m=t.metrics;
 return <section className="sq-card sq-detail cp-detail" aria-label="带单员详情"><div className="sq-row"><div><span className="sq-kicker">{effectivePool(t,clock)==="quality"?"优质聪明钱 · 候选":"普通池 · 继续核验"}</span><h2>{t.name}</h2><p className="sq-note">组合 ID {t.id} · 资料 {date(t.observedAt)}<br/>订单证据时间：{date(t.historyAt??t.observedAt)}{t.updateError?"（本轮未完整更新）":""}{t.mixedAssets?<><br/>包含传统资产合约标签；组合总收益不等于纯加密币种收益。</>:null}</p></div><a className="sq-button" href={t.sourceUrl} target="_blank" rel="noreferrer">查看币安来源 <ExternalLink size={14}/></a></div>
 <div className="cp-detailgrid"><div><h3>优质池门槛</h3><ul className="cp-checks">{t.checks.map(c=><li key={c.key} className={c.pass?"pass":""}>{c.pass?<Check size={16}/>:<Minus size={16}/>}<span>{c.label}</span></li>)}</ul><p className="sq-note">所有门槛均须通过；资料失效、变为不公开或更新失败会暂停优质标记。</p></div><div><h3>收益质量与持仓习惯</h3><dl className="sq-facts"><dt>运行天数</dt><dd>{num(t.tenureDays)} 天</dd><dt>90天 ROI / 回撤</dt><dd>{pct(t.performance["90D"].roi)} / {pct(t.performance["90D"].mdd)}</dd><dt>带单余额 / AUM</dt><dd>{cash(t.marginBalance)} / {cash(t.aum)}</dd><dt>样本利润因子</dt><dd>{num(m.profitFactor,2)}</dd><dt>单周期盈利贡献</dt><dd>{pct(m.topProfitPct)}</dd><dt>亏损周期</dt><dd>{m.lossCycles}</dd><dt>一分钟内平仓</dt><dd>{pct(m.under60sPct)}</dd><dt>快速同向重开</dt><dd>{pct(m.rapidReopenPct)}</dd><dt>快速反向开仓</dt><dd>{pct(m.oppositeReversalPct)}</dd><dt>同币双向重叠</dt><dd>{m.overlapCount} 次（可能为对冲）</dd></dl><p className="sq-note">{m.flags.map(f=>f.label).join("；")||"当前规则未触发异常信号，不能据此证明不存在对刷。"}<br/>异常分不是违规概率。</p></div><div><h3>证据完整性</h3><dl className="sq-facts"><dt>订单 / 周期</dt><dd>{m.orderCount} / {m.cycleCount}</dd><dt>边界不明周期</dt><dd>{m.boundaryCycles}</dd><dt>未匹配平仓</dt><dd>{m.unmatched}</dd><dt>方向不明确</dt><dd>{m.ambiguous}</dd><dt>疑似重复 / 同刻开平</dt><dd>{m.duplicates} / {m.sameTime}</dd><dt>未闭合残留</dt><dd>{m.unresolved.length} 组</dd><dt>最新订单</dt><dd>{date(m.lastOrderAt)}</dd></dl><p className="sq-note">{t.positionEvidence}<br/>{t.updateError??"公开数据不能核验撮合对手账户。"}<br/>持仓与利润因子是本次可重建样本统计，不等于全部历史业绩。</p></div></div>
 <details className="cp-cycles"><summary>查看最近20个重建完整周期</summary><div className="sq-scroll"><table><thead><tr><th>币种 / 方向</th><th>开仓 / 平仓时间</th><th>持仓时长</th><th>订单 PNL</th><th>开仓笔数</th></tr></thead><tbody>{m.cycles.slice(-20).reverse().map(c=><tr key={c.evidenceId}><td>{c.symbol} / {c.side}</td><td>{date(c.openedAt)}<small>{date(c.closedAt)}</small></td><td>{duration(c.holdSeconds)}</td><td>{cash(c.pnl)}</td><td>{c.adds}</td></tr>)}</tbody></table></div><p className="sq-note">不是扣除全部费用后的净利润，不含尚未平仓的浮亏/浮盈。</p></details></section>;
}
