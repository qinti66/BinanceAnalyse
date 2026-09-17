import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.argv[2] || process.cwd();
const pointer = JSON.parse(fs.readFileSync(path.join(root,"data","full-snapshots","latest.json"),"utf8"));
const input = pointer.runDir;
const id = path.basename(input);
const out = path.join(root,"analysis",id);
fs.mkdirSync(out,{recursive:true});
const read = n => JSON.parse(fs.readFileSync(path.join(input,n),"utf8"));
const n = (v,d=0) => Number.isFinite(Number(v)) ? Number(v) : d;
const clamp = (v,a=0,b=1) => Math.max(a,Math.min(b,n(v)));
const r = (v,d=4) => Number.isFinite(v) ? Number(v.toFixed(d)) : null;
const rat = (a,b) => b ? a/b : null;
const pct = (xs,p) => {
  if(!xs.length) return null;
  const s=[...xs].sort((a,b)=>a-b), i=(s.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i);
  return s[lo]+(s[hi]-s[lo])*(i-lo);
};
const json=(name,x)=>fs.writeFileSync(path.join(out,name),JSON.stringify(x,null,2));
const esc=v=>'"'+String(v??"").replaceAll('"','""')+'"';
const csv=(name,rows)=>{
  if(!rows.length) return fs.writeFileSync(path.join(out,name),"");
  const keys=Object.keys(rows[0]);
  fs.writeFileSync(path.join(out,name),[keys.map(esc).join(","),...rows.map(x=>keys.map(k=>esc(x[k])).join(","))].join("\n")+"\n");
};
const sha=f=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const boards=read("copy-trader-leaderboards.json");
const profiles=read("copy-trader-profiles.json");
const histories=read("copy-trader-order-history.json");
const hot=read("hot-coins.json");
const overview=read("market-overview.json");
const markets=read("hot-coin-market-data.json");
const capturedAt=histories.capturedAt||profiles.capturedAt||markets.capturedAt;
const capturedMs=Date.parse(capturedAt);

const perfById=new Map();
for(const b of boards.leaderboards||[]){
  for(const row of b.list||[]){
    const key=String(row.leadPortfolioId);
    if(!perfById.has(key)) perfById.set(key,{});
    const x=perfById.get(key);
    if(!x[b.request.timeRange]) x[b.request.timeRange]=row;
  }
}
const profileById=new Map((profiles.profiles||[]).map(x=>[String(x.id),x]));
const kind=o=>{
  const side=String(o.side).toUpperCase(), ps=String(o.positionSide||"BOTH").toUpperCase();
  if(ps==="LONG") return side==="BUY"?"open":"close";
  if(ps==="SHORT") return side==="SELL"?"open":"close";
  return n(o.totalPnl)===0?"open":"close";
};

function cyclesFrom(orders){
  const sorted=[...orders].sort((a,b)=>n(a.orderTime||a.orderUpdateTime)-n(b.orderTime||b.orderUpdateTime));
  const states=new Map(), cycles=[];
  let unmatched=0;
  for(const o of sorted){
    const symbol=String(o.symbol||"UNKNOWN"), side=String(o.positionSide||"BOTH").toUpperCase();
    const key=symbol+"|"+side, qty=Math.abs(n(o.executedQty)), price=Math.abs(n(o.avgPrice));
    const ts=n(o.orderTime||o.orderUpdateTime);
    if(!(qty>0&&ts>0)) continue;
    let s=states.get(key);
    if(kind(o)==="open"){
      if(!s) s={symbol,side,openedAt:ts,lastAt:ts,qty:0,openQty:0,openNotional:0,closeNotional:0,turnover:0,pnl:0,openOrders:0,closeOrders:0};
      s.qty+=qty; s.openQty+=qty; s.openNotional+=qty*price; s.turnover+=qty*price; s.openOrders++; s.lastAt=ts;
      states.set(key,s);
    } else {
      if(!s||s.qty<=1e-12){unmatched++;continue}
      const used=Math.min(qty,s.qty);
      s.qty-=used; s.closeNotional+=used*price; s.turnover+=used*price; s.pnl+=n(o.totalPnl); s.closeOrders++; s.lastAt=ts;
      if(qty>used+1e-12) unmatched++;
      if(s.qty<=Math.max(1e-10,s.openQty*1e-9)){
        cycles.push({
          symbol:s.symbol,side:s.side,openedAt:s.openedAt,closedAt:ts,
          holdSeconds:Math.max(0,(ts-s.openedAt)/1000),openOrders:s.openOrders,closeOrders:s.closeOrders,
          openQty:r(s.openQty,8),openNotional:r(s.openNotional,4),closeNotional:r(s.closeNotional,4),
          turnover:r(s.turnover,4),realizedPnl:r(s.pnl,8),realizedReturn:s.openNotional?r(s.pnl/s.openNotional,8):null
        });
        states.delete(key);
      }
    }
  }
  const incomplete=[...states.values()].map(s=>({symbol:s.symbol,side:s.side,openedAt:s.openedAt,lastAt:s.lastAt,openQty:r(s.openQty,8),remainingQty:r(s.qty,8),turnover:r(s.turnover,4),realizedPnl:r(s.pnl,8)}));
  return {sorted,cycles,incomplete,unmatched};
}

function analyzeHistory(h){
  const b=cyclesFrom(h.orders||[]), c=b.cycles, ds=c.map(x=>x.holdSeconds);
  const first=b.sorted.length?n(b.sorted[0].orderTime||b.sorted[0].orderUpdateTime):0;
  const last=b.sorted.length?n(b.sorted.at(-1).orderTime||b.sorted.at(-1).orderUpdateTime):0;
  const days=first&&last?Math.max((last-first)/86400000,1/24):0;
  let reopens=0,reversals=0;
  const lastCycle=new Map();
  for(const x of [...c].sort((a,b)=>a.openedAt-b.openedAt)){
    const same=lastCycle.get(x.symbol+"|"+x.side);
    const opposite=lastCycle.get(x.symbol+"|"+(x.side==="LONG"?"SHORT":"LONG"));
    if(same&&x.openedAt>=same.closedAt&&x.openedAt-same.closedAt<=60000) reopens++;
    if(opposite&&x.openedAt>=opposite.closedAt&&x.openedAt-opposite.closedAt<=60000) reversals++;
    lastCycle.set(x.symbol+"|"+x.side,x);
  }
  let repeats=0,comparables=0;
  const prevOrder=new Map();
  for(const o of b.sorted){
    const key=[o.symbol,o.positionSide,o.side].join("|"), qty=Math.abs(n(o.executedQty)), ts=n(o.orderTime||o.orderUpdateTime);
    const p=prevOrder.get(key);
    if(p&&ts-p.ts<=300000&&p.qty>0){comparables++;if(Math.abs(qty-p.qty)/p.qty<=.001)repeats++}
    prevOrder.set(key,{qty,ts});
  }
  const wins=c.filter(x=>x.realizedPnl>0).sort((a,b)=>b.realizedPnl-a.realizedPnl);
  const losses=Math.abs(c.filter(x=>x.realizedPnl<0).reduce((a,x)=>a+x.realizedPnl,0));
  const gp=wins.reduce((a,x)=>a+x.realizedPnl,0);
  const pnl=c.reduce((a,x)=>a+x.realizedPnl,0);
  const turnover=c.reduce((a,x)=>a+x.turnover,0)+b.incomplete.reduce((a,x)=>a+x.turnover,0);
  const margin=n(profileById.get(String(h.id))?.data?.marginBalance);
  const u60=rat(ds.filter(x=>x<=60).length,c.length),u5=rat(ds.filter(x=>x<=300).length,c.length);
  const rr=rat(reopens,Math.max(0,c.length-1)),rv=rat(reversals,Math.max(0,c.length-1)),rq=rat(repeats,comparables);
  const zero=rat(c.filter(x=>x.realizedReturn!=null&&Math.abs(x.realizedReturn)<=.0002).length,c.length);
  const daily=margin>0&&days>0?turnover/margin/days:null;
  const comp={
    ultraShort:clamp((u60||0)/.35),shortHolding:clamp((u5||0)/.60),
    rapidReopen:clamp((rr||0)/.35),oppositeReversal:clamp((rv||0)/.25),
    turnoverIntensity:clamp((daily||0)/20),repeatedQuantity:clamp((rq||0)/.60),
    nearZeroRoundTrips:clamp((zero||0)/.50)
  };
  const risk=100*(comp.ultraShort*.20+comp.shortHolding*.15+comp.rapidReopen*.15+comp.oppositeReversal*.15+comp.turnoverIntensity*.15+comp.repeatedQuantity*.10+comp.nearZeroRoundTrips*.10);
  const conf=clamp(Math.min(1,c.length/50)*.65+Math.min(1,days/30)*.35);
  return {cycles:c,incomplete:b.incomplete,metrics:{
    orderCount:b.sorted.length,completeCycleCount:c.length,incompleteCycleCount:b.incomplete.length,unmatchedCloseOrders:b.unmatched,
    coverageDays:r(days,3),symbolCount:new Set((h.orders||[]).map(o=>o.symbol)).size,
    medianHoldSeconds:r(pct(ds,.5),1),p25HoldSeconds:r(pct(ds,.25),1),p75HoldSeconds:r(pct(ds,.75),1),
    under60sRatio:r(u60),under5mRatio:r(u5),under30mRatio:r(rat(ds.filter(x=>x<=1800).length,c.length)),
    rapidReopenRatio:r(rr),oppositeReversalRatio:r(rv),repeatedQuantityRatio:r(rq),nearZeroRoundTripRatio:r(zero),
    totalTurnover:r(turnover,2),dailyTurnoverToEquity:r(daily,3),realizedPnl:r(pnl,4),
    cycleWinRate:r(rat(c.filter(x=>x.realizedPnl>0).length,c.length)),
    profitFactor:losses?r(gp/losses,3):(gp>0?999:null),
    top1ProfitConcentration:r(gp?(wins[0]?.realizedPnl||0)/gp:null),
    top5ProfitConcentration:r(gp?wins.slice(0,5).reduce((a,x)=>a+x.realizedPnl,0)/gp:null),
    washRiskScore:r(risk,1),washRiskLevel:risk>=50?"high":risk>=25?"medium":"low",
    washRiskComponents:Object.fromEntries(Object.entries(comp).map(([k,v])=>[k,r(v*100,1)])),confidence:r(conf,3)
  }};
}

function score(id,profile,m){
  const hs=perfById.get(String(id))||{}, p=hs["30D"]||hs["90D"]||hs["180D"]||hs["7D"]||{};
  const roi=n(p.roi),mdd=Math.abs(n(p.mdd,100)),sharp=p.sharpRatio==null?n(profile.sharpRatio,-1):n(p.sharpRatio,-1);
  const copier=n(p.copierPnl,n(profile.copierPnl)), win=n(p.winRate);
  const tenure=profile.startTime?Math.max(0,(capturedMs-n(profile.startTime))/86400000):0;
  const parts={
    roi:clamp(Math.log1p(Math.max(0,roi))/Math.log(301)),drawdown:1-clamp(mdd/50),
    sharpe:clamp((sharp+.5)/3.5),copierAlignment:copier>0?clamp(Math.log1p(copier)/Math.log(10001)):0,
    winRate:clamp(win/100),tenure:clamp(tenure/180),authenticity:1-n(m.washRiskScore)/100
  };
  const raw=100*(parts.roi*.20+parts.drawdown*.20+parts.sharpe*.15+parts.copierAlignment*.15+parts.winRate*.10+parts.tenure*.10+parts.authenticity*.10);
  const eligible=profile.positionShow===true&&m.completeCycleCount>=30&&m.coverageDays>=7&&m.confidence>=.25&&copier>0&&mdd<=50&&m.washRiskScore<50&&(m.medianHoldSeconds==null||m.medianHoldSeconds>=60);
  return {
    performance:{horizon:hs["30D"]?"30D":"fallback",roi:r(roi),pnl:r(n(p.pnl)),aum:r(n(p.aum,n(profile.aumAmount)),2),mdd:r(mdd),winRate:r(win),copierPnl:r(copier),sharpRatio:p.sharpRatio??profile.sharpRatio??null,currentCopyCount:n(p.currentCopyCount,n(profile.currentCopyCount))},
    tenureDays:r(tenure,1),compositeScore:r(m.washRiskScore>=50?Math.min(raw,49):raw,1),eligible,
    scoreComponents:Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,r(v*100,1)]))
  };
}

const traders=[],allCycles=[];
for(const h of histories.histories||[]){
  const pw=profileById.get(String(h.id)), profile=pw?.data||{}, a=analyzeHistory(h), s=score(h.id,profile,a.metrics);
  const row={id:String(h.id),nickname:h.nickname||profile.nickname,positionShow:h.positionShow,ranking:pw?.ranking||null,...s,metrics:a.metrics};
  traders.push(row);
  for(const x of a.cycles) allCycles.push({traderId:String(h.id),nickname:row.nickname,...x});
}
traders.sort((a,b)=>b.compositeScore-a.compositeScore||b.metrics.confidence-a.metrics.confidence);
traders.forEach((x,i)=>x.rank=i+1);
const hidden=(profiles.profiles||[]).filter(x=>x.data?.positionShow!==true).map(x=>({id:String(x.id),nickname:x.data?.nickname,reason:"订单/持仓未公开，无法核验持仓周期与回转风险"}));
const traderOut={
  generatedAt:new Date().toISOString(),snapshotId:id,capturedAt,
  methodology:{
    cycleDefinition:"同一品种与持仓方向从首次开仓到数量归零；支持加仓和部分平仓。",
    boundaryRule:"未配对平仓与当前未归零持仓单独报告，不强行补齐。",
    riskDisclaimer:"washRiskScore 是数据膨胀/对刷风险筛查信号，不是对刷行为的定性证据。",
    eligibility:"公开订单、完整周期>=30、覆盖>=7天、置信度>=0.25、跟单者PnL>0、MDD<=50%、风险分<50，且中位持仓不少于60秒。",
    feeNote:"公开订单历史未提供手续费字段，因此不估算手续费或手续费占比。"
  },
  coverage:{rankedUniqueProfiles:profileById.size,publicOrderHistories:traders.length,hiddenProfiles:hidden.length,totalOrders:(histories.histories||[]).reduce((a,h)=>a+(h.orders||[]).length,0),reconstructedCompleteCycles:allCycles.length},
  traders,hiddenProfiles:hidden
};

const future=new Map((markets.futures||[]).filter(x=>x.ok).map(x=>[x.value.token,x.value]));
const spot=new Map((markets.spot||[]).filter(x=>x.ok).map(x=>[x.value.token,x.value]));
const period=(xs,p)=>(xs||[]).find(x=>x.timePeriod===p)||null;
const newest=xs=>Array.isArray(xs)&&xs.length?[...xs].sort((a,b)=>n(b.timestamp)-n(a.timestamp))[0]:null;
const coinUniverse=(markets.mapping||[]).map(m=>{const found=(hot.coins||[]).find(c=>c.token===m.token),d=hot.coinDetails?.[m.token]||{};return found||{token:m.token,searchCount:n(d.searchCount),priceChange:0,tradersRatio:d.sentiment||{},holdersRatio:d.sentiment||{}}});
const coins=coinUniverse.map((coin,index)=>{
  const token=coin.token,d=hot.coinDetails?.[token]||{},f=future.get(token),sp=spot.get(token),originalHotIndex=(hot.coins||[]).findIndex(c=>c.token===token);
  const fd=f?.supported?f.data:null,sd=sp?.supported?sp.data:null;
  const tt=period(d.topTraders,"15min")||period(d.topTraders,"1h"),hh=period(d.topHolders,"15min")||period(d.topHolders,"1h");
  const tk=newest(fd?.taker15m),ga=newest(fd?.globalLongShort15m),ta=newest(fd?.topAccounts15m),tp=newest(fd?.topPositions15m);
  const change=n(fd?.ticker24h?.priceChangePercent,n(sd?.ticker24h?.priceChangePercent,n(coin.priceChange)*100));
  const volume=n(fd?.ticker24h?.quoteVolume,n(sd?.ticker24h?.quoteVolume)),funding=fd?n(fd.markPrice?.lastFundingRate):null;
  const ttp=tt?n(tt.buyPercent,50):n(coin.tradersRatio?.buyPercent,50),hhp=hh?n(hh.buyPercent,50):n(coin.holdersRatio?.buyPercent,50);
  const taker=tk?n(tk.buySellRatio,1):null,gls=ga?n(ga.longShortRatio,1):null;
  const rankHeat=originalHotIndex>=0?1-originalHotIndex/Math.max(1,(hot.coins||[]).length):0,searchHeat=clamp(Math.log1p(n(coin.searchCount))/Math.log(5000));
  const heat=100*(rankHeat*.35+searchHeat*.25+clamp(Math.log1p(volume)/Math.log(5e9))*.25+clamp(Math.abs(change)/20)*.15);
  const takerSent=taker==null?.5:clamp((Math.log(Math.max(.01,taker))+1.5)/3);
  const sentiment=100*(ttp/100*.30+hhp/100*.20+takerSent*.25+clamp((change+15)/30)*.25);
  const flags=[];
  if(change>=3&&ttp<45)flags.push("价格上涨但头部交易者偏卖");
  if(change<=-3&&ttp>55)flags.push("价格下跌但头部交易者吸筹");
  if(gls!=null&&taker!=null&&gls>1.2&&taker<.85)flags.push("账户偏多但主动卖盘占优");
  if(gls!=null&&taker!=null&&gls<.8&&taker>1.15)flags.push("账户偏空但主动买盘占优");
  if(funding!=null&&funding<0&&change>3&&(taker||0)>1)flags.push("负资金费率下价格与主动买盘走强，存在逼空特征");
  if(funding!=null&&funding>.0005)flags.push("资金费率偏高，追多成本上升");
  return {
    token,hotRank:originalHotIndex>=0?originalHotIndex+1:null,searchCount:n(coin.searchCount),priceChangePct:r(change,3),quoteVolume:r(volume,2),
    futuresSupported:Boolean(fd),heatScore:r(heat,1),sentimentScore:r(sentiment,1),
    sentimentLabel:sentiment>=65?"偏多":sentiment<=35?"偏空":"中性",
    topTraderBuyPct:r(ttp,1),holderBuyPct:r(hhp,1),takerBuySellRatio:r(taker,3),globalLongShortRatio:r(gls,3),
    topAccountLongShortRatio:r(ta?n(ta.longShortRatio,1):null,3),topPositionLongShortRatio:r(tp?n(tp.longShortRatio,1):null,3),
    fundingRate:r(funding,8),openInterest:r(n(fd?.openInterest?.openInterest),4),flags
  };
}).sort((a,b)=>b.heatScore-a.heatScore);
coins.forEach((x,i)=>x.heatRank=i+1);
const coinOut={generatedAt:new Date().toISOString(),snapshotId:id,capturedAt,market:overview.metrics,methodology:{heatScore:"热门榜位35% + 搜索热度25% + 成交额25% + 24h波动15%",sentimentScore:"头部交易者15m买入占比30% + 大户15m买入占比20% + 合约主动买卖25% + 24h动量25%",note:"情绪分反映本次截面，不构成未来收益预测。"},coins};

json("trader-analysis.json",traderOut);
json("position-cycles.json",{snapshotId:id,count:allCycles.length,cycles:allCycles});
json("coin-analysis.json",coinOut);
csv("trader-ranking.csv",traders.map(t=>({
  rank:t.rank,id:t.id,nickname:t.nickname,eligible:t.eligible,compositeScore:t.compositeScore,roi:t.performance.roi,mdd:t.performance.mdd,sharpRatio:t.performance.sharpRatio,
  copierPnl:t.performance.copierPnl,currentCopyCount:t.performance.currentCopyCount,tenureDays:t.tenureDays,orders:t.metrics.orderCount,completeCycles:t.metrics.completeCycleCount,
  incompleteCycles:t.metrics.incompleteCycleCount,coverageDays:t.metrics.coverageDays,medianHoldSeconds:t.metrics.medianHoldSeconds,under60sRatio:t.metrics.under60sRatio,
  under5mRatio:t.metrics.under5mRatio,rapidReopenRatio:t.metrics.rapidReopenRatio,reversalRatio:t.metrics.oppositeReversalRatio,repeatedQuantityRatio:t.metrics.repeatedQuantityRatio,
  dailyTurnoverToEquity:t.metrics.dailyTurnoverToEquity,cycleWinRate:t.metrics.cycleWinRate,profitFactor:t.metrics.profitFactor,
  top1ProfitConcentration:t.metrics.top1ProfitConcentration,washRiskScore:t.metrics.washRiskScore,riskLevel:t.metrics.washRiskLevel,confidence:t.metrics.confidence
})));
csv("coin-ranking.csv",coins.map(c=>({
  heatRank:c.heatRank,token:c.token,originalHotRank:c.hotRank,heatScore:c.heatScore,sentimentScore:c.sentimentScore,sentimentLabel:c.sentimentLabel,
  priceChangePct:c.priceChangePct,quoteVolume:c.quoteVolume,searchCount:c.searchCount,topTraderBuyPct:c.topTraderBuyPct,holderBuyPct:c.holderBuyPct,
  takerBuySellRatio:c.takerBuySellRatio,globalLongShortRatio:c.globalLongShortRatio,fundingRate:c.fundingRate,flags:c.flags.join("；")
})));

const eligible=traders.filter(t=>t.eligible), high=traders.filter(t=>t.metrics.washRiskLevel==="high").sort((a,b)=>b.metrics.washRiskScore-a.metrics.washRiskScore);
const dur=s=>s==null?"无":s<60?Math.round(s)+"秒":s<3600?r(s/60,1)+"分钟":r(s/3600,1)+"小时";
let report="# 币安广场热门币与合约带单员：一次性快照分析\n\n";
report+="- 快照时间："+capturedAt+"\n- 唯一榜单交易员："+profileById.size+"\n- 公开订单交易员："+traders.length+"\n- 订单："+traderOut.coverage.totalOrders.toLocaleString()+" 笔\n- 重建完整持仓周期："+allCycles.length.toLocaleString()+" 个\n- 热门币："+coins.length+" 个\n\n";
report+="## 初筛结果\n\n满足公开订单、周期/覆盖、正跟单者收益、最大回撤和风险阈值的交易员共 **"+eligible.length+"** 位。\n\n";
report+=eligible.slice(0,10).map((t,i)=>(i+1)+". "+t.nickname+"（综合 "+t.compositeScore+"，风险 "+t.metrics.washRiskScore+"，中位持仓 "+dur(t.metrics.medianHoldSeconds)+"，完整周期 "+t.metrics.completeCycleCount+"，跟单者PnL "+t.performance.copierPnl+"）").join("\n");
report+="\n\n## 高风险筛查（仅为信号，不是定性）\n\n";
report+=(high.length?high.slice(0,10).map(t=>"- "+t.nickname+"：风险 "+t.metrics.washRiskScore+"，1分钟内周期 "+r((t.metrics.under60sRatio||0)*100,1)+"%，快速重开 "+r((t.metrics.rapidReopenRatio||0)*100,1)+"%，日换手/权益 "+(t.metrics.dailyTurnoverToEquity??"无")+"。").join("\n"):"未发现达到高风险阈值的公开订单账户。");
report+="\n\n## 热门币截面\n\n";
report+=coins.slice(0,10).map((c,i)=>(i+1)+". "+c.token+"：热度 "+c.heatScore+"，情绪 "+c.sentimentScore+"（"+c.sentimentLabel+"），24h "+c.priceChangePct+"%，主动买卖比 "+(c.takerBuySellRatio??"无")+(c.flags.length?"；提示："+c.flags.join("；"):"")).join("\n");
report+="\n\n## 解释边界\n\n- 当前是一次性截面，适合完成横向筛选和识别明显异常，但不能代替跨日稳定性验证。\n- 订单历史没有手续费字段，因此未虚构手续费数据。\n- 未公开订单/持仓的交易员不能做持仓时间和对刷风险核验，已与公开样本分开。\n- 综合分用于研究排序，不是投资建议或自动跟单指令。\n";
fs.writeFileSync(path.join(out,"report.md"),report);

const names=["trader-analysis.json","position-cycles.json","coin-analysis.json","trader-ranking.csv","coin-ranking.csv","report.md"];
const manifest={generatedAt:new Date().toISOString(),snapshotId:id,capturedAt,files:Object.fromEntries(names.map(name=>[name,{bytes:fs.statSync(path.join(out,name)).size,sha256:sha(path.join(out,name))}])),summary:{eligibleTraders:eligible.length,highRiskTraders:high.length,reconstructedCycles:allCycles.length,analyzedCoins:coins.length}};
json("manifest.json",manifest);
fs.mkdirSync(path.join(root,"analysis"),{recursive:true});
fs.writeFileSync(path.join(root,"analysis","latest.json"),JSON.stringify({snapshotId:id,path:out,generatedAt:manifest.generatedAt},null,2));
console.log(JSON.stringify({outputDir:out,...manifest.summary,topEligible:eligible.slice(0,8).map(t=>({nickname:t.nickname,score:t.compositeScore,risk:t.metrics.washRiskScore,medianHoldSeconds:t.metrics.medianHoldSeconds,cycles:t.metrics.completeCycleCount,copierPnl:t.performance.copierPnl})),topRisk:high.slice(0,5).map(t=>({nickname:t.nickname,risk:t.metrics.washRiskScore})),topCoins:coins.slice(0,8).map(c=>({token:c.token,heat:c.heatScore,sentiment:c.sentimentScore,flags:c.flags}))},null,2));
