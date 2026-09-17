import test from "node:test";
import assert from "node:assert/strict";
import { assessPost, analyzeSquare, RULES } from "../lib/square/model.ts";
import { DEMO_SNAPSHOT, EMPTY_SNAPSHOT } from "../lib/square/demo.ts";
const clone=()=>structuredClone(DEMO_SNAPSHOT.posts[0]);
const now=DEMO_SNAPSHOT.capturedAt;
const assess=p=>assessPost(p,now);
test("eligible long / short views both gain evidence weight",()=>{
  assert.ok(assess(clone()).weight>1);
  const short=structuredClone(DEMO_SNAPSHOT.posts[1]);
  assert.equal(assess(short).eligible,true);
  assert.ok(assess(short).weight>1);
});
test("screenshot, self-report and unmatched identity receive no bonus",()=>{
  for(const grade of ["screenshot","self_report"]){const p=clone();p.evidence.grade=grade;assert.equal(assess(p).weight,1);}
  const p=clone();p.evidence.identityVerified=false;assert.equal(assess(p).weight,1);
});
test("mismatched author / instrument cannot be associated",()=>{
  for(const key of ["authorId","symbol"]){const p=clone();p.evidence[key]="different";assert.equal(assess(p).weight,1);}
});
test("conflicting current direction keeps original opinion without bonus",()=>{
  const p=clone();p.evidence.current.side=-1;assert.equal(assess(p).state,"conflict");assert.equal(assess(p).weight,1);
});
test("closed, stale and missing evidence do not gain weight",()=>{
  const p=clone();p.evidence.current.state="closed";assert.equal(assess(p).state,"closed");
  p.evidence.current.state="open";p.evidence.current.observedAt="2026-09-17T10:01:00+08:00";
  assert.equal(assessPost(p,"2026-09-17T18:00:00+08:00").state,"stale");
  p.evidence=null;assert.equal(assess(p).weight,1);
});
test("later opening and later evidence cannot backdate support",()=>{
  const p=clone();p.evidence.openedAt="2026-09-17T10:30:00+08:00";assert.equal(assess(p).state,"late");
  p.evidence.openedAt="2026-09-17T01:00:00+08:00";p.evidence.atPost.observedAt="2026-09-17T10:01:00+08:00";
  assert.equal(assess(p).state,"late");
});
test("invalid, future and pre-post current observations are rejected",()=>{
  for(const t of ["invalid","2026-09-18T12:00:00+08:00","2026-09-17T09:30:00+08:00"]){
    const p=clone();p.evidence.current.observedAt=t;assert.equal(assess(p).weight,1);
  }
});
test("opening time without pre-post snapshot is insufficient",()=>{
  const p=clone();p.evidence.atPost=null;assert.equal(assess(p).weight,1);
  p.evidence=clone().evidence;p.evidence.openedAt=null;assert.equal(assess(p).weight,1);
});
test("no bonus for leverage, nominal exposure or floating profit",()=>{
  const p=clone(),baseline=assess(p).weight;p.evidence.leverage=125;p.evidence.notionalUsd=1e12;p.evidence.unrealizedPnlUsd=1e12;p.evidence.unrealizedRoiPct=100000;
  assert.equal(assess(p).weight,baseline);
});
test("missing or invalid equity does not fabricate allocation",()=>{
  const p=clone();p.evidence.equityUsd=null;assert.equal(assess(p).authorSharePct,null);
  p.evidence.equityUsd=0;assert.equal(assess(p).authorSharePct,null);
});
test("position size and complete history bonuses are bounded",()=>{
  const p=clone();p.evidence.marginUsd=1e15;p.evidence.equityUsd=1e15;p.evidence.openedAt="2020-01-01T00:00:00Z";
  assert.ok(assess(p).weight<=RULES.maxWeight);
  p.evidence.history.closedCycles=1;assert.ok(!assess(p).bonuses.some(b=>b.label.includes("历史净盈利")));
});
test("dedup and one latest opinion per author resist repeated shouting",()=>{
  const snapshot=structuredClone(DEMO_SNAPSHOT),first=analyzeSquare(snapshot).find(c=>c.symbol==="BTC");
  assert.equal(first.postCount,8);assert.equal(first.authorCount,8);
  snapshot.posts.push({...clone(),id:"later",text:"更新观点",postedAt:"2026-09-17T11:00:00+08:00",direction:-1});
  const second=analyzeSquare(snapshot).find(c=>c.symbol==="BTC");assert.equal(second.authorCount,8);
  assert.equal(second.rows.find(r=>r.post.authorId==="a").post.id,"later");
  assert.ok(second.raw.net<first.raw.net);
});
test("repeated evidence ID cannot become independent supports",()=>{
  const a=clone(),b=clone();b.id="other-post";b.authorId="other-author";b.evidence.authorId="other-author";
  const c=analyzeSquare({...DEMO_SNAPSHOT,posts:[a,b]})[0];assert.equal(c.supported,1);assert.equal(c.evidenceIds.length,1);
});
test("missing evidence is not bearish; no data remains empty",()=>{
  assert.deepEqual(analyzeSquare(EMPTY_SNAPSHOT),[]);
  const p=clone();p.evidence=null;const c=analyzeSquare({...DEMO_SNAPSHOT,posts:[p]})[0];
  assert.equal(c.raw.bull,100);assert.equal(c.weighted.bull,100);assert.equal(c.supported,0);
});
test("heat is independent of position PnL and direction",()=>{
  const p=clone(),first=analyzeSquare({...DEMO_SNAPSHOT,posts:[p]})[0].heat;
  p.direction=-1;p.evidence.unrealizedPnlUsd=999999;
  assert.equal(analyzeSquare({...DEMO_SNAPSHOT,posts:[p]})[0].heat,first);
});
test("snapshot cutoff excludes future posts",()=>{
  const p=clone();p.postedAt="2026-09-18T12:00:00+08:00";assert.deepEqual(analyzeSquare({...DEMO_SNAPSHOT,posts:[p]}),[]);
});
