import { db } from "./db";
import { sql } from "drizzle-orm";

async function main() {
  if (!db) {
    console.error("DATABASE_URL not set — cannot connect");
    process.exit(1);
  }

  console.log("\n=== EQUITY SIGNAL CHECK ===\n");

  // Query 1: All equity signals
  const equitySignals = await db.execute(sql`
    SELECT symbol, pattern_type, direction, timeframe, status, entry_price, created_at
    FROM live_signals
    WHERE symbol NOT LIKE '%/%'
    ORDER BY created_at DESC
    LIMIT 20
  `);
  console.log(`--- Equity signals (${equitySignals.rows.length} found) ---`);
  for (const row of equitySignals.rows) {
    console.log(`  ${row.symbol} ${row.pattern_type} ${row.direction} ${row.timeframe} | status=${row.status} entry=$${row.entry_price} | ${row.created_at}`);
  }
  if (equitySignals.rows.length === 0) console.log("  (none)");

  // Query 2: Equity SHORTs specifically
  const equityShorts = await db.execute(sql`
    SELECT symbol, pattern_type, direction, timeframe, status, entry_price, entry_order_id, created_at
    FROM live_signals
    WHERE symbol NOT LIKE '%/%' AND direction = 'short'
    ORDER BY created_at DESC
    LIMIT 20
  `);
  console.log(`\n--- Equity SHORT signals (${equityShorts.rows.length} found) ---`);
  for (const row of equityShorts.rows) {
    console.log(`  ${row.symbol} ${row.pattern_type} SHORT ${row.timeframe} | status=${row.status} entry=$${row.entry_price} | order=${row.entry_order_id || 'NONE'} | ${row.created_at}`);
  }
  if (equityShorts.rows.length === 0) console.log("  (none)");

  // Query 3: Equity scan states
  const equityScanStates = await db.execute(sql`
    SELECT symbol, timeframe, phase, best_pattern, best_direction, projected_d, distance_to_d_pct, last_scanned_at, next_scan_due
    FROM symbol_scan_state
    WHERE symbol NOT LIKE '%/%'
    ORDER BY
      CASE phase
        WHEN 'D_APPROACHING' THEN 1
        WHEN 'CD_PROJECTED' THEN 2
        WHEN 'BC_FORMING' THEN 3
        WHEN 'AB_FORMING' THEN 4
        WHEN 'XA_FORMING' THEN 5
        ELSE 6
      END,
      next_scan_due ASC
    LIMIT 50
  `);
  console.log(`\n--- Equity scan states (${equityScanStates.rows.length} rows) ---`);
  for (const row of equityScanStates.rows) {
    const d = row.projected_d ? `D=$${row.projected_d}` : '';
    const dist = row.distance_to_d_pct ? `dist=${row.distance_to_d_pct}%` : '';
    const pat = row.best_pattern ? `${row.best_pattern} ${row.best_direction || ''}` : 'none';
    console.log(`  ${row.symbol} ${row.timeframe} | phase=${row.phase} | pattern=${pat} ${d} ${dist} | last_scan=${row.last_scanned_at} next=${row.next_scan_due}`);
  }
  if (equityScanStates.rows.length === 0) console.log("  (none)");

  // Query 4: Signal summary by asset class + direction + status
  const summary = await db.execute(sql`
    SELECT
      CASE WHEN symbol LIKE '%/%' THEN 'crypto' ELSE 'equity' END as asset_class,
      direction,
      status,
      COUNT(*) as count
    FROM live_signals
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `);
  console.log(`\n--- Signal summary ---`);
  for (const row of summary.rows) {
    console.log(`  ${row.asset_class} ${row.direction} ${row.status}: ${row.count}`);
  }
  if (summary.rows.length === 0) console.log("  (no signals in database)");

  console.log("\n=== CHECK COMPLETE ===\n");
  process.exit(0);
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
