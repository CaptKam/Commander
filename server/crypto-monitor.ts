/**
 * Crypto Position Monitor — Price-Based Exit Fallback
 *
 * Complements the order-based exit-manager by directly monitoring
 * live crypto positions against TP/SL price levels. This catches
 * edge cases where Alpaca exit orders fail or aren't placed.
 *
 * Called every scan cycle alongside runExitCycle().
 *
 * CLAUDE.md Rule #1: All quantities pass through Anti-422 formatters.
 * CLAUDE.md Rule #2: All state changes persisted to PostgreSQL.
 */

import { db } from "./db";
import { liveSignals } from "../shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { formatAlpacaQty } from "./utils/alpacaFormatters";
import { sendError } from "./utils/notifier";

// ============================================================
// Environment
// ============================================================
function getAlpacaConfig() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) {
    throw new Error("[CryptoMonitor] ALPACA_API_KEY and ALPACA_API_SECRET must be set");
  }
  const rawBase = process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
  const base = rawBase.replace(/\/v2\/?$/, "");
  return { key, secret, base };
}

// ============================================================
// Alpaca types
// ============================================================
interface AlpacaPosition {
  symbol: string;
  qty: string;
  side: string;
  current_price: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}

// ============================================================
// Alpaca API helpers
// ============================================================
async function getPositions(): Promise<AlpacaPosition[]> {
  const { key, secret, base } = getAlpacaConfig();
  const res = await fetch(`${base}/v2/positions`, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca GET positions: ${res.status} — ${body}`);
  }
  return (await res.json()) as AlpacaPosition[];
}

async function closePosition(
  symbol: string,
  qty: string,
): Promise<void> {
  const { key, secret, base } = getAlpacaConfig();
  const res = await fetch(
    `${base}/v2/positions/${encodeURIComponent(symbol)}`,
    {
      method: "DELETE",
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ qty }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca close position ${symbol}: ${res.status} — ${body}`);
  }
}

// ============================================================
// Main crypto monitor cycle
// ============================================================
export async function runCryptoMonitor(): Promise<void> {
  try {
    const positions = await getPositions();

    // Filter to crypto positions only (symbol contains "/")
    const cryptoPositions = positions.filter((p) => p.symbol.includes("/"));
    if (cryptoPositions.length === 0) return;

    // Load matching signals from DB
    const activeSignals = await db
      .select()
      .from(liveSignals)
      .where(inArray(liveSignals.status, ["filled", "partial_exit"]));

    for (const pos of cryptoPositions) {
      const currentPrice = Number(pos.current_price);
      const posQty = Number(pos.qty);

      // Find matching signal — normalize symbol for comparison
      // Alpaca may return "BTC/USD" or "BTCUSD" depending on context
      const normalizedSymbol = pos.symbol.replace(/\//g, "");
      const signal = activeSignals.find((s) => {
        const normalizedSignalSymbol = s.symbol.replace(/\//g, "");
        return normalizedSignalSymbol === normalizedSymbol &&
          (s.status === "filled" || s.status === "partial_exit");
      });

      if (!signal) continue;

      const tp1 = Number(signal.tp1Price);
      const tp2 = Number(signal.tp2Price);
      const sl = Number(signal.stopLossPrice);
      const isLong = signal.direction === "long";
      const isCrypto = true;

      // ---- Check SL hit ----
      const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
      if (slHit) {
        console.log(
          `[CryptoMonitor] SL HIT: ${pos.symbol} current=$${currentPrice} SL=$${sl} — closing full position`,
        );
        try {
          const safeQty = formatAlpacaQty(posQty, isCrypto);
          await closePosition(pos.symbol, String(safeQty));
          await db
            .update(liveSignals)
            .set({ status: "closed" })
            .where(eq(liveSignals.id, signal.id));
          console.log(`[CryptoMonitor] Position closed and signal #${signal.id} marked closed`);
        } catch (err) {
          console.error(`[CryptoMonitor] Failed to close SL position ${pos.symbol}:`, err);
          sendError(`CryptoMonitor SL close failed: ${pos.symbol}`, err).catch(() => {});
        }
        continue;
      }

      // ---- Check TP1 hit (only if not already partial_exit) ----
      if (signal.status === "filled") {
        const tp1Hit = isLong ? currentPrice >= tp1 : currentPrice <= tp1;
        if (tp1Hit) {
          console.log(
            `[CryptoMonitor] TP1 HIT: ${pos.symbol} current=$${currentPrice} TP1=$${tp1} — closing 50%`,
          );
          try {
            const halfQty = posQty / 2;
            const safeQty = formatAlpacaQty(halfQty, isCrypto);
            await closePosition(pos.symbol, String(safeQty));
            await db
              .update(liveSignals)
              .set({ status: "partial_exit" })
              .where(eq(liveSignals.id, signal.id));
            console.log(`[CryptoMonitor] 50% closed, signal #${signal.id} → partial_exit`);
          } catch (err) {
            console.error(`[CryptoMonitor] Failed to close TP1 position ${pos.symbol}:`, err);
            sendError(`CryptoMonitor TP1 close failed: ${pos.symbol}`, err).catch(() => {});
          }
          continue;
        }
      }

      // ---- Check TP2 hit (only after partial_exit) ----
      if (signal.status === "partial_exit") {
        const tp2Hit = isLong ? currentPrice >= tp2 : currentPrice <= tp2;
        if (tp2Hit) {
          console.log(
            `[CryptoMonitor] TP2 HIT: ${pos.symbol} current=$${currentPrice} TP2=$${tp2} — closing remaining`,
          );
          try {
            const safeQty = formatAlpacaQty(posQty, isCrypto);
            await closePosition(pos.symbol, String(safeQty));
            await db
              .update(liveSignals)
              .set({ status: "closed" })
              .where(eq(liveSignals.id, signal.id));
            console.log(`[CryptoMonitor] Remaining closed, signal #${signal.id} → closed`);
          } catch (err) {
            console.error(`[CryptoMonitor] Failed to close TP2 position ${pos.symbol}:`, err);
            sendError(`CryptoMonitor TP2 close failed: ${pos.symbol}`, err).catch(() => {});
          }
          continue;
        }
      }
    }
  } catch (err) {
    console.error("[CryptoMonitor] Monitor cycle failed:", err);
    sendError("Crypto monitor cycle failed", err).catch(() => {});
  }
}
