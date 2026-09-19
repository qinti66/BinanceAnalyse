# 指标模块 AI 解读 v1

按用户要求，AI 解读只接入**指标模块**（`/indicators`），不接入广场、带单或交叉验证模块。

## 定位

这不是一个新的信号，也不提高胜率——它只是把某个币种在页面上**已经展示给用户**的那份数据（价格/资金流/早期信号/方向研判等，详见 `lib/ai/indicator-analysis.ts` 的 `IndicatorAiPayload`），原样交给大模型重新组织成一段叙述，帮助更快读懂已有证据。它不产生用户在页面上看不到的信息，不参与观察名单、早期分或候选池的计算，输出也不进入交叉验证。

**为什么不会提高胜率**：大模型看到的和用户看到的是同一份数据，没有关于未来价格的额外信息；一段读起来流畅的 AI 叙述反而可能制造虚假的确信感——这是需要警惕的风险，不是收益来源。胜率要靠回测证明，这个项目目前没有回测数据，AI 解读同样没有、也不能绕过这一点。

## 使用方式

打开指标页，选中一个币种，滚动到详情区最下方的"AI 解读"卡片，点击"生成 AI 解读"（手动触发，不自动请求）。结果按币种缓存在页面内存里，切换币种来回看不会重复请求；点"重新生成"会再发一次请求。

## 在页面上添加并测试模型（推荐）

指标页底部有"AI 模型设置"卡片：选类型（Anthropic / OpenAI / DeepSeek / 本地 Ollama / 自定义 OpenAI 兼容）→ 填接口地址、模型名称、API Key → 先"先测试"再"添加"；列表里可以随时"测试连通"、"设为当前"、删除。测试会向模型发一条极小的请求（只让它回复 OK），显示是否连通、耗时和回复。

- 密钥只保存在你这个浏览器的 localStorage（明文），点击"AI 解读"时随请求经本机服务转发给模型厂商；服务端不记录、不落盘、不回显，错误信息里出现的密钥会被替换为 `***`。不要在公共电脑上保存密钥。
- 接口地址必须是 https；只有 localhost / 127.0.0.1 允许 http（用于本地 Ollama 等），且不允许 URL 里带账号密码。
- 没在页面添加模型时，才会回退到下面的服务端环境变量配置。"测试服务端默认配置"按钮可以检查它是否生效。
- 代码：`lib/ai/providers.ts`（两种协议的调用与校验，`scripts/test-ai-providers.mjs` 覆盖）、`lib/ai/config-store.ts`（浏览器端存储）、`app/indicators/ai-settings.tsx`（设置界面）、`app/api/ai/test-connection/route.ts`（连通测试）。

## 配置（服务端环境变量，可选）

1. 复制 `.dev.vars.example` 为 `.dev.vars`（已在 `.gitignore` 排除，不会被提交）。
2. 填入 `ANTHROPIC_API_KEY=你的密钥`；可选 `ANTHROPIC_MODEL`（默认 `claude-sonnet-5`，见 `lib/ai/providers.ts` 的 `DEFAULT_MODEL`）。
3. 重启 `npm run dev`。Wrangler/vinext 本地开发会自动把 `.dev.vars` 里的变量注入 Cloudflare Workers 的 `env` 绑定（和 `db/index.ts` 读取 `env.DB` 是同一套机制，通过 `cloudflare:workers` 的 `env`，不是 `process.env`）。
4. 没配置密钥时，点击按钮会得到一条明确的错误提示，不会静默失败或返回编造的内容。

线上部署时对应的是 `wrangler secret put ANTHROPIC_API_KEY`（或托管平台自己的密钥管理界面），本版未涉及部署配置。

## 架构

- `lib/ai/providers.ts`：Anthropic 与 OpenAI 兼容两种协议的调用层，直接用 `fetch`，不引入 SDK 依赖。
- `lib/ai/indicator-analysis.ts`：`IndicatorAiPayload` 类型 + `buildMessages()` 纯函数（系统提示词 + 按字段拼接的用户消息），不发网络请求，可单测（`scripts/test-ai-analysis.mjs`）。
- `app/api/ai/indicator-analysis/route.ts`：POST 路由，服务端校验请求体、读取 `env.ANTHROPIC_API_KEY`、调用客户端，返回 `{analysis, model, generatedAt}` 或明确的错误信息。密钥只在服务端出现，客户端代码和响应里都不会有密钥。
- `app/indicators/page.tsx`：`toAiPayload()` 把当前币种的 `IndicatorCoin` + `DirectionAnalysis` 打包成请求体；`AiAnalysisPanel` 组件负责按钮、加载态、错误提示和结果展示。

## 系统提示词的约束（`lib/ai/indicator-analysis.ts` 的 `SYSTEM_PROMPT`）

- 只能基于给定字段分析，不能引入模型自己的市场知识或价格预期；字段缺失要明确说"缺失"，不能当0或中性处理。
- 禁止"建议买入/卖出/做多/做空""目标价""止损位""胜率"这类指令性或承诺性表述。
- 明确告知这不是新信号，只是把已有规则输出重新叙述。
- 结尾必须提醒：规则未经回测，不构成投资建议。

## 未回测声明

这段功能本身谈不上"回测"——它不产生可回测的信号，只是文字解读。规则未回测的声明适用于它引用的全部底层数据（早期分、方向研判等），这一点在 prompt 里也明确要求模型自己重复提醒用户。
