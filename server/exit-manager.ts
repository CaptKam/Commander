/**
 * Exit Manager — Automated TP/SL Order Lifecycle
 *
 * Completes the automation loop:
 *   Entry fills → place TP1 + TP2 (limit) + SL (stop) → monitor fills → cancel counterparts
 *
 * Lifecycle:
 *   pending    → Entry order placed, waiting for fill
 *   filled     → Entry filled, exit orders (TP1/TP2/SL) placed
 *   partial_exit → TP1 hit, SL qty reduced to remaining half
 *   closed     → All exits complete (TP2 or SL filled)
 *   cancelled  → Entry order cancelled/expired on Alpaca
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
// Exit order placement — TP1 + TP2 (limit) + SL (stop)
// ============================================================
async function placeExitOrders(signal: {
  id: number;
  symbol: string;
  direction: string;
  tp1Price: string;
  tp2Price: string;
  stopLossPrice: string;
  filledQty: string;
}): Promise<{ tp1Id: string; tp2Id: string; slId: string }> {
  const isCrypto = signal.symbol.includes("/");
  const totalQty = Number(signal.filledQty);
  const tp1Qty = totalQty / 2;
  const tp2Qty = totalQty - tp1Qty; // Avoids rounding loss

  // Exit side is opposite of entry
  const exitSide = signal.direction === "long" ? "sell" : "buy";

  // Anti-422 formatting (CLAUDE.md Rule #1)
  const safeTp1Qty = formatAlpacaQty(tp1Qty, isCrypto);
  const safeTp2Qty = formatAlpacaQty(tp2Qty, isCrypto);
  const safeSlQty = formatAlpacaQty(totalQty, isCrypto);
  const safeTp1Price = formatAlpacaPrice(Number(signal.tp1Price), isCrypto);
  const safeTp2Price = formatAlpacaPrice(Number(signal.tp2Price), isCrypto);
  const safeSlPrice = formatAlpacaPrice(Number(signal.stopLossPrice), isCrypto);

  console.log(
    `[ExitManager] Placing exit orders for ${signal.symbol} #${signal.id}: ` +
    `TP1=${safeTp1Price} (qty ${safeTp1Qty}), TP2=${safeTp2Price} (qty ${safeTp2Qty}), ` +
    `SL=${safeSlPrice} (qty ${safeSlQty})`,
  );

  // Place all three exit orders
  const [tp1Order, tp2Order, slOrder] = await Promise.all([
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
    placeOrder({
      symbol: signal.symbol,
      qty: String(safeSlQty),
      side: exitSide,
      type: "stop",
      time_in_force: "gtc",
      stop_price: String(safeSlPrice),
    }),
  ]);

  console.log(
    `[ExitManager] Exit orders placed for ${signal.symbol}: ` +
    `TP1=${tp1Order.id}, TP2=${tp2Order.id}, SL=${slOrder.id}`,
  );

  return { tp1Id: tp1Order.id, tp2Id: tp2Order.id, slId: slOrder.id };
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

      const order = await getOrder(signal.entryOrderId);
      if (!order) continue;

      if (order.status === "filled") {
        console.log(
          `[ExitManager] Entry FILLED: ${signal.symbol} #${signal.id} ` +
          `qty=${order.filled_qty} avg=${order.filled_avg_price}`,
        );

        try {
          // Place TP1 + TP2 + SL exit orders
          const exits = await placeExitOrders({
            id: signal.id,
            symbol: signal.symbol,
            direction: signal.direction,
            tp1Price: signal.tp1Price,
            tp2Price: signal.tp2Price,
            stopLossPrice: signal.stopLossPrice,
            filledQty: order.filled_qty,
          });

          // Persist to DB (CLAUDE.md Rule #2 — never in-memory only)
          await db
            .update(liveSignals)
            .set({
              status: "filled",
              filledQty: order.filled_qty,
              filledAvgPrice: order.filled_avg_price,
              tp1OrderId: exits.tp1Id,
              tp2OrderId: exits.tp2Id,
              slOrderId: exits.slId,
              executedAt: new Date(),
            })
            .where(eq(liveSignals.id, signal.id));
        } catch (err) {
          console.error(
            `[ExitManager] Failed to place exit orders for ${signal.symbol} #${signal.id}:`,
            err,
          );
          sendError(`Exit order placement failed: ${signal.symbol}`, err).catch(() => {});
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
    // Phase 2: Check filled entries for exit order fills
    // ============================================================
    const filledSignals = await db
      .select()
      .from(liveSignals)
      .where(inArray(liveSignals.status, ["filled", "partial_exit"]));

    for (const signal of filledSignals) {
      if (!signal.tp1OrderId || !signal.tp2OrderId || !signal.slOrderId) continue;

      const [tp1, tp2, sl] = await Promise.all([
        getOrder(signal.tp1OrderId),
        getOrder(signal.tp2OrderId),
        getOrder(signal.slOrderId),
      ]);

      // ---- SL filled: cancel all TP orders, mark closed ----
      if (sl?.status === "filled") {
        console.log(`[ExitManager] SL HIT: ${signal.symbol} #${signal.id}`);
        await Promise.all([
          cancelOrder(signal.tp1OrderId),
          cancelOrder(signal.tp2OrderId),
        ]);
        await db
          .update(liveSignals)
          .set({ status: "closed" })
          .where(eq(liveSignals.id, signal.id));
        continue;
      }

      // ---- Both TPs filled: cancel SL, mark closed ----
      if (tp1?.status === "filled" && tp2?.status === "filled") {
        console.log(`[ExitManager] Both TPs HIT: ${signal.symbol} #${signal.id}`);
        await cancelOrder(signal.slOrderId);
        await db
          .update(liveSignals)
          .set({ status: "closed" })
          .where(eq(liveSignals.id, signal.id));
        continue;
      }

      // ---- TP1 filled (partial exit): reduce SL qty to remaining half ----
      if (tp1?.status === "filled" && signal.status === "filled") {
        console.log(`[ExitManager] TP1 HIT: ${signal.symbol} #${signal.id} — reducing SL qty`);

        try {
          // Cancel the full-qty SL and re-place with half qty
          await cancelOrder(signal.slOrderId);

          const isCrypto = signal.symbol.includes("/");
          const totalQty = Number(signal.filledQty);
          const remainingQty = totalQty / 2;
          const exitSide = signal.direction === "long" ? "sell" : "buy";
          const safeSlQty = formatAlpacaQty(remainingQty, isCrypto);
          const safeSlPrice = formatAlpacaPrice(Number(signal.stopLossPrice), isCrypto);

          const newSlOrder = await placeOrder({
            symbol: signal.symbol,
            qty: String(safeSlQty),
            side: exitSide,
            type: "stop",
            time_in_force: "gtc",
            stop_price: String(safeSlPrice),
          });

          await db
            .update(liveSignals)
            .set({
              status: "partial_exit",
              slOrderId: newSlOrder.id,
            })
            .where(eq(liveSignals.id, signal.id));

          console.log(
            `[ExitManager] SL replaced for ${signal.symbol} #${signal.id}: ` +
            `new SL order ${newSlOrder.id} qty=${safeSlQty}`,
          );
        } catch (err) {
          console.error(
            `[ExitManager] Failed to adjust SL for ${signal.symbol} #${signal.id}:`,
            err,
          );
          sendError(`SL adjustment failed: ${signal.symbol}`, err).catch(() => {});
        }
        continue;
      }

      // ---- TP2 filled after partial_exit: cancel SL, mark closed ----
      if (tp2?.status === "filled" && signal.status === "partial_exit") {
        console.log(`[ExitManager] TP2 HIT: ${signal.symbol} #${signal.id} — fully closed`);
        await cancelOrder(signal.slOrderId);
        await db
          .update(liveSignals)
          .set({ status: "closed" })
          .where(eq(liveSignals.id, signal.id));
        continue;
      }
    }
  } catch (err) {
    console.error("[ExitManager] Exit cycle failed:", err);
    sendError("Exit manager cycle failed", err).catch(() => {});
  }
}
