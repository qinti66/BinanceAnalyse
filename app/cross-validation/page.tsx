"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import {GitCompareArrows,RefreshCw,AlertTriangle} from "lucide-react";
import {ModuleNav} from "@/components/module-nav";
import {Checkbox} from "@/components/ui/checkbox";
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from "@/components/ui/select";
import {MODULES,LABELS,buildCross,type Module,type Sources} from "@/lib/cross-validation/model";
import {useCollections} from "@/lib/collection-client";
import "../square/square.css";
import "./cross.css";
const paths={square:"/square/latest.json",indicators:"/indicators/latest.json",copy:"/copy-trading/latest.json"};
const date=(v:number|string|null|undefined)=>v==null?"无可用时间":new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
export default function CrossValidation(){
 const [sources,setSources]=useState<Sources>({square:null,indicators:null,copy:null}),[errors,setErrors]=useState<Partial<Record<Module,string>>>({});
 const [selected,setSelected]=useState<Module[]>([...MODULES]),[pool,setPool]=useState<"quality"|"ordinary"|"all">("quality"),[query,setQuery]=useState(""),[filter,setFilter]=useState("all"),[loading,setLoading]=useState(true),[clock,setClock]=useState(Date.now());
 const read=useCallback(async()=>{
  setLoading(true);const results=await Promise.all(MODULES.map(async m=>{try{
   const r=await fetch(paths[m]+"?t="+Date.now(),{cache:"no-store"});if(!r.ok)throw Error("尚无真实快照");
   const d=await r.json() as Record<string,unknown>;if(!d||(m==="square"?(d.mode!=="live"||!Array.isArray(d.posts)):m==="indicators"?(d.schemaVersion!==1||!Array.isArray(d.coins)):(d.schemaVersion!==2||!Array.isArray(d.entities))))throw Error("快照结构无效（带单模块若仍是旧版币安快照，请先用新的 Hyperliquid 服务更新）");
   return {m,data:d,error:null};
  }catch(e){return {m,data:null,error:String((e as Error).message)};}}));
  setSources(previous=>Object.fromEntries(results.map(r=>[r.m,r.data??previous[r.m]])) as Sources);
  setErrors(Object.fromEntries(results.filter(r=>r.error).map(r=>[r.m,r.error])));setClock(Date.now());setLoading(false);
 },[]);
 const collection=useCollections(()=>void read());
 useEffect(()=>{void read();const timer=setInterval(()=>setClock(Date.now()),60000);return()=>clearInterval(timer);},[read]);
 const result=useMemo(()=>{
  const usable={...sources};
  for(const m of selected)if(collection.jobs[m]?.state==="failed"||errors[m])usable[m]=null;
  return buildCross(usable,selected,pool,clock);
 },[sources,selected,pool,clock,collection.jobs,errors]);
 const rows=result.rows.filter(r=>r.token.toLowerCase().includes(query.trim().toLowerCase())&&(filter==="all"||filter==="covered"&&r.coverage===selected.length||filter==="conflict"&&r.state.includes("冲突")||filter==="aligned"&&r.state.includes("同向")||filter==="missing"&&r.state==="证据不足"));
 const toggle=(m:Module)=>setSelected(v=>v.includes(m)?v.filter(x=>x!==m):[...v,m]);
 const times={square:sources.square?.capturedAt,indicators:sources.indicators?.cutoff,copy:sources.copy?.generatedAt};
 return <main className="sq cv"><header className="sq-header"><div className="sq-shell sq-row"><div className="sq-brand"><span className="sq-mark"><GitCompareArrows size={22}/></span><div><strong>Alpha Radar</strong><small>交叉验证 / RESEARCH</small></div></div><ModuleNav current="/cross-validation"/></div></header>
 <div className="sq-shell sq-content">
 <div className="sq-row sq-heading"><div><h1>选择证据，再看它们是否一致。</h1><p>任意两个或三个模块交叉；只使用真实快照，不自动采集。</p></div><div className="cv-actions"><button className="sq-button" disabled={loading} onClick={()=>void read()}>读取最新快照</button><button className="sq-button sq-primary" disabled={!collection.local||collection.busy} onClick={()=>void collection.update(MODULES)}><RefreshCw size={16}/>全部更新一次</button></div></div>
 <div className="cv-sources">{MODULES.map(m=><section className={"sq-card cv-source "+(selected.includes(m)?"chosen":"")} key={m}><label><Checkbox checked={selected.includes(m)} onCheckedChange={()=>toggle(m)} aria-label={LABELS[m]}/><strong>{LABELS[m]}</strong></label><p>{m==="square"?"24h 讨论、明确观点与仓位证据":m==="indicators"?"4h 主动资金流、价格、OI 与风险":"实时公开持仓方向 · Hyperliquid 官方数据"}</p><small>快照：{date(times[m])}</small><span className={errors[m]?"sq-down":"sq-muted"}>{errors[m]?"读取失败："+errors[m]+"；有旧快照则保留原时间":m==="square"?(sources.square?.posts.length??0)+" 条币种观点":m==="indicators"?(sources.indicators?.coverage.tokens??0)+" 个代币":(sources.copy?.coverage.analyzed??0)+" 个地址"}</span><button className="sq-button" disabled={!collection.local||collection.jobs[m]?.state==="running"} onClick={()=>void collection.update([m])}>{collection.jobs[m]?.state==="running"?"更新中…":"单独更新"}</button><small role="status">{collection.jobs[m]?.message??"读取已保存数据；未启动采集"}</small></section>)}</div>
 <div className="sq-row cv-controls"><strong>已选择 {selected.length}/3 个模块</strong><button className="sq-button" disabled={!collection.local||collection.busy||selected.length<2} onClick={()=>void collection.update(selected)}>更新所选模块一次</button><label className="sq-field"><span>聪明钱样本池</span><Select value={pool} onValueChange={v=>setPool(v as typeof pool)}><SelectTrigger aria-label="聪明钱样本池" className="sq-select"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="quality">候选池</SelectItem><SelectItem value="ordinary">观察池 · 探索</SelectItem><SelectItem value="all">两个池 · 探索</SelectItem></SelectContent></Select></label><label className="sq-field"><span>币种</span><input aria-label="交叉币种搜索" value={query} onChange={e=>setQuery(e.target.value)} placeholder="例如 BTC / ZEC"/></label><label className="sq-field"><span>结论</span><Select value={filter} onValueChange={setFilter}><SelectTrigger aria-label="交叉结论筛选" className="sq-select"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部</SelectItem><SelectItem value="covered">全部所选模块有证据</SelectItem><SelectItem value="aligned">同向</SelectItem><SelectItem value="conflict">冲突</SelectItem><SelectItem value="missing">证据不足</SelectItem></SelectContent></Select></label></div>
 <div className="sq-notice"><AlertTriangle size={17}/><span>广场为公开热门/最新帖采样，不是全站全量。文本规则无法可靠判断的观点归为未明确；分享卡不等于当前持仓。Hyperliquid 持仓是查询时刻快照，观察池不代表较差的聪明钱，只是未通过候选门槛。信号不是买卖建议。</span></div>
 <p className="sq-note">分析截止：{date(result.anchor)}（北京时间） · 广场历史向前24h，指标向前4h，Hyperliquid 持仓为实时查询 · {loading?"正在读快照…":"自动更新关闭"}{MODULES.filter(m=>collection.jobs[m]?.state==="failed"||errors[m]).map(m=><span key={m}> · {LABELS[m]}本轮失败/缺失，旧快照保留但不参与本页本轮计算</span>)}</p>
 {selected.length<2?<section className="sq-empty"><h2>请至少选择两个模块</h2><p>支持三种双模块组合，以及三个模块一起验证。</p></section>:<section className="sq-card cv-results"><div className="sq-row cv-results-head"><h2>交叉结果</h2><span>{rows.length} 个币种 · 切换勾选后即时重算</span></div><div className="sq-scroll"><table><thead><tr><th>币种 / 结论</th>{MODULES.filter(m=>selected.includes(m)).map(m=><th key={m}>{LABELS[m]}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.token}><td><strong>{r.token}</strong><p className={r.state.includes("冲突")?"sq-down":r.state.includes("同向")?"sq-up":"sq-muted"}>{r.state}</p><small>有效证据 {r.coverage}/{selected.length}</small><details><summary>限制与风险</summary><ul>{r.warnings.length?r.warnings.map((w,j)=><li key={j}>{w}</li>):<li>未触发已定义风险不等于没有风险。</li>}</ul></details></td>{MODULES.filter(m=>selected.includes(m)).map(m=>{const s=r.signals[m];return <td key={m}><span className={"sq-tag "+(!s.available?"sq-muted":s.direction>0?"sq-up":s.direction<0?"sq-down":"sq-muted")}>{!s.available?"不足":s.direction>0?"偏多":s.direction<0?"偏空":"中性／混合"}</span><p>{s.summary}</p><small>证据时间：{date(s.at)}</small>{s.links.length>0&&<details><summary>查看来源</summary>{s.links.map(l=><a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a>)}</details>}</td>;})}</tr>)}</tbody></table></div>{!rows.length&&<div className="sq-noresults">没有符合当前组合或筛选条件的币种；不会用演示数据补齐。</div>}</section>}
 <details className="sq-rules"><summary>计算规则与边界</summary><p>按币种合并所选模块的并集，缺失不按0计算。广场每作者每币种取截止时点前24h最新观点，至少3位作者且2位方向明确，净情绪±15%为方向阈值；仓位加分不再次计入跨模块投票，减少同源证据重复使用。</p><p>指标复用指标页的综合研判：价格和主动资金同向、EMA同向，并有增仓或放量确认；过热、过度减仓、费率拥挤、波动及市值比例风险会改为观望。OI本身不是多空票。具体阈值见指标页参数分析。</p><p>Hyperliquid 每个地址每币种取当前最大名义价值的一侧持仓，至少2个地址，多空地址数差占比达到34%才有方向；只统计通过所选样本池门槛且数据在12小时内的地址。持仓是查询时刻快照，不是承诺后续维持。</p><p>快照超过6小时、时间异常、采集失败或证据不足不产生同向结论。有中性信号则尚未形成共识。观点一致不证明因果或独立验证；规则尚未回测。</p><a href="/legacy-dashboard">查看旧版固定快照（不参与本页计算） ↗</a></details>
 </div></main>;
}
