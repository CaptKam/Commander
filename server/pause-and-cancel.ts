async function main() {
  const key = process.env.ALPACA_API_KEY!;
  const secret = process.env.ALPACA_API_SECRET!;
  const base = "https://paper-api.alpaca.markets";
  const h: Record<string,string> = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };

  // Cancel all orders
  const res = await fetch(base + "/v2/orders", { method: "DELETE", headers: h });
  console.log("Cancel all orders:", res.status === 207 || res.ok ? "Done" : "Failed " + res.status);

  // Pause trading in DB so bot stops placing new orders
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("UPDATE system_settings SET trading_enabled = false");
  console.log("Trading PAUSED in DB — bot will detect signals but not place orders");

  await new Promise(r => setTimeout(r, 2000));
  const acct = await fetch(base + "/v2/account", { headers: h }).then(r => r.json()) as any;
  console.log("Buying power: $" + Number(acct.buying_power).toFixed(2));

  await pool.end();
}
main().catch(console.error);
