// 指标模块的 AI 解读：把页面上已经展示给用户的那份数据原样组织成 prompt，交给大模型重新叙述一遍。
// 明确定位：不是新增的信号，不产生用户在页面上看不到的信息，不做买卖建议。详见 docs/ai-indicator-analysis-v1.md。
export const AI_ANALYSIS_RULE = "indicator-ai-v1";

export interface AiEarlySignal {
  ruleVersion: string;
  earlyScoreCoverage: number;
  volSqueezePct: number | null;
  oiAccel: number | null;
  topShortDivergence: number | null;
  avgTradeSizePct: number | null;
  netRatioStreak: number | null;
  obvDivergence: { diverging: boolean; magnitude: number } | null;
  fundingLag: number | null;
}
export interface AiDirection {
  state: string;
  label: string;
  summary: string;
  risks: string[];
  conditions: string;
  factors: { label: string; value: string; reading: string }[];
}
export interface IndicatorAiPayload {
  token: string;
  cutoffIso: string;
  priceChange: { h1: number | null; h4: number | null; h24: number | null };
  oi: { h1: number | null; h4: number | null; h24: number | null };
  ioNetRatio4h: number | null;
  volumeRatio: number | null;
  rsi: number | null;
  atrPct: number | null;
  fundingDaily: number | null;
  fundingHours: number | null;
  oiCapPct: number | null;
  marketCap: number | null;
  trend: string;
  tags: string[];
  warnings: string[];
  reason: string;
  strengthScore: number | null;
  earlyScore: number | null;
  earlyCandidate: boolean;
  earlySignal: AiEarlySignal | null;
  direction: AiDirection;
}

const fmt = (v: number | null | undefined, unit = ""): string => (v === null || v === undefined ? "缺失" : v.toFixed(4).replace(/\.?0+$/, "") + unit);
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "缺失" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");

export const SYSTEM_PROMPT = `你是一个只做"解读"、不做"预测"的加密货币合约数据助手，服务对象是一个研究性的看板工具。严格遵守：
1. 只能基于用户消息里给出的字段做分析，不得引入你自己的市场知识、价格预期或未列出的外部信息；字段值为"缺失"表示数据未采集到，不是0或中性，缺失越多结论应该越谨慎。
2. 绝不使用"建议买入/卖出/做多/做空""目标价""止损位""胜率"这类指令性或承诺性表述；不给出具体仓位或交易参数建议。
3. 你产出的不是新的信号，只是把已经计算好的规则输出重新组织成更容易读的叙述；不要暗示这段解读比原始数据更可靠或包含额外信息。
4. 结构：先用一两句话直接说这批信号现在整体呈现什么状态；再分点说明哪些数据支持这个状态、哪些数据矛盾或不足；最后如果有明显的数据覆盖缺口，指出来。
5. 用简体中文回答，四百字以内，语气客观克制（用"现有数据显示""这组信号目前"，不用"我认为""我建议"）。
6. 结尾必须有一句话：这段解读基于现有规则计算出的历史/当前快照数据重新组织而成，规则本身未经回测，不构成投资建议。`;

function directionText(d: AiDirection): string {
  const factors = d.factors.map((f) => "  - " + f.label + "：" + f.value + "（" + f.reading + "）").join("\n");
  return [
    "方向研判：" + d.label + "（内部状态 " + d.state + "）",
    "研判摘要：" + d.summary,
    factors ? "研判因子：\n" + factors : "研判因子：无",
    "风险/反对依据：" + (d.risks.length ? d.risks.join("；") : "无已触发的风险标记"),
    "研判前提：" + d.conditions,
  ].join("\n");
}

function earlySignalText(e: AiEarlySignal | null): string {
  if (!e) return "早期信号：该快照没有早期信号字段（旧版规则生成，或本次未采集）。";
  return [
    "早期信号（规则 " + e.ruleVersion + "，子项覆盖 " + e.earlyScoreCoverage + "/4）：",
    "  - 波动率压缩百分位：" + fmt(e.volSqueezePct, "%（越低越紧）"),
    "  - OI 加速度：" + fmt(e.oiAccel, " pct/h"),
    "  - 顶级账户多空比背离：" + fmt(e.topShortDivergence),
    "  - 大单占比百分位：" + fmt(e.avgTradeSizePct, "%"),
    "  - 连续净流入计数：" + (e.netRatioStreak === null ? "缺失" : e.netRatioStreak + " 根1h K线"),
    "  - OBV/价量背离：" + (e.obvDivergence === null ? "缺失" : (e.obvDivergence.diverging ? "疑似背离" : "未背离") + "（幅度 " + e.obvDivergence.magnitude.toFixed(1) + "）"),
    "  - 资金费率滞后（仅辅助折扣，不加分）：" + fmt(e.fundingLag, "%"),
  ].join("\n");
}

/** 把页面已经展示的字段拼成一份结构化用户消息；纯函数，不发网络请求，方便单测。 */
export function buildUserMessage(p: IndicatorAiPayload): string {
  return [
    "币种：" + p.token + "　分析时点（北京时间口径的采集截止）：" + p.cutoffIso,
    "价格变化：1h " + pct(p.priceChange.h1) + "　4h " + pct(p.priceChange.h4) + "　24h " + pct(p.priceChange.h24),
    "持仓（OI）变化：1h " + pct(p.oi.h1) + "　4h " + pct(p.oi.h4) + "　24h " + pct(p.oi.h24),
    "4h 主动净流入比：" + pct(p.ioNetRatio4h) + "（主动买入额减主动卖出额，占成交额比例）",
    "4h 成交量比：" + fmt(p.volumeRatio, "×") + "　RSI14(1h)：" + fmt(p.rsi) + "　ATR14/价格：" + fmt(p.atrPct, "%"),
    "资金费率（24h等效）：" + pct(p.fundingDaily) + "　结算周期：" + (p.fundingHours === null ? "未知/非永续" : p.fundingHours + "小时"),
    "持仓市值／流通市值：" + fmt(p.oiCapPct, "%") + "　流通市值：" + (p.marketCap === null ? "缺失" : "$" + p.marketCap.toLocaleString("en-US")),
    "EMA 趋势结构：" + p.trend,
    "走势强度分（事后确认型，不是早期信号）：" + fmt(p.strengthScore),
    "早期分（覆盖不足2/4子项时应为缺失）：" + fmt(p.earlyScore) + "　是否触发疑似启动候选：" + (p.earlyCandidate ? "是" : "否"),
    earlySignalText(p.earlySignal),
    "已触发信号标签：" + (p.tags.length ? p.tags.join("、") : "无"),
    "风险提示：" + (p.warnings.length ? p.warnings.join("；") : "无已触发的风险标记"),
    "入选依据摘要：" + p.reason,
    directionText(p.direction),
    "",
    "请按系统提示的结构给出一段解读。",
  ].join("\n");
}

export function buildMessages(p: IndicatorAiPayload): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: buildUserMessage(p) };
}
