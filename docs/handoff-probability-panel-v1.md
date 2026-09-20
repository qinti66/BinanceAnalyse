# 开发交接文档：结构化特征库 + 校准概率研判面板

> **给接手的开发会话**：本文假设你没有任何先前上下文。所有"已核实"的事实都是架构会话实测过的，**可以直接采信，不需要重新探查**（每条都标了出处）。凡是标"待确认"的，必须先问用户，不要自己拍板。
>
> 架构由另一个会话负责。你在阶段边界回报，架构会话会复核。**不要一次做完所有阶段。**

---

## 一、任务目标

在 `/indicators` 页新增一个"概率研判"面板，形态对标同类工具：

- 做多可行性 / 做空可行性 / 开仓风险 三条进度条
- 形态多分类概率分布
- 方向多分类概率分布
- 挤压风险标签 + 置信度

**但本项目的硬要求是：这些数字必须是经过回测校准的概率，不是拍脑袋的规则权重。** 用户明确拒绝了"显示规则权重"的方案。这是整个项目最重要的约束，下面所有设计都围绕它。

最终目的是提高"早期币"（尚未启动、正在蓄势）的发现胜率。

### 展示约定（从对标工具反推，已验证）

标题处的数字不是最高类概率，而是归一化置信度：

```
confidence = (p_max − 1/K) / (1 − 1/K)      K = 类别数
```

验证：形态 (0.60−0.25)/0.75 = 0.467 ≈ 显示的 0.46；方向 (0.55−0.333)/0.667 = 0.325 ≈ 显示的 0.32。两处都吻合。本项目沿用同一约定。

---

## 二、已经定死的决策（不要重新讨论）

### 用户已决策

| # | 决策 | 含义 |
|---|---|---|
| 1 | **必须是校准概率**，不是规则权重 | 没有校准就不显示概率，显示"校准不足" |
| 2 | **现在就从币安历史接口回填**做校准 | 不等攒几周快照 |
| 3 | 预测窗口 **4h + 24h** | 两个头，短线导向 |
| 4 | 多周期 K 线**分层采集** | 全部币种保留 1h；只给入选币种补采细周期 |
| 5 | 新面板与现有"综合参数分析"**并存**，不替换 | `DirectionDetail` 保留 |
| 6 | 用户是**短线交易者** | 细周期（5m/15m/30m）有实际价值 |
| 7 | ~~融合七套体系~~ → **用户 2026-09-20 澄清：七套只是参考，要的是最优组合，不是全都用上** | 见第六节。**七套里只保留 3 项，其余全部砍掉** |
| 8 | **从现在开始持久化 OI / 多空比历史**（用户已批准） | 币安只保留 30 天，要能校准这类特征只能自己攒。见第六节末 |

### 架构已决策

| # | 决策 | 理由 |
|---|---|---|
| A1 | **结构分析走 `earlySignal.ts` 模式**（在 `buildIndicators` 里算，只把结果存进快照），**不走 `direction.ts` 模式**（客户端 `useMemo`） | 结构分析需要 7 周期 × 360 根 × 6 列 ≈ 15k 浮点数/币。客户端算就得下发这些数据，体积爆炸；且概率打分要加载校准产物，放构建期更干净 |
| A2 | **OHLCV 永不下发给浏览器** | 同上。重序列只在分析阶段存在，像 `earlyInputs` 一样被剔除 |
| A3 | **`toBars()` 是 kline→Bar 的唯一入口**，训练脚本和线上分析都必须调它 | 这是防 train/serve skew 的机械保证，不能靠自律 |
| A4 | 形态分类用 **6 类**（5 类 + 混合兜底） | 用户给的 4 类不构成划分（"冲高回落"缺对称的看涨反转）。用户对类别选择表示"无偏好"，由架构决定 |
| A5 | **谐波排最后（P6），仅作展示标签，不进概率模型** | 全表证据最弱，且对 ZigZag 阈值超敏感 |
| A6 | 特征表**训练前定稿并进 git** | 多重检验控制 |
| A7 | 质量门槛**写在代码里**，不是写在文档里靠自觉 | 见 P3 |
| A8 | 模型只吃**去重后的核心特征集**，七个模块的输出降级为人可读证据 | 见第六节"结构性观察" |

### 用户已确认（2026-09-20，已定，不要再问）

| # | 问题 | **用户决定** |
|---|---|---|
| Q1 | 模型 B（OI / 多空比类特征）v1 是否产出概率 | **接受不产概率**。这类特征只做文字读数，等 P7 前向样本攒够再评估 |
| Q2 | 是否删除 `coins[].chart` / `contracts[].chart` / `contracts[].oiChart`（实测占快照 66.6%，零消费端） | **删除**。放在 P0 的独立 commit 里，便于单独回滚。原始数据在 `data/indicators/<id>/` 完整保留，随时可重新生成 |
| Q3 | 校准回填规模 | **按架构建议**：约 120 币 × 1–2 年 1h。预估 6 分钟、50–100MB 磁盘。币种选择 = BTC/ETH/SOL 锚定币 + 按 24h 成交额补齐，并记录选择规则到产物里（幸存者偏差已知且不可修复，见第八节第 8 条） |

---

## 三、已核实的代码现状（不要重新探查）

### 3.1 致命现状：快照里没有任何 OHLC

`lib/indicators/model.ts` 的 `contractMetrics()` 作用域内有完整的 360 根 1h OHLCV，但：

- `k[2]`(high) / `k[3]`(low) **全仓库只在第 59 行算 `trs` 时用过一次**，是局部变量，从不进入返回值
- `k[1]`(open) **从头到尾没有任何代码读取过**
- 发给前端的价格信息只有 `chart` = 48 个 `{time, price}` 点（price 就是 close）
- `earlyInputs` 里的 360 点序列被 `withoutEarlyInputs` 剔除（注释写明为控制体积）

**结论：SMC / 缠论 / Wyckoff / 形态识别 全部依赖 K 线结构，现在一根完整 K 线都拿不到。这是必须先修的地基（P0）。**

### 3.2 K 线列索引（UM / CM 不同，极易搞错）

`raw.klines` 每行 12 列：

| 索引 | 含义 | 当前是否被读 |
|---|---|---|
| k[0] | openTime | 排序 + 连续性检查 |
| k[1] | **open** | **从未被读** |
| k[2] | **high** | 仅第 59 行 `trs` |
| k[3] | **low** | 仅第 59 行 `trs` |
| k[4] | close | `close` / `chart` / 过滤条件 |
| k[5] | volume（UM=base 量；**CM=合约张数**） | `candleFlow` CM 分支的 total |
| k[6] | closeTime | 过滤、连续性、`chart[].time` |
| k[7] | quoteAssetVolume（**UM=报价额**；CM=base 量） | `candleFlow` UM 分支的 total |
| k[8] | numTrades | `avgTradeSizeSeries` |
| k[9] | takerBuyVolume（CM 张数） | `candleFlow` CM 分支的 buy |
| k[10] | takerBuyQuoteVolume（UM 报价额） | `candleFlow` UM 分支的 buy |
| k[11] | ignore | 未用 |

`candleFlow()`（第 30–35 行）的换算，**必须原样复用，不要重写**：

```
UM: total = k[7],  buy = k[10], fx = quoteUsd
CM: total = k[5],  buy = k[9],  fx = contractSize
返回 {inflow, outflow, net, total} 全部单位为 USD
```

⚠️ **单位陷阱**：`close` 是**原始报价单位**（含 1000x 等乘数，CM 是 USD/张）；对外的 `price` = `last*fx/multiplier`。两者口径不同，结构分析用哪个要想清楚（建议：结构分析全程用原始 close，因为形态只关心相对关系；但跨币比较必须用归一后的）。

### 3.3 `k` 的构造与连续性

```ts
const k = (raw.klines??[])
  .filter(k => Number(k[6]) < cutoff && Number(k[6]) >= Number(k[0]) && positive(k[4]) !== null)
  .sort((a,b) => Number(a[0]) - Number(b[0]));          // 最旧在前
const contiguous = k.length>0
  && Number(k.at(-1)?.[6]) === cutoff-1
  && k.every((x,i) => i===0 || Number(x[0])-Number(k[i-1][0]) === HOUR);
```

实测：601/603 个合约有 360 根，另 2 个 305/306 根；603/603 全部 `contiguous:true`。

### 3.4 其它已核实事实

| 事实 | 出处 |
|---|---|
| `ratioPoints`（第 84–85 行）只取 `longShortRatio`，**丢弃了 `longAccount` / `shortAccount`** | model.ts:84 |
| 同上，用 `raw.topAccountRatio ?? raw.topPositionRatio` —— **`??` 意味着"按仓位"的那套几乎永远用不上**，而它和"按人头"信息量完全不同 | model.ts:87 |
| `raw.ticker`（含 24h highPrice/lowPrice/quoteVolume/count）已采集但 **`contractMetrics` 一次都没读过** | 零成本可用的 24h 高低价 |
| `earlySignal` 的调用模式：`computeEarlySignal(rep.earlyInputs, {oi4,p4,netRatio4h})` 在 `buildIndicators` 里，结果存快照 | **这是新功能要照抄的模式** |
| `direction.ts` 是纯函数，在 `page.tsx` 的 `useMemo` 里**客户端**调用，不在构建期 | 新功能**不要**学这个 |
| coin 对象 37 个键；`contracts[]` 36 个键（= 合约级全部字段减 `earlyInputs`） | `withoutEarlyInputs` 只剔除一个字段 |
| `oiQtyHourly` 只有 **6 个点**（`openInterestHist` 当前 `limit=25`，够不到 72h） | model.ts:82 |
| `topRatioSeries`/`globalRatioSeries` 各 **48 点 = 48 小时** | 采集端 `limit=48` |
| 实测 526 coin：`candidate=31`、`liquid=218`、**`earlyCandidate=0`** | 而 `page.tsx` 的 `onlyEarly` 默认 `true` ⇒ **页面默认状态表格是空的**。这是"手调阈值会退化成恒假"的活证据 |

### 3.5 体积实测（架构会话亲自测过）

| 项 | 大小 |
|---|---|
| 完整快照 `public/indicators/latest.json` | **4.48 MB** |
| `coins[].chart` | 0.94 MB |
| `contracts[].chart` | 1.08 MB |
| `contracts[].oiChart` | 0.96 MB |
| **三者合计** | **2.99 MB = 66.6%** |

`grep -rn "\.chart\b\|oiChart" app lib scripts components` 的结果：**只有 `model.ts:97` 和 `model.ts:174` 两处生产端，零消费端。**

⇒ 体积不是被有用数据占满的，是被三个没人读的字段占满的。这让"降采样 / 定点数压缩 / 分离文件"从必答题变成可选优化。见 Q2。

---

## 四、已核实的外部接口事实

### 4.1 币安限制（已实测/查证）

| 接口族 | 限制 |
|---|---|
| `/futures/data/*`（openInterestHist、各类多空比） | period 支持 5m/15m/30m/1h/2h/4h/6h/12h/1d；limit 默认 30、**最大 500**；**只保留最近 30 天**；权重 0 但 **IP 限额 1000 请求 / 5 分钟（≈200/分钟）** |
| `/fapi/v1/klines` | **不在上面那个族里**，走按 weight 计费的行情族（UM 2400 weight/min）。支持 `endTime` 分页回溯，**历史可到上市日（数年）** |
| `/fapi/v1/fundingRate` | 资金费率历史，**可回填到上市日（数年）**。当前**完全没有采集** |

### 4.2 由此得出的关键推论

**"多周期 K 线"其实是便宜的那部分；真正贵的是多周期 `/futures/data/`。**

分层策略应该围绕"限制 `/futures/data/` 的周期扩展"设计，而不是限制 klines。全量 603 币 × 6 个周期的 `/futures/data/` = 3618 次请求，会把配额打爆 3 倍，**严禁**。

### 4.3 既有 bug：当前采集已超配额

`collect-indicators.mjs` 每合约 6 个请求里有 **4 个属于 `/futures/data/`**（openInterestHist + 三个多空比）。全局节流 170ms ⇒ ≈353 req/min，其中 4/6 ≈ **235 req/min 落在该族，超过 200/min 上限约 18%**。

今天没被封可能是滑动窗口宽松，但这是既有隐患，**多周期扩展之前必须先修**（P2）。

### 4.4 深度历史的关键不对称（决定整个校准设计）

| 数据 | 可回填深度 | 后果 |
|---|---|---|
| klines（OHLCV） | **数年** | 价格结构特征可在多个市场区间上校准 |
| fundingRate | **数年** | **唯一能深度回填的持仓类数据** |
| openInterestHist | **仅 30 天** | OI 特征只有单一区间 |
| `*LongShortRatio` | **仅 30 天** | 多空比特征只有单一区间 |

⇒ **拆成两个模型**：

- **模型 A**（价格 + 资金费率，深历史）：v1 **只上线这个模型的概率**
- **模型 B**（含 OI / 多空比，30 天）：v1 **不产概率**，其特征只作"结构证据"文字读数

这不是靠声明化解区间偏差，是**把受影响的特征隔离出概率输出**。见 Q1。

### 4.5 ⚠️ 操作陷阱：本机到币安的网络路径（2026-09-20 重写，旧结论已作废）

**旧记录说"curl 会 451、Node 直连正常"，现在是反的。**旧结论把"美国出口会 451"误记成了"代理会 451"。

当前事实：

| 路径 | 结果 |
|---|---|
| **直连**（Node `fetch` 默认） | **不可用**：DNS 被污染 + **SNI 过滤** |
| **经本机代理，美国出口** | **HTTP 451**（币安地域政策） |
| **经本机代理，日本出口** | ✅ **HTTP 200**，实测返回真实数据 |

**SNI 过滤的决定性证据**（同 IP 换 servername）：

| IP | SNI | 结果 |
|---|---|---|
| 18.155.192.89 | `fapi.binance.com` | ECONNRESET |
| **18.155.192.89** | `data.binance.vision` | **OK**, `*.binance.vision`, authorized |

同一个 IP、同一条 TCP 路径，只换 TLS 握手里的服务器名，一个被重置一个正常。**所以改 DNS 无效**——污染只是同一套机制的表层。（`www.google.com` 同样被污染，是全局的，非针对币安。）

**诊断方法论**：网络层超时时先分层验证 **DNS → TCP → TLS → HTTP**。TCP 握手成功**不能**证明应用层可用——架构会话就是只测了 TCP 就下了错误结论。

**代码要求**：采集器显式读 `HTTPS_PROXY`（Node 的 `fetch` 不自动读，是 Node 的特例）——有则走代理，无则直连。**不得把代理写死**，部署到服务器时不设该变量即自动直连。

### 4.6 数据通道授权（2026-09-21，用户批准）

**`data.binance.vision`（币安官方公开历史归档）已获用户授权为长期数据通道。**

分工：

| 通道 | 职责 | 理由 |
|---|---|---|
| **归档源** | **多年历史回填**（训练/校准） | 不打 API、不占限速配额、带 SHA256 校验、按月打包。历史回填正是请求量最大、最容易触发 WAF 的部分 |
| **API** | 线上每轮的少量请求 | 归档源不适用于实时数据；线上量级不易触发 WAF |

⚠️ **架构层授权 ≠ 执行层权限。**每条下载命令仍需用户在开发会话里逐条批准（或选"始终允许"）。架构会话与开发会话都无权代批。

⚠️ **API 线上的 403/451/418/429 规则一条不改**：遇到就停，不绕、不换节点重试。

背景：2026-09-20 的资金费率回填在第 126、308 个币处各遇一次 WAF 403（HTML 拦截页，非 JSON 错误），节奏仅 1.25 req/s、远低于官方限额，判断为共享出口 IP 上的 WAF 启发式。已彻底停手，未摸阈值。

---

🚫 **硬性边界**：**任何路径上币安返回 451 ⇒ 立即停止，不得更换节点重试直至放行。**
451 是币安自己的地域政策，绕过它是规避服务方的决定；修复本机网络路径只是恢复币安已经愿意提供的服务。二者不同。
同样禁止：改 SNI、域前置、ECH 等规避本机网络过滤的手段——那属于用户的网络选择，不该写进产品。

---

## 五、项目约定（必须遵守）

| 方面 | 约定 |
|---|---|
| **核心原则** | **缺失就是缺失，绝不按 0 填充**。所有启发式标注"未回测"。不给买卖指令 |
| 代码风格 | `lib/indicators/*.ts` 是极度压缩的单行风格（无空格、单空格缩进）。**新建文件可以用正常风格**，但改动既有文件时保持原风格 |
| 纯函数 | 分析逻辑必须是纯函数、无 I/O、不读 `Date.now()`（时间从参数传入），便于单测 |
| 测试 | `scripts/test-*.mjs`，`node --test` 运行。`.mjs` 直接 `import {...} from "../lib/xxx.ts"`（Node 类型擦除，**必须带 `.ts` 后缀**）。fixture 用工厂箭头函数 `const fixture=()=>({...})` 支持 `...o` 覆盖 |
| 测试惯例 | **第一个测试永远是 "missing inputs stay missing, never zero"** |
| 文档 | `docs/*-v1.md`，中文，结尾固定 `## 未回测声明` 章节 |
| TS 陷阱 | Node 类型擦除**不支持构造函数参数属性简写**（`constructor(public x)`），必须手动赋值。之前踩过这个坑 |
| 提交 | 除非用户明确要求，不要自己 commit |

---

## 六、最优组合（架构结论，直接执行）

> **2026-09-20 用户澄清**：七套体系只是参考方向，要的是**一个最优组合，不是全部用上**。
> 下面的取舍已定，不要自行加回被砍掉的部分。

### 6.1 取舍原则

按**机制**选特征，不按流行程度选。"早期启动痕迹"在永续市场里是一个具体的物理现象：有人要在价格启动前建仓，又不想推高价格，只能被动吃单慢慢吸收卖盘。这个行为**必然**留下一组副作用：

| 机制 | 必然的可观测副作用 | 我们能否观测 |
|---|---|---|
| 在建仓但不想推价 | **持仓量上升，价格不动** | 能（OI vs 价格） |
| 用被动单而非主动扫货 | **资金费率保持中性** | 能（费率相对自身基线） |
| 吸收别人的卖盘 | **主动卖量不小但价格不跌** | 能（effort vs result） |
| 吸收压制了波动 | 波动率压缩、成交量枯竭 | 能 |
| 建仓末期拿最后筹码 | **扫掉区间下方止损后收回** | 能（需 OHLC，P0 解锁） |
| 独立于大盘在买 | **大盘跌它扛住** | 能（526 币横截面） |
| 谁在建仓 | 顶级账户 vs 散户持仓分歧 | 能（**唯一直接观测"是谁"的数据**） |
| 冰山单 / 真实挂单 | — | **不能**（需订单簿深度，未采集） |
| 链上钱包建仓 | — | **不能**（另一套数据源） |

**核心判断：七套体系测的几乎都是价格结构，而价格结构恰恰是"早期"信息最稀薄的地方——一旦在价格结构上看得见，动作就已经开始了。真正早的信息在持仓数据和横截面对比里。**

### 6.2 七套里只保留 3 项

| 保留 | 形式 | 理由 |
|---|---|---|
| **流动性扫荡 / Spring** | 一个特征（**SMC 和 Wyckoff 是同一个东西，只算一次**） | 建仓末期扫止损拿筹码，机制最硬 |
| **趋势状态（道氏 / BOS）** | **仅作排除过滤器** | "已经走出来了就别再叫它早期"。当早期触发器用是自相矛盾 |
| **Effort vs result（Wyckoff）** | 一个特征 | 主动卖量大但价格不跌 = 有人在吸。**它是 OI 信号在价格/成交量上的影子**，这一点很重要（见 6.4） |

可选加项（**仅当 P1 的摆动点原语做完后几乎免费**才做）：EQH/EQL（止损簇位置）、premium/discount（区间内位置）。

### 6.3 砍掉的，以及理由（不要加回来）

| 砍掉 | 理由 |
|---|---|
| **自动谐波（全部）** | 对"检测建仓行为"没有任何机制，纯几何。证据基础也最弱 |
| **形态识别（全部）** | 测的是盘整，与波动压缩完全重复，却多了一层主观几何拟合 |
| **缠论（全部）** | 中枢定义确实比 ATR 百分位严谨，但测的**还是盘整**——价值在定义严谨，不在新增信息；而实现成本全场最高（含线段流派分歧）。用 P1 的摆动点做区间检测可拿 90% 价值、花 10% 成本。**⚠️ 因此 P1 不要建 `chanBars.ts`（包含处理是缠论专用）** |
| **ICT killzone / OTE** | killzone 是外汇时段逻辑，加密 7×24 不适用；OTE 是入场时机，不是早期发现 |
| **ICT SMT 背离** | 与横截面相对强度高度重叠，后者更简单直接 |
| **SMC 的 FVG / Order Block** | 这两个标记的是**快速推进后**的失衡区——安静吸筹期根本不该出现 FVG。属于启动**之后**的入场区概念 |
| **Wyckoff 阶段标注** | 基本不可证伪，任何区间事后都能贴标签。其可量化的部分已化入上面两个特征 |

⇒ 严格说，**Wyckoff 作为一个模块不再存在**；它有用的部分变成了两个本来就要做的特征。这就是去重的实际效果。

### 6.4 最优特征集（约 18 个，覆盖 7 个互不重复的维度）

| 维度 | 特征 | 深度可校准？ |
|---|---|---|
| **A 建仓行为** | A1 `oiChange4h/24h`；A2 OI↑与价格不动的**显式交互项**；A3 **`fundingZ` = 费率相对自身尾随基线的偏离**；A4 安静建仓标志（OI↑ ∧ \|fundingZ\| 小） | A3/A4 ✅（费率可回填数年）<br>A1/A2 ❌（OI 仅 30 天） |
| **B 谁在建仓** | B1 顶级账户比（**按人头**）百分位；B2 顶级账户比（**按仓位**）百分位 —— **B1/B2 必须分开，信息量不同**；B3 聪明钱−散户分歧 | ❌ 仅 30 天 |
| **C 吸收** | C1 `effortVsResult` = z(成交额) − z(振幅/ATR)；C2 主动卖被吸收（显式交互项） | ✅ 全来自 K 线 |
| **D 蓄势** | D1 `volSqueezePct`（已有）；D2 **`volumeDryUpPct`**（成交额相对自身尾随历史的百分位）；D3 压缩持续时长 | ✅ |
| **E 横截面** | E1 相对 BTC 强度（多窗口）；E2 相对全市场中位数；E3 收益排名百分位 | ✅ |
| **F 结构** | F1 扫荡后收回（深度 + 距今）；F2 趋势状态（分类，作条件/排除）；F3 到止损簇距离（可选） | ✅ |
| **G 环境** | G1 市场宽度（% 币在 EMA60 上）；G2 BTC 已实现波动率分位 | ✅ |

**重要结论：18 个里有 13 个可深度校准（C/D/E/F/G + A3/A4）。**只有 OI 和多空比那 5 个受 30 天限制。

原因值得记住：**effort vs result 是 OI 信号在价格/成交量上的影子**——有人在吸筹，即使看不到持仓数据，也会在"量大但价格不动"上留下痕迹。所以 v1 的校准模型不是残缺版。

模型仍须遵守：特征数 ≤ 30、相关性剪枝（\|ρ\|>0.8 只留一个）、VIF>5 报警。

### 6.5 持久化 OI / 多空比历史（用户已批准，从 P2 起生效）

B 组和 A1/A2 无法深度校准，唯一解是**自己攒**。从 P2 开始，每轮采集都要把 `openInterestHist` 与三套多空比的原始点**追加持久化**（按 symbol + timestamp 去重），目标是两三个月后能训练模型 B。

⚠️ 本项目一贯坚持"无定时任务、只手动触发"。要攒出连续历史就需要采集**足够频繁**。这是个真实的设计冲突，**不要自行引入调度器**——如实回报给架构会话，由用户决定。

### 6.6 一条来自市场研究的具体改进

研究指出：**OI 上升而资金费率保持中性**往往先于方向性突破（安静建仓、不推高溢价）；**OI 上升 + 费率极端**则是拥挤、易挤压。

现状缺陷：我们只把极端费率当**折扣项**（`fundingLag >= 0.08` 时 earlyScore × 0.85），没有把"OI↑且费率中性"当成**独立的正向状态**；而且用的是**绝对阈值**，而同一个费率对 BTC 和对某个小币含义完全不同 ⇒ 必须改成**相对该币自身尾随基线**（即 A3 的 `fundingZ`）。

## 七、分阶段任务

> **P0–P3 是地基，缺一不可。P4 以后是增量。**
> **关键排序理由**：P3（校准管线 + 门槛）必须在 P4（堆结构指标）之前。否则你会面对几百个高度共线的特征、一次多重检验灾难、且没有基线可比。先把最便宜的横截面+持仓特征跑通管线，之后每加一批结构特征都能回答一个具体问题："它把 Brier 技能分提升了多少？"
>
> **面板在 P3 末尾就上线**，可能以"校准不足 · 仅显示结构证据"状态呈现。这符合项目一贯原则，也避免"等全做完才看得见东西"。

### P0 · 体积回收 + OHLCV 出口 【地基】

**改动**
1. 新建 `lib/structure/types.ts`：`Bar` 接口
   ```ts
   export interface Bar {
     t: number;    // openTime
     ct: number;   // closeTime
     o: number; h: number; l: number; c: number;
     v: number;              // 基础单位量（UM=base，CM=张数）
     qvUsd: number | null;   // USD 成交额，family 归一后
     takerBuyUsd: number | null;
     trades: number | null;
   }
   ```
2. 新建 `lib/structure/bars.ts`：
   ```ts
   export function toBars(
     klines: unknown[][], family: "UM"|"CM",
     quoteUsd: number|null, contractSize: number|null,
     cutoff: number, intervalMs: number
   ): { bars: Bar[]; contiguous: boolean; coverage: number };
   ```
   - **必须复用 `candleFlow` 的 family 列索引逻辑**（见 3.2），不要重写换算
   - **必须沿用现有的过滤与连续性语义**（见 3.3）
   - 这是 kline→Bar 的**唯一入口**（决策 A3）
3. `lib/indicators/model.ts`：
   - `contractMetrics` 里 `k` 改为经 `toBars()` 得到；`close`/`trs`/`flowAt` 全部从 `bars` 派生。**这是纯重构，行为必须等价**
   - 新增 `bars` 到 `earlyInputs` 的兄弟位置（建议新字段 `analysisInputs`），由同款解构剔除，**不进快照**
   - `ratioPoints` 保留 `longAccount`/`shortAccount`，并**区分 account / position 两族**（不要再用 `??` 合并）
   - 开始读取 `raw.ticker` 的 24h 高低价
   - **若 Q2 获批**：删除 `chart` / `oiChart`（单独 commit）

**验收**
- `node --test scripts/test-indicators.mjs scripts/test-early-signal.mjs scripts/test-indicator-direction.mjs scripts/test-cross-validation.mjs` 全绿
- 重跑 `node scripts/analyze-indicators.mjs`，**逐字段 diff 新旧 `latest.json`**（除有意删除的字段外必须完全一致）——这是"纯重构"的证明
- 打印一个币的 `bars` 首尾值，人工核对与 `data/indicators/<id>/UM-XXX.json` 的原始 kline 一致
- 若删字段：体积应从 4.48MB → 约 1.5MB；页面视觉零变化

### P1 · 底层原语 + 前视守卫 【地基】

**新建 `lib/structure/`**：`atr.ts` · `swings.ts` · `levels.ts` · `ranges.ts`

⚠️ **不要建 `chanBars.ts`**（缠论包含处理）和 `sessions.ts`（killzone）—— 缠论与 ICT killzone 已被砍掉，见第六节。`ranges.ts` 用摆动点做区间检测，替代缠论中枢的作用。

关键签名与设计要点：

```ts
export function atrSeries(bars: Bar[], period = 14): (number|null)[];
// 复用 model.ts:59 已有的 trs 定义保持一致。前 period-1 根返回 null，不按 0 填

export function fractals(bars: Bar[], k = 2): Swing[];
// Williams k-bar 分型。⚠️ swing 在 i+k 根之后才"确认"
// Swing 必须带 confirmedIndex 字段

export function zigzag(bars: Bar[], opts: {mode:"atr"|"pct"; mult?:number; pct?:number}): Swing[];
// ATR 自适应阈值逐根变化。⚠️ 最后一段永远未确认，必须剔除

export function detectRange(bars: Bar[], swings: Swing[], opts): Range | null;
// 用摆动点聚类出区间上下沿（止损簇所在）。替代缠论中枢，
// 供 F1 扫荡检测与 D3 压缩时长使用
```

统一的发现类型：

```ts
export interface Finding<M = unknown> {
  kind: string;
  startIndex: number; endIndex: number;
  startTime: number; endTime: number;
  priceHigh: number; priceLow: number;
  confirmedIndex: number;        // 何时可知 —— 前视守卫的关键字段
  strength: number | null;
  meta: M;
}
export interface StructureResult {
  version: string;
  params: Readonly<Record<string, number|string>>;  // 参数快照，进产物，可复现
  findings: Finding[];
  coverage: number;
  unavailable: string[];         // 哪些检测因数据不足没跑，不按"未触发"处理
}
```

**两个必须有的守卫测试**（它们是整个方案能不能信的分水岭）：

```js
test("prefix invariance: features at index i never see bars after i", () => {
  // 对多个 i，断言 f(allBars.slice(0,i+1), i) === f(allBars, i)
});
test("swing confirmation lag is respected", () => {
  // 把 i 之后的 bar 全换成随机值，断言 index<=i 的 Finding 集合不变
});
```

**验收**：`node --test scripts/test-structure.mjs` 全绿，含上述两个守卫测试 + "missing inputs stay missing, never zero"

### P2 · 分层采集 + 权重感知限速 + 历史回填 【地基】

1. 新建 `scripts/rate-limit.mjs`：按**族**独立的滑动窗口 token bucket
   ```
   futuresData: 900 / 5min   （官方 1000，留 10% 余量）
   umMarket:    2000 weight/min（官方 2400）
   cmMarket:    2000 weight/min
   spot:        1000 / min
   ```
   - 读 `X-MBX-USED-WEIGHT-1M` 响应头做反馈：超桶上限 80% 时发放速率折半，低于 50% 恢复
   - klines weight 按 limit 阶梯（≤100→1，≤500→2，≤1000→5，>1000→10）
   - **418/429 保持现状：不绕过，全局 blockedUntil，418 直接中止**
   - 接入后 tier A 节奏自动降到 ≤180/min，全量采集 ~10min → ~13–14min。**这是修既有 bug 必须付的代价**

2. **全币种新增 4h K 线采集**（`collect-indicators.mjs` 主循环里加一个请求，limit=360）
   - 理由见 `docs/feature-spec-v1.md` 2.2：线上只有 360 根 1h，聚合成 4h 仅 90 根，不足以支撑 336 根百分位窗口（违反 R5）
   - 直接采 4h 比加深 1h 便宜一个数量级：磁盘 +25% vs +300%，且多拿 60 天历史、1d 可免费聚合
   - 4h 走**便宜的行情族**（weight 计费），不碰 `/futures/data/` 的 200 请求/分钟紧张配额
   - ⚠️ **必做对账测试**：用 1h 聚合出的 4h 与币安直接返回的 4h **逐根比对**，必须完全一致。不一致 = 时区对齐或聚合边界有 bug，这类 bug 静默但会让训练与线上算出不同的东西

3. 新建 `scripts/collect-indicators-deep.mjs`（独立脚本，不改主循环——主采集要跑 13 分钟，deep 失败时不该重跑它）
   - tier B 名单 = 并集：`anchor`（BTC/ETH/SOL，**强制**，SMT 跨品种背离和横截面相对强度都需要锚）+ `carryover`（上一轮快照里 candidate/earlyCandidate 的币）+ `candidate`（本轮观察名单）+ `volume`（成交额补齐到 60）
   - 每币：6 个细周期 klines（行情族，便宜）+ fundingRate + **仅 1 次** `/futures/data/openInterestHist`
   - **`/futures/data/` 只 +60 次请求。严禁扩展到全量。**

4. 回填脚本：`scripts/backfill-klines.mjs` · `scripts/backfill-funding.mjs`
   - 按 `endTime` 分页回溯；产物写 `data/calibration/`
   - **`.gitignore` 必须加 `data/calibration/`**（`data/` 当前未被忽略，已有 138MB 跟踪文件，不加会把仓库搞崩）

5. `scripts/update-indicators.mjs` 的 launch 序列插入 deep 步骤；`scripts/indicator-service.mjs` 的 phase 映射加 `"deep"` 分支

**验收**
- deep 跑完统计 `/futures/data/` 实际速率 **< 180/min**，`X-MBX-USED-WEIGHT-1M` 峰值 < 80%
- **对账测试**：用回填的 klines 重算某个 cutoff 的特征向量，断言与线上路径**逐元素相等**（容差 1e-9）。这条直接杀死 train/serve skew

### P3 · 标签 + 校准 + 质量门槛 【地基，胜率的真正来源】

**标签定义**（`lib/indicators/labels.ts`，训练与前向评分**共用同一份实现**）

- **方向头（3 类）**：三重壁垒。t 根收盘进场，上壁垒 `+barrierAtr×ATR + costPct`，下壁垒对称，垂直壁垒 `horizonBars`。用后续 bar 的 **high/low** 判定先触（正好用上 P0 导出的 OHLC）
- **形态头（6 类）**：多头趋势 / 空头趋势 / 冲高回落 / 杀跌反弹 / 震荡无方向 / 混合兜底。判据用 ATR 单位的 `ret` / `mfe` / `mae`
- **开仓风险头（二分类）**：`P(MAE ≥ riskAtr×ATR 先于有利方向触及)`。⚠️ **它的分母和方向头不同，UI 必须视觉分隔**，否则"0.36 / 0.36 / 0.93"会被读成三个可比的数
- **挤压头**：`P(|ret| ≥ 2×ATR)`，条件于低波动 + 高 oiCapPct/费率状态
- ⚠️ **`costPct` 必须是净值**：taker 0.05%×2 + 该币实测 `spreadBps/1e4` + 滑点余量。往返轻松 0.2–0.3%，一个"预期 0.6% 的 4h 移动"在纸面有 edge、在账户里没有
- 前瞻窗口不完整 ⇒ 返回 `null`，**不按 0 / 中性填充**

**切分：purged walk-forward + embargo**

```
折 k：训练 [0, T_k] → purge → embargo → 测试 (T_k+E, T_{k+1}]
```
- **Purge**：剔除训练集里标签窗口与测试起点重叠的样本
- **Embargo**：`E = horizonBars + 24`（h24 ⇒ 48 小时）
- **按时间分折，不按币种分折**（同一时刻不同币高度相关，按币种分折等于把同一信息同时放进训练和测试）

**重叠标签**（h24 下相邻两小时共享 23/24 标签窗口，名义百万样本的有效独立样本可能只有几千）
1. **唯一度加权**：标签窗口被多少样本共享，取倒数平均作 `weight`，加权损失
2. **评估时子采样**：每 `horizonBars` 取一个，并**遍历全部相位偏移**分别评估，报告分布而非单次
3. **禁止 iid 标准误**，用块自举（块长 ≥ 2×horizon）

**模型**：L2 正则多项 logistic，**特征数 ≤ 30，不用梯度提升**（有效样本几千，树模型必过拟合；且线性模型系数是个小 JSON，可入 git、在 Worker 里零依赖运行）。校准器用 **isotonic regression**（袋外预测上拟合）

**评估指标**：多分类 Brier、**Brier 技能分（基线 = 训练折的类别基础频率，不是 1/3）**、ECE/MCE（10 等频桶，每桶 ≥50 样本）、可靠性曲线、AUC（**仅辅助——AUC 好但校准差的模型不允许显示概率**）、**残差版 BSS**（用 `symbol_ret − β×BTC_ret` 重跑；若 ≈0 说明模型只是在预测大盘，不是在选币）

**质量门槛（写进代码）**

```ts
export const CALIBRATION_GATE = {
  minEffectiveN: 2000,      // 唯一度加权后
  minFolds: 3,
  minFoldBss: 0.02,         // 每一折都要过，不是合并后过
  minPooledBss: 0.03,
  maxEce: 0.05,
  minTestSpanDays: 60,
  minRegimes: 2,
  minFeatureCoverage: 0.8,
  maxArtifactAgeDays: 45,
  maxFeaturePsi: 0.25,      // 线上特征分布 vs 训练分布漂移
} as const;
```

**任一条不过 ⇒ `probability = null` + `calibrationState`，UI 显示"校准不足 · 仅显示结构证据"，不画进度条。门槛按每个头独立判定。**

**多重检验控制**
1. 特征表 `lib/indicators/features/registry.ts` **看标签之前定稿**，改动进 git 记录
2. **随机特征基线**：同样数量的随机特征训同样模型跑 N=100 次，取 BSS 的 95 分位作"运气门槛"，真实模型必须超过它
3. **试验台账** `docs/calibration-log-v1.md`：记录**每一次**跑过的配置及其 BSS，**包括失败的**。不记录失败次数的回测报告不可信
4. 最终留出折**只碰一次**，碰完冻结

**验收**
- `evaluate-calibration.mjs` 输出：逐折 BSS、ECE、可靠性曲线、随机特征基线分位、残差版 BSS
- **泄漏对照实验**：故意打乱标签跑一次，**如果打乱后指标没有显著变差，说明管线有泄漏**
- `test-probability.mjs` 断言门槛函数在每条边界上正确拒绝
- **门槛不过 ⇒ 面板显示"校准不足"，这也算通过验收，不是失败**

### P4–P7 · 增量（每阶段完成后回报，等架构确认再继续）

| 阶段 | 内容 |
|---|---|
| P4 | 第六节 6.4 的 **C/D/E/G 四组特征**（吸收 / 蓄势 / 横截面 / 环境）——全部可深度校准，成本低。**每组加入后重跑 P3 评估，记录 ΔBSS 进台账**；共线性检查（\|ρ\|>0.8、VIF>5 报警） |
| P5 | **F 组结构特征**：扫荡后收回、趋势状态、（可选）EQH/EQL 与 premium/discount。这是七套体系里唯一保留进模型的部分 |
| P6 | **A/B 组持仓特征**：先只做文字读数不入概率（Q1 已定）；同时确认 6.5 的历史持久化已在运行、数据在累积 |
| P7 | UI 面板 + 前向验证闭环 + 漂移监控 |

**UI 要点**（P7）
- `app/indicators/probability-panel.tsx`，插在 `page.tsx` 的 `<DirectionDetail/>` 之后（约第 117 行）
- 分布条**复用 `app/square/square.css` 现成样式**：`.sq-bar`（10px 高 flex 圆角）内含多个 `<span style={{width:pct+"%"}}/>`，配 `.sq-bull-bar`/`.sq-neutral-bar`/`.sq-bear-bar` + `.sq-legend`。`page.tsx` 第 12 行已 import `square.css`
- `indicators.css` **没有任何进度条样式**，需新增少量 `.im-prob-*`
- 每个数字旁显示：模型版本、校准时间、**有效样本量、折数、Brier 技能分**
- 三条进度条**必须视觉分隔**（前两条共享分母，第三条是独立二分类）
- 表述框架用**"历史条件频率"**而不是"概率"，每处打印条件集大小（"历史上 N 个相似时点中"）。这比再加一句免责声明有用得多

---

## 八、必须避免的陷阱（按踩中可能性排序）

1. **摆动点确认延迟被忘记** —— ZigZag 最后一段、k-bar 分型最后 k 根偷看未来。**最常见的隐形前视偏差**
2. **百分位用了全样本而非尾随窗口** —— 任何对整条序列调用 `percentileRank` 的地方都是 bug
3. **折内调参然后报告折外指标**
4. **把七套共线体系的一致当成独立印证**（见 6.2）
5. **谐波因为"看起来很精确"被高估**
6. **train/serve skew** —— 历史路径从原始 kline 算特征，线上路径从 collector 对象算；fx 换算、contractSize、cutoff 语义任何一处不一致，线上喂给模型的就不是它训练时见过的东西。对策：唯一的 `toBars` + 对账测试
7. **成本吃掉 4h 级别的边际** —— 壁垒必须是净值
8. **幸存者偏差，且无法修复** —— `exchangeInfo` 只返回当前 TRADING 的 603 个合约，已下架的拿不到。只回填现存币种会系统性高估任何与"活下来"相关的特征。**这个偏差用现有数据无解，必须在文档和 UI 注脚里明说，不能藏**
9. **横截面不独立** —— 526 个币不是 526 个独立实验，全市场跟 BTC 走，有效宽度可能只有 5–15。残差版 BSS 是唯一的诚实检验
10. **参数蔓延** —— 七套 × 每套 3–10 个旋钮 = 数千种配置。训练前冻结进 `params` 常量并提交

### 最大的风险，一句话

**不可信的过程产出了可信外观的数字。** "0.36" 带两位小数读起来像科学。如果门槛是软的（写在文档里靠自觉），这就是主要失败模式。所以门槛写在代码里，不过门槛就不画条。

---

## 九、与架构会话的交互协议

1. **开工前**：先问用户 Q1 / Q2 / Q3 三个待确认问题
2. **每个阶段结束**：回报"做了什么 / 验收结果 / 遇到的意外 / 是否需要偏离计划"，等架构确认再进下一阶段
3. **任何要偏离本文档已定决策（第二节）的情况**：先说明理由，不要自行改变
4. **发现本文档的事实有误**：立刻指出。本文档的事实都经过实测，但实测是在特定时点做的，数据会变
5. **不确定时不要猜** —— 尤其是涉及"缺失怎么处理"的地方，本项目的答案永远是"保持缺失"

---

## 未回测声明

本文档描述的全部规则、阈值、特征与分级判断均**未经回测验证**。P3 之前不存在任何经验证据支持这些设计；P3 之后也只有在质量门槛通过的前提下，才能称其输出为"校准概率"，且仅限于校准数据覆盖的市场区间。

本项目的输出是研究性启发式排序，不是收益预测，不构成任何买卖建议。
