import {mkdir,readFile,writeFile,rename,open,unlink} from "node:fs/promises";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {normalizeSquare} from "../lib/square/normalize.ts";
const root=join(dirname(fileURLToPath(import.meta.url)),".."),data=join(root,"data/square"),dest=join(root,"public/square");
await mkdir(data,{recursive:true});await mkdir(dest,{recursive:true});
const lockPath=join(data,"update.lock");let lock;
try{lock=await open(lockPath,"wx");await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));}catch{throw Error("广场采集已有任务或遗留锁；请先检查，不重复启动");}
const startedAt=new Date().toISOString(),runDir=join(data,startedAt.replace(/[:.]/g,"-"));await mkdir(runDir,{recursive:true});
const receipts=[],rows=[],errors=[],feeds=[];
let stopped=false;
try{
 const indicator=JSON.parse(await readFile(join(root,"public/indicators/latest.json"),"utf8"));
 const tokens=new Set(indicator.coins.map(c=>c.token));
 for(const [type,maxPages] of [[1,10],[2,50]]){
  const ids=new Set();let reason="达到采样页数上限",pages=0;
  for(let page=1;page<=maxPages;page++){
   if(stopped)break;
   const url="https://www.binance.com/bapi/composite/v3/friendly/pgc/content/article/list?pageIndex="+page+"&pageSize=20&type="+type;
   try{
    const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(20000)});
    receipts.push({url,status:r.status,at:new Date().toISOString()});
    if([401,403,418,429].includes(r.status)){stopped=true;throw Error("访问/限流限制 HTTP "+r.status+"；停止，不绕过限制");}
    if(!r.ok)throw Error("HTTP "+r.status);
    const j=await r.json();if(j.code!=="000000"||!Array.isArray(j.data?.vos))throw Error("接口失败或结构变化："+j.code);
    await writeFile(join(runDir,type+"-"+page+".json"),JSON.stringify(j));
    pages++;const list=j.data.vos;
    if(!list.length){reason="公开列表已结束";break;}
    const unique=list.filter(v=>!ids.has(String(v.id)));for(const v of unique)ids.add(String(v.id));
    if(!unique.length){reason="返回重复分页，停止以避免重复计数";break;}
    rows.push(...unique);
    console.log(JSON.stringify({phase:"square",message:"广场"+(type===1?"热门":"最新")+"已采集 "+pages+" 页，共 "+rows.length+" 条原始记录"}));
    // Only latest feed is time-ordered. Stop after a full page is outside the 24h window.
    if(type===2&&list.every(v=>Number(v.date)*1000<Date.parse(startedAt)-24*3600000)){reason="已达到24h窗口边界";break;}
    await new Promise(r=>setTimeout(r,850));
   }catch(e){errors.push({url,error:String(e)});reason="请求失败，本次未完成";stopped=true;break;}
  }
  feeds.push({type,pages,reason});
 }
 const capturedAt=new Date().toISOString(),snapshot=normalizeSquare(rows,capturedAt,tokens);
 const coverage={rawRecords:rows.length,uniquePosts:new Set(rows.map(r=>r.id)).size,coinOpinions:snapshot.posts.length,coins:new Set(snapshot.posts.map(p=>p.symbol)).size,authors:new Set(snapshot.posts.map(p=>p.authorId)).size,sharedCards:snapshot.posts.filter(p=>p.sharedPosition).length,complete:!errors.length,feeds};
 await writeFile(join(runDir,"manifest.json"),JSON.stringify({startedAt,capturedAt,coverage,receipts,errors},null,2));
 if(errors.length||!snapshot.posts.length)throw Error("本轮广场未完整完成或没有可用观点；保留旧快照。"+(errors[0]?.error??""));
 const output={...snapshot,coverage};
 await writeFile(join(runDir,"snapshot.json"),JSON.stringify(output));
 await writeFile(join(dest,"latest.json.tmp"),JSON.stringify(output));await rename(join(dest,"latest.json.tmp"),join(dest,"latest.json"));
 console.log(JSON.stringify({phase:"complete",message:"广场真实采样完成（非全站全量）",coverage}));
}catch(e){console.error(String(e));process.exitCode=1;}
finally{await lock.close();await unlink(lockPath);}
