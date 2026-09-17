CREATE TABLE `behavior_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trader_id` integer NOT NULL,
	`calculated_at` integer NOT NULL,
	`window_days` integer NOT NULL,
	`median_hold_seconds` integer,
	`under_60s_ratio` real,
	`under_5m_ratio` real,
	`same_minute_reversal_ratio` real,
	`daily_turnover_to_equity` real,
	`fee_to_gross_profit` real,
	`wash_risk_score` real,
	`confidence` real NOT NULL,
	FOREIGN KEY (`trader_id`) REFERENCES `traders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_behavior_scores_trader_time` ON `behavior_scores` (`trader_id`,`calculated_at`);--> statement-breakpoint
CREATE TABLE `coin_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`captured_at` integer NOT NULL,
	`symbol` text NOT NULL,
	`locale` text NOT NULL,
	`heat_score` real NOT NULL,
	`sentiment_score` real,
	`search_rank` integer,
	`discussion_count` integer,
	`rapid_riser` integer DEFAULT false NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_coin_signals_symbol_time` ON `coin_signals` (`symbol`,`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_coin_signals_time_heat` ON `coin_signals` (`captured_at`,`heat_score`);--> statement-breakpoint
CREATE TABLE `position_cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trader_id` integer NOT NULL,
	`position_key` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer NOT NULL,
	`duration_seconds` integer NOT NULL,
	`trade_count` integer NOT NULL,
	`gross_pnl` real NOT NULL,
	`fees` real NOT NULL,
	`funding` real NOT NULL,
	`net_pnl` real NOT NULL,
	`turnover` real NOT NULL,
	FOREIGN KEY (`trader_id`) REFERENCES `traders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_position_cycles_key` ON `position_cycles` (`trader_id`,`position_key`);--> statement-breakpoint
CREATE INDEX `idx_position_cycles_trader_close` ON `position_cycles` (`trader_id`,`closed_at`);--> statement-breakpoint
CREATE INDEX `idx_position_cycles_duration` ON `position_cycles` (`trader_id`,`duration_seconds`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`raw_json` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_snapshots_source_time` ON `snapshots` (`source_id`,`captured_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_snapshots_source_hash` ON `snapshots` (`source_id`,`payload_hash`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`locale` text DEFAULT 'global' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sources_url` ON `sources` (`url`);--> statement-breakpoint
CREATE TABLE `trade_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trader_id` integer NOT NULL,
	`position_key` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`action` text NOT NULL,
	`event_at` integer NOT NULL,
	`quantity` real,
	`notional` real,
	`price` real,
	`fee` real,
	`funding` real,
	`realized_pnl` real,
	`raw_hash` text NOT NULL,
	FOREIGN KEY (`trader_id`) REFERENCES `traders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_trade_events_raw_hash` ON `trade_events` (`raw_hash`);--> statement-breakpoint
CREATE INDEX `idx_trade_events_trader_time` ON `trade_events` (`trader_id`,`event_at`);--> statement-breakpoint
CREATE INDEX `idx_trade_events_position` ON `trade_events` (`trader_id`,`position_key`,`event_at`);--> statement-breakpoint
CREATE TABLE `trader_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trader_id` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`window_days` integer NOT NULL,
	`roi` real NOT NULL,
	`pnl` real NOT NULL,
	`copier_pnl` real NOT NULL,
	`sharpe` real,
	`mdd` real NOT NULL,
	`win_rate` real,
	`days_trading` integer NOT NULL,
	`aum` real,
	`leading_balance` real,
	`public_score` real,
	FOREIGN KEY (`trader_id`) REFERENCES `traders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_trader_snapshots_trader_time` ON `trader_snapshots` (`trader_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_trader_snapshots_time_score` ON `trader_snapshots` (`captured_at`,`public_score`);--> statement-breakpoint
CREATE TABLE `traders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_traders_platform_id` ON `traders` (`platform_id`);
--> statement-breakpoint
PRAGMA optimize;
