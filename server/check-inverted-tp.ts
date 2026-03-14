/**
 * One-off script: find all live_signals where TP is inverted relative to entry.
 * Run with: npx tsx scripts/check-inverted-tp.ts
 */
import pkg from "pg";
const { Pool } = pkg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const { rows } = await pool.query(`
    SELECT id, symbol, pattern_type, timeframe, direction,
           entry_price, stop_loss_price, tp1_price, tp2_price,
           status, created_at
    FROM live_signals
    WHERE (direction = 'long' AND tp1_price::numeric < entry_price::numeric)
       OR (direction = 'short' AND tp1_price::numeric > entry_price::numeric)
    ORDER BY created_at DESC
  `);

  if (rows.length === 0) {
    console.log("No inverted TP signals found in the database.");
  } else {
    console.log(`Found ${rows.length} inverted TP signal(s):\n`);
    for (const row of rows) {
      console.log(
        `  ID=${row.id} ${row.symbol} ${row.pattern_type} ${row.timeframe} ${row.direction} ` +
        `| entry=${row.entry_price} TP1=${row.tp1_price} TP2=${row.tp2_price} SL=${row.stop_loss_price} ` +
        `| status=${row.status} created=${row.created_at}`
      );
    }
  }

  // Also check SL inversion
  const slResult = await pool.query(`
    SELECT id, symbol, pattern_type, timeframe, direction,
           entry_price, stop_loss_price, tp1_price, tp2_price
    FROM live_signals
    WHERE (direction = 'long' AND stop_loss_price::numeric > entry_price::numeric)
       OR (direction = 'short' AND stop_loss_price::numeric < entry_price::numeric)
    ORDER BY created_at DESC
  `);

  if (slResult.rows.length === 0) {
    console.log("No inverted SL signals found in the database.");
  } else {
    console.log(`\nFound ${slResult.rows.length} inverted SL signal(s):\n`);
    for (const row of slResult.rows) {
      console.log(
        `  ID=${row.id} ${row.symbol} ${row.pattern_type} ${row.direction} ` +
        `| entry=${row.entry_price} SL=${row.stop_loss_price}`
      );
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
