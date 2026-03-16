/**
 * Database Connection — PostgreSQL via Drizzle ORM
 * Provides a shared db instance for all server modules.
 *
 * NOTE: Does NOT throw at import time. If DATABASE_URL is missing the
 * db object will be null and callers must handle that gracefully.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pkg from "pg";
import * as schema from "../shared/schema";

const { Pool } = pkg;

function createDb() {
  if (!process.env.DATABASE_URL) {
    console.error("[DB] DATABASE_URL is not set — database features disabled");
    return null;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return drizzle(pool, { schema });
}

export const db = createDb()!;

/**
 * Ensures the live_signals table exists. Called once at boot.
 * Uses CREATE TABLE IF NOT EXISTS so it's safe to run repeatedly.
 */
export async function ensureTablesExist(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn("[DB] Skipping table init — no DATABASE_URL");
    return;
  }
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS live_signals (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        pattern_type TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price NUMERIC(20,10) NOT NULL,
        stop_loss_price NUMERIC(20,10) NOT NULL,
        tp1_price NUMERIC(20,10) NOT NULL,
        tp2_price NUMERIC(20,10) NOT NULL,
        x_price NUMERIC(20,10),
        a_price NUMERIC(20,10),
        b_price NUMERIC(20,10),
        c_price NUMERIC(20,10),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        executed_at TIMESTAMP
      )
    `);

    // Add pivot columns to existing tables (safe to run repeatedly)
    for (const col of ["x_price", "a_price", "b_price", "c_price"]) {
      await db.execute(sql.raw(
        `ALTER TABLE live_signals ADD COLUMN IF NOT EXISTS ${col} NUMERIC(20,10)`
      ));
    }

    // Add exit management columns (safe to run repeatedly)
    for (const col of ["entry_order_id", "tp1_order_id", "tp2_order_id", "sl_order_id"]) {
      await db.execute(sql.raw(
        `ALTER TABLE live_signals ADD COLUMN IF NOT EXISTS ${col} TEXT`
      ));
    }
    for (const col of ["filled_qty", "filled_avg_price"]) {
      await db.execute(sql.raw(
        `ALTER TABLE live_signals ADD COLUMN IF NOT EXISTS ${col} NUMERIC(20,10)`
      ));
    }
    // exit_retries tracks how many times exit order placement has failed
    await db.execute(sql.raw(
      `ALTER TABLE live_signals ADD COLUMN IF NOT EXISTS exit_retries INTEGER NOT NULL DEFAULT 0`
    ));
    // realized P&L — persisted so it survives Alpaca order history purges
    await db.execute(sql.raw(
      `ALTER TABLE live_signals ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC(20,10)`
    ));
    console.log("[DB] Table live_signals: OK");

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS watchlist (
        symbol VARCHAR(20) PRIMARY KEY,
        asset_class VARCHAR(20) NOT NULL DEFAULT 'equity'
      )
    `);
    // Fix any bare crypto tickers from previous seeds (e.g. "XRP" → "XRP/USD")
    // Also purge stale live_signals with bare symbols so they stop generating orders
    // Also remove unsupported Alpaca crypto tickers
    for (const unsupported of ["BNB/USD", "SUI/USD"]) {
      await db.execute(sql.raw(`DELETE FROM watchlist WHERE symbol = '${unsupported}'`));
      await db.execute(sql.raw(`DELETE FROM live_signals WHERE symbol = '${unsupported}' AND status = 'pending'`));
    }
    for (const base of ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "AVAX", "LINK", "LTC", "SUI"]) {
      await db.execute(sql.raw(
        `DELETE FROM watchlist WHERE symbol = '${base}'`
      ));
      await db.execute(sql.raw(
        `DELETE FROM live_signals WHERE symbol = '${base}'`
      ));
    }

    // Seed full watchlist — crypto + equities
    // ON CONFLICT DO NOTHING means existing correct entries are preserved
    await db.execute(sql`
      INSERT INTO watchlist (symbol, asset_class) VALUES
        ('BTC/USD', 'crypto'),
        ('ETH/USD', 'crypto'),
        ('SOL/USD', 'crypto'),
        ('XRP/USD', 'crypto'),
        ('DOGE/USD', 'crypto'),
        ('ADA/USD', 'crypto'),
        ('AVAX/USD', 'crypto'),
        ('LINK/USD', 'crypto'),
        ('LTC/USD', 'crypto'),
        ('AAPL', 'equity'),
        ('TSLA', 'equity'),
        ('NVDA', 'equity'),
        ('AMZN', 'equity'),
        ('META', 'equity'),
        ('MSFT', 'equity'),
        ('AMD', 'equity'),
        ('GOOGL', 'equity'),
        ('INTC', 'equity'),
        ('SPY', 'equity'),
        ('QQQ', 'equity'),
        ('IWM', 'equity')
      ON CONFLICT (symbol) DO NOTHING
    `);
    console.log("[DB] Table watchlist: OK (23 symbols seeded)");

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        trading_enabled BOOLEAN NOT NULL DEFAULT true,
        equity_allocation NUMERIC(5,4) NOT NULL DEFAULT 0.05,
        crypto_allocation NUMERIC(5,4) NOT NULL DEFAULT 0.07,
        enabled_patterns JSONB NOT NULL DEFAULT '["Gartley","Bat","Alt Bat","Butterfly","ABCD"]'::jsonb
      )
    `);
    await db.execute(sql.raw(
      `ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS go_live_target INTEGER NOT NULL DEFAULT 15`
    ));
    await db.execute(sql`
      INSERT INTO system_settings (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING
    `);
    console.log("[DB] Table system_settings: OK");

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS symbol_scan_state (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        timeframe VARCHAR(5) NOT NULL,
        phase VARCHAR(20) NOT NULL DEFAULT 'NO_PATTERN',
        best_pattern VARCHAR(20),
        best_direction VARCHAR(10),
        x_price NUMERIC(20,10),
        a_price NUMERIC(20,10),
        b_price NUMERIC(20,10),
        c_price NUMERIC(20,10),
        projected_d NUMERIC(20,10),
        distance_to_d_pct NUMERIC(10,4),
        last_scanned_at TIMESTAMP DEFAULT NOW() NOT NULL,
        next_scan_due TIMESTAMP DEFAULT NOW() NOT NULL,
        scan_interval_ms INTEGER NOT NULL DEFAULT 28800000,
        pivot_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
        UNIQUE(symbol, timeframe)
      )
    `);
    console.log("[DB] Table symbol_scan_state: OK");
  } catch (err) {
    console.error("[DB] Failed to ensure tables exist:", err);
  }
}
