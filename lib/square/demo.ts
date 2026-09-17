import type { PositionEvidence, SquarePost, SquareSnapshot } from "./model";
const at=(hour:number,minute=0)=>"2026-09-17T"+String(hour).padStart(2,"0")+":"+String(minute).padStart(2,"0")+":00+08:00";
const position=(id:string,symbol:string,patch:Partial<PositionEvidence>={}):PositionEvidence=>({
  id:"demo-position-"+id,authorId:id,symbol,source:"虚构测试证据 · 不对应任何真实账户",
  grade:"verified",identityVerified:true,market:"futures",side:1,openedAt:at(1),
  atPost:{observedAt:at(9),side:1,state:"open"},current:{observedAt:at(11,50),side:1,state:"open"},
  notionalUsd:50000,marginUsd:5000,equityUsd:40000,leverage:10,entryPrice:null,
  unrealizedPnlUsd:480,unrealizedRoiPct:9.6,realizedPnlUsd:1200,feesIncluded:true,
  history:{verified:true,closedCycles:36,days:45,netPnlUsd:1200,maxDrawdownPct:12},...patch
});
const post=(id:string,symbol:string,name:string,direction:-1|0|1,evidence:PositionEvidence|null,text:string):SquarePost=>({
  id:"demo-post-"+id,authorId:id,authorName:"演示作者 · "+name,symbol,postedAt:at(10),text,direction,isCall:direction!==0,likes:24,comments:8,evidence
});
const btc=[
  post("a","BTC","同向持仓",1,position("a","BTC"),"继续看多 BTC，维持原仓位。"),
  post("b","BTC","大仓空头",-1,position("b","BTC",{side:-1,atPost:{observedAt:at(9),side:-1,state:"open"},current:{observedAt:at(11,45),side:-1,state:"open"},marginUsd:80000,notionalUsd:400000,equityUsd:300000,leverage:5,unrealizedPnlUsd:-1600,unrealizedRoiPct:-2}),"BTC 上行承压，我保留空仓。"),
  post("c","BTC","截图喊多",1,position("c","BTC",{grade:"screenshot",identityVerified:false}),"截图显示盈利，继续看涨。"),
  post("d","BTC","言行矛盾",1,position("d","BTC",{current:{observedAt:at(11,50),side:-1,state:"open"}}),"我的观点仍然偏多。"),
  post("e","BTC","已平仓",1,position("e","BTC",{current:{observedAt:at(11,30),side:1,state:"closed"},unrealizedPnlUsd:0,unrealizedRoiPct:0,realizedPnlUsd:650}),"早些时候继续持多，后续已经离场。"),
  post("f","BTC","发帖后开仓",1,position("f","BTC",{openedAt:at(10,30),atPost:null}),"先发表看多观点，半小时后才买入。"),
  post("g","BTC","未公开仓位",0,null,"BTC 暂无明确方向，等待确认。"),
  {...post("h","BTC","证据过期",-1,position("h","BTC",{side:-1,atPost:{observedAt:at(1,30),side:-1,state:"open"},current:{observedAt:at(3),side:-1,state:"open"}}),"我偏空，但公开仓位记录已经过期。"),postedAt:at(2)}
];
export const DEMO_SNAPSHOT:SquareSnapshot={
  id:"square-demo-001",mode:"demo",capturedAt:at(12),windowHours:24,
  sourceNote:"全部作者、帖子、仓位和盈亏均为虚构验收样本；可核验等级也仅用于演示规则。",
  posts:[...btc,{...btc[0],id:"demo-duplicate",duplicateOf:btc[0].id,likes:2000},
    post("i","SOL","减仓持多",1,position("i","SOL",{current:{observedAt:at(11,55),side:1,state:"reduced"},marginUsd:1000,notionalUsd:5000,leverage:5}),"仍看多 SOL，但已降低仓位。"),
    post("j","SOL","谨慎看空",-1,null,"SOL 近期偏热，观点偏空；未公开仓位。"),
    post("k","SOL","仅自述",1,position("k","SOL",{grade:"self_report",identityVerified:false}),"自述持有多仓，暂未提供可核验证据。"),
    post("l","ETH","账户规模未知",1,position("l","ETH",{equityUsd:null,history:null}),"看多 ETH，仓位已公开，账户总资金未公开。"),
    post("m","ETH","中性观察",0,null,"ETH 等待突破，暂不表达方向。")]
};
export const EMPTY_SNAPSHOT:SquareSnapshot={
 id:"square-not-connected",mode:"live",capturedAt:at(12),windowHours:24,posts:[],
 sourceNote:"现有项目快照没有完成作者—帖子—仓位身份映射，真实帖子与仓位数据源尚未接入。"
};
