import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
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
  status: text("status").notNull().default("pending"),
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
