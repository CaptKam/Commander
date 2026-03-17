import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
  varchar,
  boolean,
  jsonb,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================================
// Live Signals Table
// tp1_price and tp2_price are NOT NULL at the database level.
// See CLAUDE.md Rule #2 (Anti-NULL Rule).
// ============================================================
export const liveSignals = pgTable("live_signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  patternType: text("pattern_type").notNull(),
  timeframe: text("timeframe").notNull(),
  direction: text("direction").notNull(), // "long" | "short"
  entryPrice: numeric("entry_price", { precision: 20, scale: 10 }).notNull(),
  stopLossPrice: numeric("stop_loss_price", { precision: 20, scale: 10 }).notNull(),
  tp1Price: numeric("tp1_price", { precision: 20, scale: 10 }).notNull(),
  tp2Price: numeric("tp2_price", { precision: 20, scale: 10 }).notNull(),
  xPrice: numeric("x_price", { precision: 20, scale: 10 }),
  aPrice: numeric("a_price", { precision: 20, scale: 10 }),
  bPrice: numeric("b_price", { precision: 20, scale: 10 }),
  cPrice: numeric("c_price", { precision: 20, scale: 10 }),
  status: text("status").notNull().default("pending"),
  // Exit management columns — order IDs from Alpaca
  entryOrderId: text("entry_order_id"),
  tp1OrderId: text("tp1_order_id"),
  tp2OrderId: text("tp2_order_id"),
  slOrderId: text("sl_order_id"),
  filledQty: numeric("filled_qty", { precision: 20, scale: 10 }),
  filledAvgPrice: numeric("filled_avg_price", { precision: 20, scale: 10 }),
  realizedPnl: numeric("realized_pnl", { precision: 20, scale: 10 }),
  exitRetries: integer("exit_retries").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  executedAt: timestamp("executed_at"),
});

// ============================================================
// Zod Validation — Anti-NULL enforcement for tp1Price / tp2Price
// Three layers of defense:
//   1. Drizzle .notNull() — DB rejects NULLs
//   2. Zod .refine()    — App rejects invalid values before DB
//   3. Pattern filter   — Blocks Crab/Deep Crab (CLAUDE.md Rule #3)
// ============================================================

const DISABLED_PATTERNS = ["Crab", "Deep Crab"] as const;

const positiveNumericString = (fieldName: string) =>
  z.string().refine(
    (val) => {
      const num = Number(val);
      return !isNaN(num) && num > 0;
    },
    { message: `${fieldName} must be a positive number — cannot be NULL, zero, or negative` }
  );

const baseInsertSchema = createInsertSchema(liveSignals);

export const insertLiveSignalSchema = baseInsertSchema.extend({
  tp1Price: positiveNumericString("tp1Price"),
  tp2Price: positiveNumericString("tp2Price"),
  entryPrice: positiveNumericString("entryPrice"),
  stopLossPrice: positiveNumericString("stopLossPrice"),
  patternType: z.string().refine(
    (val) => !DISABLED_PATTERNS.includes(val as (typeof DISABLED_PATTERNS)[number]),
    { message: "Crab and Deep Crab patterns are globally DISABLED (see CLAUDE.md Rule #3)" }
  ),
  direction: z.enum(["long", "short"]),
  timeframe: z.enum(["1D", "4H"]),
});

export type InsertLiveSignal = z.infer<typeof insertLiveSignalSchema>;
export type LiveSignal = typeof liveSignals.$inferSelect;

// ============================================================
// Watchlist Table — Dynamic symbol list managed via dashboard
// ============================================================
export const watchlist = pgTable("watchlist", {
  symbol: varchar("symbol", { length: 20 }).primaryKey(),
  assetClass: varchar("asset_class", { length: 20 }).notNull().default("equity"),
});

export type WatchlistEntry = typeof watchlist.$inferSelect;

// ============================================================
// System Settings Table — singleton row for bot configuration
// ============================================================
export const systemSettings = pgTable("system_settings", {
  id: integer("id").primaryKey().default(1),
  tradingEnabled: boolean("trading_enabled").notNull().default(true),
  equityAllocation: numeric("equity_allocation", { precision: 5, scale: 4 }).notNull().default("0.05"),
  cryptoAllocation: numeric("crypto_allocation", { precision: 5, scale: 4 }).notNull().default("0.07"),
  enabledPatterns: jsonb("enabled_patterns").notNull().default(["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"]),
  goLiveTarget: integer("go_live_target").notNull().default(15),
});

export type SystemSettings = typeof systemSettings.$inferSelect;

// ============================================================
// Symbol Scan State — Tiered scanner scheduling per symbol+timeframe
// Unique constraint on (symbol, timeframe) via uniqueIndex below
// ============================================================
export const symbolScanState = pgTable("symbol_scan_state", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  timeframe: varchar("timeframe", { length: 5 }).notNull(), // "1D" or "4H"
  phase: varchar("phase", { length: 20 }).notNull().default("NO_PATTERN"),
  // Best pattern match info (if any forming pattern detected)
  bestPattern: varchar("best_pattern", { length: 20 }),   // "Gartley", "Bat", etc. or null
  bestDirection: varchar("best_direction", { length: 10 }), // "long", "short", or null
  // Pivot prices for the best match (null if not yet detected)
  xPrice: numeric("x_price", { precision: 20, scale: 10 }),
  aPrice: numeric("a_price", { precision: 20, scale: 10 }),
  bPrice: numeric("b_price", { precision: 20, scale: 10 }),
  cPrice: numeric("c_price", { precision: 20, scale: 10 }),
  projectedD: numeric("projected_d", { precision: 20, scale: 10 }),
  distanceToDPct: numeric("distance_to_d_pct", { precision: 10, scale: 4 }),
  // Scheduling
  lastScannedAt: timestamp("last_scanned_at").defaultNow().notNull(),
  nextScanDue: timestamp("next_scan_due").defaultNow().notNull(),
  scanIntervalMs: integer("scan_interval_ms").notNull().default(28800000), // 8 hours default
  // Metadata
  pivotCount: integer("pivot_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_scan_state_symbol_tf").on(table.symbol, table.timeframe),
]);

export type SymbolScanState = typeof symbolScanState.$inferSelect;
export type InsertSymbolScanState = typeof symbolScanState.$inferInsert;
