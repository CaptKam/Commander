async function main() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  const base = "https://paper-api.alpaca.markets";
  const h: Record<string, string> = { "APCA-API-KEY-ID": key!, "APCA-API-SECRET-KEY": secret! };

  const res = await fetch(base + "/v2/orders", { method: "DELETE", headers: h });
  console.log("Cancel all orders:", res.status === 207 || res.ok ? "Done" : "Failed " + res.status);

  await new Promise(r => setTimeout(r, 2000));

  const acct = await fetch(base + "/v2/account", { headers: h }).then(r => r.json()) as any;
  console.log("Buying power restored: $" + Number(acct.buying_power).toFixed(2));
  console.log("Non-marginable BP: $" + Number(acct.non_marginable_buying_power).toFixed(2));
}

main().catch(console.error);
