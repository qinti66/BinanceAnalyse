"use client";
import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, ArrowUpDown, RefreshCw, AlertTriangle, Database, CheckCircle2 } from "lucide-react";
import { Tabs,TabsList,TabsTrigger } from "@/components/ui/tabs";
import { Select,SelectTrigger,SelectValue,SelectContent,SelectItem } from "@/components/ui/select";
import type { IndicatorCoin,IndicatorSnapshot } from "@/lib/indicators/model";
import "../square/square.css";
import "./indicators.css";
const SERVICE="http://127.0.0.1:8791";
type JobStatus={state:string;message:string;error?:string};
const cash=(v:number|null|undefined)=>v==null?"—":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",notation:"compact",maximumFractionDigits:2}).format(v);
const percent=(v:number|null|undefined,d=2)=>v==null?"—":(v>0?"+":"")+v.toFixed(d)+"%";
const num=(v:number|null|undefined,d=2)=>v==null?"—":v.toFixed(d);
const timestamp=(v:number|string)=>new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
const color=(v:number|null|undefined)=>v==null?"sq-muted":v>0?"sq-up":v<0?"sq-down":"sq-muted";
function Picker({label,value,change,options}:{label:string;value:string;change:(v:string)=>void;options:Record<string,string>}){
 return <div className="sq-field"><span>{label}</span><Select value={value} onValueChange={change}><SelectTrigger aria-label={label} className="sq-select"><SelectValue/></SelectTrigger><SelectContent>{Object.entries(options).map(([v,t])=><SelectItem key={v} value={v}>{t}</SelectItem>)}</SelectContent></Select></div>;
}
export default function IndicatorsPage(){
 const [data,setData]=useState<IndicatorSnapshot|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
 const [view,setView]=useState("watch"),[query,setQuery]=useState(""),[tag,setTag]=useState("all"),[sort,setSort]=useState("attention"),[ascending,setAscending]=useState(false);
 const [selected,setSelected]=useState<string|null>(null),[polling,setPolling]=useState(false),[status,setStatus]=useState(""),[local,setLocal]=useState(false);
 async function readSnapshot(){
   const r=await fetch("/indicators/latest.json?t="+Date.now(),{cache:"no-store"});
   if(!r.ok)throw Error("尚无可用指标快照，请先执行一次采集。");
   const json=await r.json() as IndicatorSnapshot;if(json.schemaVersion!==1||!Array.isArray(json.coins))throw Error("快照格式不正确，保留旧数据。");
   setData(json);setError("");
 }
 useEffect(()=>{
   const isLocal=["127.0.0.1","localhost"].includes(window.location.hostname);setLocal(isLocal);
   readSnapshot().catch(e=>setError(String(e.message))).finally(()=>setLoading(false));
   if(isLocal)fetch(SERVICE+"/status",{signal:AbortSignal.timeout(2000)}).then(r=>r.json() as Promise<JobStatus>).then(j=>{if(j.state==="running"){setPolling(true);setStatus(j.message)}else setStatus("本地更新服务已就绪 · 只在点击时采集");}).catch(()=>setStatus("本地更新服务未启动；仍可查看已保存的真实快照。"));
 },[]);
 useEffect(()=>{
   if(!polling)return;
   let stopped=false,inFlight=false;
   const timer=setInterval(async()=>{
     if(inFlight)return;inFlight=true;
     try{const r=await fetch(SERVICE+"/status",{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error("状态读取失败");const j=await r.json() as JobStatus;
       if(stopped)return;setStatus(j.message);
       if(j.state==="complete"){await readSnapshot();if(!stopped)setPolling(false);}
       else if(j.state==="failed"||j.state==="idle")setPolling(false);
     }catch{if(!stopped){setStatus("更新服务连接中断，旧快照保留；重新连接后可查询任务进度。");setPolling(false);}}
     finally{inFlight=false;}
   },1500);
   return()=>{stopped=true;clearInterval(timer)};
 },[polling]);
 async function update(){
   if(polling)return;
   setStatus("正在连接本地采集服务…");
   try{const r=await fetch(SERVICE+"/update",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(5000)});
     const j=await r.json() as JobStatus;if(r.status!==202&&r.status!==409)throw Error(j.error??"无法启动更新");setPolling(true);setStatus(j.message??"正在更新");
   }catch(e){setStatus("无法启动采集："+String((e as Error).message)+"。请启动本地指标更新服务；当前快照未改变。");}
 }
 const rows=useMemo(()=>{
   if(!data)return [];
   const getValue=(c:IndicatorCoin)=>sort==="oi"?c.oi.h4:sort==="io"?c.flows.h4?.net:sort==="cap"?c.oiCapPct:sort==="volume"?c.flows.h24?.total:c.attention;
   return data.coins.filter(c=>(view==="all"||view==="watch"&&c.candidate||view==="risk"&&c.warnings.length>0||view==="missing"&&!c.quality)&&
     (tag==="all"||c.tags.includes(tag))&&c.token.toLowerCase().includes(query.trim().toLowerCase()))
     .sort((a,b)=>{const av=getValue(a),bv=getValue(b);if(av==null)return bv==null?0:1;if(bv==null)return -1;return (ascending?1:-1)*(av-bv)});
 },[data,view,query,tag,sort,ascending]);
 const coin=data?.coins.find(c=>c.token===selected)??rows[0];
 const old=data?Date.now()-data.cutoff>6*3600000:false;
 return <main className="sq im"><header className="sq-header"><div className="sq-shell sq-row"><div className="sq-brand"><span className="sq-mark"><Activity size={21}/></span><div><strong>Alpha Radar</strong><small>全市场合约指标 / SOURCE 02</small></div></div><div className="im-nav"><a href="/square">广场情绪</a><a href="/"><ArrowLeft size={15}/>原有融合分析</a></div></div></header>
 <div className="sq-shell sq-content"><div className="sq-row sq-heading"><div><span className="sq-eyebrow">资金流 × 持仓 × 市值 × 技术</span><h1>从全市场，筛出值得留意的变化。</h1><p>IO 看主动买卖成交资金；持仓增减与持仓市值单独衡量。</p></div><div className="im-actions"><button className="sq-button" disabled={polling} onClick={()=>readSnapshot().catch(e=>setError(e.message))}>读取已保存快照</button><button className="sq-button sq-primary" onClick={update} disabled={polling||!local}><RefreshCw size={16} className={polling?"sq-spin":""}/>{polling?"采集进行中…":"更新指标数据"}</button></div></div>
 <div className="sq-status sq-row"><span role="status" aria-live="polite">{status||"正在读取真实快照…"}</span><span>一次性手动采集 · 无交易操作</span></div>
 {error&&<div className="sq-notice" role="alert"><AlertTriangle size={18}/>{error}</div>}
 {loading&&!data?<div className="sq-empty">正在读取指标快照…</div>:!data?<section className="sq-empty"><Database size={32}/><h2>尚无真实数据</h2><p>没有快照时不展示虚构币种或演示排行榜。</p></section>:<>
 <div className="im-stats"><Stat label="代币合约覆盖" value={data.coverage.contracts+" / "+(data.coverage.um+data.coverage.cm)} note={"U 本位 "+data.coverage.um+" · 币本位 "+data.coverage.cm}/><Stat label="合并后代币" value={String(data.coverage.tokens)} note="同币种多合约聚合，避免重复入选"/><Stat label="整点持仓数据" value={data.coverage.oiContracts+" / "+data.coverage.contracts} note={"流通市值可用 "+data.coverage.marketCapTokens+" 币"}/><Stat label="观察名单" value={String(data.coverage.candidates)} note="满足数据、流动性与多信号门槛"/></div>
 <div className={"im-timing "+(old?"im-stale":"")}><CheckCircle2 size={16}/><span>统一分析时点：{timestamp(data.cutoff)}（北京时间） · 采集完成：{timestamp(data.completedAt)}{old?" · 已超过6小时，仅作历史观察":""}</span></div>
 <div className="sq-notice"><AlertTriangle size={17}/><span>IO 净流入是主动买入额减主动卖出额，不是充值提现。持仓市值是未平仓合约名义价值，不是保证金。观察名单同时包含上涨、下跌与拥挤风险，不等于买入名单。</span></div>
 <section className="sq-card im-list"><div className="im-listhead"><Tabs value={view} onValueChange={v=>{setView(v);setSelected(null)}}><TabsList className="im-tabs" aria-label="指标名单"><TabsTrigger value="watch">观察名单</TabsTrigger><TabsTrigger value="all">全部代币</TabsTrigger><TabsTrigger value="risk">风险提示</TabsTrigger><TabsTrigger value="missing">数据不足</TabsTrigger></TabsList></Tabs><div className="im-tools"><label className="sq-field"><span>币种</span><input aria-label="搜索币种" value={query} onChange={e=>{setQuery(e.target.value);setSelected(null)}} placeholder="例如 BTC / SOL"/></label><Picker label="筛选信号" value={tag} change={setTag} options={{all:"全部信号","上涨增仓":"上涨增仓","盘整增仓":"盘整增仓","下跌增仓":"下跌增仓","减仓波动":"减仓波动","主动净流入":"主动净流入","主动净流出":"主动净流出","成交放量":"成交放量","拥挤风险":"拥挤风险"}}/><Picker label="排序依据" value={sort} change={setSort} options={{attention:"关注分",oi:"4h 持仓增减",io:"4h IO 净流入",cap:"持仓／流通市值",volume:"24h 成交额"}}/><button className="sq-button" onClick={()=>setAscending(!ascending)} aria-label="切换排序方向"><ArrowUpDown size={15}/>{ascending?"升序":"降序"}</button></div></div>
 <div className="sq-scroll"><table><thead><tr><th>币种 / 关注分</th><th>IO 净流入 4h</th><th>持仓增减 4h / 24h</th><th>整点持仓市值</th><th>现货流通市值</th><th>持仓／流通市值</th><th>价格 4h / 24h</th><th>量比 / RSI</th><th>费率 24h 等效</th><th>入选依据</th></tr></thead><tbody>{rows.map(c=><tr key={c.token} className={coin?.token===c.token?"sq-selected":""}><td><button className="sq-author" onClick={()=>setSelected(c.token)} aria-label={"查看 "+c.token+" 指标"}>{c.token} →</button><small>关注 {num(c.attention,1)} · {c.contractCount} 合约</small></td><td className={color(c.flows.h4?.net)}>{cash(c.flows.h4?.net)}<small>净额／成交 {percent(c.ioNetRatio4h,1)}</small></td><td><span className={color(c.oi.h4)}>{percent(c.oi.h4)}</span><small>{percent(c.oi.h24)}</small></td><td>{cash(c.oiValue)}<small>{c.oiCoverage}/{c.contractCount} 合约可用</small></td><td>{cash(c.marketCap)}<small>{c.capSource.includes("估算")?"流通量×价格估算":c.marketCap!==null?"外部流通市值":"待核验"}</small></td><td>{c.oiCapPct===null?"—":c.oiCapPct.toFixed(2)+"%"}</td><td><span className={color(c.priceChange.h4)}>{percent(c.priceChange.h4)}</span><small>{percent(c.priceChange.h24)}</small></td><td>{num(c.volumeRatio)}×<small>RSI {num(c.rsi,1)}</small></td><td className={color(c.fundingDaily)}>{percent(c.fundingDaily,4)}<small>{c.fundingHours===null?"周期未知／非永续":c.fundingHours+" 小时结算"}</small></td><td><div className="im-tags">{c.tags.slice(0,3).map(t=><span key={t}>{t}</span>)}</div><small>{!c.candidate?c.reason:c.warnings.length?"附 "+c.warnings.length+" 项风险提示":"数据与流动性达标"}</small></td></tr>)}</tbody></table></div>
 {!rows.length&&<div className="sq-noresults">没有符合条件的币种。<button className="sq-textbutton" onClick={()=>{setQuery("");setTag("all");setView("all")}}>查看全部代币</button></div>}
 <div className="sq-tablefoot">显示 {rows.length} 个币种 · 空值表示缺失，不按 0 处理 · 关注分衡量变化程度，不是盈利概率</div></section>
 {coin&&<CoinDetail coin={coin}/>}
 <details className="sq-rules"><summary>筛选口径、数据覆盖与来源</summary><div>{data.notes.map(n=><p key={n}>{n}</p>)}<p>默认观察门槛：24h 合约成交额 ≥ $5M，整点持仓市值 ≥ $1M，主合约价差 ≤ 25bps，OI、资金流和至少60根连续小时K线可用，且至少触发两项信号。规则待回测，不保证未来表现。</p><p>价涨／价跌与 OI 同增仅描述结构，不直接判断是哪一方开仓。持仓市值／流通市值偏高用作杠杆拥挤提示，不作为估值便宜的依据。</p><p>保留了 {data.excluded.length} 个非交易状态或非代币合约的排除记录；未混入股票、商品或指数合约。请求错误 {data.coverage.errors} 个。</p><p><a href="https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data" target="_blank" rel="noreferrer">币安 U 本位官方数据说明</a> · <a href="https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-coin-m-futures/api/rest-api/market-data" target="_blank" rel="noreferrer">币安币本位官方数据说明</a> · <a href="https://docs.coingecko.com/reference/coins-markets" target="_blank" rel="noreferrer">CoinGecko 市值交叉校验</a></p><p>快照 {data.id} · 规则 {data.ruleVersion}</p></div></details>
 </>}<footer className="sq-footer">指标模块独立采集与筛选 · 不修改广场数据 · 无定时任务 · 不自动下单</footer></div></main>;
}
function Stat({label,value,note}:{label:string;value:string;note:string}){return <div className="sq-card im-stat"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>}
function CoinDetail({coin:c}:{coin:IndicatorCoin}){
 return <section className="sq-card sq-detail im-detail" aria-label="币种指标详情"><div className="sq-row"><div><span className="sq-kicker">{c.token} / 数据证据</span><h2>{c.reason}</h2></div><span className="sq-muted">主合约 {c.representative} · {c.trend}</span></div><div className="im-detailgrid"><div><h3>IO 主动成交资金流</h3><table className="im-flow"><thead><tr><th>周期</th><th>流入</th><th>流出</th><th>净流入</th></tr></thead><tbody>{(["h1","h4","h24"] as const).map(w=><tr key={w}><td>{w.slice(1)}h</td><td className="sq-up">{cash(c.flows[w]?.inflow)}</td><td className="sq-down">{cash(c.flows[w]?.outflow)}</td><td className={color(c.flows[w]?.net)}>{cash(c.flows[w]?.net)}</td></tr>)}</tbody></table><p className="sq-note">流入+流出=成交额；每笔成交只按主动方计一次。不会将两边都算成流入。</p></div><div><h3>持仓与市值</h3><dl className="sq-facts"><dt>整点持仓市值</dt><dd>{cash(c.oiValue)}</dd><dt>最新持仓市值</dt><dd>{cash(c.currentValue)}</dd><dt>最新覆盖</dt><dd>{c.currentCoverage}/{c.contractCount} 合约</dd><dt>流通市值</dt><dd>{cash(c.marketCap)}</dd><dt>持仓／流通市值</dt><dd>{c.oiCapPct===null?"—":c.oiCapPct.toFixed(2)+"%"}</dd><dt>1h 持仓增减</dt><dd>{percent(c.oi.h1)}</dd></dl><p className="sq-note">{c.capSource}</p></div><div><h3>技术与交易风险</h3><dl className="sq-facts"><dt>RSI14 / 1h</dt><dd>{num(c.rsi,1)}</dd><dt>ATR14 / 价格</dt><dd>{num(c.atrPct)}%</dd><dt>4h 成交量比</dt><dd>{num(c.volumeRatio)}×</dd><dt>标记／指数溢价</dt><dd>{percent(c.basisPct,3)}</dd><dt>主合约买卖价差</dt><dd>{num(c.spreadBps)} bps</dd><dt>最新每期费率</dt><dd>{percent(c.fundingRate,4)}</dd></dl><p className="sq-note">{c.warnings.length?c.warnings.join("；"):"本次规则未发现额外风险标记，不代表无风险。"}</p></div></div>
 <details className="im-contracts"><summary>展开 {c.contractCount} 个合约的持仓口径与覆盖</summary><div className="sq-scroll"><table><thead><tr><th>合约</th><th>类型</th><th>整点 OI 数量</th><th>整点持仓市值</th><th>OI 4h</th><th>最新持仓观察</th></tr></thead><tbody>{c.contracts.map(x=><tr key={x.symbol}><td>{x.symbol}</td><td>{x.family} · {x.type}</td><td>{num(x.oiQty)} {x.family==="CM"?"张":"合约基础单位"}</td><td>{cash(x.oiValue)}</td><td>{percent(x.oi.h4)}</td><td>{x.currentTime?timestamp(x.currentTime):"缺失"}</td></tr>)}</tbody></table></div></details></section>;
}
