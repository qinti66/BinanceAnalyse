import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["square_trends", "lead_profile", "position_history", "market"] }).notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  locale: text("locale").notNull().default("global"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("idx_sources_url").on(table.url)]);

export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceId: integer("source_id").notNull().references(() => sources.id),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  payloadHash: text("payload_hash").notNull(),
  rawJson: text("raw_json").notNull(),
}, (table) => [
  index("idx_snapshots_source_time").on(table.sourceId, table.capturedAt),
  uniqueIndex("idx_snapshots_source_hash").on(table.sourceId, table.payloadHash),
]);

export const coinSignals = sqliteTable("coin_signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  symbol: text("symbol").notNull(),
  locale: text("locale").notNull(),
  heatScore: real("heat_score").notNull(),
  sentimentScore: real("sentiment_score"),
  searchRank: integer("search_rank"),
  discussionCount: integer("discussion_count"),
  rapidRiser: integer("rapid_riser", { mode: "boolean" }).notNull().default(false),
  evidenceJson: text("evidence_json").notNull().default("[]"),
}, (table) => [
  index("idx_coin_signals_symbol_time").on(table.symbol, table.capturedAt),
  index("idx_coin_signals_time_heat").on(table.capturedAt, table.heatScore),
]);

export const traders = sqliteTable("traders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  platformId: text("platform_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("idx_traders_platform_id").on(table.platformId)]);

export const traderSnapshots = sqliteTable("trader_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traderId: integer("trader_id").notNull().references(() => traders.id),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  windowDays: integer("window_days").notNull(),
  roi: real("roi").notNull(),
  pnl: real("pnl").notNull(),
  copierPnl: real("copier_pnl").notNull(),
  sharpe: real("sharpe"),
  mdd: real("mdd").notNull(),
  winRate: real("win_rate"),
  daysTrading: integer("days_trading").notNull(),
  aum: real("aum"),
  leadingBalance: real("leading_balance"),
  publicScore: real("public_score"),
}, (table) => [
  index("idx_trader_snapshots_trader_time").on(table.traderId, table.capturedAt),
  index("idx_trader_snapshots_time_score").on(table.capturedAt, table.publicScore),
]);

export const tradeEvents = sqliteTable("trade_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traderId: integer("trader_id").notNull().references(() => traders.id),
  positionKey: text("position_key").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side", { enum: ["long", "short"] }).notNull(),
  action: text("action", { enum: ["open", "increase", "reduce", "close", "liquidate"] }).notNull(),
  eventAt: integer("event_at", { mode: "timestamp_ms" }).notNull(),
  quantity: real("quantity"),
  notional: real("notional"),
  price: real("price"),
  fee: real("fee"),
  funding: real("funding"),
  realizedPnl: real("realized_pnl"),
  rawHash: text("raw_hash").notNull(),
}, (table) => [
  uniqueIndex("idx_trade_events_raw_hash").on(table.rawHash),
  index("idx_trade_events_trader_time").on(table.traderId, table.eventAt),
  index("idx_trade_events_position").on(table.traderId, table.positionKey, table.eventAt),
]);

export const positionCycles = sqliteTable("position_cycles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traderId: integer("trader_id").notNull().references(() => traders.id),
  positionKey: text("position_key").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side", { enum: ["long", "short"] }).notNull(),
  openedAt: integer("opened_at", { mode: "timestamp_ms" }).notNull(),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }).notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  tradeCount: integer("trade_count").notNull(),
  grossPnl: real("gross_pnl").notNull(),
  fees: real("fees").notNull(),
  funding: real("funding").notNull(),
  netPnl: real("net_pnl").notNull(),
  turnover: real("turnover").notNull(),
}, (table) => [
  uniqueIndex("idx_position_cycles_key").on(table.traderId, table.positionKey),
  index("idx_position_cycles_trader_close").on(table.traderId, table.closedAt),
  index("idx_position_cycles_duration").on(table.traderId, table.durationSeconds),
]);

export const behaviorScores = sqliteTable("behavior_scores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traderId: integer("trader_id").notNull().references(() => traders.id),
  calculatedAt: integer("calculated_at", { mode: "timestamp_ms" }).notNull(),
  windowDays: integer("window_days").notNull(),
  medianHoldSeconds: integer("median_hold_seconds"),
  under60sRatio: real("under_60s_ratio"),
  under5mRatio: real("under_5m_ratio"),
  sameMinuteReversalRatio: real("same_minute_reversal_ratio"),
  dailyTurnoverToEquity: real("daily_turnover_to_equity"),
  feeToGrossProfit: real("fee_to_gross_profit"),
  washRiskScore: real("wash_risk_score"),
  confidence: real("confidence").notNull(),
}, (table) => [index("idx_behavior_scores_trader_time").on(table.traderId, table.calculatedAt)]);

export const marketSnapshots = sqliteTable("market_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  symbol: text("symbol").notNull(),
  lastPrice: real("last_price").notNull(),
  priceChangePercent: real("price_change_percent").notNull(),
  quoteVolume: real("quote_volume").notNull(),
  markPrice: real("mark_price").notNull(),
  fundingRate: real("funding_rate").notNull(),
  openInterest: real("open_interest").notNull(),
  longShortRatio: real("long_short_ratio"),
  takerBuySellRatio: real("taker_buy_sell_ratio"),
}, (table) => [
  index("idx_market_snapshots_symbol_time").on(table.symbol, table.capturedAt),
  index("idx_market_snapshots_time").on(table.capturedAt),
]);
