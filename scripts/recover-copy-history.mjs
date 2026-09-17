// One-time recovery for the first collection: seed last-known complete evidence
// from the original immutable snapshot, never label it as newly fetched history.
import {readFile,writeFile,rename} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {makeSnapshot} from "../lib/copy-trading/model.ts";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const read=async p=>JSON.parse(await readFile(join(root,p),"utf8"));
const pointer=await read("data/full-snapshots/latest.json");
const history=JSON.parse(await readFile(join(pointer.runDir,"copy-trader-order-history.json"),"utf8"));
const originals=new Map(history.histories.map(h=>[String(h.id),h]));
const rows=await read("data/copy-trading/records.json"),previous=await read("public/copy-trading/latest.json");
let restored=0;
for(const r of rows){
 const orig=originals.get(r.id);
 if(r.history&&!r.history.error&&r.history.complete){r.lastGoodHistory=r.history;continue;}
 if(orig&&orig.truncated===false&&orig.returned===orig.total){
  const last={orders:orig.orders,total:orig.total,complete:true,truncated:false,observedAt:history.capturedAt};
  r.lastGoodHistory=last;
  if(r.profile?.positionShow===true){r.history={...last,error:r.history?.error??"本轮历史未完整获取；保留历史证据，等待重试"};restored++;}
 }
}
const result=makeSnapshot(rows,previous,"all","币安公开数据；部分订单采用原始快照保留证据，待重新核验",previous.coverage.discovered);
result.poolUpdatedAt=previous.poolUpdatedAt;
await writeFile(join(root,"data/copy-trading/records.json.tmp"),JSON.stringify(rows));await rename(join(root,"data/copy-trading/records.json.tmp"),join(root,"data/copy-trading/records.json"));
await writeFile(join(root,"public/copy-trading/latest.json.tmp"),JSON.stringify(result));await rename(join(root,"public/copy-trading/latest.json.tmp"),join(root,"public/copy-trading/latest.json"));
console.log(JSON.stringify({restored,coverage:result.coverage}));
