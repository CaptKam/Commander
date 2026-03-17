/**
 * Order Distance Diagnostic — How far are our limit orders from current price?
 * Run with: npx tsx server/check-order-distance.ts
 */
async function run() {
  const apiKey = process.env.ALPACA_API_KEY!;
  const apiSecret = process.env.ALPACA_API_SECRET!;
  const baseUrl = (process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets").replace(/\/v2\/?$/, "");
  const dataUrl = "https://data.alpaca.markets";

  console.log("=== ORDER DISTANCE CHECK ===\n");

  // 1. Fetch all open orders
  const res = await fetch(`${baseUrl}/v2/orders?status=open&limit=500`, {
    headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret },
  });
  const orders = (await res.json()) as any[];
  console.log(`${orders.length} open orders\n`);

  // 2. Get current prices for each symbol
  const symbols = [...new Set(orders.map((o: any) => o.symbol))];

  const results: any[] = [];
  for (const symbol of symbols) {
    const isCrypto = symbol.includes("USD") && !symbol.match(/^[A-Z]{1,5}$/);
    let currentPrice: number | null = null;

    try {
      if (isCrypto) {
        // Crypto: use latest trade
        const tradeRes = await fetch(
          `https://data.alpaca.markets/v1beta3/crypto/us/latest/trades?symbols=${symbol}`,
          { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret } },
        );
        const tradeData = (await tradeRes.json()) as any;
        currentPrice = tradeData?.trades?.[symbol]?.p ?? null;
      } else {
        // Stock: use latest bar (works outside market hours)
        const barRes = await fetch(
          `${dataUrl}/v2/stocks/${symbol}/bars/latest?feed=iex`,
          { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret } },
        );
        const barData = (await barRes.json()) as any;
        currentPrice = barData?.bar?.c ?? null;
      }
    } catch {}

    // Match orders for this symbol
    for (const order of orders.filter((o: any) => o.symbol === symbol)) {
      const limitPrice = Number(order.limit_price);
      const side = order.side;
      const qty = Number(order.qty);
      const notional = limitPrice * qty;

      let distancePct: number | null = null;
      let direction = "";

      if (currentPrice !== null) {
        distancePct = ((currentPrice - limitPrice) / limitPrice) * 100;

        if (side === "buy") {
          // Buy order: price needs to DROP to limit price
          direction =
            currentPrice > limitPrice
              ? `${distancePct.toFixed(1)}% above (needs to drop)`
              : `${Math.abs(distancePct).toFixed(1)}% below (should fill!)`;
        } else {
          // Sell order: price needs to RISE to limit price
          direction =
            currentPrice < limitPrice
              ? `${Math.abs(distancePct).toFixed(1)}% below (needs to rise)`
              : `${distancePct.toFixed(1)}% above (should fill!)`;
        }
      }

      results.push({
        symbol,
        side,
        limitPrice,
        currentPrice,
        distancePct: distancePct !== null ? Math.abs(distancePct) : null,
        direction,
        notional: notional.toFixed(2),
        age: Math.round((Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60)),
      });
    }

    // Small delay to not hit rate limit
    await new Promise((r) => setTimeout(r, 200));
  }

  // Sort by distance (farthest first)
  results.sort((a, b) => (b.distancePct ?? 0) - (a.distancePct ?? 0));

  // Display
  console.log("Symbol         | Side | Limit Price    | Current Price  | Distance  | Notional    | Age");
  console.log("---------------|------|----------------|----------------|-----------|-------------|----");

  let totalNotional = 0;
  let farCount = 0;

  for (const r of results) {
    const dist = r.distancePct !== null ? `${r.distancePct.toFixed(1)}%` : "???";
    const cur = r.currentPrice !== null ? `$${r.currentPrice.toFixed(4)}` : "N/A";
    const far = r.distancePct !== null && r.distancePct > 5;
    const marker = far ? "\u{1F534}" : r.distancePct !== null && r.distancePct <= 2 ? "\u{1F7E2}" : "\u{1F7E1}";

    console.log(
      `${marker} ${r.symbol.padEnd(12)} | ${r.side.padEnd(4)} | $${r.limitPrice.toFixed(4).padEnd(12)} | ${cur.padEnd(14)} | ${dist.padEnd(9)} | $${r.notional.padEnd(10)} | ${r.age}h`,
    );

    totalNotional += Number(r.notional);
    if (far) farCount++;
  }

  console.log("\n--- SUMMARY ---");
  console.log(`Total orders: ${results.length}`);
  console.log(`Total capital locked: $${totalNotional.toFixed(2)}`);
  console.log(`\u{1F534} Far (>5% away): ${farCount} orders \u2014 capital wasted on orders unlikely to fill soon`);
  console.log(
    `\u{1F7E1} Medium (2-5%): ${results.filter((r) => r.distancePct !== null && r.distancePct > 2 && r.distancePct <= 5).length} orders`,
  );
  console.log(
    `\u{1F7E2} Close (<2%): ${results.filter((r) => r.distancePct !== null && r.distancePct <= 2).length} orders \u2014 these might actually fill`,
  );

  // Account info
  const acctRes = await fetch(`${baseUrl}/v2/account`, {
    headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret },
  });
  const acct = (await acctRes.json()) as any;
  console.log(`\nAccount equity: $${Number(acct.equity).toFixed(2)}`);
  console.log(`Buying power: $${Number(acct.buying_power).toFixed(2)}`);
  console.log(`Non-marginable BP: $${Number(acct.non_marginable_buying_power).toFixed(2)}`);
  console.log(`Capital utilization: ${((totalNotional / Number(acct.equity)) * 100).toFixed(1)}% locked in orders`);
  console.log("\n=== DONE ===");
}

run().catch(console.error);
