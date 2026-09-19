import type {SquarePost,SquareSnapshot,Direction} from "./model";
// 币安广场原始帖子：只声明用到的字段，值一律按 unknown 处理并在使用前转换，接口字段缺失或类型变化时不会被误读。
interface RawPair {code?:unknown;chainId?:unknown;stockCode?:unknown;supportStock?:unknown;supportEtf?:unknown}
interface RawShareCard {baseAsset?:unknown;positionCreateTime?:unknown;positionSide?:unknown;showAmount?:unknown;positionSize?:unknown;
 initialMargin?:unknown;isShowPNL?:unknown;pnl?:unknown;returnRate?:unknown}
interface Raw {id?:unknown;squareAuthorId?:unknown;authorName?:unknown;date?:unknown;title?:unknown;content?:unknown;
 likeCount?:unknown;commentCount?:unknown;tradingPairsV2?:unknown;tradingPairs?:unknown;userInputTradingPairs?:unknown;
 shareTrading?:{futuresTrading?:RawShareCard|null}|null}
const pairs=(x:unknown):RawPair[]=>Array.isArray(x)?x:[];
const value=(x:unknown):number|null=>x===null||x===undefined||x===""||!Number.isFinite(Number(x))?null:Number(x);
// 关键词方向分类仅供内部证据匹配（assessPost 需要 post.direction 判断持仓方向是否与观点一致）与跨模块交叉验证使用；
// 默认广场页面不再对外展示该多空分类结果（见 docs/module-redesign-v2.md 第二节：去方向化）。
export function classify(text:string):{direction:Direction;note:string}{
 // Explicit intent only. Questions, mixed/conditional/negated statements are not reliable directional calls.
 if(/[?？]|\b(if|unless|not|don't|never)\b|如果|假如|不看|不要|别做/i.test(text))return {direction:0,note:"疑问、条件或否定句；规则未能明确方向"};
 const bull=/看多|做多|买入|加仓|持有|看涨|\b(bullish|buy|buying|bought|long|holding|accumulate)\b/i.test(text);
 const bear=/看空|做空|卖出|看跌|\b(bearish|sell|selling|short|shorting)\b/i.test(text);
 return {direction:bull===bear?0:bull?1:-1,note:bull===bear?"方向未明确或多空混合":"中英关键词规则识别；不是人工确认或预测"};
}
const plain=(s:unknown)=>String(s??"").replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\{(?:future|spot)\}\([^)]*\)/g," ").trim();
export function normalizeSquare(raw:Raw[],capturedAt:string,knownTokens:Set<string>):SquareSnapshot{
 const now=Date.parse(capturedAt),seen=new Set<string>(),posts:SquarePost[]=[];
 for(const r of raw){
  const id=String(r.id??""),authorId=String(r.squareAuthorId??""),at=Number(r.date)*1000;
  if(!/^\d+$/.test(id)||!authorId||seen.has(id)||!Number.isFinite(at)||at>now||at<now-24*3600000)continue;
  seen.add(id);
  const text=plain([r.title,r.content].filter(Boolean).join("\n"));if(!text)continue;
  // Only exchange-labelled tokens present in the official contract universe; no name guessing.
  const codes=[...pairs(r.tradingPairsV2),...pairs(r.tradingPairs),...pairs(r.userInputTradingPairs)].filter(p=>p&&(!p.chainId)&&(!p.stockCode)&&!p.supportStock&&!p.supportEtf).map(p=>String(p.code??""));
  const symbols=[...new Set<string>(codes.filter(c=>knownTokens.has(c)))];
  for(const symbol of symbols){
   const local=symbols.length===1?text:text.split(/[\n。.!！]/).filter(s=>new RegExp("(^|[^A-Za-z0-9])\\$?"+symbol+"([^A-Za-z0-9]|$)","i").test(s)).join(" ");
   const {direction,note}=classify(local);
   const post:SquarePost={id:id+":"+symbol,authorId,authorName:String(r.authorName??authorId),symbol,postedAt:new Date(at).toISOString(),text,
    direction,isCall:direction!==0,likes:Math.max(0,value(r.likeCount)??0),comments:Math.max(0,value(r.commentCount)??0),evidence:null,
    sourceUrl:"https://www.binance.com/en/square/post/"+id,classificationNote:note};
   const card=r.shareTrading?.futuresTrading;
   if(card&&card.baseAsset===symbol){
    const opened=value(card.positionCreateTime);
    post.sharedPosition={side:String(card.positionSide??"未知"),notionalUsd:card.showAmount===true?value(card.positionSize):null,
     marginUsd:card.showAmount===true?value(card.initialMargin):null,pnlUsd:card.isShowPNL===true?value(card.pnl):null,
     roiPct:card.isShowPNL===true&&value(card.returnRate)!==null?Number(card.returnRate)*100:null,
     openedAt:opened&&opened>0&&opened<=at?new Date(opened).toISOString():null,
     note:"币安原帖交易分享卡；未核验卡片刷新时间、是否已平仓及发帖前仓位证据，不作当前实仓，不加权。未公开金额保持缺失。"};
   }
   posts.push(post);
  }
 }
 return {id:"square-"+capturedAt,mode:"live",capturedAt,windowHours:24,posts,
  sourceNote:"真实公开热门/最新帖的有界采样（非全站全量）；仅保留24h内、能映射合约币种的观点。情绪为保守中英关键词规则，未明确不等于中立看法。交易分享卡未经当前持仓核验，不获得仓位加分。"};
}
