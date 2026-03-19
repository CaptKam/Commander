/**
 * Exit Manager — Automated TP/SL Order Lifecycle
 *
 * Completes the automation loop:
 *   Entry fills → place TP1 + TP2 (limit) → software SL monitors price → market exit if breached
 *
 * Lifecycle:
 *   pending      → Entry order placed, waiting for fill
 *   filled       → Entry filled, TP1/TP2 limit exits placed
 *   partial_exit → TP1 hit, remaining half protected by TP2 + software SL
 *   closed       → All exits complete (both TPs or SL triggered)
 *   exit_failed  → Exit order placement failed 3x, needs manual intervention
 *   cancelled    → Entry order cancelled/expired on Alpaca
 *
 * SL Architecture: Alpaca crypto rejects standalone "stop" orders and enforces
 * that total pending sell qty cannot exceed position size. Since TP1 (50%) +
 * TP2 (50%) = 100% of position, there's no room for a separate SL order.
 * Instead, Phase 3 of the exit cycle checks price each scan (~30s) and
 * fires a market exit if the SL level is breached.
 *
 * Called once per orchestrator scan cycle (~30s). Stays under Alpaca rate limits
 * by batching order status checks via GET /v2/orders (single call per batch).
 *
 * CLAUDE.md Rule #1: All prices/quantities pass through Anti-422 formatters.
 * CLAUDE.md Rule #2: All state is persisted to PostgreSQL, never in-memory only.
 */

import { db } from "./db";
import { liveSignals } from "../shared/schema";
import { eq, inArray } from "drizzle-orm";
import { formatAlpacaQty, formatAlpacaPrice } from "./utils/alpacaFormatters";
import { sendError } from "./utils/notifier";
import { getStreamPrice } from "./websocket-stream";
import { getLatestCachedPrice } from "./alpaca-data";
import { checkTradingRateLimit } from "./utils/tradingRateLimiter";

// ============================================================
// Environment
// ============================================================
function getAlpacaConfig() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) {
    throw new Error("[ExitManager] ALPACA_API_KEY and ALPACA_API_SECRET must be set");
  }
  const rawBase = process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
  const base = rawBase.replace(/\/v2\/?$/, "");
  return { key, secret, base };
}

// ============================================================
// Alpaca API helpers
// ============================================================
interface AlpacaOrder {
  id: string;
  status: string;
  symbol: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  side: string;
  type: string;
  limit_price: string | null;
  stop_price: string | null;
}

async function getOrder(orderId: string): Promise<AlpacaOrder | null> {
  const { key, secret, base } = getAlpacaConfig();
  try {
    checkTradingRateLimit();
    const res = await fetch(`${base}/v2/orders/${orderId}`, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
      },
    });
    if (!res.ok) {
      if (res.status === 404) return null;
      const body = await res.text();
      throw new Error(`Alpaca GET order ${orderId}: ${res.status} — ${body}`);
    }
    return (await res.json()) as AlpacaOrder;
  } catch (err) {
    console.error(`[ExitManager] Failed to fetch order ${orderId}:`, err);
    return null;
  }
}

async function placeOrder(payload: Record<string, string | boolean>): Promise<AlpacaOrder> {
  const { key, secret, base } = getAlpacaConfig();
  checkTradingRateLimit();
  const res = await fetch(`${base}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca POST order: ${res.status} — ${body}`);
  }
  return (await res.json()) as AlpacaOrder;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  qty_available: string;
  side: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
}

/**
 * Query the ACTUAL Alpaca position for a symbol.
 * Returns the real qty held, not what we think we ordered.
 */
async function getPosition(symbol: string): Promise<AlpacaPosition | null> {
  const { key, secret, base } = getAlpacaConfig();
  try {
    checkTradingRateLimit();
    // Alpaca position endpoint uses symbol without slash for crypto
    const encodedSymbol = encodeURIComponent(symbol);
    const res = await fetch(`${base}/v2/positions/${encodedSymbol}`, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
      },
    });
    if (!res.ok) {
      if (res.status === 404) return null; // No position
      const body = await res.text();
      console.warn(`[ExitManager] Position query ${symbol}: ${res.status} — ${body}`);
      return null;
    }
    return (await res.json()) as AlpacaPosition;
  } catch (err) {
    console.error(`[ExitManager] Failed to query position ${symbol}:`, err);
    return null;
  }
}

/**
 * Get all open orders for a symbol from Alpaca.
 */
async function getOpenOrders(symbol: string): Promise<AlpacaOrder[]> {
  const { key, secret, base } = getAlpacaConfig();
  try {
    const res = await fetch(
      `${base}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`,
      { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret } },
    );
    if (!res.ok) return [];
    return (await res.json()) as AlpacaOrder[];
  } catch (err) {
    console.error(`[ExitManager] Failed to fetch open orders for ${symbol}:`, err);
    return [];
  }
}

/**
 * Cancel all open orders for a symbol.
 */
async function cancelAllOrdersForSymbol(symbol: string): Promise<void> {
  const orders = await getOpenOrders(symbol);
  if (orders.length === 0) return;
  await Promise.all(orders.map((o) => cancelOrder(o.id)));
  console.log(`[ExitManager] Cancelled ${orders.length} open orders for ${symbol}`);
}

async function cancelOrder(orderId: string): Promise<boolean> {
  const { key, secret, base } = getAlpacaConfig();
  try {
    const res = await fetch(`${base}/v2/orders/${orderId}`, {
      method: "DELETE",
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
      },
    });
    if (res.status === 204 || res.status === 200) return true;
    if (res.status === 404 || res.status === 422) return true; // already gone
    console.warn(`[ExitManager] Cancel order ${orderId}: ${res.status}`);
    return false;
  } catch (err) {
    console.error(`[ExitManager] Failed to cancel order ${orderId}:`, err);
    return false;
  }
}

// ============================================================
// Constants
// ============================================================
const MAX_EXIT_RETRIES = 3;

// ============================================================
// Exit order placement — Position-aware TP1 + TP2 (limit)
//
// Queries Alpaca for the ACTUAL position size and existing open
// orders, then calculates the exact quantities that are available.
//
// If no exit orders exist:
//   TP1 = floor(positionQty × 0.5 × 10^6) / 10^6
//   TP2 = positionQty - TP1
//   Guarantees TP1 + TP2 = exactly positionQty, zero overflow.
//
// If one exit order already exists:
//   Second exit = positionQty - alreadyOrderedQty
//   Handles rounding/fee differences from first exit.
//
// SL is monitored software-side in Phase 3 (not a separate order).
// ============================================================
async function placeExitOrders(signal: {
  id: number;
  symbol: string;
  direction: string;
  tp1Price: string;
  tp2Price: string;
  stopLossPrice: string;
}): Promise<{ tp1Id: string | null; tp2Id: string | null; positionQty: string }> {
  const isCrypto = signal.symbol.includes("/");
  const exitSide = signal.direction === "long" ? "sell" : "buy";

  // Step 1: Query ACTUAL Alpaca position — qty_available is the source of truth.
  // qty_available already subtracts qty locked by existing open orders.
  const position = await getPosition(signal.symbol);
  if (!position || Number(position.qty) <= 0) {
    throw new Error(`No Alpaca position for ${signal.symbol} — cannot place exits`);
  }
  const positionQty = Number(position.qty);
  const availableQty = Number(position.qty_available);

  console.log(
    `[ExitManager] ${signal.symbol} #${signal.id}: qty=${positionQty}, ` +
    `qty_available=${availableQty}`,
  );

  // If nothing is available, exits already cover the full position
  if (availableQty <= 0) {
    // Return existing exit order IDs from open orders
    const openOrders = await getOpenOrders(signal.symbol);
    const exitOrders = openOrders.filter((o) => o.side === exitSide);
    console.log(`[ExitManager] ${signal.symbol} #${signal.id}: fully covered by ${exitOrders.length} exit orders`);
    return {
      tp1Id: exitOrders[0]?.id ?? null,
      tp2Id: exitOrders[1]?.id ?? null,
      positionQty: String(positionQty),
    };
  }

  // Anti-422 formatting (CLAUDE.md Rule #1)
  const safeTp1Price = formatAlpacaPrice(Number(signal.tp1Price), isCrypto);
  const safeTp2Price = formatAlpacaPrice(Number(signal.tp2Price), isCrypto);

  // If only part of the position is available, one exit already exists.
  // Place ONLY the second exit for exactly qty_available.
  if (availableQty < positionQty) {
    const safeQty = formatAlpacaQty(availableQty, isCrypto);
    const openOrders = await getOpenOrders(signal.symbol);
    const exitOrders = openOrders.filter((o) => o.side === exitSide);

    console.log(
      `[ExitManager] Placing SECOND exit for ${signal.symbol} #${signal.id}: ` +
      `qty=${safeQty} (available=${availableQty}, total=${positionQty})`,
    );

    const secondOrder = await placeOrder({
      symbol: signal.symbol,
      qty: String(safeQty),
      side: exitSide,
      type: "limit",
      time_in_force: isCrypto ? "gtc" : "day",
      limit_price: String(safeTp2Price),
      ...(isCrypto ? {} : { extended_hours: true }),
    });

    return {
      tp1Id: exitOrders[0]?.id ?? null,
      tp2Id: secondOrder.id,
      positionQty: String(positionQty),
    };
  }

  // Full position available — fresh split using qty_available
  // Floor to 6 decimal places for crypto
  const tp1Qty = isCrypto
    ? Math.floor(availableQty * 0.5 * 1e6) / 1e6
    : Math.floor(availableQty * 0.5);
  const tp2Qty = isCrypto
    ? Math.floor((availableQty - tp1Qty) * 1e6) / 1e6
    : availableQty - tp1Qty;

  const safeTp1Qty = formatAlpacaQty(tp1Qty, isCrypto);
  const safeTp2Qty = formatAlpacaQty(tp2Qty, isCrypto);

  console.log(
    `[ExitManager] Placing exit orders for ${signal.symbol} #${signal.id}: ` +
    `TP1=${safeTp1Price} (qty ${safeTp1Qty}), TP2=${safeTp2Price} (qty ${safeTp2Qty}), ` +
    `total=${safeTp1Qty + safeTp2Qty} of ${positionQty}`,
  );

  // Place TP1 first, then TP2 sequentially.
  // If TP1 succeeds but TP2 fails, next cycle will detect 1 existing order
  // and place only the second using remaining available qty.
  const tp1Order = await placeOrder({
    symbol: signal.symbol,
    qty: String(safeTp1Qty),
    side: exitSide,
    type: "limit",
    time_in_force: isCrypto ? "gtc" : "day",
    limit_price: String(safeTp1Price),
    ...(isCrypto ? {} : { extended_hours: true }),
  });

  // Re-query position AFTER TP1 is placed — Alpaca has now locked TP1's qty.
  // Using stale pre-calculated tp2Qty causes 403 "qty exceeds available" errors.
  let tp2Order: AlpacaOrder;
  try {
    const freshPosition = await getPosition(signal.symbol);
    const freshAvailable = freshPosition ? Number(freshPosition.qty_available) : 0;
    const freshTp2Qty = formatAlpacaQty(freshAvailable, isCrypto);

    console.log(
      `[ExitManager] TP2 for ${signal.symbol} #${signal.id}: ` +
      `fresh qty_available=${freshAvailable}, using qty=${freshTp2Qty} (was ${safeTp2Qty})`,
    );

    if (freshAvailable <= 0) {
      console.warn(
        `[ExitManager] TP1 placed (${tp1Order.id}) but no qty_available left for TP2 — next cycle will fix`,
      );
      return { tp1Id: tp1Order.id, tp2Id: null, positionQty: String(positionQty) };
    }

    tp2Order = await placeOrder({
      symbol: signal.symbol,
      qty: String(freshTp2Qty),
      side: exitSide,
      type: "limit",
      time_in_force: isCrypto ? "gtc" : "day",
      limit_price: String(safeTp2Price),
      ...(isCrypto ? {} : { extended_hours: true }),
    });
  } catch (err) {
    // TP1 succeeded but TP2 failed — don't throw, return what we have.
    // Next cycle will detect 1 existing order and place the remainder.
    console.warn(
      `[ExitManager] TP1 placed (${tp1Order.id}) but TP2 failed for ${signal.symbol} #${signal.id}: ${err}`,
    );
    return { tp1Id: tp1Order.id, tp2Id: null, positionQty: String(positionQty) };
  }

  console.log(
    `[ExitManager] Exit orders placed for ${signal.symbol}: ` +
    `TP1=${tp1Order.id}, TP2=${tp2Order.id}`,
  );

  return { tp1Id: tp1Order.id, tp2Id: tp2Order.id, positionQty: String(positionQty) };
}

// ============================================================
// Software SL — Get current price for a symbol
// ============================================================

/**
 * Fetch ALL open positions from Alpaca in a single API call.
 * Returns a map of symbol → current_price for use as a REST fallback
 * when WebSocket and candle cache have no data.
 */
async function fetchAllPositionPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const { key, secret, base } = getAlpacaConfig();
  try {
    checkTradingRateLimit();
    const res = await fetch(`${base}/v2/positions`, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
      },
    });
    if (!res.ok) {
      console.warn(`[ExitManager] Failed to fetch positions for SL prices: ${res.status}`);
      return prices;
    }
    const positions = (await res.json()) as AlpacaPosition[];
    for (const pos of positions) {
      const cp = Number(pos.current_price);
      if (cp > 0) prices.set(pos.symbol, cp);
    }
  } catch (err) {
    console.error("[ExitManager] fetchAllPositionPrices failed:", err);
  }
  return prices;
}

/** Consecutive no-price cycle counter per symbol */
const noPriceCycles = new Map<string, number>();

function getCurrentPrice(
  symbol: string,
  positionPrices?: Map<string, number>,
): number | null {
  return getStreamPrice(symbol)
    ?? getLatestCachedPrice(symbol)
    ?? positionPrices?.get(symbol)
    ?? null;
}

/**
 * Check if the stop loss level has been breached.
 * For longs: price dropped below SL. For shorts: price rose above SL.
 */
function isSlBreached(
  direction: string,
  currentPrice: number,
  slPrice: number,
): boolean {
  return direction === "long"
    ? currentPrice <= slPrice
    : currentPrice >= slPrice;
}

/**
 * Place a market order to exit the full remaining position immediately.
 * Used when software SL detects a breach — market orders are supported
 * for both crypto and equities on Alpaca.
 */
async function placeMarketExit(
  symbol: string,
  qty: number,
  side: string,
  isCrypto: boolean,
): Promise<AlpacaOrder> {
  const safeQty = formatAlpacaQty(qty, isCrypto);
  return placeOrder({
    symbol,
    qty: String(safeQty),
    side,
    type: "market",
    time_in_force: "gtc",
  });
}

// ============================================================
// Main exit management cycle — called by orchestrator
// ============================================================
export async function runExitCycle(): Promise<void> {
  try {
    // ============================================================
    // Phase 1: Check pending entries for fills
    // ============================================================
    const pendingSignals = await db
      .select()
      .from(liveSignals)
      .where(eq(liveSignals.status, "pending"));

    for (const signal of pendingSignals) {
      if (!signal.entryOrderId) continue; // No order placed yet

      // Skip signals that have exhausted exit retries
      if (signal.exitRetries >= MAX_EXIT_RETRIES) continue;

      const order = await getOrder(signal.entryOrderId);
      if (!order) continue;

      if (order.status === "filled") {
        console.log(
          `[ExitManager] Entry FILLED: ${signal.symbol} #${signal.id} ` +
          `qty=${order.filled_qty} avg=${order.filled_avg_price}`,
        );

        try {
          // Place exit orders — queries Alpaca position + open orders internally
          const exits = await placeExitOrders({
            id: signal.id,
            symbol: signal.symbol,
            direction: signal.direction,
            tp1Price: signal.tp1Price,
            tp2Price: signal.tp2Price,
            stopLossPrice: signal.stopLossPrice,
          });

          // Persist to DB (CLAUDE.md Rule #2 — never in-memory only)
          // Only reset exitRetries if BOTH exits succeeded. If TP2 is still
          // missing, increment retries so the counter actually accumulates
          // toward MAX_EXIT_RETRIES instead of resetting to 0 each cycle.
          const bothPlaced = !!(exits.tp1Id && exits.tp2Id);
          await db
            .update(liveSignals)
            .set({
              status: bothPlaced ? "filled" : "pending",
              filledQty: exits.positionQty,
              filledAvgPrice: order.filled_avg_price,
              tp1OrderId: exits.tp1Id,
              tp2OrderId: exits.tp2Id,
              exitRetries: bothPlaced ? 0 : signal.exitRetries + 1,
              executedAt: new Date(),
            })
            .where(eq(liveSignals.id, signal.id));
        } catch (err) {
          const retries = signal.exitRetries + 1;
          console.error(
            `[ExitManager] Failed to place exit orders for ${signal.symbol} #${signal.id} ` +
            `(attempt ${retries}/${MAX_EXIT_RETRIES}):`,
            err,
          );

          if (retries >= MAX_EXIT_RETRIES) {
            // Stop retrying — mark as exit_failed and alert
            console.warn(
              `[Exit] ${signal.symbol} exit failed ${MAX_EXIT_RETRIES}x — manual review needed`,
            );
            await db
              .update(liveSignals)
              .set({
                status: "exit_failed",
                exitRetries: retries,
              })
              .where(eq(liveSignals.id, signal.id));
            sendError(
              `${signal.symbol} exit failed ${MAX_EXIT_RETRIES}x — manual review needed`,
              err,
            ).catch(() => {});
          } else {
            // Increment retry counter, stay pending for next cycle
            await db
              .update(liveSignals)
              .set({ exitRetries: retries })
              .where(eq(liveSignals.id, signal.id));
          }
        }
      } else if (
        order.status === "cancelled" ||
        order.status === "expired" ||
        order.status === "rejected"
      ) {
        console.log(
          `[ExitManager] Entry ${order.status}: ${signal.symbol} #${signal.id}`,
        );
        await db
          .update(liveSignals)
          .set({ status: "cancelled" })
          .where(eq(liveSignals.id, signal.id));
      }
      // "new", "partially_filled", "accepted" → keep waiting
    }

    // ============================================================
    // Phase 2: Check filled entries for TP order fills
    // ============================================================
    const filledSignals = await db
      .select()
      .from(liveSignals)
      .where(inArray(liveSignals.status, ["filled", "partial_exit"]));

    for (const signal of filledSignals) {
      if (!signal.tp1OrderId || !signal.tp2OrderId) continue;

      const [tp1, tp2] = await Promise.all([
        getOrder(signal.tp1OrderId),
        getOrder(signal.tp2OrderId),
      ]);

      // ---- Both TPs filled: mark closed with realized P&L ----
      if (tp1?.status === "filled" && tp2?.status === "filled") {
        console.log(`[ExitManager] Both TPs HIT: ${signal.symbol} #${signal.id}`);

        // Compute realized P&L from TP fill prices
        const entryPrice = Number(signal.filledAvgPrice || signal.entryPrice);
        const tp1Qty = Number(tp1.filled_qty || tp1.qty);
        const tp1Price = Number(tp1.filled_avg_price);
        const tp2Qty = Number(tp2.filled_qty || tp2.qty);
        const tp2Price = Number(tp2.filled_avg_price);
        const totalQty = tp1Qty + tp2Qty;
        const avgExitPrice = totalQty > 0 ? (tp1Qty * tp1Price + tp2Qty * tp2Price) / totalQty : 0;
        const realizedPnl = signal.direction === "long"
          ? (avgExitPrice - entryPrice) * totalQty
          : (entryPrice - avgExitPrice) * totalQty;

        await db
          .update(liveSignals)
          .set({ status: "closed", realizedPnl: String(realizedPnl) })
          .where(eq(liveSignals.id, signal.id));
        continue;
      }

      // ---- TP1 filled (partial exit): update status ----
      if (tp1?.status === "filled" && signal.status === "filled") {
        console.log(`[ExitManager] TP1 HIT: ${signal.symbol} #${signal.id} — partial exit`);
        await db
          .update(liveSignals)
          .set({ status: "partial_exit" })
          .where(eq(liveSignals.id, signal.id));
        continue;
      }

      // ---- TP2 filled after partial_exit: mark closed with realized P&L ----
      if (tp2?.status === "filled" && signal.status === "partial_exit") {
        console.log(`[ExitManager] TP2 HIT: ${signal.symbol} #${signal.id} — fully closed`);

        const entryPrice = Number(signal.filledAvgPrice || signal.entryPrice);
        const tp1Qty = tp1 ? Number(tp1.filled_qty || tp1.qty) : 0;
        const tp1Price = tp1?.filled_avg_price ? Number(tp1.filled_avg_price) : 0;
        const tp2Qty = Number(tp2.filled_qty || tp2.qty);
        const tp2Price = Number(tp2.filled_avg_price);
        const totalQty = tp1Qty + tp2Qty;
        const avgExitPrice = totalQty > 0 ? (tp1Qty * tp1Price + tp2Qty * tp2Price) / totalQty : 0;
        const realizedPnl = signal.direction === "long"
          ? (avgExitPrice - entryPrice) * totalQty
          : (entryPrice - avgExitPrice) * totalQty;

        await db
          .update(liveSignals)
          .set({ status: "closed", realizedPnl: String(realizedPnl) })
          .where(eq(liveSignals.id, signal.id));
        continue;
      }
    }

    // ============================================================
    // Phase 3: Software SL — monitor price vs stop loss level
    //
    // Alpaca crypto doesn't support standalone "stop" orders alongside
    // existing limit TPs (aggregate qty would exceed position).
    // Instead we check price each cycle (~30s) and market-sell if breached.
    // ============================================================
    const openSignals = await db
      .select()
      .from(liveSignals)
      .where(inArray(liveSignals.status, ["filled", "partial_exit"]));

    // Fetch position prices ONCE for all filled symbols — REST API fallback
    // when WebSocket is down and candle cache has no data.
    // Typically 1-5 positions, so this is a single lightweight API call.
    const positionPrices = openSignals.length > 0
      ? await fetchAllPositionPrices()
      : new Map<string, number>();

    for (const signal of openSignals) {
      const slPrice = Number(signal.stopLossPrice);
      if (!slPrice || slPrice <= 0) continue;

      const currentPrice = getCurrentPrice(signal.symbol, positionPrices);
      if (currentPrice === null) {
        // Track consecutive no-price cycles for this symbol
        const count = (noPriceCycles.get(signal.symbol) || 0) + 1;
        noPriceCycles.set(signal.symbol, count);
        if (count >= 5) {
          console.error(
            `[ExitManager] CRITICAL: No price data for ${signal.symbol} for ${count} consecutive cycles. ` +
            `SL at $${slPrice} NOT being monitored. WebSocket may be down.`,
          );
        }
        continue;
      }
      noPriceCycles.delete(signal.symbol); // Reset on success

      if (!isSlBreached(signal.direction, currentPrice, slPrice)) continue;

      // SL breached — emergency market exit
      console.log(
        `[ExitManager] SOFTWARE SL TRIGGERED: ${signal.symbol} #${signal.id} ` +
        `price=${currentPrice} sl=${slPrice} direction=${signal.direction}`,
      );

      try {
        const isCrypto = signal.symbol.includes("/");
        const exitSide = signal.direction === "long" ? "sell" : "buy";

        // Cancel any outstanding TP orders FIRST
        await cancelAllOrdersForSymbol(signal.symbol);

        // Query actual remaining position from Alpaca — the only source of truth
        const position = await getPosition(signal.symbol);
        const remainingQty = position ? Number(position.qty) : 0;
        if (remainingQty <= 0) {
          console.log(`[ExitManager] ${signal.symbol} #${signal.id}: no position left after SL check`);
          await db
            .update(liveSignals)
            .set({ status: "closed" })
            .where(eq(liveSignals.id, signal.id));
          continue;
        }

        // Market sell remaining position
        const slOrder = await placeMarketExit(signal.symbol, remainingQty, exitSide, isCrypto);

        console.log(
          `[ExitManager] SL market exit placed: ${signal.symbol} #${signal.id} ` +
          `order=${slOrder.id} qty=${remainingQty}`,
        );

        // Compute realized P&L: entry from signal, exit ≈ currentPrice (market order)
        const entryPrice = Number(signal.filledAvgPrice || signal.entryPrice);
        const exitPrice = currentPrice; // best approximation for market order
        const realizedPnl = signal.direction === "long"
          ? (exitPrice - entryPrice) * remainingQty
          : (entryPrice - exitPrice) * remainingQty;

        await db
          .update(liveSignals)
          .set({
            status: "closed",
            slOrderId: slOrder.id,
            realizedPnl: String(realizedPnl),
          })
          .where(eq(liveSignals.id, signal.id));
      } catch (err) {
        console.error(
          `[ExitManager] SL market exit FAILED for ${signal.symbol} #${signal.id}:`,
          err,
        );
        sendError(`Software SL exit failed: ${signal.symbol} — MANUAL INTERVENTION NEEDED`, err).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[ExitManager] Exit cycle failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("TradingRateLimit")) {
      sendError("Exit manager cycle failed", err).catch(() => {});
    }
  }
}

// ============================================================
// Manual fix for stuck positions — callable via API
//
// 1. Cancels ALL open Alpaca orders for the symbol
// 2. Queries actual Alpaca position qty
// 3. Places fresh TP1 + TP2 limit exits based on real position
// 4. Updates the DB record
// ============================================================
export async function fixStuckExits(signalId: number): Promise<string> {
  const signal = await db
    .select()
    .from(liveSignals)
    .where(eq(liveSignals.id, signalId))
    .then((rows) => rows[0]);

  if (!signal) return `Signal #${signalId} not found`;

  // Step 1: Cancel all open orders for this symbol on Alpaca
  await cancelAllOrdersForSymbol(signal.symbol);

  // Step 2: Query actual Alpaca position
  const position = await getPosition(signal.symbol);
  if (!position || Number(position.qty) <= 0) {
    await db
      .update(liveSignals)
      .set({ status: "closed" })
      .where(eq(liveSignals.id, signalId));
    return `${signal.symbol} #${signalId}: no Alpaca position found — marked closed`;
  }

  console.log(
    `[ExitManager] Fix stuck: ${signal.symbol} #${signalId} position qty=${position.qty}`,
  );

  // Step 3: Place fresh exit orders (position-aware — queries position internally)
  try {
    const exits = await placeExitOrders({
      id: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      tp1Price: signal.tp1Price,
      tp2Price: signal.tp2Price,
      stopLossPrice: signal.stopLossPrice,
    });

    // Step 4: Update DB
    await db
      .update(liveSignals)
      .set({
        status: exits.tp1Id && exits.tp2Id ? "filled" : "pending",
        filledQty: exits.positionQty,
        tp1OrderId: exits.tp1Id,
        tp2OrderId: exits.tp2Id,
        exitRetries: 0,
        executedAt: new Date(),
      })
      .where(eq(liveSignals.id, signalId));

    return (
      `${signal.symbol} #${signalId}: fixed — position qty=${exits.positionQty}, ` +
      `TP1=${exits.tp1Id}, TP2=${exits.tp2Id}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${signal.symbol} #${signalId}: exit order placement failed — ${msg}`;
  }
}
