export type Direction = -1 | 0 | 1;
export type EvidenceGrade = "verified" | "screenshot" | "self_report";
export interface PositionEvidence {
  id: string; authorId: string; symbol: string; source: string;
  grade: EvidenceGrade; identityVerified: boolean;
  market: "spot" | "futures"; side: -1 | 1;
  openedAt: string | null;
  // Independent observations: opening time alone does not prove a position was public at posting.
  atPost: { observedAt: string; side: -1 | 1; state: "open" | "closed" } | null;
  current: { observedAt: string; side: -1 | 1; state: "open" | "reduced" | "closed" };
  notionalUsd: number | null; marginUsd: number | null; equityUsd: number | null;
  leverage: number | null; entryPrice: number | null;
  unrealizedPnlUsd: number | null; unrealizedRoiPct: number | null;
  realizedPnlUsd: number | null; feesIncluded: boolean | null;
  history: { verified: boolean; closedCycles: number; days: number; netPnlUsd: number; maxDrawdownPct: number } | null;
}
export interface SquarePost {
  sourceUrl?: string; classificationNote?: string;
  sharedPosition?: {side:string;notionalUsd:number|null;marginUsd:number|null;pnlUsd:number|null;roiPct:number|null;openedAt:string|null;note:string};
  id: string; authorId: string; authorName: string; symbol: string;
  postedAt: string; text: string; direction: Direction; isCall: boolean;
  likes: number; comments: number; duplicateOf?: string;
  evidence: PositionEvidence | null;
}
export interface SquareSnapshot {
  id: string; mode: "demo" | "live"; capturedAt: string; windowHours: number;
  posts: SquarePost[]; sourceNote: string;
}
export const RULE_VERSION = "square-evidence-v1";
export const RULES = { freshnessHours: 6, maxWeight: 1.75, minHistoryDays: 30, minHistoryCycles: 20 } as const;
export const EVIDENCE_LABELS = { verified: "可核验证据", screenshot: "截图待核验", self_report: "仅作者自述" };
export type EvidenceState = "aligned" | "conflict" | "closed" | "late" | "stale" | "unverified" | "unknown";
export const STATE_LABELS: Record<EvidenceState,string> = {
  aligned:"方向一致",conflict:"方向矛盾",closed:"已平仓",late:"发帖后开仓／补证",stale:"证据过期",unverified:"尚未核验",unknown:"证据不足"
};
export interface Assessment {
  post: SquarePost; state: EvidenceState; weight: number; reasons: string[];
  bonuses: {label:string;value:number}[]; authorSharePct: number | null;
  holdHours: number | null; eligible: boolean; evidenceId: string | null;
}
const stamp=(s:string|null)=>s?Date.parse(s):NaN;
const valid=(n:number|null):n is number=>n!==null&&Number.isFinite(n);
const positive=(n:number|null):n is number=>valid(n)&&n>0;
const round=(n:number)=>Math.round(n*100)/100;
export function assessPost(post:SquarePost,asOf:string):Assessment {
  const e=post.evidence,now=stamp(asOf),posted=stamp(post.postedAt);
  const r:Assessment={post,state:"unknown",weight:1,reasons:[],bonuses:[],authorSharePct:null,holdHours:null,eligible:false,evidenceId:e?.id??null};
  const reject=(state:EvidenceState,reason:string)=>{r.state=state;r.reasons.push(reason);return r;};
  if(!Number.isFinite(now)||!Number.isFinite(posted)||posted>now)return reject("unknown","时间字段无效或帖子晚于快照。");
  if(!e)return reject("unknown","没有公开仓位证据；仍计入原始情绪。");
  if(e.authorId!==post.authorId||e.symbol!==post.symbol)return reject("unknown","作者或币种映射不一致，不能关联此仓位。");
  if(positive(e.marginUsd)&&positive(e.equityUsd))r.authorSharePct=round(e.marginUsd/e.equityUsd*100);
  const opened=stamp(e.openedAt),observed=stamp(e.current.observedAt);
  if(Number.isFinite(opened)&&Number.isFinite(observed)&&opened<=observed)r.holdHours=round((observed-opened)/3600000);
  if(e.grade!=="verified"||!e.identityVerified||!e.source.trim())return reject("unverified","截图、自述或未完成身份关联的证据不加权。");
  if(!Number.isFinite(observed)||observed>now||observed<posted||(Number.isFinite(opened)&&observed<opened))return reject("unknown","当前仓位时间无效、早于观点或来自未来。");
  if(now-observed>RULES.freshnessHours*3600000)return reject("stale","当前仓位观察超过 6 小时；不把旧仓位当成仍在持有。");
  if(e.current.state==="closed")return reject("closed","已确认平仓；撤销当前仓位加分，保留原观点。");
  if(post.direction!==0&&e.current.side!==post.direction)return reject("conflict","当前仓位与观点相反；保留原始观点，但不增加权重。");
  if(!post.isCall||post.direction===0)return reject("unknown","没有明确方向性喊单，不增加仓位权重。");
  if(!Number.isFinite(opened))return reject("unknown","缺少开仓时间，无法判断发帖时是否持仓。");
  const before=stamp(e.atPost?.observedAt??null);
  if(opened>posted||!Number.isFinite(before)||before>posted)return reject("late","开仓或证据晚于发帖；不追溯认定发帖时已有仓位。");
  if(before<opened||posted-before>RULES.freshnessHours*3600000)return reject("unknown","发帖时仓位快照无效或过旧。");
  if(e.atPost?.state!=="open"||e.atPost.side!==post.direction)return reject("conflict","发帖时的仓位状态或方向不支持该观点。");
  r.state="aligned";r.eligible=true;
  r.bonuses.push({label:"身份已关联、前后两次仓位证据同向",value:.35});
  // Use supplied capital, never nominal exposure or leverage to infer conviction.
  if(positive(e.marginUsd))r.bonuses.push({label:"实际投入规模（对数压缩，封顶 0.10）",value:round(Math.min(.1,Math.log10(1+e.marginUsd)/50))});
  if(r.authorSharePct!==null&&r.authorSharePct<=100)r.bonuses.push({label:"账户投入占比（封顶 0.10）",value:round(Math.min(.1,r.authorSharePct/200))});
  else r.reasons.push("账户资金信息缺失或口径异常，占比不加分。");
  const holdBefore=(posted-opened)/3600000;
  r.bonuses.push({label:"发帖前已持仓时长（封顶 0.10）",value:round(Math.min(.1,holdBefore/240))});
  const h=e.history;
  if(h?.verified&&h.days>=RULES.minHistoryDays&&h.closedCycles>=RULES.minHistoryCycles&&h.netPnlUsd>0&&h.maxDrawdownPct>=0&&h.maxDrawdownPct<=20)
    r.bonuses.push({label:"已核验历史净盈利，样本与回撤达标",value:.1});
  else r.reasons.push("历史净收益、样本或回撤未达验证门槛，不增加盈利权重。");
  r.reasons.push("当前浮盈与杠杆仅展示，不直接加分；权重不是胜率。");
  if(e.current.state==="reduced")r.reasons.push("仓位已减持；仅展示本次剩余投入，不代表维持原规模。");
  r.weight=round(Math.min(RULES.maxWeight,1+r.bonuses.reduce((s,b)=>s+b.value,0)));
  return r;
}
export function analyzeSquare(snapshot:SquareSnapshot) {
  const now=stamp(snapshot.capturedAt),start=now-snapshot.windowHours*3600000;
  const seen=new Set<string>(),texts=new Set<string>();
  const clean=snapshot.posts.filter(p=>{
    const t=stamp(p.postedAt),text=p.text.trim().replace(/\s+/g," ").toLowerCase(),key=p.authorId+"|"+p.symbol+"|"+text;
    if(!Number.isFinite(t)||t>now||t<start||p.duplicateOf||seen.has(p.id)||texts.has(key)||!text)return false;
    seen.add(p.id);texts.add(key);return true;
  });
  const symbols=[...new Set(clean.map(p=>p.symbol))];
  return symbols.map(symbol=>{
    const posts=clean.filter(p=>p.symbol===symbol),authors=new Map<string,SquarePost>();
    // One latest opinion per author / coin; repeated posts cannot multiply their vote.
    posts.slice().sort((a,b)=>stamp(a.postedAt)-stamp(b.postedAt)||a.id.localeCompare(b.id)).forEach(p=>authors.set(p.authorId,p));
    const evidenceUsed=new Set<string>();
    const rows=[...authors.values()].map(p=>{
      const r=assessPost(p,snapshot.capturedAt);
      if(r.eligible&&r.evidenceId){if(evidenceUsed.has(r.evidenceId)){r.weight=1;r.eligible=false;r.reasons.push("此仓位证据已使用，本次不重复加权。");}else evidenceUsed.add(r.evidenceId);}
      if(posts.some(other=>other.authorId===p.authorId&&other.direction!==p.direction))r.reasons.push("该作者窗口内出现方向变化；仅最新观点参与投票。");
      return r;
    });
    const distribution=(weighted:boolean)=>{
      const counts=[0,0,0];for(const r of rows)counts[r.post.direction+1]+=weighted?r.weight:1;
      const total=counts.reduce((a,b)=>a+b,0);
      return {bear:round(counts[0]/total*100),neutral:round(counts[1]/total*100),bull:round(counts[2]/total*100),net:round((counts[2]-counts[0])/total*100)};
    };
    const interactions=posts.reduce((s,p)=>s+Math.max(0,p.likes)+Math.max(0,p.comments),0);
    // Relative discussion heat only; prices / returns / positions are intentionally absent.
    const heat=round(Math.log1p(posts.length)*20+Math.log1p(authors.size)*25+Math.log1p(interactions)*5);
    return {symbol,postCount:posts.length,authorCount:authors.size,interactions,heat,rows,raw:distribution(false),weighted:distribution(true),
      supported:rows.filter(r=>r.eligible).length,conflicts:rows.filter(r=>r.state==="conflict").length,
      evidenceIds:[...evidenceUsed],ruleVersion:RULE_VERSION};
  }).sort((a,b)=>b.heat-a.heat);
}
