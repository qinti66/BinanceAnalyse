import "./require-node.mjs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RateLimiter } from "./rate-limit.mjs";
import { classifyRequest } from "./collector-cost.mjs";
import { isDue, mergeSeries, T2_LIMIT } from "./positions-store.mjs";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const startedAt=new Date().toISOString(),id=startedAt.replace(/[:.]/g,"-");
const output=join(root,"data","indicators",id);
await mkdir(output,{recursive:true});
const cutoff=Math.floor(Date.now()/3600000)*3600000;
// T2: topLongShortPositionRatio has no consumer (no page field reads it) but its history cannot be back-filled, so it is kept in a separate append-only store, not in the snapshot.
const positionsDir=join(root,"data","indicators","positions");
await mkdir(positionsDir,{recursive:true});
const readStore=async p=>{try{return JSON.parse(await readFile(p,"utf8"))}catch{return null}};
const positionsGaps=[];
// Per-family limiter (rate-limit.mjs): /futures/data/ is capped at 900 per 5 min, the market families by request weight. 403/418 abort, 429 blocks all families.
const limiter=new RateLimiter();
let requestCount=0;
const errors=[],responses=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url){
  for(let attempt=0;attempt<3;attempt++){
    const cls=classifyRequest(url);
    if(cls)await limiter.acquire(cls.family,cls.cost);
    const receivedAt=new Date().toISOString();requestCount++;
    try{
      const r=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{accept:"application/json","user-agent":"AlphaRadarResearch/2.0"}});
      if(cls){
        const used=Number(r.headers.get("x-mbx-used-weight-1m"));
        if(cls.family!=="futuresData"&&Number.isFinite(used)&&r.headers.has("x-mbx-used-weight-1m"))limiter.feedback(cls.family,used);
      }
      if(r.status===418||r.status===403)limiter.onStatus(r.status);
      if(r.status===429){
        limiter.onStatus(429,r.headers.get("retry-after"));
        if(attempt===2)throw new Error("HTTP 429 after retries");
        continue;
      }
      if(!r.ok)throw new Error("HTTP "+r.status);
      const data=await r.json();
      if(data?.code<0)throw new Error("API "+data.code+" "+data.msg);
      responses.push({url,receivedAt,status:r.status});return data;
    }catch(e){
      if(e?.name==="RateLimitAbort")throw e;
      if(attempt===2||/HTTP 4/.test(String(e)))throw e;
      await wait(700*(attempt+1));
    }
  }
}
async function optional(url){try{return await get(url)}catch(e){if(e?.name==="RateLimitAbort")throw e;errors.push({url,error:String(e),at:new Date().toISOString()});return null;}}
const UM="https://fapi.binance.com",CM="https://dapi.binance.com";
const [um,cm]=await Promise.all([get(UM+"/fapi/v1/exchangeInfo"),get(CM+"/dapi/v1/exchangeInfo")]);
if(!Array.isArray(um.symbols)||!Array.isArray(cm.symbols))throw Error("Exchange universe unavailable; refusing a partial universe.");
const all=[
  ...um.symbols.map(s=>({...s,family:"UM",status:s.status})),
  ...cm.symbols.map(s=>({...s,family:"CM",status:s.contractStatus}))
];
const contracts=all.filter(s=>s.status==="TRADING"&&s.underlyingType==="COIN");
const excluded=all.filter(s=>s.status!=="TRADING"||s.underlyingType!=="COIN").map(s=>({family:s.family,symbol:s.symbol,status:s.status,underlyingType:s.underlyingType,reason:s.status!=="TRADING"?"非交易状态":"非代币合约"}));
const keys=new Set();for(const c of contracts){if(keys.has(c.symbol))throw Error("Duplicate symbol across API families requires migration reconciliation: "+c.symbol);keys.add(c.symbol);}
console.log(JSON.stringify({phase:"universe",contracts:contracts.length,baseAssets:new Set(contracts.map(c=>c.baseAsset)).size,excluded:excluded.length,cutoff:new Date(cutoff).toISOString()}));
await writeFile(join(output,"universe.json"),JSON.stringify({um,cm,excluded},null,2));
const [umTicker,cmTicker,umPremium,cmPremium,umFunding,cmFunding,umBook,cmBook,spot]=await Promise.all([
 optional(UM+"/fapi/v1/ticker/24hr"),optional(CM+"/dapi/v1/ticker/24hr"),
 optional(UM+"/fapi/v1/premiumIndex"),optional(CM+"/dapi/v1/premiumIndex"),
 optional(UM+"/fapi/v1/fundingInfo"),optional(CM+"/dapi/v1/fundingInfo"),
 optional(UM+"/fapi/v1/ticker/bookTicker"),optional(CM+"/dapi/v1/ticker/bookTicker"),
 optional("https://api.binance.com/api/v3/ticker/price")
]);
const index=list=>new Map((Array.isArray(list)?list:[]).map(x=>[x.symbol,x]));
const global={UM:{ticker:index(umTicker),premium:index(umPremium),funding:index(umFunding),book:index(umBook)},CM:{ticker:index(cmTicker),premium:index(cmPremium),funding:index(cmFunding),book:index(cmBook)}};
const spotIndex=index(spot);
const fx={USD:1,USDT:1};for(const quote of new Set(contracts.map(c=>c.quoteAsset))){const p=Number(spotIndex.get(quote+"USDT")?.price);if(p>0)fx[quote]=p;}
await writeFile(join(output,"global.json"),JSON.stringify({umTicker,cmTicker,umPremium,cmPremium,umFunding,cmFunding,umBook,cmBook,spot,fx},null,2));
const results=new Array(contracts.length);let cursor=0,completed=0;
async function worker(){
 while(cursor<contracts.length){
  const i=cursor++,c=contracts[i],base=c.family==="UM"?UM:CM,prefix=c.family==="UM"?"/fapi/v1":"/dapi/v1";
  const query=c.family==="UM"?"symbol="+c.symbol:"pair="+c.pair+"&contractType="+c.contractType;
  const storePath=join(positionsDir,c.family+"-"+c.symbol+".json"),store=await readStore(storePath),t2Due=isDue(store,Date.now());
  const [history,klines,openInterest,topAccountRatio,topPositionRatio,globalAccountRatio]=await Promise.all([
    optional(base+"/futures/data/openInterestHist?"+query+"&period=1h&limit=25&endTime="+cutoff),
    // 200 -> 360 根1h K线：早期信号体系（volSqueezePct）需要约14天（336点）自身ATR%历史分布做百分位排名。
    optional(base+prefix+"/klines?symbol="+c.symbol+"&interval=1h&limit=360&endTime="+(cutoff-1)),
    optional(base+prefix+"/openInterest?symbol="+c.symbol),
    // 早期信号体系新增：顶级账户（前20%保证金）与全市场账户多空比，同属 /futures/data/ 免鉴权接口族，与 openInterestHist 用同一限速节奏。
    optional(base+"/futures/data/topLongShortAccountRatio?"+query+"&period=1h&limit=48&endTime="+cutoff),
    t2Due?optional(base+"/futures/data/topLongShortPositionRatio?"+query+"&period=1h&limit="+T2_LIMIT+"&endTime="+cutoff):Promise.resolve(null),
    optional(base+"/futures/data/globalLongShortAccountRatio?"+query+"&period=1h&limit=48&endTime="+cutoff)
  ]);
  const g=global[c.family];
  const value={contract:c,history,klines,openInterest,ticker:g.ticker.get(c.symbol)??null,premium:g.premium.get(c.symbol)??null,
    funding:g.funding.get(c.symbol)??null,fundingEndpointAvailable:c.family==="UM"?Array.isArray(umFunding):Array.isArray(cmFunding),
    book:g.book.get(c.symbol)??null,quoteUsd:fx[c.quoteAsset]??null,receivedAt:new Date().toISOString(),
    topAccountRatio:Array.isArray(topAccountRatio)?topAccountRatio:null,
    globalAccountRatio:Array.isArray(globalAccountRatio)?globalAccountRatio:null};
  if(t2Due&&Array.isArray(topPositionRatio)){
    const m=mergeSeries(store,topPositionRatio,Date.now());
    await writeFile(storePath+".tmp",JSON.stringify(m.store));await rename(storePath+".tmp",storePath);
    if(m.gap)positionsGaps.push({symbol:c.symbol,...m.gap});
  }
  results[i]=value;
  await writeFile(join(output,c.family+"-"+c.symbol+".json"),JSON.stringify(value));
  completed++;if(completed%25===0||completed===contracts.length)console.log(JSON.stringify({phase:"contracts",completed,total:contracts.length,errors:errors.length,requests:requestCount}));
 }
}
await Promise.all(Array.from({length:4},worker));
// Optional external market-cap cross-check. Missing/ambiguous symbols never get guessed.
const marketCaps=[];
for(let page=1;page<=4;page++){
 const data=await optional("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page="+page+"&sparkline=false");
 if(!Array.isArray(data))break;marketCaps.push(...data);await wait(2200);
}
const raw={schemaVersion:1,id,startedAt,completedAt:new Date().toISOString(),cutoff,contracts:results,excluded,marketCaps,errors,
 coverage:{um:contracts.filter(c=>c.family==="UM").length,cm:contracts.filter(c=>c.family==="CM").length,allListed:all.length,allTrading:all.filter(c=>c.status==="TRADING").length},
 fxNote:"USD=1、USDT≈1 USD；其他报价使用采集时币安现货兑 USDT 汇率。"};
await writeFile(join(output,"raw.json"),JSON.stringify(raw));
await writeFile(join(output,"requests.json"),JSON.stringify(responses));
await writeFile(join(output,"manifest.json"),JSON.stringify({id,startedAt,completedAt:raw.completedAt,cutoff,contracts:results.length,errors,requests:requestCount,coverage:raw.coverage,positionsGaps},null,2));
// Promote only after every contract has been attempted and raw snapshots are durable.
const pointer=join(root,"data","indicators","latest.json");
await writeFile(pointer+".tmp",JSON.stringify({id,path:output,completedAt:raw.completedAt},null,2));
await rename(pointer+".tmp",pointer);
console.log(JSON.stringify({phase:"complete",output,contracts:results.length,errors:errors.length}));
