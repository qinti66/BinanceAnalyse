import fs from "node:fs";
import path from "node:path";

const root=process.argv[2]||process.cwd();
const pointer=JSON.parse(fs.readFileSync(path.join(root,"analysis","latest.json"),"utf8"));
const analysisDir=pointer.path;
const snapshotDir=JSON.parse(fs.readFileSync(path.join(root,"data","full-snapshots","latest.json"),"utf8")).runDir;
const traderAnalysis=JSON.parse(fs.readFileSync(path.join(analysisDir,"trader-analysis.json"),"utf8"));
const coinAnalysis=JSON.parse(fs.readFileSync(path.join(analysisDir,"coin-analysis.json"),"utf8"));
const histories=JSON.parse(fs.readFileSync(path.join(snapshotDir,"copy-trader-order-history.json"),"utf8"));
const marketData=JSON.parse(fs.readFileSync(path.join(snapshotDir,"hot-coin-market-data.json"),"utf8"));
const cycles=JSON.parse(fs.readFileSync(path.join(analysisDir,"position-cycles.json"),"utf8")).cycles;

const n=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(v,a=-1,b=1)=>Math.max(a,Math.min(b,n(v)));
const round=(v,d=4)=>Number.isFinite(v)?Number(v.toFixed(d)):null;
const capturedMs=Date.parse(traderAnalysis.capturedAt);
const lookbackMs=24*60*60*1000;
const recentStart=capturedMs-lookbackMs;
const traderById=new Map(traderAnalysis.traders.map(t=>[String(t.id),t]));
const strict=traderAnalysis.traders.filter(t=>t.eligible&&t.metrics.washRiskScore<25);
const strictIds=new Set(strict.map(t=>String(t.id)));
const weightOf=t=>clamp((n(t.compositeScore)/100)*(1-n(t.metrics.washRiskScore)/100)*(.5+.5*n(t.metrics.confidence)),0,1);
const tokenBySymbol=new Map();
for(const m of marketData.mapping||[]){
  if(m.futuresSymbol)tokenBySymbol.set(m.futuresSymbol,m.token);
  if(m.spotSymbol)tokenBySymbol.set(m.spotSymbol,m.token);
}
const resultByToken=new Map(coinAnalysis.coins.map(c=>[c.token,{
  token:c.token,hotRank:c.hotRank,heatRank:c.heatRank,heatScore:c.heatScore,squareSentimentScore:c.sentimentScore,
  squareSentimentLabel:c.sentimentLabel,priceChangePct:c.priceChangePct,takerBuySellRatio:c.takerBuySellRatio,
  fundingRate:c.fundingRate,quoteVolume:c.quoteVolume,flags:[...c.flags],
  currentVotes:[],flowVotes:[],cycleVotes:[],recentOrderCount:0,recentCycleCount:0,involved:new Set()
}]));

function orderDirection(o){
  const side=String(o.side).toUpperCase(),ps=String(o.positionSide||"BOTH").toUpperCase();
  if(ps==="LONG")return side==="BUY"?1:-1;
  if(ps==="SHORT")return side==="SELL"?-1:1;
  return side==="BUY"?1:-1;
}
function isOpen(o){
  const side=String(o.side).toUpperCase(),ps=String(o.positionSide||"BOTH").toUpperCase();
  if(ps==="LONG")return side==="BUY";
  if(ps==="SHORT")return side==="SELL";
  return n(o.totalPnl)===0;
}

for(const h of histories.histories||[]){
  const id=String(h.id);
  if(!strictIds.has(id))continue;
  const trader=traderById.get(id),weight=weightOf(trader);
  const orders=[...(h.orders||[])].sort((a,b)=>n(a.orderTime||a.orderUpdateTime)-n(b.orderTime||b.orderUpdateTime));
  const states=new Map();
  let totalRecentNotional=0;
  const recentByToken=new Map();
  for(const o of orders){
    const token=tokenBySymbol.get(String(o.symbol));
    const qty=Math.abs(n(o.executedQty)),price=Math.abs(n(o.avgPrice)),notional=qty*price,ts=n(o.orderTime||o.orderUpdateTime);
    if(ts>=recentStart&&ts<=capturedMs&&token){
      totalRecentNotional+=notional;
      const prev=recentByToken.get(token)||{signed:0,turnover:0,orders:0};
      prev.signed+=orderDirection(o)*notional;prev.turnover+=notional;prev.orders++;
      recentByToken.set(token,prev);
    }
    if(!token||!(qty>0))continue;
    const ps=String(o.positionSide||"BOTH").toUpperCase(),key=token+"|"+ps;
    let s=states.get(key);
    if(isOpen(o)){
      if(!s)s={token,side:ps,qty:0,cost:0,lastTs:ts};
      s.qty+=qty;s.cost+=notional;s.lastTs=ts;states.set(key,s);
    }else if(s&&s.qty>0){
      const used=Math.min(qty,s.qty),ratio=used/s.qty;
      s.cost-=s.cost*ratio;s.qty-=used;s.lastTs=ts;
      if(s.qty<=Math.max(1e-10,used*1e-9))states.delete(key);else states.set(key,s);
    }
  }
  const currentByToken=new Map();
  for(const s of states.values()){
    const x=currentByToken.get(s.token)||{long:0,short:0};
    if(s.side==="SHORT")x.short+=Math.max(0,s.cost);else x.long+=Math.max(0,s.cost);
    currentByToken.set(s.token,x);
  }
  const totalCurrent=[...currentByToken.values()].reduce((a,x)=>a+x.long+x.short,0);
  for(const [token,x] of currentByToken){
    const target=resultByToken.get(token);if(!target)continue;
    const net=x.long-x.short,gross=x.long+x.short,share=totalCurrent?gross/totalCurrent:0;
    target.currentVotes.push({traderId:id,name:trader.nickname,weight,signal:net===0?0:Math.sign(net)*Math.sqrt(share),longNotional:x.long,shortNotional:x.short});
    target.involved.add(id);
  }
  for(const [token,x] of recentByToken){
    const target=resultByToken.get(token);if(!target)continue;
    const portfolioShare=totalRecentNotional?x.turnover/totalRecentNotional:0;
    const directional=x.turnover?x.signed/x.turnover:0;
    target.flowVotes.push({traderId:id,name:trader.nickname,weight,signal:directional*Math.sqrt(portfolioShare),signedNotional:x.signed,turnover:x.turnover,orders:x.orders});
    target.recentOrderCount+=x.orders;target.involved.add(id);
  }
}

for(const c of cycles){
  const id=String(c.traderId),token=tokenBySymbol.get(String(c.symbol));
  if(!strictIds.has(id)||!token||n(c.closedAt)<recentStart||n(c.closedAt)>capturedMs)continue;
  const target=resultByToken.get(token);if(!target)continue;
  const trader=traderById.get(id),weight=weightOf(trader);
  const side=String(c.side)==="SHORT"?-1:1;
  const performance=clamp(Math.tanh(n(c.realizedReturn)*20),-1,1);
  target.cycleVotes.push({traderId:id,name:trader.nickname,weight,signal:side*performance,side:c.side,realizedPnl:c.realizedPnl,realizedReturn:c.realizedReturn,holdSeconds:c.holdSeconds});
  target.recentCycleCount++;target.involved.add(id);
}

function weighted(votes){
  const den=votes.reduce((a,x)=>a+x.weight,0);
  return den?votes.reduce((a,x)=>a+x.weight*x.signal,0)/den:0;
}
function marketScore(c){
  const momentum=clamp((n(c.priceChangePct)+10)/20,0,1);
  const taker=c.takerBuySellRatio==null?.5:clamp((Math.log(Math.max(.05,n(c.takerBuySellRatio)))+1.5)/3,0,1);
  return 100*(momentum*.55+taker*.45);
}
function conclusion(x){
  const conf=x.smartMoneyConfidence;
  if(conf<20&&x.heatScore>=55)return {label:"热门但缺少聪明钱样本",stance:"谨慎",reason:"广场热度较高，但严格候选交易员在该币上的公开订单不足。"};
  if(x.heatScore>=55&&x.squareSentimentScore>=55&&x.smartMoneyScore>=60&&conf>=30)return {label:"广场与聪明钱共振偏多",stance:"偏多",reason:"高讨论热度、广场情绪与严格候选交易员方向同时偏多。"};
  if(x.heatScore>=55&&x.smartMoneyScore<=40&&conf>=30)return {label:"高热度但聪明钱偏空",stance:"规避追多",reason:"讨论热度较高，但低风险高手的持仓或近期订单方向偏空。"};
  if(x.heatScore>=55&&x.squareSentimentScore>=60&&x.smartMoneyScore<55&&conf>=25)return {label:"广场偏多，聪明钱未确认",stance:"等待",reason:"广场情绪乐观，但严格候选交易员没有形成同向确认。"};
  if(x.heatScore>=50&&x.squareSentimentScore<=40&&x.smartMoneyScore>=60&&conf>=30)return {label:"广场偏空，聪明钱逆向吸筹",stance:"逆向观察",reason:"广场情绪偏空，但低风险高手的持仓与订单方向偏多。"};
  if(x.smartMoneyScore>=60&&conf>=30&&x.heatScore<55)return {label:"聪明钱偏多，广场热度未起",stance:"提前观察",reason:"低风险高手方向偏多，但广场讨论热度尚未形成共振。"};
  if(x.fusionScore>=60&&x.smartMoneyScore>=55&&conf>=25)return {label:"聪明钱确认度较高",stance:"偏多观察",reason:"聪明钱方向和市场成交确认较强，但广场热度尚未完全共振。"};
  if(x.smartMoneyScore<=45&&conf>=30)return {label:"聪明钱方向偏空",stance:"偏空",reason:"严格候选交易员的当前持仓与近期订单整体偏空。"};
  return {label:"暂无一致结论",stance:"中性",reason:"广场、聪明钱与市场成交之间尚未形成足够一致的方向。"};
}

const fusion=[...resultByToken.values()].map(x=>{
  const current=weighted(x.currentVotes),flow=weighted(x.flowVotes),performance=weighted(x.cycleVotes);
  const currentTraders=new Set(x.currentVotes.map(v=>v.traderId)).size;
  const recentTraders=new Set(x.flowVotes.map(v=>v.traderId)).size;
  const activeTraders=x.involved.size;
  const confidence=100*(Math.min(1,currentTraders/3)*.45+Math.min(1,recentTraders/5)*.35+Math.min(1,x.recentOrderCount/15)*.20);
  const smart=clamp(50+current*24+flow*18+performance*8,0,100);
  const market=marketScore(x);
  const fusionScore=x.heatScore*.25+x.squareSentimentScore*.20+smart*.40+market*.15;
  const decisionScore=fusionScore*(.55+.45*confidence/100);
  const currentLong=x.currentVotes.reduce((a,v)=>a+v.longNotional,0);
  const currentShort=x.currentVotes.reduce((a,v)=>a+v.shortNotional,0);
  const recentNet=x.flowVotes.reduce((a,v)=>a+v.signedNotional,0);
  const topParticipants=[...new Map([...x.currentVotes,...x.flowVotes].sort((a,b)=>b.weight-a.weight).map(v=>[v.traderId,{traderId:v.traderId,name:v.name,score:traderById.get(v.traderId)?.compositeScore,risk:traderById.get(v.traderId)?.metrics.washRiskScore,currentSide:x.currentVotes.find(p=>p.traderId===v.traderId)?.signal>0?"LONG":x.currentVotes.find(p=>p.traderId===v.traderId)?.signal<0?"SHORT":"NONE",recentFlow:x.flowVotes.find(p=>p.traderId===v.traderId)?.signal??0}]))].slice(0,5).map(([,v])=>v);
  const row={
    token:x.token,hotRank:x.hotRank,heatRank:x.heatRank,heatScore:x.heatScore,squareSentimentScore:x.squareSentimentScore,
    squareSentimentLabel:x.squareSentimentLabel,smartMoneyScore:round(smart,1),smartMoneyConfidence:round(confidence,1),
    marketConfirmationScore:round(market,1),fusionScore:round(fusionScore,1),decisionScore:round(decisionScore,1),
    currentConsensus:round(current,4),recentFlowSignal:round(flow,4),recentPerformanceSignal:round(performance,4),
    strictTraderCount:activeTraders,currentPositionTraderCount:currentTraders,recentTraderCount:recentTraders,
    recentOrderCount:x.recentOrderCount,recentCycleCount:x.recentCycleCount,currentLongNotional:round(currentLong,2),
    currentShortNotional:round(currentShort,2),recentNetDirectionalNotional:round(recentNet,2),
    priceChangePct:x.priceChangePct,takerBuySellRatio:x.takerBuySellRatio,fundingRate:x.fundingRate,
    topParticipants,existingFlags:x.flags
  };
  return {...row,...conclusion(row)};
}).sort((a,b)=>b.decisionScore-a.decisionScore||b.fusionScore-a.fusionScore);
fusion.forEach((x,i)=>x.fusionRank=i+1);

const output={
  generatedAt:new Date().toISOString(),snapshotId:traderAnalysis.snapshotId,capturedAt:traderAnalysis.capturedAt,
  methodology:{
    smartMoneyPool:"仅使用同时满足公开订单、完整周期>=30、覆盖>=7天、跟单者PnL>0、MDD<=50%、风险分<25的严格候选账户。",
    smartMoneyScore:"当前未平仓方向48% + 最近24小时方向性订单36% + 最近24小时已平仓方向收益16%，每位交易员按综合分、真实性与样本置信度加权。",
    fusionScore:"广场热度25% + 广场情绪20% + 聪明钱40% + 价格/主动成交确认15%；决策分再按聪明钱证据置信度折减。",
    confidence:"依据当前持仓交易员数量、最近24小时活跃交易员数量和订单数量计算。",
    disclaimer:"一次性快照用于识别共振与背离，不代表未来收益，也不构成交易指令。"
  },
  coverage:{strictSmartMoneyTraders:strict.length,hotCoins:fusion.length,lookbackHours:24},
  coins:fusion
};
fs.writeFileSync(path.join(analysisDir,"fusion-analysis.json"),JSON.stringify(output,null,2));
const dashboardPath=path.join(root,"lib","dashboard-data.json");
const dashboard=JSON.parse(fs.readFileSync(dashboardPath,"utf8"));
dashboard.fusion=output;
fs.writeFileSync(dashboardPath,JSON.stringify(dashboard,null,2));
console.log(JSON.stringify({coverage:output.coverage,top:fusion.slice(0,12).map(x=>({token:x.token,fusion:x.fusionScore,heat:x.heatScore,square:x.squareSentimentScore,smart:x.smartMoneyScore,confidence:x.smartMoneyConfidence,label:x.label,strict:x.strictTraderCount,current:x.currentPositionTraderCount,recent:x.recentTraderCount})),divergence:fusion.filter(x=>x.label.includes("偏空")||x.label.includes("未确认")||x.label.includes("缺少")).slice(0,10).map(x=>({token:x.token,label:x.label,heat:x.heatScore,smart:x.smartMoneyScore,confidence:x.smartMoneyConfidence}))},null,2));
