import {readFile,mkdir,writeFile,rename} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {makeSnapshot} from "../lib/copy-trading/model.ts";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const pointer=JSON.parse(await readFile(join(root,"data/full-snapshots/latest.json"),"utf8"));
const read=async name=>JSON.parse(await readFile(join(pointer.runDir,name),"utf8"));
const [boards,profiles,histories]=await Promise.all(["copy-trader-leaderboards.json","copy-trader-profiles.json","copy-trader-order-history.json"].map(read));
const history=new Map(histories.histories.map(h=>[String(h.id),h])),perfs=new Map();
for(const b of boards.leaderboards)for(const r of b.list){const id=String(r.leadPortfolioId);if(!perfs.has(id))perfs.set(id,{});perfs.get(id)[b.request.timeRange]??=r;}
const rows=profiles.profiles.map(p=>{const h=history.get(String(p.id));return {id:String(p.id),observedAt:histories.capturedAt,profile:p.data,performance:perfs.get(String(p.id))??{},history:h?{orders:h.orders,total:h.total,truncated:Boolean(h.truncated),complete:h.truncated===false&&h.returned===h.total}:null};});
const dest=join(root,"public/copy-trading"),dataDir=join(root,"data/copy-trading");await mkdir(dest,{recursive:true});await mkdir(dataDir,{recursive:true});
const result=makeSnapshot(rows,null,"all","项目内历史真实快照（非本次重新采集）",perfs.size);
// Imported records keep their source times rather than claiming a new network refresh.
result.poolUpdatedAt={quality:histories.capturedAt,ordinary:histories.capturedAt};
await writeFile(join(dataDir,"records.json"),JSON.stringify(rows));
await writeFile(join(dest,"latest.json.tmp"),JSON.stringify(result));await rename(join(dest,"latest.json.tmp"),join(dest,"latest.json"));
console.log(JSON.stringify({coverage:result.coverage,quality:result.traders.filter(t=>t.pool==="quality").map(t=>({id:t.id,name:t.name})),closest:result.traders.slice(0,5).map(t=>({name:t.name,failed:t.reasons}))},null,2));
