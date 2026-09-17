# 合约指标模块 v1

## 用户确认口径

- IO：主动买卖成交资金。流入=主动买入成交额；流出=主动卖出成交额；净流入=流入−流出。不是链上充值提现，也不是净入金。
- 合约市值：未平仓合约持仓名义价值，只计一侧。不是成交额、保证金或代币流通市值。
- OI：未平仓数量，独立于 IO；数量增减与价格变化组合看，不直接认定为多头或空头开仓。

## 覆盖与采集

动态读取币安 U 本位与币本位 exchangeInfo，取 TRADING、underlyingType=COIN，包括永续与交割合约。不混入非交易合约、股票、商品及指数；完整排除清单保存在快照中。跨 API 出现重复 symbol 时停止，避免迁移期重复计数。

每合约取 25 个整点 OI 样本、200 根已收盘 1h K线和当前 OI；批量取24h行情、标记/指数价格、费率周期与盘口报价。固定共同整点，避免各币种比较不同窗口。接口错误保留为缺失，绝不按0填充。

公开数据不需要账户密钥。170ms 请求间隔、4个处理工作单元；429 按 Retry-After 暂停，418 停止，不绕过限流。独立手动更新，无计划任务。

## 单位及算法

- U本位 IO：K线 taker-buy quote volume 为流入，quote volume 减去它为流出。
- 币本位 IO：成交张数/主动买入张数 × USD 合约面值。不能将 base asset volume 直接当美元。
- U本位持仓市值：历史 sumOpenInterestValue 换算 USD；币本位：sumOpenInterest 张数 × contractSize（USD）。
- 跨合约的 OI 增减以各合约期初持仓市值为固定权重，聚合其数量增减；不会把价格升高自动当成数量增仓。币本位 inverse 合约与线性合约不直接相加原始数量。
- 一致整点用于主筛选。另列最新持仓市值、观察时间与覆盖；当前 OI 与批量标记价格并非原子同一时刻。
- USD按1，USDT近似1美元；其他报价按采集时现货兑USDT折算。跨币报价历史额亦按此固定汇率近似；不宣称精确历史美元现金流。
- CMC流通量由币安OI历史接口提供，采用合约基础单位。独立采集同整点币安USDT现货已收盘价；流通市值=CMC流通量×合约代币倍数×现货单位价格。千倍/百万倍合约只能归一化一次。没有现货对或收盘时间不匹配时，不用合约价格代替。
- CoinGecko前1000币种用于交叉校验。仅唯一symbol、价格接近、时间差小于3小时才候选匹配，不保证同名币身份；差异>25%时比值置空。缺少币安流通量时，可采用通过该校验的外部流通市值，并明确标注来源。缺失不得用FDV代替。
- 主合约按24h成交额选取。EMA20/60、Wilder RSI14、ATR14简单均值/价格来自连续小时K线；量比为最后4小时成交额 / 前24小时平均4小时成交额；费率按实际结算周期折算24h。

## 默认筛选（未回测，不是盈利模型）

基础门槛：完整整点 OI/资金流、至少60根连续小时K线；24h成交额≥500万美元、持仓市值≥100万美元、主合约价差≤25bps。

信号：4h OI增加≥3%配合价格变动分类；减仓≤−3%且价格变动绝对值≥1%；IO净额/成交额绝对值≥8%；4h量比≥1.5；持仓/流通市值≥20%或24h等效费率绝对值≥0.1%提示拥挤。至少两项信号才入选。

关注分仅为变化强度排序，绝对OI变化、IO失衡、量比和价格变动封顶相加。不把增仓直接看多，不把高持仓市值比解释成低估，不回避净流出和下跌风险。

## 操作

使用 Node 24（本项目可用的完整运行时）。

- 完整手动更新：node scripts/update-indicators.mjs
- 单独重分析：node scripts/analyze-indicators.mjs
- 单独补充现货价格：node scripts/enrich-indicator-spot.mjs
- 本地更新服务：node scripts/indicator-service.mjs（127.0.0.1:8791）
- 项目预览：node scripts/run-framework.mjs dev --hostname 127.0.0.1（5173）
- 页面：/indicators
- 规则测试：node --test scripts/test-indicators.mjs

网页按钮仅在本地主机可用，由本地服务启动固定采集脚本；来源限制为localhost/127.0.0.1:5173，POST必须application/json。生产站点不能访问本机服务。正在运行的任务互斥，失败保留上次页面快照。进度轮询不等于定时采集。

原始数据保存在 data/indicators/时间戳/；分析输出 analysis.json；页面读取 public/indicators/latest.json，成功后原子替换。update.lock 阻止并发更新，异常退出后的遗留锁需要先确认进程已停止才能人工清理。

## 官方数据文档

- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data
- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-coin-m-futures/api/rest-api/market-data
- https://docs.coingecko.com/reference/coins-markets
