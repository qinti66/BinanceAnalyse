import test from "node:test";
import assert from "node:assert/strict";
import {buildMessages,buildUserMessage,SYSTEM_PROMPT} from "../lib/ai/indicator-analysis.ts";

const payload=(over={})=>({
 token:"BTC",cutoffIso:"2026/09/19 12:00:00",
 priceChange:{h1:0.1,h4:-1.2,h24:3.4},oi:{h1:null,h4:5.6,h24:12.3},
 ioNetRatio4h:8.5,volumeRatio:1.8,rsi:62.1,atrPct:2.3,fundingDaily:0.05,fundingHours:8,oiCapPct:15.2,marketCap:1.2e9,
 trend:"多头排列",tags:["上涨增仓","主动净流入"],warnings:["RSI 处于极端区间"],reason:"上涨增仓 + 主动净流入",
 strengthScore:64.2,earlyScore:48.3,earlyCandidate:true,
 earlySignal:{ruleVersion:"indicator-early-v1",earlyScoreCoverage:3,volSqueezePct:18.5,oiAccel:0.021,topShortDivergence:null,avgTradeSizePct:72.1,netRatioStreak:5,obvDivergence:{diverging:true,magnitude:12.4},fundingLag:0.05},
 direction:{state:"long",label:"偏多 · 多头观察",summary:"价格和资金同向，EMA支持多头。",risks:["RSI 处于极端区间"],conditions:"基于4h价格与资金窗口",factors:[{label:"价格",value:"+3.4%",reading:"上涨确认"}]},
 ...over
});
test("buildUserMessage only echoes given fields, marks missing ones explicitly, never fabricates zeros",()=>{
 const msg=buildUserMessage(payload());
 assert.match(msg,/BTC/);
 assert.match(msg,/\+3\.40%/); // priceChange.h24
 assert.match(msg,/缺失/); // oi.h1 is null
 assert.doesNotMatch(msg,/oi\.h1.*0(?!\d)/); // never silently renders the missing field as 0
 assert.match(msg,/疑似背离/);
 assert.match(msg,/偏多 · 多头观察/);
 assert.match(msg,/价格.*\+3\.4%.*上涨确认/s);
});
test("missing earlySignal is stated as missing, not omitted or treated as zero-candidate",()=>{
 const msg=buildUserMessage(payload({earlySignal:null}));
 assert.match(msg,/该快照没有早期信号字段/);
});
test("system prompt forbids trading instructions and requires the unbacktested disclaimer",()=>{
 assert.match(SYSTEM_PROMPT,/买入|卖出|做多|做空/);
 assert.match(SYSTEM_PROMPT,/未经回测/);
 assert.match(SYSTEM_PROMPT,/不构成投资建议/);
});
test("buildMessages pairs the fixed system prompt with a per-payload user message",()=>{
 const {system,user}=buildMessages(payload({token:"ETH"}));
 assert.equal(system,SYSTEM_PROMPT);
 assert.match(user,/ETH/);
});
