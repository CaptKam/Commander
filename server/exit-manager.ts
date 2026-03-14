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

async function placeOrder(payload: Record<string, string>): Promise<AlpacaOrder> {
  const { key, secret, base } = getAlpacaConfig();
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
 * Cancel all open orders for a symbol.
 */
async function cancelAllOrdersForSymbol(symbol: string): Promise<void> {
  const { key, secret, base } = getAlpacaConfig();
  try {
    const res = await fetch(
      `${base}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`,
      { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret } },
    );
    if (!res.ok) return;
    const orders = (await res.json()) as AlpacaOrder[];
    await Promise.all(orders.map((o) => cancelOrder(o.id)));
    console.log(`[ExitManager] Cancelled ${orders.length} open orders for ${symbol}`);
  } catch (err) {
    console.error(`[ExitManager] Failed to cancel orders for ${symbol}:`, err);
  }
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
// Exit order placement — TP1 + TP2 (limit only, split 50/50)
//
// SL is NOT placed as a separate order because Alpaca enforces
// that total pending sell qty cannot exceed position size.
// TP1 (50%) + TP2 (50%) = 100%, leaving no room for a separate SL.
// Instead, SL is monitored software-side in the exit cycle (Phase 3).
//
// Quantity split uses floor() for TP1, remainder for TP2, so
// TP1 + TP2 = exactly filledQty with zero rounding overflow.
// ============================================================
async function placeExitOrders(signal: {
  id: number;
  symbol: string;
  direction: string;
  tp1Price: string;
  tp2Price: string;
  stopLossPrice: string;
  filledQty: string;
}): Promise<{ tp1Id: string; tp2Id: string }> {
  const isCrypto = signal.symbol.includes("/");
  const totalQty = Number(signal.filledQty);

  // Floor-based split: TP1 gets floor(50%), TP2 gets the remainder.
  // This guarantees TP1 + TP2 = totalQty exactly, no overflow.
  const tp1Qty = isCrypto
    ? Math.floor(totalQty * 0.5 * 1e9) / 1e9   // floor to 9 decimals (crypto max)
    : Math.floor(totalQty * 0.5);                // whole shares for equities
  const tp2Qty = isCrypto
    ? Math.round((totalQty - tp1Qty) * 1e9) / 1e9
    : totalQty - tp1Qty;

  // Exit side is opposite of entry
  const exitSide = signal.direction === "long" ? "sell" : "buy";

  // Anti-422 formatting (CLAUDE.md Rule #1)
  const safeTp1Qty = formatAlpacaQty(tp1Qty, isCrypto);
  const safeTp2Qty = formatAlpacaQty(tp2Qty, isCrypto);
  const safeTp1Price = formatAlpacaPrice(Number(signal.tp1Price), isCrypto);
  const safeTp2Price = formatAlpacaPrice(Number(signal.tp2Price), isCrypto);

  console.log(
    `[ExitManager] Placing exit orders for ${signal.symbol} #${signal.id}: ` +
    `TP1=${safeTp1Price} (qty ${safeTp1Qty}), TP2=${safeTp2Price} (qty ${safeTp2Qty}), ` +
    `SL=${formatAlpacaPrice(Number(signal.stopLossPrice), isCrypto)} (software-monitored)`,
  );

  // Place TP1 + TP2 as limit orders (50/50 split = 100% of position)
  const [tp1Order, tp2Order] = await Promise.all([
    placeOrder({
      symbol: signal.symbol,
      qty: String(safeTp1Qty),
      side: exitSide,
      type: "limit",
      time_in_force: "gtc",
      limit_price: String(safeTp1Price),
    }),
    placeOrder({
      symbol: signal.symbol,
      qty: String(safeTp2Qty),
      side: exitSide,
      type: "limit",
      time_in_force: "gtc",
      limit_price: String(safeTp2Price),
    }),
  ]);

  console.log(
    `[ExitManager] Exit orders placed for ${signal.symbol}: ` +
    `TP1=${tp1Order.id}, TP2=${tp2Order.id}`,
  );

  return { tp1Id: tp1Order.id, tp2Id: tp2Order.id };
}

// ============================================================
// Software SL — Get current price for a symbol
// ============================================================
function getCurrentPrice(symbol: string): number | null {
  return getStreamPrice(symbol) ?? getLatestCachedPrice(symbol);
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
          // Query ACTUAL Alpaca position to get real qty held.
          // This is the source of truth — not the order's filled_qty,
          // which can differ due to partial fills or rounding.
          const position = await getPosition(signal.symbol);
          const actualQty = position ? position.qty : order.filled_qty;

          if (!position) {
            console.warn(
              `[ExitManager] No Alpaca position found for ${signal.symbol} — ` +
              `falling back to order filled_qty=${order.filled_qty}`,
            );
          } else {
            console.log(
              `[ExitManager] Alpaca position for ${signal.symbol}: qty=${position.qty} ` +
              `(order filled_qty=${order.filled_qty})`,
            );
          }

          // Place TP1 + TP2 limit exit orders (SL monitored in software)
          const exits = await placeExitOrders({
            id: signal.id,
            symbol: signal.symbol,
            direction: signal.direction,
            tp1Price: signal.tp1Price,
            tp2Price: signal.tp2Price,
            stopLossPrice: signal.stopLossPrice,
            filledQty: actualQty,
          });

          // Persist to DB (CLAUDE.md Rule #2 — never in-memory only)
          await db
            .update(liveSignals)
            .set({
              status: "filled",
              filledQty: actualQty,
              filledAvgPrice: order.filled_avg_price,
              tp1OrderId: exits.tp1Id,
              tp2OrderId: exits.tp2Id,
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
              `[Exit] ${signal.symbol} exit order failed ${MAX_EXIT_RETRIES}x — manual intervention needed`,
            );
            await db
              .update(liveSignals)
              .set({
                status: "exit_failed",
                filledQty: order.filled_qty,
                filledAvgPrice: order.filled_avg_price,
                exitRetries: retries,
              })
              .where(eq(liveSignals.id, signal.id));
            sendError(
              `${signal.symbol} exit order failed ${MAX_EXIT_RETRIES}x — manual intervention needed`,
              err,
            ).catch(() => {});
          } else {
            // Increment retry counter, stay pending for next cycle
            await db
              .update(liveSignals)
              .set({
                exitRetries: retries,
                filledQty: order.filled_qty,
                filledAvgPrice: order.filled_avg_price,
              })
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

      // ---- Both TPs filled: mark closed ----
      if (tp1?.status === "filled" && tp2?.status === "filled") {
        console.log(`[ExitManager] Both TPs HIT: ${signal.symbol} #${signal.id}`);
        await db
          .update(liveSignals)
          .set({ status: "closed" })
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

      // ---- TP2 filled after partial_exit: mark closed ----
      if (tp2?.status === "filled" && signal.status === "partial_exit") {
        console.log(`[ExitManager] TP2 HIT: ${signal.symbol} #${signal.id} — fully closed`);
        await db
          .update(liveSignals)
          .set({ status: "closed" })
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

    for (const signal of openSignals) {
      const slPrice = Number(signal.stopLossPrice);
      if (!slPrice || slPrice <= 0) continue;

      const currentPrice = getCurrentPrice(signal.symbol);
      if (currentPrice === null) continue; // No price data available this cycle

      if (!isSlBreached(signal.direction, currentPrice, slPrice)) continue;

      // SL breached — emergency market exit
      console.log(
        `[ExitManager] SOFTWARE SL TRIGGERED: ${signal.symbol} #${signal.id} ` +
        `price=${currentPrice} sl=${slPrice} direction=${signal.direction}`,
      );

      try {
        const isCrypto = signal.symbol.includes("/");
        const totalQty = Number(signal.filledQty);
        const exitSide = signal.direction === "long" ? "sell" : "buy";

        // Determine remaining qty based on which TPs have filled
        // Uses same floor-based split as placeExitOrders for consistency
        let remainingQty = totalQty;
        if (signal.tp1OrderId) {
          const tp1 = await getOrder(signal.tp1OrderId);
          if (tp1?.status === "filled") {
            const tp1Qty = isCrypto
              ? Math.floor(totalQty * 0.5 * 1e9) / 1e9
              : Math.floor(totalQty * 0.5);
            remainingQty = isCrypto
              ? Math.round((totalQty - tp1Qty) * 1e9) / 1e9
              : totalQty - tp1Qty;
          }
        }

        // Cancel any outstanding TP orders before market exit
        const cancels: Promise<boolean>[] = [];
        if (signal.tp1OrderId) cancels.push(cancelOrder(signal.tp1OrderId));
        if (signal.tp2OrderId) cancels.push(cancelOrder(signal.tp2OrderId));
        await Promise.all(cancels);

        // Market sell remaining position
        const slOrder = await placeMarketExit(signal.symbol, remainingQty, exitSide, isCrypto);

        console.log(
          `[ExitManager] SL market exit placed: ${signal.symbol} #${signal.id} ` +
          `order=${slOrder.id} qty=${remainingQty}`,
        );

        await db
          .update(liveSignals)
          .set({
            status: "closed",
            slOrderId: slOrder.id,
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
    sendError("Exit manager cycle failed", err).catch(() => {});
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
    // No position — mark as closed
    await db
      .update(liveSignals)
      .set({ status: "closed" })
      .where(eq(liveSignals.id, signalId));
    return `${signal.symbol} #${signalId}: no Alpaca position found — marked closed`;
  }

  const actualQty = position.qty;
  console.log(
    `[ExitManager] Fix stuck: ${signal.symbol} #${signalId} actual position qty=${actualQty}`,
  );

  // Step 3: Place fresh exit orders using actual position qty
  try {
    const exits = await placeExitOrders({
      id: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      tp1Price: signal.tp1Price,
      tp2Price: signal.tp2Price,
      stopLossPrice: signal.stopLossPrice,
      filledQty: actualQty,
    });

    // Step 4: Update DB
    await db
      .update(liveSignals)
      .set({
        status: "filled",
        filledQty: actualQty,
        tp1OrderId: exits.tp1Id,
        tp2OrderId: exits.tp2Id,
        exitRetries: 0,
        executedAt: new Date(),
      })
      .where(eq(liveSignals.id, signalId));

    return (
      `${signal.symbol} #${signalId}: fixed — position qty=${actualQty}, ` +
      `TP1=${exits.tp1Id}, TP2=${exits.tp2Id}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${signal.symbol} #${signalId}: exit order placement failed — ${msg}`;
  }
}
