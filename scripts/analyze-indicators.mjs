import { readFile,writeFile,mkdir,rename } from "node:fs/promises";
import { join,dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndicators } from "../lib/indicators/model.ts";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const pointer=JSON.parse(await readFile(join(root,"data","indicators","latest.json"),"utf8"));
const raw=JSON.parse(await readFile(join(pointer.path,"raw.json"),"utf8"));
try{
 const spot=JSON.parse(await readFile(join(pointer.path,"spot-prices.json"),"utf8"));
 if(spot.cutoff===raw.cutoff){
  raw.spotPrices=spot.prices;
  if(Date.parse(spot.receivedAt)>Date.parse(raw.completedAt))raw.completedAt=spot.receivedAt;
  raw.errors.push(...(spot.errors??[]).map(e=>({url:"Binance spot klines: "+e.symbol,error:e.error})));
 }
}catch{/* no aligned spot data: do not substitute futures prices */}
const result=buildIndicators(raw);
await writeFile(join(pointer.path,"analysis.json"),JSON.stringify(result));
const dest=join(root,"public","indicators");await mkdir(dest,{recursive:true});
await writeFile(join(dest,"latest.json.tmp"),JSON.stringify(result));
await rename(join(dest,"latest.json.tmp"),join(dest,"latest.json"));
console.log(JSON.stringify({coverage:result.coverage,top:result.coins.filter(c=>c.candidate).slice(0,12).map(c=>({token:c.token,oi4:c.oi.h4,io4:c.flows.h4?.net,oiCap:c.oiCapPct,reason:c.reason}))},null,2));
