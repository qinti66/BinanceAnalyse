import { readFile,writeFile } from "node:fs/promises";
import { join,dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenIdentity } from "../lib/indicators/model.ts";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const pointer=JSON.parse(await readFile(join(root,"data","indicators","latest.json"),"utf8"));
const raw=JSON.parse(await readFile(join(pointer.path,"raw.json"),"utf8"));
let next=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url){
 const t=Math.max(Date.now(),next);next=t+180;await sleep(t-Date.now());
 const r=await fetch(url,{signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error("HTTP "+r.status);
 return r.json();
}
const ex=await get("https://api.binance.com/api/v3/exchangeInfo");
const available=new Map(ex.symbols.filter(s=>s.status==="TRADING"&&s.quoteAsset==="USDT"&&s.isSpotTradingAllowed!==false).map(s=>[s.baseAsset,s.symbol]));
const tokens=[...new Set(raw.contracts.map(c=>tokenIdentity(c.contract.baseAsset).token))];
const prices={},missing=[],errors=[];let cursor=0;
async function worker(){
 while(cursor<tokens.length){
  const token=tokens[cursor++],symbol=available.get(token);
  if(!symbol){missing.push({token,reason:"没有交易中的币安 USDT 现货对"});continue;}
  try{
   const data=await get("https://api.binance.com/api/v3/klines?symbol="+encodeURIComponent(symbol)+"&interval=1h&limit=1&endTime="+(raw.cutoff-1));
   if(!Array.isArray(data)||!data[0]||Number(data[0][6])!==raw.cutoff-1||!(Number(data[0][4])>0))throw Error("No aligned spot candle");
   prices[token]={priceUsd:Number(data[0][4]),time:raw.cutoff,symbol,source:"Binance spot 1h close; USDT≈USD"};
  }catch(e){if(/HTTP (418|429)/.test(String(e)))throw e;errors.push({token,symbol,error:String(e)});}
 }
}
await Promise.all(Array.from({length:4},worker));
await writeFile(join(pointer.path,"spot-prices.json"),JSON.stringify({cutoff:raw.cutoff,prices,missing,errors,receivedAt:new Date().toISOString()}));
console.log(JSON.stringify({phase:"spot",prices:Object.keys(prices).length,missing:missing.length,errors:errors.length}));
