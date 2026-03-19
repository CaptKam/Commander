/**
 * Crypto & Stock Position Monitor — Real-Time Exit Engine
 *
 * Uses WebSocket streaming prices for instant TP/SL detection.
 * Falls back to Alpaca REST position data if no stream price available.
 *
 * Monitors BOTH crypto and stock positions against TP/SL levels.
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
import { getStreamPrice, getPriceWithAge, isPriceFresh } from "./websocket-stream";
import { checkTradingRateLimit } from "./utils/tradingRateLimiter";

// ============================================================
// Environment
// ============================================================
function getAlpacaConfig() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) {
    throw new Error("[PositionMonitor] ALPACA_API_KEY and ALPACA_API_SECRET must be set");
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
  checkTradingRateLimit();
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

async function getOpenOrders(symbol: string): Promise<{ id: string }[]> {
  const { key, secret, base } = getAlpacaConfig();
  try {
    checkTradingRateLimit();
    const res = await fetch(
      `${base}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`,
      { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret } },
    );
    if (!res.ok) return [];
    return (await res.json()) as { id: string }[];
  } catch {
    return [];
  }
}

async function cancelOrder(orderId: string): Promise<void> {
  const { key, secret, base } = getAlpacaConfig();
  try {
    checkTradingRateLimit();
    await fetch(`${base}/v2/orders/${orderId}`, {
      method: "DELETE",
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
    });
  } catch {}
}

async function cancelAllOrdersForSymbol(symbol: string): Promise<void> {
  const orders = await getOpenOrders(symbol);
  if (orders.length === 0) return;
  await Promise.all(orders.map((o) => cancelOrder(o.id)));
  console.log(`[PositionMonitor] Cancelled ${orders.length} open orders for ${symbol}`);
}

async function closePosition(
  symbol: string,
  qty: string,
): Promise<void> {
  const { key, secret, base } = getAlpacaConfig();
  checkTradingRateLimit();
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
// Main position monitor cycle — crypto AND stocks
// Uses WebSocket streaming prices when available, falls back
// to Alpaca REST position current_price.
// ============================================================
export async function runCryptoMonitor(): Promise<void> {
  try {
    const positions = await getPositions();
    if (positions.length === 0) return;

    // Load matching signals from DB
    const activeSignals = await db
      .select()
      .from(liveSignals)
      .where(inArray(liveSignals.status, ["filled", "partial_exit"]));

    if (activeSignals.length === 0) return;

    for (const pos of positions) {
      const posQty = Number(pos.qty);
      const isCrypto = pos.symbol.includes("/");

      // Use WebSocket streaming price if available, else REST fallback
      const streamPrice = getStreamPrice(pos.symbol);
      const currentPrice = streamPrice ?? Number(pos.current_price);
      const priceSource = streamPrice ? "stream" : "rest";

      // Find matching signal — normalize symbol for comparison
      const normalizedSymbol = pos.symbol.replace(/\//g, "");
      const signal = activeSignals.find((s) => {
        const normalizedSignalSymbol = s.symbol.replace(/\//g, "");
        return normalizedSignalSymbol === normalizedSymbol &&
          (s.status === "filled" || s.status === "partial_exit");
      });

      if (!signal) continue;

      // Re-read signal status from DB to avoid race with exit-manager
      // (exit-manager runs first in the orchestrator's finally block and may
      // have already closed this signal since we loaded activeSignals above)
      const [freshSignal] = await db
        .select()
        .from(liveSignals)
        .where(eq(liveSignals.id, signal.id))
        .limit(1);
      if (!freshSignal || freshSignal.status === "closed" || freshSignal.status === "cancelled" || freshSignal.status === "exit_failed") {
        continue; // exit-manager already handled this
      }

      const tp1 = Number(freshSignal.tp1Price);
      const tp2 = Number(freshSignal.tp2Price);
      const sl = Number(freshSignal.stopLossPrice);
      const isLong = freshSignal.direction === "long";
      const signalStatus = freshSignal.status;

      // SAFETY: Do NOT make TP/SL decisions on stale price data
      if (!isPriceFresh(pos.symbol)) {
        const priceAgeData = getPriceWithAge(pos.symbol);
        const ageSeconds = priceAgeData ? Math.round(priceAgeData.ageMs / 1000) : null;
        console.warn(
          `[PositionMonitor] SKIPPING TP/SL check for ${pos.symbol} — ` +
          `price is ${ageSeconds ? ageSeconds + 's old' : 'unavailable'} (stale threshold: 60s)`,
        );
        continue;
      }

      // ---- Check SL hit ----
      const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
      if (slHit) {
        console.log(
          `[PositionMonitor] SL HIT: ${pos.symbol} ${priceSource}=$${currentPrice} SL=$${sl} — closing full position`,
        );
        try {
          // Cancel outstanding TP limit orders first (Bug 6 fix applies here too)
          await cancelAllOrdersForSymbol(pos.symbol);
          const safeQty = formatAlpacaQty(posQty, isCrypto);
          await closePosition(pos.symbol, String(safeQty));

          // Compute realized P&L
          const entryPrice = Number(freshSignal.filledAvgPrice || freshSignal.entryPrice);
          const slRealizedPnl = isLong
            ? (currentPrice - entryPrice) * posQty
            : (entryPrice - currentPrice) * posQty;

          await db
            .update(liveSignals)
            .set({ status: "closed", realizedPnl: String(slRealizedPnl) })
            .where(eq(liveSignals.id, freshSignal.id));
          console.log(`[PositionMonitor] Position closed and signal #${freshSignal.id} marked closed (P&L: ${slRealizedPnl.toFixed(2)})`);
        } catch (err) {
          console.error(`[PositionMonitor] Failed to close SL position ${pos.symbol}:`, err);
          sendError(`PositionMonitor SL close failed: ${pos.symbol}`, err).catch(() => {});
        }
        continue;
      }

      // ---- Check TP1 hit (only if not already partial_exit) ----
      if (signalStatus === "filled") {
        const tp1Hit = isLong ? currentPrice >= tp1 : currentPrice <= tp1;
        if (tp1Hit) {
          console.log(
            `[PositionMonitor] TP1 HIT: ${pos.symbol} ${priceSource}=$${currentPrice} TP1=$${tp1} — closing 50%`,
          );
          try {
            // Cancel existing TP limit orders placed by exit-manager to prevent
            // over-selling (the limit orders would try to sell shares we're
            // already closing via the DELETE /positions endpoint)
            await cancelAllOrdersForSymbol(pos.symbol);
            const halfQty = posQty / 2;
            const safeQty = formatAlpacaQty(halfQty, isCrypto);
            await closePosition(pos.symbol, String(safeQty));
            await db
              .update(liveSignals)
              .set({ status: "partial_exit", tp1OrderId: null, tp2OrderId: null })
              .where(eq(liveSignals.id, freshSignal.id));
            console.log(`[PositionMonitor] 50% closed, signal #${freshSignal.id} → partial_exit`);
          } catch (err) {
            console.error(`[PositionMonitor] Failed to close TP1 position ${pos.symbol}:`, err);
            sendError(`PositionMonitor TP1 close failed: ${pos.symbol}`, err).catch(() => {});
          }
          continue;
        }
      }

      // ---- Check TP2 hit (only after partial_exit) ----
      if (signalStatus === "partial_exit") {
        const tp2Hit = isLong ? currentPrice >= tp2 : currentPrice <= tp2;
        if (tp2Hit) {
          console.log(
            `[PositionMonitor] TP2 HIT: ${pos.symbol} ${priceSource}=$${currentPrice} TP2=$${tp2} — closing remaining`,
          );
          try {
            // Cancel any remaining limit orders before closing
            await cancelAllOrdersForSymbol(pos.symbol);
            const safeQty = formatAlpacaQty(posQty, isCrypto);
            await closePosition(pos.symbol, String(safeQty));

            // Compute realized P&L for the full trade
            // TP1 closed ~50% at tp1, TP2 closes remaining at currentPrice (≈ tp2)
            const entryPriceTp2 = Number(freshSignal.filledAvgPrice || freshSignal.entryPrice);
            const filledQty = Number(freshSignal.filledQty || posQty);
            const tp2RealizedPnl = isLong
              ? (currentPrice - entryPriceTp2) * filledQty
              : (entryPriceTp2 - currentPrice) * filledQty;

            await db
              .update(liveSignals)
              .set({ status: "closed", realizedPnl: String(tp2RealizedPnl) })
              .where(eq(liveSignals.id, freshSignal.id));
            console.log(`[PositionMonitor] Remaining closed, signal #${freshSignal.id} → closed (P&L: ${tp2RealizedPnl.toFixed(2)})`);
          } catch (err) {
            console.error(`[PositionMonitor] Failed to close TP2 position ${pos.symbol}:`, err);
            sendError(`PositionMonitor TP2 close failed: ${pos.symbol}`, err).catch(() => {});
          }
          continue;
        }
      }
    }
  } catch (err) {
    console.error("[PositionMonitor] Monitor cycle failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("TradingRateLimit")) {
      sendError("Position monitor cycle failed", err).catch(() => {});
    }
  }
}
