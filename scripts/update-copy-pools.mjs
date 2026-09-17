import {readFile,writeFile,mkdir,rename,open,unlink} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {makeSnapshot,effectivePool} from "../lib/copy-trading/model.ts";
const root=join(dirname(fileURLToPath(import.meta.url)),".."),dataDir=join(root,"data/copy-trading"),dest=join(root,"public/copy-trading");
const scope=process.argv[2]??"all";if(!["quality","ordinary","all","retry"].includes(scope))throw Error("Invalid pool scope");
await mkdir(dataDir,{recursive:true});await mkdir(dest,{recursive:true});
const lockPath=join(dataDir,"update.lock");let lock;
try{lock=await open(lockPath,"wx");await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),scope}));}
catch{console.error("带单更新正在运行或存在遗留锁，请先检查进程。");process.exit(1);}
const read=async(path,fallback)=>{try{return JSON.parse(await readFile(path,"utf8"));}catch(e){if(e.code==="ENOENT")return fallback;throw e;}};
const startedAt=new Date().toISOString(),runDir=join(dataDir,startedAt.replace(/[:.]/g,"-"));
await mkdir(runDir,{recursive:true});
let stopped=false;for(const s of ["SIGINT","SIGTERM"])process.on(s,()=>{stopped=true;});
const base="https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade";
const headers={"content-type":"application/json",accept:"application/json",clienttype:"web",lang:"en","bnc-location":"GLOBAL","user-agent":"Mozilla/5.0 (Alpha Radar research snapshot)"};
let next=0;const receipts=[],requestErrors=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path,body,attempt=0){
 if(stopped)throw Error("更新已停止");
 const wait=Math.max(Date.now(),next);next=wait+350;await pause(Math.max(0,wait-Date.now()));
 if(stopped)throw Error("更新已停止");
 const url=base+path,at=new Date().toISOString();
 try{
  const response=await fetch(url,{method:body?"POST":"GET",headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  receipts.push({path,body,at,status:response.status});
  if([401,403,418,429].includes(response.status)){stopped=true;throw Error("访问受限 HTTP "+response.status+"；停止请求，不绕过限制");}
  if(!response.ok)throw Error("HTTP "+response.status);
  const result=await response.json();
  if(result.code==="90801003"||/too many requests|rate limit/i.test(String(result.message??""))){
   stopped=true;throw Error("平台限流 API "+result.code+"；停止本轮，不继续重试");
  }
  // The public service explicitly asks to try later for this temporary error.
  // Retry only this code twice with backoff; access/rate-limit errors above never retry.
  if(result.code==="11012005"&&attempt<2){await pause(attempt===0?1500:4000);return get(path,body,attempt+1);}
  if(result.code!=="000000"||result.success===false)throw Error("API "+result.code+" "+(result.message??""));
  if(result.data==null)throw Error("响应缺少 data");return result.data;
 }catch(e){requestErrors.push({path,at,error:String(e)});throw e;}
}
const query=(timeRange,dataType="ROI",nickname="")=>get("/home-page/query-list",{pageNumber:1,pageSize:50,timeRange,dataType,favoriteOnly:false,hideFull:false,nickname,order:dataType==="MDD"?"ASC":"DESC",apiKeyOnly:false});
const progress=x=>console.log(JSON.stringify(x));
async function main(){
 const previous=await read(join(dest,"latest.json"),null),cached=await read(join(dataDir,"records.json"),[]);
 if(scope!=="all"&&!previous)throw Error("尚无分池快照，请先更新两个池。");
 const old=new Map(cached.map(r=>[r.id,r])),performances=new Map(),discover=new Map(),boards=[];
 let discovered=previous?.coverage.discovered??0;
 if(scope==="all"){
  for(const range of ["7D","30D","90D","180D"])for(const metric of ["ROI","PNL","AUM","COPIER_PNL","SHARP_RATIO","MDD","WIN_RATE"]){
   progress({phase:"discovery",message:"正在发现候选："+range+" / "+metric});
   const b=await query(range,metric);if(!Array.isArray(b.list))throw Error("榜单结构变化");
   boards.push({request:{timeRange:range,dataType:metric},...b});
   for(const row of b.list){
    const id=String(row.leadPortfolioId);if(!/^\d+$/.test(id))continue;
    discover.set(id,row);if(!performances.has(id))performances.set(id,{});
    performances.get(id)[range]??=row;
   }
  }
  discovered=discover.size;await writeFile(join(runDir,"leaderboards.json"),JSON.stringify(boards));
 }
 const ids=scope==="all"?[...new Set([...discover.keys(),...(previous?.traders??[]).map(t=>t.id)])]:scope==="retry"?previous.traders.filter(t=>t.updateError).map(t=>t.id):(previous.traders.filter(t=>effectivePool(t)===(scope)).map(t=>t.id));
 if(ids.length>600)throw Error("候选超过600位，本轮停止；需要调整有记录的采样范围。");
 const rows=[];let cursor=0,done=0;
 async function worker(){
  while(cursor<ids.length){
   if(stopped)throw Error("更新中断，页面快照保留");
   const id=ids[cursor++];let record;
   try{
    const p=await get("/lead-portfolio/detail?portfolioId="+encodeURIComponent(id));
    if(String(p.leadPortfolioId)!==id)throw Error("组合身份不匹配");
    const perf=performances.get(id)??{};
    for(const range of ["30D","90D"])if(!perf[range]){
     const b=await query(range,"ROI",String(p.nickname??""));
     if(!Array.isArray(b.list))throw Error("业绩响应结构变化");
     const match=b.list.find(r=>String(r.leadPortfolioId)===id);if(match)perf[range]=match;
    }
    let history=null;
    if(p.positionShow===true){
     const orders=[];let total=null,firstPage=null,consistent=true,historyError=null;
     try{
      for(let pageNumber=1;pageNumber<=100;pageNumber++){
       const body={portfolioId:id,pageNumber,pageSize:100},d=await get("/lead-portfolio/order-history",body);
       if(!Array.isArray(d.list)||!Number.isInteger(Number(d.total))||Number(d.total)<0)throw Error("订单历史结构变化");
       if(total===null){total=Number(d.total);firstPage=JSON.stringify(d.list);}else if(Number(d.total)!==total)consistent=false;
       orders.push(...d.list);
       if(!d.list.length||orders.length>=total)break;
      }
      if(orders.length>100){
       const check=await get("/lead-portfolio/order-history",{portfolioId:id,pageNumber:1,pageSize:100});
       if(JSON.stringify(check.list)!==firstPage||Number(check.total)!==total)consistent=false;
      }
     }catch(e){if(stopped)throw e;historyError=String(e);}
     const complete=!historyError&&consistent&&total!==null&&orders.length===total;
     history={orders,total,truncated:!complete,complete,observedAt:new Date().toISOString(),...(historyError?{error:historyError}:!consistent?{error:"分页期间订单变化，待重新核验"}:{})};
     if(!complete){
      await writeFile(join(runDir,id+"-partial-history.json"),JSON.stringify(history));
      const last=old.get(id)?.lastGoodHistory??(old.get(id)?.history?.complete?old.get(id).history:null);
      if(last)history={...last,observedAt:last.observedAt??old.get(id).observedAt,error:historyError??"本轮分页不完整；保留上次完整历史，暂停优质标记"};
     }
    }
    record={id,observedAt:new Date().toISOString(),profile:p,performance:perf,history,
     lastGoodHistory:history?.complete&&!history.error?history:old.get(id)?.lastGoodHistory??null};
   }catch(e){
    if(stopped)throw e;
    record={...(old.get(id)??{id,observedAt:startedAt,profile:discover.get(id)??null,performance:{},history:null}),error:String(e)};
   }
   rows.push(record);await writeFile(join(runDir,id+".json"),JSON.stringify(record));
   done++;progress({phase:"profiles",message:"已复核 "+done+" / "+ids.length+" 位带单员",done,total:ids.length});
  }
 }
 // Two workers, shared pacing; rate/access restrictions abort without publishing partial data.
 const workers=await Promise.allSettled([worker(),worker()]);
 const failed=workers.find(w=>w.status==="rejected");
 if(failed)throw failed.reason;
 if(rows.length!==ids.length)throw Error("本次成员采集未完成");
 const snapshot=makeSnapshot(rows,previous,scope==="retry"?"all":scope,"币安公开带单网页数据（真实采集）",discovered);
 if(scope==="retry"){snapshot.poolUpdatedAt=previous.poolUpdatedAt;snapshot.scope="retry-failed";}
 for(const r of rows)old.set(r.id,r);
 await writeFile(join(runDir,"snapshot.json"),JSON.stringify(snapshot));
 await writeFile(join(runDir,"manifest.json"),JSON.stringify({startedAt,completedAt:snapshot.generatedAt,scope,discovered,targetCount:ids.length,coverage:snapshot.coverage,requestErrors},null,2));
 // Both artifacts are atomic individually. Snapshot is promoted last, leaving the old UI on any error.
 await writeFile(join(dataDir,"records.json.tmp"),JSON.stringify([...old.values()]));await rename(join(dataDir,"records.json.tmp"),join(dataDir,"records.json"));
 await writeFile(join(dest,"latest.json.tmp"),JSON.stringify(snapshot));await rename(join(dest,"latest.json.tmp"),join(dest,"latest.json"));
 progress({phase:"complete",message:"带单双池复核完成",coverage:snapshot.coverage,scope});
}
try{await main();}
catch(e){console.error(String(e));process.exitCode=1;}
finally{await writeFile(join(runDir,"requests.json"),JSON.stringify({receipts,errors:requestErrors}));await lock.close();await unlink(lockPath);}
