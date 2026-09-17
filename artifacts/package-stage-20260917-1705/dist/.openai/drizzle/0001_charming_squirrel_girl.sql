CREATE TABLE `market_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`captured_at` integer NOT NULL,
	`symbol` text NOT NULL,
	`last_price` real NOT NULL,
	`price_change_percent` real NOT NULL,
	`quote_volume` real NOT NULL,
	`mark_price` real NOT NULL,
	`funding_rate` real NOT NULL,
	`open_interest` real NOT NULL,
	`long_short_ratio` real,
	`taker_buy_sell_ratio` real
);
--> statement-breakpoint
CREATE INDEX `idx_market_snapshots_symbol_time` ON `market_snapshots` (`symbol`,`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_market_snapshots_time` ON `market_snapshots` (`captured_at`);
--> statement-breakpoint
PRAGMA optimize;
