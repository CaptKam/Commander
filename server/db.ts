/**
 * Database Connection — Neon PostgreSQL via Drizzle ORM
 * Provides a shared db instance for all server modules.
 *
 * NOTE: Does NOT throw at import time. If DATABASE_URL is missing the
 * db object will be null and callers must handle that gracefully.
 */

import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "../shared/schema";

function createDb() {
  if (!process.env.DATABASE_URL) {
    console.error("[DB] DATABASE_URL is not set — database features disabled");
    return null;
  }
  return drizzle(process.env.DATABASE_URL, { schema });
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
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL,
        executed_at TIMESTAMP
      )
    `);
    console.log("[DB] Table live_signals: OK");
  } catch (err) {
    console.error("[DB] Failed to ensure tables exist:", err);
  }
}
