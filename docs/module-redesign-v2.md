# 三模块重设计 v2 —— 早期信号 · 去方向化热度 · Hyperliquid Phase 0

本文档记录三个模块的重写/改进方案与对应代码改动。所有规则均为研究性启发式规则，**尚未回测**，不构成买卖建议，不保证未来表现。数值门槛、归一化区间均为经验取值，会随样本积累调整；缺失数据不按 0 或"无风险"处理，缺失就是缺失。

---

# 第一节：技术指标模块——早期信号体系

## 背景

`lib/indicators/direction.ts` 现有的 long/short/wait 判定是"事后确认型"设计：要求价格方向＝资金流方向＝EMA 趋势对齐，并且 OI 增仓或放量确认，才给出方向。这套规则本身没问题（作为风险受控的确认体系继续保留），但它天然滞后——当所有条件都对齐时，行情往往已经走出一段。

同时，首页默认排序用的"关注分"公式：

```
attention = min(35, |oi4|*4) + min(25, |netRatio|*2) + min(20, max(0, volumeRatio-1)*15) + min(20, |p4|*3)
```

价格变化权重与量比权重都依赖"已经发生的变化"，本质上和 direction.ts 一样是事后确认，排序结果会偏向已经涨（或跌）过一段的币种。

现有"盘整增仓"标签（`oi4>=3% 且 |p4|<1%`）已经具备早期信号的雏形——持仓在增加，但价格还没怎么动——但它只是若干标签之一，没有被单独拿出来做排序依据。`atrPct`（ATR/价格）目前只用于止损否决（≥5% 暂停方向结论），没有利用"波动率压缩"这个常见的启动前形态。OI 也只看区间内的变化幅度，没有"加速度"（变化率的变化率）这个维度。

## 现状问题小结

1. direction.ts 要求多重确认，注定滞后。
2. "关注分"价格权重最高（`min(20,|p4|*3)`），排序偏向已经动过的币。
3. "盘整增仓"标签是天然的早期信号，但未被独立使用于排序。
4. ATR 只做止损否决，没有"波动率压缩→即将放量"的正向利用。
5. OI 只看幅度，没有加速度。
6. 缺少"高净值账户是否已经领先散户调整方向"这个维度——现有指标完全没有账户结构数据。

## 新设计：三个新字段 + 一个新标签 + 早期分公式

### 新增字段定义

所有字段实现在 `lib/indicators/earlySignal.ts`，输入为**主合约**（成交最活跃的合约）的原始序列，不跨合约聚合，保持可解释；数据不足时字段本身缺失，绝不按 0 填充。

| 字段 | 含义 | 计算方式 | 数据需求 |
|---|---|---|---|
| `volSqueezePct` | 波动率压缩百分位 | 当前 1h ATR14/价格（%）在该合约近14天（约336根1h K线）自身历史分布中的百分位排名（0-100，越低越紧） | 需要约336根连续1h K线；样本不足9个点时缺失 |
| `oiAccel` | OI 加速度 | 最新1h OI变化率 − 过去4h平均1h OI变化率（单位：百分点/小时） | 需要最近6个整点 OI 数量点（t-5..t），任一点缺失则整体缺失 |
| `fundingLag` | 资金费率滞后（辅助否决，不进主公式权重） | 当前24h等效资金费率的绝对值（%）。本版未采集历史资金费率序列，用当前单点绝对值近似"市场是否已经察觉"；后续应改为与该合约过去N天资金费率均值的偏离度 | 当前 fundingDaily 可用即可 |
| `topShortDivergence` | 顶级账户多空比背离 | 顶级账户（前20%保证金）多空比近6h斜率 − 全市场账户多空比近6h斜率（单位：比值/小时）。正且明显＝高净值账户在散户/价格察觉之前已经在调整方向 | 需要 `/futures/data/topLongShortAccountRatio`（或 `topLongShortPositionRatio`）与 `/futures/data/globalLongShortAccountRatio` 各至少2个近6h内的历史点 |
| `avgTradeSizePct` | 大单占比趋势 | 单笔平均成交额 `avgTradeSize = quoteVolume/numTrades`（K线自带字段，零新数据源）在该合约历史分布中的百分位排名 | 与 volSqueezePct 共用K线窗口，样本不足9个点时缺失 |
| `netRatioStreak` | 连续净流入持续性 | 过去1h K线中，`netRatio`（该小时主动买卖净额/成交额）同向（同正或同负）的连续计数，从最近一根向过去数，最多看24根；正数=连续净流入，负数=连续净流出 | 需要连续1h K线，任意一根缺失即在该处截断 |
| `obvDivergence` | OBV/价量背离 | 用现有K线重建近24h OBV（收盘价上涨累加成交额，下跌累减，平盘不变），比较 OBV 斜率方向与价格斜率方向：价格24h涨幅≤0.3%但OBV相对区间涨幅≥20%，标记为正背离（`diverging:true`） | 需要至少25根连续1h K线 |

新标签"疑似启动"（`earlyCandidate`），代码里体现为 `tags` 数组新增的 `"疑似启动"`：

```
earlyCandidate = 盘整增仓（oi4>=3% 且 |p4|<1%）
              且 主动净流入（netRatio4h>=5%，注意比现有确认用阈值 8% 更宽松，因为不要求价格已确认）
              且 volSqueezePct < 30
```

三项同时满足即进入"疑似启动"候选，不要求价格已经动，也不依赖 direction.ts 的任何确认条件。

### 早期分公式（0-100，替换首页默认排序依据）

```
earlyScore = min(30, normalize_top(topShortDivergence))
           + min(25, (100 - volSqueezePct) * 0.25)
           + min(25, normalize_streak(netRatioStreak))
           + min(20, normalize_trade(avgTradeSizePct))
```

四个子项**缺失不按0填充**，直接从求和中剔除；已知子项少于2个时，`earlyScore` 整体记为缺失（`earlyScoreCoverage < 2`），因为覆盖度太低时分数不具跨币种可比性。`fundingLag`（当前实现取当前费率绝对值）仅作否决/折扣：当 `fundingLag >= 0.08%` 时对已算出的 `earlyScore` 打 0.85 折——费率已经明显偏离，说明市场可能已经察觉，早期性打折；`fundingLag` 本身不参与加分，符合"辅助否决而非主要权重"的设计要求。

归一化函数（区间为经验取值，未回测，写在这里保证公式可复现，实现见 `lib/indicators/earlySignal.ts`）：

- `normalize_top(x) = clamp((x + 0.02) / 0.08 * 100, 0, 100)` —— 域 `[-0.02, 0.06]` 比值/小时，正向偏移允许更大空间，因为我们只关心"顶级账户领先"这一侧。
- `normalize_streak(x) = clamp(max(0, x) / 12 * 100, 0, 100)` —— 12根1h同向K线（约半天）映射到满分域；由于外层还有 `min(25, ...)`，实际在连续同向 ≥ 6.25 小时后该子项即封顶。
- `normalize_trade(pct) = clamp((pct - 50) * 2, 0, 100)` —— 只奖励高于历史中位数的单笔均值百分位，50分位以下贡献为0；外层 `min(20, ...)` 封顶意味着百分位 ≥60 即可拿满分。
- `volSqueezePct` 项不需要额外 normalize，公式本身 `(100 - volSqueezePct) * 0.25` 在 `volSqueezePct∈[0,100]` 时天然落在 `[0,25]`。

### 与现有体系的关系

- 现有"确认分"（原"关注分"公式）**保留**，代码里字段名不变（`attention`，向后兼容 `lib/cross-validation/model.ts` 的引用），新增同义字段 `strengthScore`，UI 展示改名"走势强度分"。
- `long/short/wait` 方向判定（`analyzeDirection`）**保留**，逻辑不变，但从默认列表的主列降级为详情展开区（`DirectionDetail`），不再是默认视图的主要依据。
- UI 默认排序改为按 `earlyScore` 降序（`app/indicators/page.tsx` 的 `sort` 状态默认值改为 `"early"`），"疑似启动"筛选默认开启（`onlyEarly` 状态默认 `true`，可关闭）。
- "已转确认"徽章：当某币同时满足 `earlyCandidate === true` 且 `analyzeDirection` 给出的 `state` 为 `"long"` 或 `"short"` 时，在列表行显示"已转确认"徽章。**重要限制**：这是单快照内的组合判断，项目当前没有跨快照的信号时序存储，因此徽章只能证明"本次快照两个条件同时成立"，**不能**证明"早期信号确实先于方向确认出现"。要做严格的时序验证，需要落地一个跨快照的信号历史表（可参考 `db/schema.ts` 里现成的 `coinSignals`/`marketSnapshots` 结构扩展），这是后续工作，本版未实现。

## 数据源接口表

| 接口 | 用途 | 鉴权 | 参数建议 | 备注 |
|---|---|---|---|---|
| `/fapi/v1/klines`、`/dapi/v1/klines` | 1h K线（收盘价、成交额、笔数、主动买入额等） | 无 | `interval=1h&limit=360` | 本版把 `limit` 从 200 提升到 360，为 `volSqueezePct`/`avgTradeSizePct` 提供约14天历史窗口 |
| `/futures/data/openInterestHist` | 整点 OI 历史 | 无 | `period=1h&limit=25` | 现状不变，`oiAccel` 复用已有的 `oiQtyHourly` 取最近6点 |
| `/futures/data/topLongShortAccountRatio` | 顶级账户（前20%保证金）多空账户比 | 无 | `period=1h&limit=48` | **新增**，与 `openInterestHist` 同批次、同限速节奏拉取；只保留最近30天（币安限制） |
| `/futures/data/topLongShortPositionRatio` | 顶级账户多空持仓量比 | 无 | `period=1h&limit=48` | **新增**，作为 `topLongShortAccountRatio` 缺失时的备选（代码里 `raw.topAccountRatio ?? raw.topPositionRatio`） |
| `/futures/data/globalLongShortAccountRatio` | 全市场账户多空账户比 | 无 | `period=1h&limit=48` | **新增**，作为 `topShortDivergence` 的对照基线 |

三个新接口在 U 本位（`fapi`）与币本位（`dapi`）下都提供对应路径（`/dapi/v1/futures/data/...` 实为同样的 `/futures/data/` 前缀 + `pair`/`contractType` 查询参数，与现有 `openInterestHist` 写法一致），采集脚本按合约 family 复用现有的 `query` 变量（UM 用 `symbol=`，CM 用 `pair=...&contractType=...`）。

## 实施步骤（已完成的代码改动）

1. 新建 `lib/indicators/earlySignal.ts`：独立模块，不依赖 `model.ts`，导出 `computeEarlySignal`、`percentileRank`、`computeOiAccel`、`computeNetRatioStreak`、`computeObvDivergence`、`computeTopShortDivergence` 等纯函数，方便单独单测。
2. 修改 `lib/indicators/model.ts`：
   - `RawContract` 新增可选字段 `topAccountRatio`/`topPositionRatio`/`globalAccountRatio`（未采集时为 `null`，历史快照回放不受影响）。
   - `contractMetrics` 内部新增 `earlyInputs` 的原始序列构建（ATR%序列、单笔均值序列、整点OI序列、净流比序列、顶级/全市场多空比序列、收盘价与成交额序列），随每个合约的返回值一起产出，但**不**放进最终发给前端的 `contracts` 明细数组（用解构 `({earlyInputs, ...rest})` 剔除），避免每个币种的合约展开表格里带上大量原始序列膨胀体积。
   - `buildIndicators` 在计算出币种级别的 `oi4`/`p4`/`netRatio` 之后，调用 `computeEarlySignal(rep.earlyInputs, {oi4,p4,netRatio4h:netRatio})`，把结果作为 `coin.earlySignal` 附加，同时展开 `coin.earlyScore`、`coin.earlyCandidate` 两个常用字段；`earlyCandidate` 为真时追加 `"疑似启动"` 标签。
   - 币种排序改为 `earlyScore` 优先，`candidate`/`attention` 作为并列排序的次级依据（不破坏现有行为，只是不再是第一优先级）。
3. 修改 `scripts/collect-indicators.mjs`：K线 `limit` 从200提升到360；每个合约新增3个 `/futures/data/` 请求（复用现有 `optional()` 错误处理与限速节奏），失败时该字段为 `null`，不影响其余采集。**注意**：单合约的并发请求数从3个增加到6个，整体采集耗时会明显增加，如果时间预算紧张可以考虑把这三个新接口的采集频率降低（比如只在观察名单代币上补采）——本版未做这个优化，先保证功能可用。
4. 修改 `app/indicators/page.tsx`：默认 `sort` 改为 `"early"`；新增"仅看疑似启动"开关（默认开启）；表格首列展示 `earlyScore` 与覆盖度、次列展示"疑似启动"/"已转确认"徽章与信号标签；原方向研判列整合进信号标签+详情区；详情区新增 `EarlySignalDetail` 组件展示全部早期信号子项的原始值与缺失说明；`CoinDetail` 里补充"走势强度分（原'关注分'）"数值展示。

## 未回测声明

- 所有阈值（3%、5%、8%、30百分位、6.25小时封顶等）为经验取值，未经过历史回测验证，随样本积累会调整。
- `earlyScore` 在数据覆盖不足时的部分求和（跳过缺失子项）意味着**不同币种、不同时刻的分数在覆盖度不一致时不能直接比较**——这是刻意的设计取舍（不按0填充），但使用者需要知道这个限制。
- `fundingLag` 当前实现是简化版（只用当前单点绝对值），完整设计需要历史资金费率序列，本版数据采集未覆盖，留作后续改进。

---

# 第二节：广场热度模块——去方向化 + 热度斜率

## 背景

`lib/square/model.ts`/`normalize.ts` 现有实现有两个独立问题：

1. 关键词多空分类（`normalize.ts` 的 `classify()`）用简单中英文正则识别看多/看空，不是 NLP，准确率有限，而且用户的实际目标本来就不需要方向——广场模块的价值是"发现讨论热度变化"，不是"预测多空"。
2. 热度绝对值公式 `heat = log1p(postCount)*20 + log1p(authorCount)*25 + log1p(interactions)*5` 只衡量"已经很热"的话题，天然滞后于话题真正开始扩散的时刻；持仓证据加权路径（`assessPost`）目前只有 `lib/square/demo.ts` 的虚构样本在跑，真实数据源的作者-仓位身份映射尚未接入，是纯粹的规则验收样例。

## 现状问题小结

1. 方向分类噪音大，且不是用户真正需要的信息。
2. 热度绝对值排序滞后于话题扩散过程。
3. 缺少"新账户刷帖"的降权机制。
4. `assessPost` 的仓位加权是 demo-only，不应该被当成默认展示或跨模块证据。

## 新设计

### 去方向化（默认 UI 不再展示多空分类）

`normalize.ts` 的 `classify()` 函数与 `model.ts` 里基于它的方向分布计算（`analyzeSquare` 返回的 `raw`/`weighted` 字段）**代码保留**，因为：

- `assessPost` 需要 `post.direction` 来判断"当前仓位方向是否与发帖观点一致"（证据匹配的必要输入）；
- `lib/cross-validation/model.ts` 用 `squareRows[i].raw.net` 作为广场模块参与跨模块交叉验证的方向信号，删除会破坏交叉验证功能。

因此改动限定在**默认展示层**：`app/square/page.tsx` 不再把方向分布（`Distribution` 组件的看多/看空/中性柱状图）放在页面主视觉位置，改为收进一个默认收起的 `<details>`（"展开方向分类（内部规则，默认不作为结论展示）"），并在旁注明"关键词规则准确率有限，仅供内部交叉验证使用"。

### 热度斜率（heatSlope）

```
heatSlope = 近6h热度速率 / 更早时段热度速率
```

`>= 1.5` 视为"正在变热"。**近似口径说明**：严格定义应该是"近6h平均热度 / 24-48小时前的平均热度"，但当前广场快照的采集窗口只有24h（`windowHours=24`），没有48小时前的历史留存。本版实现（`lib/square/model.ts` 的 `analyzeSquare`）用"近6h热度速率 / 窗口内剩余时段（24h窗口下即18h）的热度速率"做替代：

```
recentRate = heatFormula(近6h内的帖子) / 6
olderRate  = heatFormula(6h前~窗口起点的帖子) / (windowHours - 6)
heatSlope  = olderRate > 0 ? recentRate / olderRate : (recentRate > 0 ? 5 : null)
```

要做到真正的"24-48小时前"对比窗口，需要把 `windowHours` 扩大到48h，或者跨快照留存历史（例如落地 `db/schema.ts` 里的 `coinSignals` 表按天记录）。这是明确的后续工作，本版未实现，属于近似替代。

### "新晋热门"标签（近似版）

严格定义："该币种过去7天从未进入过热议列表（heat 超过某阈值），本轮首次进入"，需要跨天的历史存储去判断"过去7天有没有出现过"。当前项目的广场模块没有跨天持久化（每次分析都是基于单次快照重算），因此本版用**单快照内的近似代理指标**：

```
isNewlyHotApprox = rising && heat >= 25
```

即"正在变热 且 当前热度已经跨过一个基础阈值"。这不是严格的新晋判定，只是同一批规则改动里能立刻落地的近似值；严格版本留给接入 `coinSignals` 跨天存储之后的下一阶段。

### 去水化（新热度公式）

```
heat = log1p(authorCount) * 35 + log1p(weightedPostCount) * 10 + log1p(weightedInteractions) * 5
```

相比旧公式（作者权重25、帖子权重20、互动权重5），提高独立作者数权重、降低帖子数权重，减少"同一批小号刷帖"对热度的拉高效果。`weightedPostCount`/`weightedInteractions` 对注册不足7天的账户按 `0.3` 折算（`NEW_ACCOUNT_WEIGHT` 常量，`lib/square/model.ts`）；账户年龄未知（`authorAccountAgeDays` 为 `null`/`undefined`，当前所有真实/演示数据源都是这个状态）时**不打折**——不确定不按可疑处理，这是项目一贯的"缺失不按0/不按坏情况处理"原则。要让降权真正生效，采集层（`lib/square/normalize.ts` 的 `normalizeSquare`）需要补充账户注册时间字段，本版未接入真实来源，只是把机制留好。

### 页面拆分

`app/square/page.tsx` 拆成两个榜：

- **正在变热**：只列出 `rising`（`heatSlope>=1.5`）的币种，按斜率降序，标注"疑似新晋热门"。
- **当前最热**：按 `heat` 绝对值降序的传统榜。

两榜都可以点击切换到下方的详情区（原有的仓位证据表格、原帖分享卡等功能完全保留，不受影响）。

### 持仓证据加权（`assessPost`）的定位

明确标注为**实验性/demo-only**：`lib/square/model.ts` 里 `assessPost` 函数上方补充了注释说明——目前只有 `demo.ts` 的虚构样本在跑，真实来源没有完成作者-仓位身份映射；它不参与广场页面默认展示的热度/榜单排序（两个新榜单都只用 `heat`/`heatSlope`，不用仓位权重），也不进入交叉验证的方向判定（`cross-validation/model.ts` 本来就只用 `.raw.net` 原始情绪，不用 `assessPost` 的权重，这点在现有代码里已经是这样，本版只是把这个事实写进注释）。

## 数据源接口表

本节没有新增外部数据源；热度斜率与新晋检测都基于现有广场帖子快照（`SquareSnapshot`）在内存里重算，零额外网络请求。真正做到严格的"24-48h对比窗口"与"过去7天首次进入"判定时，需要的数据源是**项目内部**的历史留存（建议方案见下）：

| 建议数据源 | 用途 | 说明 |
|---|---|---|
| `db/schema.ts` 的 `coinSignals` 表（已存在，未接入运行路径） | 按天/按快照记录每个币种的 `heatScore`，供跨天回看 | 现有 schema 字段（`heatScore`、`rapidRiser`）已经基本够用，只需要接入采集脚本定时写入 |

## 实施步骤

1. `lib/square/model.ts`：新增 `authorAccountAgeDays` 可选字段（`SquarePost` 接口）；新热度公式与去水化权重；`heatSlope`/`rising`/`isNewlyHotApprox` 字段；`assessPost` 增加 demo-only 说明注释；`RULE_VERSION` 从 `square-evidence-v1` 升级到 `square-evidence-v2`。
2. `lib/square/normalize.ts`：`classify()` 函数增加注释说明其"仅供内部使用，默认不对外展示"的定位，逻辑不变。
3. `app/square/page.tsx`：新增"正在变热"/"当前最热"两个榜单区块；原方向分布图收进默认收起的 `<details>`；其余功能（证据表格、分享卡、演示/真实数据切换）不变。

## 未回测声明

- `heatSlope`/`isNewlyHotApprox` 的具体阈值（1.5×、heat≥25、NEW_ACCOUNT_WEIGHT=0.3）均为经验取值，未回测。
- 本版 `heatSlope` 是单快照内的近似口径，不是严格的"近6h对比24-48h前"，见上文说明；升级为严格口径需要跨快照/跨天的历史存储，属于后续工作。
- `authorAccountAgeDays` 目前没有真实数据源填充，降权机制虽然实现了但暂时不会在真实数据上生效，直到采集层补上账户注册时间。

---

# 第三节：聪明钱模块——Hyperliquid 实时持仓（Phase 0）

## 背景

现有 `lib/copy-trading/model.ts` 基于币安非官方 BAPI（`home-page/query-list`、`lead-portfolio/detail`、`lead-portfolio/order-history`）重建带单员的历史成交周期，拿不到实时持仓——只能看到"过去某段时间平仓了什么"，看不到"现在正拿着什么仓位"。

Hyperliquid 是一条全链上撮合的永续合约 DEX，任何地址的持仓都是公开链上状态，可以通过官方 `POST https://api.hyperliquid.xyz/info` 接口免鉴权查询任意地址的实时持仓（方向、规模、开仓均价、杠杆、未实现盈亏、清算价、保证金占用）和历史成交（`userFills`）。这为"聪明钱实时持仓"这个方向提供了一个技术上可行的数据源，但地址发现（谁是"聪明钱"）、资格筛选、定时轮询都还没有做。

## 范围声明：本次只做 Phase 0

**Phase 0 = 可行性验证 + 基础客户端**，明确不做以下事项（留给下一阶段）：

- 不改现有币安 `copy-trading` 模块的任何逻辑或路由。
- 不做地址发现（Hyperliquid 排行榜/leaderboard 抓取）。
- 不做完整的资格筛选迁移（现有币安模块的11项门槛不套用到 Hyperliquid，两边数据结构和可得字段都不同，需要单独设计）。
- 不做定时轮询任务、不接入数据库、不接入 UI。

## 接口说明

| 接口 | 方法 | 请求体 | 用途 | 鉴权 |
|---|---|---|---|---|
| `https://api.hyperliquid.xyz/info` | POST | `{"type":"clearinghouseState","user":"<address>"}` | 查询地址当前持仓：每个仓位的方向+规模（`szi`，有符号，正=多负=空）、开仓均价（`entryPx`）、杠杆、未实现盈亏（`unrealizedPnl`）、清算价（`liquidationPx`）、保证金占用（`marginUsed`），以及账户总价值（`marginSummary.accountValue`） | 无 |
| `https://api.hyperliquid.xyz/info` | POST | `{"type":"userFills","user":"<address>"}`（或 `userFillsByTime` + `startTime`） | 查询地址历史成交 | 无 |

地址格式为以太坊风格的 `0x` + 40位十六进制字符串（Hyperliquid 使用 EVM 地址体系）。

## 实施步骤（已完成的代码改动）

1. 新建 `lib/copy-trading/hyperliquid.ts`：
   - `fetchClearinghouseState(address: string)`：POST `clearinghouseState`，地址格式校验，返回 `HyperliquidClearinghouseState`（含 `assetPositions[].position` 数组，每项含 `coin`/`szi`/`entryPx`/`leverage`/`unrealizedPnl`/`liquidationPx`/`marginUsed`；以及 `marginSummary.accountValue`）。
   - `fetchUserFills(address: string, startTime?: number)`：POST `userFills`/`userFillsByTime`，返回 `HyperliquidFill[]`。
   - 基本错误处理：网络失败/超时重试（最多3次，退避递增）；429限流按 `Retry-After`（或指数退避，上限30秒）暂停重试；非200状态码（非429）直接抛出 `HyperliquidError`，不静默吞掉。
   - 完整 TypeScript 类型定义：`HyperliquidPosition`、`HyperliquidMarginSummary`、`HyperliquidClearinghouseState`、`HyperliquidFill`。
2. 新建 `scripts/verify-hyperliquid.mjs`：
   - 硬编码的 `ADDRESSES` 占位数组（默认为空），支持通过命令行参数传入要验证的地址：`node scripts/verify-hyperliquid.mjs 0x地址1 0x地址2`。
   - 未提供任何地址时只打印用法提示，**不发起网络请求**（避免误跑）。
   - 调用 `clearinghouseState` 并打印账户总价值、保证金占用、持仓列表，用于人工确认接口可行性；不接入UI、不接入数据库、不做定时任务。

## 未实现／留给下一阶段

- 地址发现：需要抓取 Hyperliquid 官方或第三方的聪明钱排行榜/大额持仓榜，目前完全没有做。
- 资格筛选：现有币安模块的11项门槛（资料时效、活跃度、ROI、回撤、夏普、样本量、订单完整性、持仓时长、利润因子、异常筛查）基于币安 BAPI 特有字段设计，不能直接套用到 Hyperliquid 的 `clearinghouseState`/`userFills` 结构，需要重新设计一套等价的资格判定逻辑。
- 定时轮询与持仓变化追踪：`clearinghouseState` 只是某一时刻的快照，要做"持仓变化提醒"需要定时轮询 + 差分记录，涉及数据库/调度设计，本版完全没有涉及。
- 与现有带单模块的融合：Hyperliquid 聪明钱和币安带单员目前是两套互不相关的数据源，暂不与 `lib/cross-validation/model.ts` 的交叉验证逻辑打通。

## 官方参考

- Hyperliquid API 文档：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api

---

# 第四节：聪明钱模块 Phase 1 —— 用 Hyperliquid 完全替换币安带单模块

## 背景与范围

Phase 0（第三节）验证了 `clearinghouseState`/`userFills` 两个官方接口可行，但明确留了"地址发现"和"资格筛选迁移"两块空白，也没有接入页面。Phase 1 按用户决定补齐这两块，**完全替换**原有的币安带单模块：`app/copy-trading/page.tsx` 和 `lib/cross-validation/model.ts` 的"带单聪明钱"信号改由 Hyperliquid 数据驱动；原币安实现（`lib/copy-trading/model.ts`、`scripts/update-copy-pools.mjs`、`scripts/copy-pool-service.mjs`、`scripts/analyze-copy-pools.mjs`、相关测试与 `data/copy-trading/`）**保留在仓库中但不再被页面使用**，删不删由用户自行决定。

切换的直接原因：币安带单 BAPI 的 `order-history` 接口在本次实际采集中连续 3 次触发平台限流（错误码 `90801003`），每次都卡在候选列表里两个历史订单特别多的账户附近，加宽请求间隔、拉长冷却时间均未解决，判断为该接口自身的短周期总量限制，不是我方请求速率问题。继续等待或硬重试不是可靠路径。

## 地址发现：两个官方公开数据源

Hyperliquid 的 `POST /info` 文档接口里，`vaultSummaries`（金库列表）实测返回空数组（`[]`），文档与实际行为不一致，原因未知。改为使用 Hyperliquid 官方前端自己渲染 `/leaderboard` 和 `/vaults` 两个公开页面时实际调用的数据源（用built-in 浏览器打开这两个页面、检查其网络请求确认）：

| 接口 | 方法 | 用途 | 鉴权 | 备注 |
|---|---|---|---|---|
| `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` | GET | 全量个人交易员排行榜快照（约4.6万地址），含 `accountValue`、`day/week/month/allTime` 四个窗口的 `pnl/roi/vlm` | 无 | 一次性返回全量，无需分页；这是官方前端渲染排行榜页面本身调用的接口，不是逆向未公开接口 |
| `https://stats-data.hyperliquid.xyz/Mainnet/vaults` | GET | 全量金库快照（约9500个，含已关闭的），含 `apr`、按窗口的 `pnls` 数值序列、`summary`（`name`/`vaultAddress`/`leader`/`tvl`/`isClosed`/`relationship`/`createTimeMillis`） | 无 | 同上；官方 `/vaults` 页面自己调用的接口 |
| `https://api.hyperliquid.xyz/info`（`vaultDetails`） | POST | 候选子集的金库详情增强：`followers`、`allowDeposits`、`leaderCommission`、更完整的 `portfolio` | 无 | 官方文档接口；只对通过筛选的候选子集调用，不对全部9500个金库调用 |

`k` 前缀的1000倍化 meme 币种（如 `kPEPE`）经 `POST /info {type:"meta"}` 核实为 `kPEPE`/`kSHIB`/`kBONK`/`kLUNC`/`kFLOKI`/`kDOGS`/`kNEIRO` 共7个，去除前缀后与其余模块的 `token` 命名对齐（`lib/cross-validation/model.ts` 的 `hlToken()`）。

## 候选筛选与限速

`scripts/collect-hyperliquid.mjs`：discovery 阶段各一次 GET（零分页），从中选出账户价值/TVL较高的候选子集（个人交易员按账户价值与全部历史 ROI 两个维度各取前80名去重合并，金库取TVL前50名且未关闭、非子金库），再对候选子集逐个调用官方 `clearinghouseState`（查实时持仓）与（仅金库）`vaultDetails`。

`lib/copy-trading/hyperliquid.ts` 内置权重限速：官方接口按IP聚合权重预算1200/分钟，`clearinghouseState` 权重2、`vaultDetails`/`userFills` 保守按权重20计，本文件把自己的请求预算控制在900/分钟（留25%余量），不追求精确复刻官方计费规则，只求不主动撞到限速——延续币安侧"检测到限流就停，不做任何规避"的原则，这里是从源头上把请求量和节奏设计得远低于限制，而不是撞到限流后再退让。实测约206个候选（156个人+50金库）全部复核完成，0个持仓查询失败，用时在一分钟量级。

## 候选门槛（`lib/copy-trading/hyperliquid-model.ts`）

不移植币安模块原有的11项门槛——那一套依赖订单笔数、边界周期、对刷筛查等币安撮合层字段，Hyperliquid 的可得数据形状完全不同，尤其是没有"重建历史平仓周期"的等价物（也不需要，因为现在能看到实时持仓）。改用一套更小、更明确标注未回测的门槛：

- 本次实时持仓查询成功；
- 数据在12小时内（比币安版本的48小时更短，因为这里展示的是"现在"的持仓，不是历史）；
- 账户价值 ≥ $20,000；
- 全部历史（allTime）浮动盈亏为正；
- 近1周有成交量或当前持有实盘仓位；
- 金库额外要求：仍开放存款（`allowDeposits` 未知时不算不通过）、运行至少30天。

全部通过进"候选池"，否则进"观察池"（继续核验，不代表表现差）。

## 与交叉验证的整合

`lib/cross-validation/model.ts` 的"带单聪明钱"信号（重命名为"Hyperliquid 聪明钱"）从"最近已平仓方向投票"改为"当前公开持仓方向投票"：候选/观察池中数据新鲜（12小时内）且本轮查询无错误的地址，按各自持仓名义价值最大的一侧计票，多空地址数差占比达到34%才判定方向。三个模块（广场、指标、Hyperliquid）现在都是"当前/近窗口"证据，`verdict()` 不再需要区分"历史"措辞分支。

## 跨快照持仓变化追踪（"新开仓提醒"）

项目里已经有一份 Drizzle/D1 schema（`db/schema.ts`，含 `traders`/`traderSnapshots`/`tradeEvents` 表），但检查后发现**没有任何真实模块在用它**——指标、广场、原币安带单三个模块全部是 `data/<module>/` + `public/<module>/latest.json` 的平铺 JSON 文件，唯一引用 D1 的是脚手架自带的示例路由 `app/api/refresh/route.ts`，与这几个模块无关。为了不在这一个功能上单独引入数据库依赖、和其余模块的存储方式不一致，跨快照追踪延续了同样的平铺文件约定：

- `scripts/collect-hyperliquid.mjs` 在覆盖 `public/copy-trading/latest.json` 之前，先读一次旧文件；只有 `schemaVersion===2`（同样是 Hyperliquid 快照）才当作有效基线，读取失败或是旧版币安快照都当作没有基线。
- `lib/copy-trading/hyperliquid-model.ts` 的 `diffPositions()` 按地址、按币种比较前后两轮的持仓：新出现的币种记为"新开仓"，消失的记为"平仓"，方向翻转记为"反手"，同方向名义价值变化 ≥30%（经验阈值，未回测）记为"加仓/减仓"。**只对上一轮也出现过的地址做比较**——新发现的候选没有基线，它当前的持仓不算"新开仓"，只是我们第一次看到它。
- 事件像原币安模块 `makeSnapshot` 的 `changes` 日志一样，累积进快照自己的 `events` 数组（最多保留500条，新的在前），不需要另外的文件或数据库。
- 页面（`app/copy-trading/page.tsx`）在数据获取失败/持仓查询失败提示下面加了一条"本轮新开仓"横幅，以及一个"最近持仓变化"的可展开列表。

**局限**：只比较相邻两次采集的净结果，不是逐笔成交流水——采集间隔越长，越可能漏掉中间的开平仓，或者把多次变化合并成一次。这不是逐笔追踪，是"两张快照对比"。

## 关于门槛回测

候选门槛（$20,000、12小时、34%、±30%名义价值变化等）都是经验取值，**这次没有做、也没法做真正的回测**——回测需要这些门槛在历史上多次运行积累的数据，而这个模块今天才第一次真正跑起来，没有历史。上面这套跨快照事件追踪，是为将来积累这些历史、支持回测打的地基，不是回测本身；不会在没有数据的情况下编造一个"回测通过"的结论。

## 已知限制（未回测声明的延伸）

- 候选发现基于账户价值/TVL较高的子集，不是全市场地址普查，存在选择偏差；账户价值高不等于策略质量高。
- 个人交易员的地址是公开钱包地址，可能承载多个策略或委托资金，并非都专注单一交易风格。
- 没有对手账户和撮合级数据；但 Hyperliquid 全链上公开透明，缺少"对刷/快速反向"这类需要私有撮合数据才能判断的异常，本版不做等价筛查，也认为不必要。
- 金库业绩窗口数值取自官方快照的末尾点（不是时间序列均值也不是精确时间戳配对），个人交易员的窗口数值是官方口径的滚动窗口，彼此重叠。
- 所有门槛阈值（$20,000、12小时、34%、±30%等）为经验取值，未回测；见上一节。
