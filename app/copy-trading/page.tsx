"use client";
import { ModuleNav } from "@/components/module-nav";
import {useEffect,useMemo,useState,useSyncExternalStore} from "react";
import {ShieldCheck,Users,RefreshCw,Star,AlertTriangle,ExternalLink,Check,Minus,X,Tag} from "lucide-react";
import {Tabs,TabsList,TabsTrigger} from "@/components/ui/tabs";
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from "@/components/ui/select";
import type {Snapshot,Entity,Pool,PositionEvent} from "@/lib/copy-trading/hyperliquid-model";
import "../square/square.css";
import "./pools.css";
const SERVICE="http://127.0.0.1:8792",STARS="alpha-hyperliquid-stars-v1";
type Job={state:string;message:string;error?:string};
const cash=(n:number|null|undefined)=>n==null?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",notation:"compact",maximumFractionDigits:2}).format(n);
const num=(n:number|null|undefined,d=1)=>n==null?"—":n.toFixed(d);
const pct=(n:number|null|undefined,d=2)=>n==null?"—":(n>0?"+":"")+n.toFixed(d)+"%";
const date=(s:string|number|null)=>s===null?"尚未更新":new Date(s).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
const short=(a:string)=>a.slice(0,6)+"…"+a.slice(-4);
const color=(n:number|null|undefined)=>n==null?"sq-muted":n>0?"sq-up":n<0?"sq-down":"sq-muted";
function Picker({label,value,onChange,options}:{label:string;value:string;onChange:(v:string)=>void;options:Record<string,string>}){
 return <label className="sq-field"><span>{label}</span><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="sq-select"><SelectValue/></SelectTrigger><SelectContent>{Object.entries(options).map(([v,l])=><SelectItem value={v} key={v}>{l}</SelectItem>)}</SelectContent></Select></label>;
}
// 本地采集服务只在本机访问时可用；用外部存储读取主机名，服务端渲染时视为非本机，避免在 effect 里同步 setState。
const isLocalHost=()=>["127.0.0.1","localhost"].includes(window.location.hostname);
const noSubscribe=()=>()=>{};
// 个人星标存于 localStorage；用外部存储读取（而不是 effect 里 setState），写入后手动通知订阅者触发重渲染。
const starListeners=new Set<()=>void>();
// useSyncExternalStore 要求 getSnapshot 在值不变时返回同一引用，否则会无限重渲染；这里按原始字符串缓存解析结果。
let starsCache:{raw:string;value:string[]}|null=null;
const readStars=():string[]=>{
 let raw="[]";try{raw=localStorage.getItem(STARS)??"[]";}catch{raw="[]";}
 if(starsCache&&starsCache.raw===raw)return starsCache.value;
 let value:string[]=[];try{const s=JSON.parse(raw);if(Array.isArray(s))value=s.filter((x:unknown)=>typeof x==="string");}catch{value=[];}
 starsCache={raw,value};return value;
};
const writeStars=(next:string[]):boolean=>{try{localStorage.setItem(STARS,JSON.stringify(next));}catch{return false;}starListeners.forEach(l=>l());return true;};
const subscribeStars=(onChange:()=>void)=>{starListeners.add(onChange);return()=>{starListeners.delete(onChange);};};
const emptyStars:string[]=[];
// 自定义标签：每个地址对应一组用户自己写的标签，同样只存本机浏览器，不上传、不影响候选/观察池判定，纯粹方便自己筛选。
const TAGS="alpha-hyperliquid-tags-v1";
const tagListeners=new Set<()=>void>();
let tagsCache:{raw:string;value:Record<string,string[]>}|null=null;
const emptyTags:Record<string,string[]>={};
const readTags=():Record<string,string[]>=>{
 let raw="{}";try{raw=localStorage.getItem(TAGS)??"{}";}catch{raw="{}";}
 if(tagsCache&&tagsCache.raw===raw)return tagsCache.value;
 let value:Record<string,string[]>={};
 try{const s=JSON.parse(raw);if(s&&typeof s==="object"&&!Array.isArray(s))for(const [k,v] of Object.entries(s))if(Array.isArray(v))value[k]=v.filter((x):x is string=>typeof x==="string"&&x.trim().length>0);}catch{value={};}
 tagsCache={raw,value};return value;
};
const writeTags=(next:Record<string,string[]>):boolean=>{try{localStorage.setItem(TAGS,JSON.stringify(next));}catch{return false;}tagListeners.forEach(l=>l());return true;};
const subscribeTags=(onChange:()=>void)=>{tagListeners.add(onChange);return()=>{tagListeners.delete(onChange);};};
async function fetchSnapshot():Promise<Snapshot>{
 const r=await fetch("/copy-trading/latest.json?t="+Date.now(),{cache:"no-store"});
 if(!r.ok)throw Error("暂无 Hyperliquid 快照，请先启动本地服务并更新。");
 const j=await r.json() as Snapshot;if(j.schemaVersion!==2||!Array.isArray(j.entities))throw Error("快照格式不正确（可能是旧版币安带单快照），请重新更新。");
 return j;
}
export default function CopyTrading(){
 const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(""),[status,setStatus]=useState("");
 const [pool,setPool]=useState<Pool|"all">("quality"),[kind,setKind]=useState<"all"|"trader"|"vault">("all"),[query,setQuery]=useState(""),[sort,setSort]=useState("accountValue"),[selected,setSelected]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const local=useSyncExternalStore(noSubscribe,isLocalHost,()=>false);
 const stars=useSyncExternalStore(subscribeStars,readStars,()=>emptyStars);
 const tags=useSyncExternalStore(subscribeTags,readTags,()=>emptyTags);
 // 读取与校验放在组件外；状态只在异步结果返回后更新，避免 effect 内同步 setState。
 const load=()=>fetchSnapshot().then(j=>{setData(j);setError("");},e=>setError((e as Error).message));
 useEffect(()=>{
  void load();
  if(isLocalHost())fetch(SERVICE+"/status",{signal:AbortSignal.timeout(2000)}).then(r=>r.json() as Promise<Job>).then(j=>{setStatus(j.message);if(j.state==="running")setBusy(true);}).catch(()=>setStatus("本地更新服务未启动，仍可浏览已保存快照。"));
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
 function saveStars(next:string[]){if(!writeStars(next))setStatus("浏览器不允许保存设置，本次改动未保存。");}
 function addTag(address:string,tag:string){
  const clean=tag.trim();if(!clean)return;
  const existing=tags[address]??[];if(existing.includes(clean))return;
  if(!writeTags({...tags,[address]:[...existing,clean]}))setStatus("浏览器不允许保存设置，本次改动未保存。");
 }
 function removeTag(address:string,tag:string){
  const next={...tags,[address]:(tags[address]??[]).filter(t=>t!==tag)};
  if(next[address].length===0)delete next[address];
  if(!writeTags(next))setStatus("浏览器不允许保存设置，本次改动未保存。");
 }
 async function update(){
  if(busy)return;setStatus("正在连接本地 Hyperliquid 采集服务…");
  try{const r=await fetch(SERVICE+"/update",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(5000)});
   const j=await r.json() as Job;if(r.status!==202&&r.status!==409)throw Error(j.error??"启动失败");setBusy(true);setStatus(j.message);
  }catch(e){setStatus("未启动更新："+(e as Error).message+"。请启动本地 Hyperliquid 服务；旧数据未改变。");}
 }
 const totals=useMemo(()=>({quality:data?.entities.filter(e=>e.pool==="quality").length??0,ordinary:data?.entities.filter(e=>e.pool==="ordinary").length??0}),[data]);
 const rows=useMemo(()=>{
  const key=(e:Entity)=>sort==="allTime"?e.performance.allTime?.pnl??null:sort==="day"?e.performance.day?.pnl??null:sort==="followers"?(e.kind==="vault"?e.followerCount??e.tvl:e.accountValue):sort==="exposure"?e.netExposurePct:e.accountValue;
  const q=query.trim().toLowerCase();
  // 搜索同时匹配地址、名称和自己打的标签，这样标签才真正能用来筛选，不只是展示。
  return (data?.entities??[]).filter(e=>(pool==="all"||e.pool===pool)&&(kind==="all"||e.kind===kind)&&((e.name??"")+" "+e.address+" "+(tags[e.address]??[]).join(" ")).toLowerCase().includes(q))
   .sort((a,b)=>{const av=key(a),bv=key(b);return av===null?bv===null?0:1:bv===null?-1:bv-av;});
 },[data,pool,kind,query,sort,tags]);
 const entity=rows.find(e=>e.address===selected)??rows[0];
 // 本轮（即最新一次采集）新开的仓位单独提炼出来提醒；其余历史事件在下方的详情区展开查看。
 const freshOpens=useMemo(()=>data?.events.filter(e=>e.detectedAt===data.generatedAt&&e.type==="opened")??[],[data]);
 return <main className="sq cp"><header className="sq-header"><div className="sq-shell sq-row"><div className="sq-brand"><span className="sq-mark"><ShieldCheck size={22}/></span><div><strong>Alpha Radar</strong><small>Hyperliquid 聪明钱 / SOURCE 03</small></div></div><ModuleNav current="/copy-trading"/></div></header>
 <div className="sq-shell sq-content"><div className="sq-row cp-heading"><div><h1>Hyperliquid 聪明钱</h1><p>官方链上公开数据：能看到「现在」的实时持仓，不再只是重建历史。候选标记不是收益承诺。</p></div><div className="cp-actions"><button className="sq-button" disabled={busy} onClick={()=>void load()}>读取保存快照</button><button className="sq-button sq-primary" disabled={!local||busy} onClick={()=>void update()}><RefreshCw size={16} className={busy?"sq-spin":""}/>{busy?"采集进行中…":"更新数据"}</button></div></div>
 <div className="sq-status sq-row"><span role="status" aria-live="polite">{status||"正在读取 Hyperliquid 快照…"}</span><span>自动更新关闭 · 无跟单、无下单</span></div>
 {error&&<div className="sq-notice" role="alert">{error}</div>}
 {/* 整张卡片都能点，不用非得点中那颗小按钮才能切换池子；再点一下当前已经选中的卡片会回到"全部"。 */}
 <div className="cp-pools">
 <section className={"sq-card cp-pool cp-pool-clickable "+(pool==="quality"?"active":"")} role="button" tabIndex={0} aria-pressed={pool==="quality"} onClick={()=>{setPool(pool==="quality"?"all":"quality");setSelected(null);}} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setPool(pool==="quality"?"all":"quality");setSelected(null);}}}>
 <div className="sq-row"><h2><ShieldCheck size={20}/> 候选池</h2><strong>{totals.quality} <small>个</small></strong></div><p>账户价值达标、历史浮盈为正、近期有活动的地址；金库额外要求仍开放存款、运行≥30天。</p><div className="cp-poolbottom"><span>更新时间：{date(data?.generatedAt??null)}</span><span className="sq-muted">{pool==="quality"?"点击卡片查看全部 →":"点击卡片只看候选池 →"}</span></div></section>
 <section className={"sq-card cp-pool cp-pool-clickable "+(pool==="ordinary"?"active":"")} role="button" tabIndex={0} aria-pressed={pool==="ordinary"} onClick={()=>{setPool(pool==="ordinary"?"all":"ordinary");setSelected(null);}} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setPool(pool==="ordinary"?"all":"ordinary");setSelected(null);}}}>
 <div className="sq-row"><h2><Users size={20}/> 观察池</h2><strong>{totals.ordinary} <small>个</small></strong></div><p>未通过全部候选门槛，或本轮数据获取不完整的地址；不等于表现差，仅是待复核。</p><div className="cp-poolbottom"><span>更新时间：{date(data?.generatedAt??null)}</span><span className="sq-muted">{pool==="ordinary"?"点击卡片查看全部 →":"点击卡片只看观察池 →"}</span></div></section>
 </div>
 <div className="sq-notice"><AlertTriangle size={17}/><span>“聪明钱”是本工具的候选标记，不是 Hyperliquid 官方认证。持仓公开透明，但不能证明策略质量，未实现盈亏会随价格波动。个人交易员地址可能承载多个策略或委托资金。</span></div>
 {data&&<><div className="cp-meta">来源：{data.source} · 候选发现自 {data.coverage.discoveredTraders} 位个人交易员、{data.coverage.discoveredVaults} 个金库中账户价值或TVL较高的子集 · 本轮复核 {data.coverage.analyzed} 个地址</div>
 {data.coverage.positionErrors>0&&<div className="sq-notice cp-errors"><AlertTriangle size={17}/><span>{data.coverage.positionErrors} 个地址本次持仓查询失败，已暂停其候选资格，展示时明确标注缺失。</span></div>}
 {freshOpens.length>0&&<div className="sq-notice cp-errors"><AlertTriangle size={17}/><span>本轮新开仓 {freshOpens.length} 个：{freshOpens.slice(0,8).map(e=>(e.name??short(e.address))+"·"+e.coin+(e.toSide==="LONG"?"多":"空")).join("、")}{freshOpens.length>8?" 等":""}；与上一次采集相比新增的持仓，不代表刚刚这一刻发生，两次采集之间的具体时间未知。</span></div>}
 <section className="sq-card cp-list"><div className="sq-tablehead"><Tabs value={pool} onValueChange={v=>{setPool(v as Pool|"all");setSelected(null);}}><TabsList aria-label="候选池"><TabsTrigger value="quality">候选池</TabsTrigger><TabsTrigger value="ordinary">观察池</TabsTrigger><TabsTrigger value="all">全部</TabsTrigger></TabsList></Tabs><div className="sq-tools"><label className="sq-field"><span>地址／名称／标签</span><input aria-label="搜索地址、金库名或自定义标签" placeholder="0x… 、金库名称或你打的标签" value={query} onChange={e=>{setQuery(e.target.value);setSelected(null);}}/></label><Picker label="类型" value={kind} onChange={v=>setKind(v as typeof kind)} options={{all:"全部",trader:"个人交易员",vault:"金库"}}/><Picker label="排序" value={sort} onChange={setSort} options={{accountValue:"账户价值／TVL",allTime:"全部历史盈亏",day:"近1日盈亏",exposure:"净敞口",followers:"跟随者数／TVL"}}/></div></div>
 <div className="sq-scroll"><table><thead><tr><th>地址 / 类型</th><th>账户价值／TVL</th><th>全部历史 PnL/ROI</th><th>近1日 / 近1周 PnL</th><th>持仓 / 净敞口</th><th>加权杠杆</th><th>数据时间</th><th>个人标记</th></tr></thead><tbody>{rows.map(e=><tr key={e.address} className={entity?.address===e.address?"sq-selected":""}><td><button className="sq-author" aria-label={"查看 "+(e.name??e.address)+" 详情"} onClick={()=>setSelected(e.address)}>{e.name??short(e.address)} →</button><small className={e.pool==="quality"?"sq-up":""}>{e.kind==="vault"?"金库":"个人交易员"} · {e.autoTag}</small></td><td>{cash(e.accountValue)}{e.kind==="vault"&&<small>TVL {cash(e.tvl)}</small>}</td><td className={color(e.performance.allTime?.pnl)}>{cash(e.performance.allTime?.pnl)}<small>{pct(e.performance.allTime?.roi!=null?e.performance.allTime.roi*100:null)}</small></td><td className={color(e.performance.day?.pnl)}>{cash(e.performance.day?.pnl)}<small>{cash(e.performance.week?.pnl)}</small></td><td>{e.positionCount} 个<small>{e.netExposurePct===null?"—":(e.netExposurePct>0?"偏多 ":e.netExposurePct<0?"偏空 ":"")+Math.abs(e.netExposurePct).toFixed(0)+"%"}</small></td><td>{e.weightedLeverage===null?"—":e.weightedLeverage.toFixed(1)+"×"}</td><td>{date(e.observedAt)}{e.error&&<small className="sq-down">查询失败 · 保留旧证据</small>}</td><td><div className="cp-marks"><button className="cp-star" aria-label={(stars.includes(e.address)?"取消关注 ":"关注 ")+(e.name??e.address)} aria-pressed={stars.includes(e.address)} onClick={()=>saveStars(stars.includes(e.address)?stars.filter(a=>a!==e.address):[...stars,e.address])}><Star size={18} fill={stars.includes(e.address)?"currentColor":"none"}/></button>{(tags[e.address]??[]).length>0&&<span className="cp-tagchips" title={(tags[e.address]??[]).join("、")}>{(tags[e.address]??[]).slice(0,2).map(t=><span key={t} className="sq-tag">{t}</span>)}{(tags[e.address]??[]).length>2&&<span className="sq-tag">+{(tags[e.address]??[]).length-2}</span>}</span>}</div></td></tr>)}</tbody></table></div>
 {!rows.length&&<div className="sq-noresults"><h3>{pool==="quality"?"暂无符合全部候选条件的地址":"没有符合筛选条件的地址"}</h3><p>不会为了填满候选池降低数据核验要求。</p><button className="sq-button" onClick={()=>{setPool("all");setQuery("");setKind("all");}}>查看全部</button></div>}<div className="sq-tablefoot">显示 {rows.length} 个地址 · 候选标记不代表收益概率 · 个人星标只存于本机浏览器</div></section>
 {entity&&<Detail e={entity} starred={stars.includes(entity.address)} onStar={()=>saveStars(stars.includes(entity.address)?stars.filter(a=>a!==entity.address):[...stars,entity.address])} entityTags={tags[entity.address]??[]} onAddTag={t=>addTag(entity.address,t)} onRemoveTag={t=>removeTag(entity.address,t)}/>}
 <details className="sq-rules"><summary>最近持仓变化（最近 {Math.min(30,data.events.length)} / 共 {data.events.length} 条）</summary><div className="cp-events">
 {data.events.length===0?<p className="sq-note">暂无记录；需要至少两次采集才能比较出变化，或者两次之间没有触发≥30%名义价值变化的开平仓。</p>:
 data.events.slice(0,30).map((ev,i)=><EventRow key={ev.address+ev.coin+ev.detectedAt+i} ev={ev}/>)}
 </div><p className="sq-note">只比较相邻两次采集的净结果，不是逐笔成交流水；间隔越长越可能漏掉中间的变化，或把多次变化合并成一次。新发现的地址第一次出现时不产生事件（没有基线可比）。名义价值变化≥30%才记为加/减仓，阈值为经验取值，未回测。</p></details>
 <details className="sq-rules"><summary>候选门槛与数据局限</summary>{data.notes.map(n=><p key={n}>{n}</p>)}<p><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api" target="_blank" rel="noreferrer">Hyperliquid 官方 API 文档</a> · <a href="https://app.hyperliquid.xyz/leaderboard" target="_blank" rel="noreferrer">官方排行榜</a> · <a href="https://app.hyperliquid.xyz/vaults" target="_blank" rel="noreferrer">官方金库列表</a> · 规则 {data.ruleVersion}</p></details>
 </>}<footer className="sq-footer">Hyperliquid 模块独立维护，不自动改写广场或指标模块。全量刷新会重新发现候选并复核持仓。</footer></div></main>;
}
function Detail({e,starred,onStar,entityTags,onAddTag,onRemoveTag}:{e:Entity;starred:boolean;onStar:()=>void;entityTags:string[];onAddTag:(t:string)=>void;onRemoveTag:(t:string)=>void}){
 const [draft,setDraft]=useState("");
 const submit=()=>{onAddTag(draft);setDraft("");};
 return <section className="sq-card sq-detail cp-detail" aria-label="聪明钱详情"><div className="sq-row"><div><span className="sq-kicker">{e.pool==="quality"?"聪明钱候选":"观察池 · 继续核验"}</span><h2>{e.name??short(e.address)}</h2><p className="sq-note">地址 {e.address}{e.kind==="vault"&&e.leader?<><br/>金库管理者 {e.leader}</>:null}<br/>数据时间：{date(e.observedAt)}{e.error?"（本轮查询失败，展示旧证据）":""}</p></div><div className="sq-row" style={{gap:10}}>{e.kind==="vault"&&<a className="sq-button" href={"https://app.hyperliquid.xyz/vaults/"+e.address} target="_blank" rel="noreferrer">官方金库页 <ExternalLink size={14}/></a>}<button className="cp-star" aria-label={(starred?"取消关注 ":"关注 ")+(e.name??e.address)} aria-pressed={starred} onClick={onStar}><Star size={18} fill={starred?"currentColor":"none"}/></button></div></div>
 <div className="cp-tageditor"><Tag size={16}/><div className="cp-tagchips">{entityTags.length?entityTags.map(t=><span key={t} className="sq-tag cp-tagchip">{t}<button aria-label={"移除标签 "+t} onClick={()=>onRemoveTag(t)}><X size={12}/></button></span>):<span className="sq-muted">还没有自定义标签</span>}</div><input aria-label="添加自定义标签" placeholder="例如：杠杆偏高、跟着观察" value={draft} onChange={ev=>setDraft(ev.target.value)} onKeyDown={ev=>{if(ev.key==="Enter"){ev.preventDefault();submit();}}} maxLength={24}/><button className="sq-button" disabled={!draft.trim()} onClick={submit}>添加</button></div>
 <div className="cp-detailgrid"><div><h3>候选门槛</h3><ul className="cp-checks">{e.checks.map(c=><li key={c.key} className={c.pass?"pass":""}>{c.pass?<Check size={16}/>:<Minus size={16}/>}<span>{c.label}</span></li>)}</ul><p className="sq-note">所有门槛均须通过；持仓查询失败或数据过期会暂停候选标记。</p></div>
 <div><h3>业绩窗口</h3><dl className="sq-facts">{(["day","week","month","allTime"] as const).map(w=><div key={w}><dt>{w==="day"?"近1日":w==="week"?"近1周":w==="month"?"近1月":"全部历史"}</dt><dd className={color(e.performance[w]?.pnl)}>{cash(e.performance[w]?.pnl)}{e.performance[w]?.roi!=null&&" ("+pct(e.performance[w]!.roi!*100)+")"}</dd></div>)}<dt>账户价值</dt><dd>{cash(e.accountValue)}</dd>{e.kind==="vault"&&<><dt>TVL</dt><dd>{cash(e.tvl)}</dd><dt>年化 APR（官方口径）</dt><dd>{e.apr==null?"—":pct(e.apr*100)}</dd><dt>跟随者</dt><dd>{e.followerCount??"—"}</dd><dt>管理费分成</dt><dd>{e.leaderCommission==null?"—":pct(e.leaderCommission*100,1)}</dd><dt>接受新存款</dt><dd>{e.allowDeposits===null?"未知":e.allowDeposits?"是":"否"}</dd><dt>运行天数</dt><dd>{e.ageDays==null?"—":e.ageDays.toFixed(0)+" 天"}</dd></>}</dl><p className="sq-note">业绩窗口彼此滚动重叠，不是独立分段业绩；金库窗口数值取官方快照末尾点，不是均值。</p></div>
 <div><h3>敞口概览</h3><dl className="sq-facts"><dt>持仓数量</dt><dd>{e.positionCount}（{e.distinctCoins} 个币种）</dd><dt>多头名义价值</dt><dd className="sq-up">{cash(e.longNotional)}</dd><dt>空头名义价值</dt><dd className="sq-down">{cash(e.shortNotional)}</dd><dt>净敞口</dt><dd>{e.netExposurePct===null?"—":pct(e.netExposurePct,1)}</dd><dt>名义价值加权杠杆</dt><dd>{e.weightedLeverage===null?"—":e.weightedLeverage.toFixed(1)+"×"}</dd><dt>占用保证金</dt><dd>{cash(e.totalMarginUsed)}</dd></dl><p className="sq-note">{e.positionCount===0?"当前没有公开持仓，不代表账户不活跃。":"以下为查询时刻的持仓快照，随时可能变化。"}</p></div></div>
 <details className="cp-cycles" open><summary>查看全部 {e.positionCount} 个当前持仓</summary><div className="sq-scroll"><table><thead><tr><th>币种 / 方向</th><th>规模</th><th>开仓均价</th><th>杠杆</th><th>未实现盈亏</th><th>强平价</th><th>占用保证金</th></tr></thead><tbody>{e.positions.map(p=><tr key={p.coin+p.side}><td className={p.side==="LONG"?"sq-up":"sq-down"}>{p.coin} / {p.side==="LONG"?"多":"空"}</td><td>{num(p.size,4)}</td><td>{num(p.entryPx,4)}</td><td>{p.leverage==null?"—":p.leverage+"×"+(p.leverageType==="cross"?"（全仓）":p.leverageType==="isolated"?"（逐仓）":"")}</td><td className={color(p.unrealizedPnl)}>{cash(p.unrealizedPnl)}</td><td>{p.liquidationPx==null?"无（或不适用）":num(p.liquidationPx,4)}</td><td>{cash(p.marginUsed)}</td></tr>)}</tbody></table></div><p className="sq-note">未实现盈亏含累计资金费影响，不是已实现收益；强平价随保证金与仓位变化实时调整，这里只是查询时刻的值。</p></details></section>;
}
const EVENT_LABEL:Record<PositionEvent["type"],string>={opened:"新开仓",closed:"平仓",reversed:"反手",increased:"加仓",reduced:"减仓"};
const side=(s:"LONG"|"SHORT"|null)=>s===null?"":s==="LONG"?"多":"空";
function EventRow({ev}:{ev:PositionEvent}){
 return <p><span className={ev.type==="opened"?"sq-up":ev.type==="closed"?"sq-muted":ev.type==="reversed"||ev.type==="reduced"?"sq-down":"sq-up"}>{EVENT_LABEL[ev.type]}</span> · {ev.coin} · {ev.name??short(ev.address)}（{ev.kind==="vault"?"金库":"个人交易员"}）
 <br/><span className="sq-muted">{ev.type==="reversed"?side(ev.fromSide)+" → "+side(ev.toSide):ev.type==="opened"?side(ev.toSide):ev.type==="closed"?side(ev.fromSide):side(ev.fromSide)}{(ev.type==="increased"||ev.type==="reduced")&&"：名义价值 "+cash(ev.fromNotional)+" → "+cash(ev.toNotional)} · {date(ev.detectedAt)}</span></p>;
}
