import type {IndicatorCoin} from "./model";
export const DIRECTION_RULE="indicator-direction-v1";
export const LIMITS={price:1,io:8,oi:3,volume:1.5,rsiHigh:75,rsiLow:25,funding:.1,capWarn:20,capStop:50,atrStop:5,freshHours:6} as const;
export type DirectionAnalysis={direction:-1|0|1;bias:-1|0|1;label:string;state:"long"|"short"|"wait"|"missing"|"stale";usable:boolean;summary:string;factors:{label:string;value:string;reading:string}[];risks:string[];conditions:string;ruleVersion:string};
const valid=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const percent=(v:unknown)=>valid(v)?(v>0?"+":"")+v.toFixed(2)+"%":"缺失";
const number=(v:unknown)=>valid(v)?v.toFixed(2):"缺失";
export function analyzeDirection(c:IndicatorCoin,cutoff:number,now=Date.now()):DirectionAnalysis{
 const p=c.priceChange.h4,io=c.ioNetRatio4h,oi=c.oi.h4,volume=c.volumeRatio,rsi=c.rsi;
 const priceSide=valid(p)?p>=LIMITS.price?1:p<=-LIMITS.price?-1:0:0;
 const ioSide=valid(io)?io>=LIMITS.io?1:io<=-LIMITS.io?-1:0:0;
 const trend=c.trend==="多头排列"?1:c.trend==="空头排列"?-1:0;
 const bias: -1|0|1=priceSide!==0&&priceSide===ioSide&&priceSide===trend?priceSide:0;
 const expanded=valid(oi)&&oi>=LIMITS.oi,volumeConfirmed=valid(volume)&&volume>=LIMITS.volume;
 const reducing=valid(oi)&&oi<=-LIMITS.oi;
 const perp=c.contracts.some(x=>x.symbol===c.representative&&x.type==="PERPETUAL");
 const missing=!c.quality||![p,io,oi,volume,rsi,c.atrPct,c.spreadBps].every(valid)||c.trend==="不足"||(perp&&!valid(c.fundingDaily));
 const stale=!valid(cutoff)||cutoff>now+60000||now-cutoff>LIMITS.freshHours*3600000;
 const risks=[...c.warnings],stops:string[]=[];
 if(reducing)stops.push("4h 持仓减少≥3%，缺少新增持仓配合，暂不追随这段涨跌");
 if(bias===1&&valid(rsi)&&rsi>=LIMITS.rsiHigh)stops.push("RSI≥75，多头追涨风险偏高");
 if(bias===-1&&valid(rsi)&&rsi<=LIMITS.rsiLow)stops.push("RSI≤25，空头追跌风险偏高");
 if(valid(c.atrPct)&&c.atrPct>=LIMITS.atrStop)stops.push("1h ATR/价格≥5%，短时波动过大");
 if(bias!==0&&valid(c.fundingDaily)&&bias*c.fundingDaily>=LIMITS.funding)stops.push("同向24h等效资金费率≥0.1%，持仓成本与拥挤风险较高");
 if(valid(c.oiCapPct)&&c.oiCapPct>=LIMITS.capStop)stops.push("持仓／流通市值≥50%，杠杆拥挤风险过高");
 if(!valid(c.oiCapPct))risks.push("市值比例缺失，无法排除杠杆拥挤；不按0处理");
 else if(c.oiCapPct>=LIMITS.capWarn)risks.push("持仓／流通市值≥20%，需留意拥挤；不是低估证据");
 if(bias!==0&&!expanded&&!volumeConfirmed)stops.push("OI未增加3%且量比不足1.5×，确认条件不够");
 if(priceSide!==0&&ioSide!==0&&priceSide!==ioSide)risks.push("价格与主动资金方向相反，暂不确认趋势");
 if(priceSide!==0&&priceSide===ioSide&&trend!==priceSide)risks.push("价格/资金与EMA趋势不一致");
 const oiReading=!valid(oi)?"持仓证据不足":reducing?"价格变化伴随减仓；无法断定是哪一方平仓":expanded?"持仓增加；仅作参与度确认，不能单独判断多空":"持仓变化较小，未达到增仓确认门槛";
 const factors=[
  {label:"价格 × 主动成交 / 4h",value:percent(p)+" / 净流比 "+percent(io),reading:priceSide&&priceSide===ioSide?"价格与主动成交同向":priceSide&&ioSide?"价格与主动成交冲突":"价格±1%与净流比±8%的同向条件未满足"},
  {label:"趋势 / 1h EMA20、EMA60",value:c.trend,reading:"价格>EMA20>EMA60确认多头；反向排列确认空头，震荡不强行选边"},
  {label:"持仓与放量 / 4h",value:"OI "+percent(oi)+" · 量比 "+number(volume)+"×",reading:oiReading+"；量比"+(volumeConfirmed?"达到1.5×确认":"未达到1.5×确认")},
  {label:"RSI14 与 ATR14 / 1h",value:number(rsi)+" / "+percent(c.atrPct),reading:"RSI≥75不追多、≤25不追空；ATR/价格≥5%暂停方向结论"},
  {label:"资金费率 / 24h等效",value:perp?percent(c.fundingDaily):"交割合约不适用",reading:"仅作成本和拥挤约束；正负费率本身不是买卖信号，等效值不是未来费用预测"},
  {label:"持仓／流通市值 · 价差",value:percent(c.oiCapPct)+" · "+number(c.spreadBps)+" bps",reading:"比例≥20%提示拥挤，≥50%暂停；价差需≤25 bps，市值缺失保留风险提示"},
 ];
 let state:DirectionAnalysis["state"]="wait",summary="";
 if(stale){state="stale";summary="快照超过6小时或时间异常；先更新，不能据此判断当前多空。";}
 else if(missing){state="missing";summary="方向或风险参数缺失，暂不判断多空。";}
 else if(!c.liquid){summary="成交、持仓规模或价差未达流动性门槛，暂不判断多空。";}
 else if(bias===0){
  const reason=valid(p)&&valid(io)&&p*io<0?(p>0?"价格上涨但主动成交净卖出，方向背离":"价格下跌但主动成交净买入，方向背离"):
   priceSide&&priceSide===ioSide?"价格与资金同向，但"+c.trend+"未确认该方向":
   !priceSide?"4h价格变化未达±1%的确认门槛":"主动净流比未达同向±8%的确认门槛";
  summary="4h价格 "+percent(p)+"、主动净流比 "+percent(io)+"；"+reason+"，观望。";
 }
 else if(stops.length){summary="4h价格 "+percent(p)+"、主动净流比 "+percent(io)+"，原始结构偏"+(bias>0?"多":"空")+"；但"+stops[0]+"。";}
 else {state=bias>0?"long":"short";summary="4h价格 "+percent(p)+"、主动净流比 "+percent(io)+"，"+c.trend+"；"+(expanded?"OI增加 "+percent(oi):"成交放量 "+number(volume)+"×")+"配合，暂偏"+(bias>0?"多":"空")+"。";}
 const direction=state==="long"?1:state==="short"?-1:0;
 return {direction,bias,state,label:state==="long"?"偏多 · 多头观察":state==="short"?"偏空 · 空头观察":state==="missing"?"观望 · 数据不足":state==="stale"?"观望 · 快照过期":"观望 · 等待确认",
  usable:!stale&&!missing&&c.liquid,summary,factors,risks:[...new Set([...stops,...risks])],
  conditions:direction?"若价格/主动资金不再同向、EMA排列失效，或风险门槛触发，撤销该偏向；这是快照研判，不是实时下单信号。":"等待新快照满足：价格与资金同向、EMA同向、增仓或放量确认，并且风险门槛通过；不因观望而反向开仓。",
  ruleVersion:DIRECTION_RULE};
}
