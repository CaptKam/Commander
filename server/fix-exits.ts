async function main() {
  const key = process.env.ALPACA_API_KEY!;
  const secret = process.env.ALPACA_API_SECRET!;
  const base = "https://paper-api.alpaca.markets";
  const h: Record<string,string> = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, "Content-Type": "application/json" };

  // Define exit orders for each position
  const exits = [
    // PSHG: 2388 shares, TP1=$2.28, TP2=$2.40, SL=$1.94
    { symbol: "PSHG", qty: "1194", side: "sell", price: "2.28", label: "PSHG TP1" },
    { symbol: "PSHG", qty: "1194", side: "sell", price: "2.40", label: "PSHG TP2" },
    { symbol: "PSHG", qty: "2388", side: "sell", price: "1.94", label: "PSHG SL", type: "stop" },
    // IWY: 18 shares long, entry $258.94, SL=$265.74, TP1=$272.29, TP2=$275.95
    // Wait - IWY entry was $258.94 but original D was $266.37. The SL/TP from the pattern:
    // SL=$265.74 is ABOVE entry for a long... that's wrong. Let's set sensible exits.
    // Entry $258.94, set SL at $253 (-2.3%), TP1 at $268 (+3.5%), TP2 at $275 (+6.2%)
    { symbol: "IWY", qty: "9", side: "sell", price: "268.00", label: "IWY TP1" },
    { symbol: "IWY", qty: "9", side: "sell", price: "275.00", label: "IWY TP2" },
    { symbol: "IWY", qty: "18", side: "sell", price: "253.00", label: "IWY SL", type: "stop" },
    // XRT: 62 shares long, entry $80.52, SL=$80.56 (above entry - bad), TP1=$84.14, TP2=$86.15
    // SL is above entry which is wrong for a long. Set sensible exits.
    // Entry $80.52, set SL at $78.00 (-3.1%), TP1 at $84.00 (+4.3%), TP2 at $86.00 (+6.8%)
    { symbol: "XRT", qty: "31", side: "sell", price: "84.00", label: "XRT TP1" },
    { symbol: "XRT", qty: "31", side: "sell", price: "86.00", label: "XRT TP2" },
    { symbol: "XRT", qty: "62", side: "sell", price: "78.00", label: "XRT SL", type: "stop" },
  ];

  for (const exit of exits) {
    const isStop = exit.type === "stop";
    const payload: any = {
      symbol: exit.symbol,
      qty: exit.qty,
      side: exit.side,
      type: isStop ? "stop" : "limit",
      time_in_force: "gtc",
    };
    if (isStop) {
      payload.stop_price = exit.price;
    } else {
      payload.limit_price = exit.price;
    }

    try {
      const res = await fetch(base + "/v2/orders", { method: "POST", headers: h, body: JSON.stringify(payload) });
      if (res.ok) {
        const order = await res.json() as any;
        console.log("OK " + exit.label + " → " + order.id);
      } else {
        const body = await res.text();
        console.log("FAIL " + exit.label + ": " + res.status + " " + body);
      }
    } catch (e: any) {
      console.log("ERROR " + exit.label + ": " + e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log("\nDone. Check Alpaca for 9 new exit orders.");
}
main().catch(console.error);
