import {readFile,writeFile,rename,readdir} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {makeSnapshot} from "../lib/copy-trading/model.ts";
const root=join(dirname(fileURLToPath(import.meta.url)),".."),dataDir=join(root,"data/copy-trading");
const read=async path=>JSON.parse(await readFile(path,"utf8"));
// This command never calls Binance. A completed-record import is explicit.
try{await readFile(join(dataDir,"update.lock"));throw Error("更新锁存在；先确认采集已经停止。");}catch(e){if(e.code!=="ENOENT")throw e;}
const rows=await read(join(dataDir,"records.json")),previous=await read(join(root,"public/copy-trading/latest.json"));
const map=new Map(rows.map(r=>[r.id,r]));let imported=0;
const stamp=process.argv[2];
if(stamp){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(stamp))throw Error("Invalid batch name");
 const dir=join(dataDir,stamp);
 for(const name of await readdir(dir)){
  if(!/^\d+\.json$/.test(name))continue;
  const r=await read(join(dir,name));if(!map.has(r.id)||String(r.id)+".json"!==name)throw Error("Unexpected portfolio ID");
  map.set(r.id,r);imported++;
 }
}
const result=makeSnapshot([...map.values()],previous,"all",stamp?"币安公开数据 · 本轮因限流停止，仅合并已完成记录，其余待复核":previous.source,previous.coverage.discovered);
result.poolUpdatedAt=previous.poolUpdatedAt;result.scope=stamp?"partial-completed-records":"local-reanalysis";
if(stamp)result.notes.unshift("最近一次复核被平台限流中止，已完成 "+imported+" 位的记录获保留；不是全池更新成功，参见每行证据时间。");
await writeFile(join(dataDir,"records.json.tmp"),JSON.stringify([...map.values()]));await rename(join(dataDir,"records.json.tmp"),join(dataDir,"records.json"));
await writeFile(join(root,"public/copy-trading/latest.json.tmp"),JSON.stringify(result));await rename(join(root,"public/copy-trading/latest.json.tmp"),join(root,"public/copy-trading/latest.json"));
if(stamp)await writeFile(join(dataDir,stamp,"interrupted-analysis.json"),JSON.stringify({status:"stopped-on-rate-limit",imported,at:result.generatedAt,coverage:result.coverage}));
console.log(JSON.stringify({imported,coverage:result.coverage,quality:result.traders.filter(t=>t.pool==="quality").map(t=>({id:t.id,name:t.name,holding:t.metrics.medianHoldSeconds,cycles:t.metrics.cycleCount}))},null,2));
