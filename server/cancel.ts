async function main() {
  const key = process.env.ALPACA_API_KEY!;
  const secret = process.env.ALPACA_API_SECRET!;
  const base = "https://paper-api.alpaca.markets";
  const h: Record<string,string> = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
  const res = await fetch(base + "/v2/orders", { method: "DELETE", headers: h });
  console.log("Orders cancelled:", res.ok || res.status === 207 ? "Done" : "Failed");
}
main().catch(console.error);
