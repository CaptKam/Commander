/**
 * Dashboard API Router
 * Serves live signal data, Alpaca account info, and system health.
 */

import { Router } from "express";
import { db } from "./db";
import { liveSignals, watchlist, systemSettings, symbolScanState } from "../shared/schema";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { getCacheStats, getLatestCachedPrice, fetchWatchlist } from "./alpaca-data";
import { getStreamPrice, getStreamStatus, getAllStreamPrices, getPriceFreshnessStats } from "./websocket-stream";
import { fixStuckExits } from "./exit-manager";
import { lastScanTimestamp, lastScanCandidates, lastScanPassedFilter, totalScanCount, isStockMarketOpen, pipelineStats } from "./orchestrator";

const router = Router();

// ============================================================
// In-memory response cache — reduces DB round-trips
// Each cached endpoint stores { data, expiresAt }
// ============================================================
const responseCache = new Map<string, { data: any; expiresAt: number }>();

function getCachedResponse<T>(key: string): T | null {
  const entry = responseCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data as T;
  return null;
}

function setCacheResponse(key: string, data: any, ttlMs: number): void {
  responseCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Alpaca trading API base (NOT market data)
const rawBase = process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
const ALPACA_BASE_URL = rawBase.replace(/\/v2\/?$/, "");

function alpacaHeaders(): Record<string, string> | null {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) return null;
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

/**
 * GET /api/account — Live account equity, buying power, P&L from Alpaca.
 */
router.get("/account", async (_req, res) => {
  try {
    const headers = alpacaHeaders();
    if (!headers) {
      return res.json({
        equity: 0,
        buying_power: 0,
        portfolio_value: 0,
        daily_pl: 0,
        daily_pl_pct: 0,
        error: "Alpaca keys not configured",
      });
    }
    const r = await fetch(`${ALPACA_BASE_URL}/v2/account`, { headers });
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: body });
    }
    const acct = (await r.json()) as Record<string, string>;
    res.json({
      equity: Number(acct.equity),
      buying_power: Number(acct.buying_power),
      portfolio_value: Number(acct.portfolio_value),
      daily_pl: Number(acct.equity) - Number(acct.last_equity),
      daily_pl_pct:
        Number(acct.last_equity) > 0
          ? ((Number(acct.equity) - Number(acct.last_equity)) /
              Number(acct.last_equity)) *
            100
          : 0,
    });
  } catch (err) {
    console.error("[API] Failed to fetch account:", err);
    res.status(500).json({ error: "Failed to fetch account" });
  }
});

/**
 * GET /api/positions — Current open positions from Alpaca, enriched with SL/TP from signals.
 */
router.get("/positions", async (_req, res) => {
  try {
    const headers = alpacaHeaders();
    if (!headers) {
      return res.json([]);
    }
    const r = await fetch(`${ALPACA_BASE_URL}/v2/positions`, { headers });
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: body });
    }
    const positions = (await r.json()) as Record<string, string>[];

    // Fetch the latest executed signal per symbol to attach SL/TP
    const recentSignals = await db
      .select()
      .from(liveSignals)
      .orderBy(desc(liveSignals.createdAt))
      .limit(200);

    const signalMap = new Map<string, typeof recentSignals[number]>();
    for (const sig of recentSignals) {
      // Keep only the most recent signal per symbol
      if (!signalMap.has(sig.symbol)) {
        signalMap.set(sig.symbol, sig);
      }
    }

    res.json(
      positions.map((p) => {
        const sig = signalMap.get(p.symbol);
        return {
          symbol: p.symbol,
          qty: Number(p.qty),
          side: p.side,
          entry_price: sig ? Number(sig.entryPrice) : Number(p.avg_entry_price),
          current_price: Number(p.current_price),
          market_value: Number(p.market_value),
          unrealized_pl: Number(p.unrealized_pl),
          unrealized_pl_pct: Number(p.unrealized_plpc) * 100,
          stop_loss: sig ? Number(sig.stopLossPrice) : null,
          tp1: sig ? Number(sig.tp1Price) : null,
          tp2: sig ? Number(sig.tp2Price) : null,
          pattern: sig?.patternType ?? null,
        };
      }),
    );
  } catch (err) {
    console.error("[API] Failed to fetch positions:", err);
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});

/**
 * GET /api/signals — Returns the most recent live signals from the DB.
 * Deduplicates by (symbol, pattern, timeframe) to show only the latest of each.
 */
router.get("/signals", async (_req, res) => {
  try {
    const signals = await db
      .select()
      .from(liveSignals)
      .orderBy(desc(liveSignals.createdAt));

    // Deduplicate: keep only the most recent signal per (symbol, patternType, timeframe)
    const seen = new Set<string>();
    const deduplicated = [];
    for (const sig of signals) {
      const key = `${sig.symbol}:${sig.patternType}:${sig.timeframe}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(sig);
        if (deduplicated.length >= 50) break; // Limit to 50 unique patterns
      }
    }

    res.json(deduplicated);
  } catch (err) {
    console.error("[API] Failed to fetch signals:", err);
    res.status(500).json({ error: "Failed to fetch signals" });
  }
});

/**
 * GET /api/metrics — Win Rate, Profit Factor, and total trade count
 * from Alpaca's closed order / activity history.
 */
router.get("/metrics", async (_req, res) => {
  const cached = getCachedResponse("metrics");
  if (cached) return res.json(cached);
  try {
    const headers = alpacaHeaders();
    if (!headers) {
      return res.json({ win_rate: 0, profit_factor: 0, total_trades: 0, wins: 0, losses: 0 });
    }

    // Fetch closed orders from Alpaca portfolio history
    const r = await fetch(
      `${ALPACA_BASE_URL}/v2/orders?status=closed&limit=200&direction=desc`,
      { headers },
    );
    if (!r.ok) {
      return res.json({ win_rate: 0, profit_factor: 0, total_trades: 0, wins: 0, losses: 0 });
    }
    const orders = (await r.json()) as Record<string, string>[];

    // Match closed filled orders with their signals to compute P&L
    const filledOrders = orders.filter((o) => o.status === "filled" && o.filled_avg_price);

    // Get all signals to match against
    const allSignals = await db
      .select()
      .from(liveSignals)
      .orderBy(desc(liveSignals.createdAt))
      .limit(500);

    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;

    // Group filled orders by symbol to pair entries/exits
    const symbolOrders = new Map<string, typeof filledOrders>();
    for (const o of filledOrders) {
      const sym = o.symbol;
      if (!symbolOrders.has(sym)) symbolOrders.set(sym, []);
      symbolOrders.get(sym)!.push(o);
    }

    // Compute actual win/loss from closed signals based on their exit outcome
    // (not R:R heuristic — that tells you setup quality, not actual results)
    for (const sig of allSignals) {
      // Only count fully closed signals with real fill data
      if (sig.status !== "closed") continue;
      const entry = Number(sig.filledAvgPrice || sig.entryPrice);
      if (!entry) continue;

      // Find exit orders for this signal's symbol
      const symOrders = symbolOrders.get(sig.symbol);
      if (!symOrders) continue;

      // Look for exit side orders (sells for longs, buys for shorts)
      const exitSide = sig.direction === "long" ? "sell" : "buy";
      const exitOrders = symOrders.filter((o) => o.side === exitSide && Number(o.filled_avg_price) > 0);
      if (exitOrders.length === 0) continue;

      // Compute weighted avg exit price
      let totalQty = 0;
      let totalValue = 0;
      for (const o of exitOrders) {
        const qty = Number(o.filled_qty || o.qty);
        const price = Number(o.filled_avg_price);
        if (qty > 0 && price > 0) {
          totalQty += qty;
          totalValue += qty * price;
        }
      }
      if (totalQty === 0) continue;
      const avgExitPrice = totalValue / totalQty;

      // P&L based on actual direction
      const pl = sig.direction === "long"
        ? (avgExitPrice - entry) * totalQty
        : (entry - avgExitPrice) * totalQty;

      if (pl >= 0) {
        wins++;
        grossProfit += pl;
      } else {
        losses++;
        grossLoss += Math.abs(pl);
      }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const result = {
      win_rate: Math.round(winRate * 10) / 10,
      profit_factor: Math.round(profitFactor * 100) / 100,
      total_trades: totalTrades,
      wins,
      losses,
    };
    setCacheResponse("metrics", result, 60_000); // 60s
    res.json(result);
  } catch (err) {
    console.error("[API] Failed to compute metrics:", err);
    res.status(500).json({ error: "Failed to compute metrics" });
  }
});

/**
 * GET /api/history — Closed orders from Alpaca for the Trade History graveyard.
 */
router.get("/history", async (_req, res) => {
  const cached = getCachedResponse("history");
  if (cached) return res.json(cached);
  try {
    const headers = alpacaHeaders();
    if (!headers) {
      return res.json([]);
    }

    const r = await fetch(
      `${ALPACA_BASE_URL}/v2/orders?status=closed&limit=50&direction=desc`,
      { headers },
    );
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: body });
    }
    const orders = (await r.json()) as Record<string, string>[];

    // Enrich with signal data
    const allSignals = await db
      .select()
      .from(liveSignals)
      .orderBy(desc(liveSignals.createdAt))
      .limit(200);

    const signalMap = new Map<string, typeof allSignals[number]>();
    for (const sig of allSignals) {
      if (!signalMap.has(sig.symbol)) {
        signalMap.set(sig.symbol, sig);
      }
    }

    const history = orders
      .filter((o) => o.status === "filled")
      .slice(0, 20)
      .map((o) => {
        const sig = signalMap.get(o.symbol);
        return {
          symbol: o.symbol,
          side: o.side,
          qty: Number(o.filled_qty || o.qty),
          filled_price: Number(o.filled_avg_price),
          submitted_at: o.submitted_at,
          filled_at: o.filled_at,
          pattern: sig?.patternType ?? null,
          direction: sig?.direction ?? null,
          entry_price: sig ? Number(sig.entryPrice) : null,
          stop_loss: sig ? Number(sig.stopLossPrice) : null,
          tp1: sig ? Number(sig.tp1Price) : null,
          tp2: sig ? Number(sig.tp2Price) : null,
        };
      });

    setCacheResponse("history", history, 30_000); // 30s
    res.json(history);
  } catch (err) {
    console.error("[API] Failed to fetch history:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

/**
 * GET /api/trades — Closed signals with realized P&L and trade outcomes.
 * Sourced from live_signals (not Alpaca order history) so data survives purges.
 */
router.get("/trades", async (_req, res) => {
  try {
    const closed = await db
      .select()
      .from(liveSignals)
      .where(eq(liveSignals.status, "closed"))
      .orderBy(desc(liveSignals.executedAt))
      .limit(30);

    const trades = closed.map((s) => {
      const entryPrice = Number(s.filledAvgPrice || s.entryPrice);
      const qty = Number(s.filledQty || 0);
      const pnl = s.realizedPnl != null ? Number(s.realizedPnl) : null;
      const pnlPct = pnl != null && entryPrice > 0 && qty > 0
        ? Math.round((pnl / (entryPrice * qty)) * 10000) / 100
        : null;
      const result = pnl != null
        ? (pnl > 0 ? "win" : pnl < 0 ? "loss" : "break_even")
        : null;

      return {
        signal_id: s.id,
        symbol: s.symbol,
        pattern: s.patternType,
        direction: s.direction,
        timeframe: s.timeframe,
        entry_price: entryPrice,
        exit_price: pnl != null && qty > 0
          ? (s.direction === "long" ? entryPrice + pnl / qty : entryPrice - pnl / qty)
          : Number(s.tp1Price),
        qty,
        pnl,
        pnl_pct: pnlPct,
        result,
        closed_at: s.executedAt,
      };
    });

    res.json(trades);
  } catch (err) {
    console.error("[API] Failed to fetch trades:", err);
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

/**
 * GET /api/orders — All open Alpaca orders enriched with signal data.
 */
router.get("/orders", async (_req, res) => {
  try {
    const headers = alpacaHeaders();
    if (!headers) {
      return res.json([]);
    }

    const r = await fetch(
      `${ALPACA_BASE_URL}/v2/orders?status=open&limit=200`,
      { headers },
    );
    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: body });
    }
    const orders = (await r.json()) as Record<string, string>[];

    // Build lookup map: entryOrderId → signal row
    const allSignals = await db
      .select()
      .from(liveSignals)
      .orderBy(desc(liveSignals.createdAt))
      .limit(200);

    const signalByOrderId = new Map<string, typeof allSignals[number]>();
    for (const sig of allSignals) {
      if (sig.entryOrderId) {
        signalByOrderId.set(sig.entryOrderId, sig);
      }
    }

    const enriched = orders
      .map((o) => {
        const sig = signalByOrderId.get(o.id) ?? null;
        return {
          id: o.id,
          symbol: o.symbol,
          side: o.side,
          qty: Number(o.qty),
          limit_price: Number(o.limit_price),
          reserved_usd: Number(o.qty) * Number(o.limit_price),
          time_in_force: o.time_in_force,
          created_at: o.created_at,
          age_hours: Math.floor((Date.now() - new Date(o.created_at).getTime()) / 3600000),
          pattern: sig?.patternType ?? null,
          direction: sig?.direction ?? null,
          signal_id: sig?.id ?? null,
        };
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    res.json(enriched);
  } catch (err) {
    console.error("[API] Failed to fetch orders:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/**
 * DELETE /api/orders/:id — Cancel a specific Alpaca order and expire its signal.
 */
router.delete("/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const headers = alpacaHeaders();
    if (!headers) {
      return res.status(500).json({ error: "Alpaca keys not configured" });
    }

    const r = await fetch(`${ALPACA_BASE_URL}/v2/orders/${orderId}`, {
      method: "DELETE",
      headers,
    });

    // 204/200 = cancelled, 404/422 = already gone — all OK
    if (!r.ok && r.status !== 404 && r.status !== 422) {
      const body = await r.text();
      console.error(`[API] Failed to cancel order ${orderId}: ${r.status} — ${body}`);
      return res.status(r.status).json({ error: body });
    }

    // Update matching signal to expired
    try {
      await db
        .update(liveSignals)
        .set({ status: "expired" })
        .where(eq(liveSignals.entryOrderId, orderId));
    } catch (dbErr) {
      console.error(`[API] Failed to update signal for cancelled order ${orderId}:`, dbErr);
    }

    console.log(`[API] Cancelled order ${orderId}`);
    res.json({ ok: true, cancelled: orderId });
  } catch (err) {
    console.error("[API] Failed to cancel order:", err);
    res.status(500).json({ error: "Failed to cancel order" });
  }
});

// ============================================================
// Watchlist CRUD
// ============================================================

/**
 * GET /api/watchlist — Returns all watchlist symbols.
 */
router.get("/watchlist", async (_req, res) => {
  try {
    const entries = await db.select().from(watchlist);
    res.json(entries);
  } catch (err) {
    console.error("[API] Failed to fetch watchlist:", err);
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

/**
 * POST /api/watchlist — Add a symbol to the watchlist.
 * Body: { symbol: string, asset_class?: "crypto" | "equity" }
 */
router.post("/watchlist", async (req, res) => {
  try {
    const { symbol, asset_class } = req.body as {
      symbol?: string;
      asset_class?: string;
    };
    if (!symbol || typeof symbol !== "string" || symbol.trim().length === 0) {
      return res.status(400).json({ error: "symbol is required" });
    }

    let clean = symbol.trim().toUpperCase();

    // Auto-correct USDT pairs → USD (Alpaca only supports USD pairs)
    clean = clean.replace(/\/USDT$/, "/USD");

    const cls = clean.includes("/") ? "crypto" : (asset_class ?? "equity");

    await db
      .insert(watchlist)
      .values({ symbol: clean, assetClass: cls })
      .onConflictDoNothing();

    // Initialize scan state for the new symbol so it gets picked up next cycle
    try {
      const { initializeScanStates } = await import("./scan-scheduler");
      await initializeScanStates([clean], ["1D", "4H"] as const);
    } catch (err) {
      console.error("[API] Failed to init scan state for new symbol:", err);
    }

    console.log(`[API] Watchlist: added ${clean} (${cls})`);
    res.json({ ok: true, symbol: clean, asset_class: cls });
  } catch (err) {
    console.error("[API] Failed to add to watchlist:", err);
    res.status(500).json({ error: "Failed to add symbol" });
  }
});

/**
 * DELETE /api/watchlist/:symbol — Remove a symbol from the watchlist.
 */
router.delete("/watchlist/:symbol", async (req, res) => {
  try {
    const sym = decodeURIComponent(req.params.symbol).toUpperCase();
    await db.delete(watchlist).where(eq(watchlist.symbol, sym));
    console.log(`[API] Watchlist: removed ${sym}`);
    res.json({ ok: true, removed: sym });
  } catch (err) {
    console.error("[API] Failed to remove from watchlist:", err);
    res.status(500).json({ error: "Failed to remove symbol" });
  }
});

// ============================================================
// System Settings
// ============================================================

/**
 * GET /api/settings — Returns current bot configuration.
 */
router.get("/settings", async (_req, res) => {
  const cached = getCachedResponse("settings");
  if (cached) return res.json(cached);
  try {
    const rows = await db.select().from(systemSettings).limit(1);
    if (rows.length === 0) {
      return res.json({
        trading_enabled: true,
        equity_allocation: 0.05,
        crypto_allocation: 0.07,
        enabled_patterns: ["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"],
        go_live_target: 15,
      });
    }
    const s = rows[0];
    const result = {
      trading_enabled: s.tradingEnabled,
      equity_allocation: Number(s.equityAllocation),
      crypto_allocation: Number(s.cryptoAllocation),
      enabled_patterns: s.enabledPatterns as string[],
      go_live_target: s.goLiveTarget ?? 15,
    };
    setCacheResponse("settings", result, 120_000); // 2min
    res.json(result);
  } catch (err) {
    console.error("[API] Failed to fetch settings:", err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

/**
 * POST /api/settings — Update bot configuration.
 */
router.post("/settings", async (req, res) => {
  try {
    const body = req.body as {
      trading_enabled?: boolean;
      equity_allocation?: number;
      crypto_allocation?: number;
      enabled_patterns?: string[];
      go_live_target?: number;
    };

    const updates: Record<string, unknown> = {};

    if (typeof body.trading_enabled === "boolean") {
      updates.tradingEnabled = body.trading_enabled;
    }
    if (typeof body.equity_allocation === "number" && body.equity_allocation > 0 && body.equity_allocation <= 1) {
      updates.equityAllocation = String(body.equity_allocation);
    }
    if (typeof body.crypto_allocation === "number" && body.crypto_allocation > 0 && body.crypto_allocation <= 1) {
      updates.cryptoAllocation = String(body.crypto_allocation);
    }
    if (Array.isArray(body.enabled_patterns)) {
      const ALL_PATTERNS = ["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"];
      const valid = body.enabled_patterns.filter((p) => ALL_PATTERNS.includes(p));
      updates.enabledPatterns = valid;
    }
    if (typeof body.go_live_target === "number" && body.go_live_target > 0 && body.go_live_target <= 100) {
      updates.goLiveTarget = body.go_live_target;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    await db.update(systemSettings).set(updates).where(eq(systemSettings.id, 1));
    responseCache.delete("settings"); // Invalidate cached settings
    console.log("[API] Settings updated:", updates);
    res.json({ ok: true, updated: updates });
  } catch (err) {
    console.error("[API] Failed to update settings:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

/**
 * GET /api/status — System status for the dashboard header.
 */
router.get("/status", (_req, res) => {
  const cacheStats = getCacheStats();
  res.json({
    status: "online",
    uptime: process.uptime(),
    cache: cacheStats,
    timestamp: new Date().toISOString(),
    scan_count: totalScanCount,
    last_scan_age_seconds: lastScanTimestamp > 0 ? Math.floor((Date.now() - lastScanTimestamp) / 1000) : null,
    last_scan_candidates: lastScanCandidates,
    last_scan_passed_filter: lastScanPassedFilter,
    filter_pass_rate: lastScanCandidates > 0 ? Math.round((lastScanPassedFilter / lastScanCandidates) * 100) : 0,
    websocket: getStreamStatus(),
    market_open: isStockMarketOpen(),
  });
});

/**
 * GET /api/approaching — All pending Phase C signals with distance to projected D.
 * Uses WebSocket price if available, otherwise falls back to the latest
 * candle close from cached REST data (refreshed every 30s scan cycle).
 * Returns signals within 50% distance of projected D, sorted by closest first.
 */
router.get("/approaching", async (_req, res) => {
  try {
    const pending = await db
      .select()
      .from(liveSignals)
      .where(inArray(liveSignals.status, ["pending", "paper_only"]))
      .orderBy(desc(liveSignals.createdAt));

    const enriched = pending
      .map((s) => {
        // Best price: WebSocket stream > cached candle close
        const currentPrice = getStreamPrice(s.symbol) ?? getLatestCachedPrice(s.symbol);
        if (currentPrice === null) return null;

        const entry = Number(s.entryPrice);
        const aPrice = s.aPrice ? Number(s.aPrice) : null;
        const distPct = entry > 0 ? (Math.abs(currentPrice - entry) / currentPrice) * 100 : 999;

        // TP3 = full move back to A (1.0 AD retracement), computed on the fly
        const adRange = aPrice !== null ? Math.abs(aPrice - entry) : 0;
        const tp3 = aPrice !== null
          ? (s.direction === "long" ? entry + adRange : entry - adRange)
          : null;

        // hasOrder / blocked / rr enrichment
        const hasOrder = !!s.entryOrderId;
        const ageMs = s.createdAt ? Date.now() - new Date(s.createdAt).getTime() : 0;
        const blocked = s.status === "paper_only"
          ? "Paper only — crypto SHORT (no Alpaca order)"
          : (!hasOrder && s.status === "pending" && ageMs > 2 * 60 * 1000)
            ? "No order — possible buying power issue"
            : null;
        const reward = Math.abs(Number(s.tp1Price) - entry);
        const risk = Math.abs(entry - Number(s.stopLossPrice));
        const rr = risk > 0 ? Math.round((reward / risk) * 10) / 10 : 0;

        return {
          id: s.id,
          symbol: s.symbol,
          pattern: s.patternType,
          direction: s.direction,
          timeframe: s.timeframe,
          projectedD: entry,
          currentPrice,
          priceSource: getStreamPrice(s.symbol) !== null ? "stream" : "candle",
          sl: Number(s.stopLossPrice),
          tp1: Number(s.tp1Price),
          tp2: Number(s.tp2Price),
          tp3,
          x: s.xPrice ? Number(s.xPrice) : null,
          a: aPrice,
          b: s.bPrice ? Number(s.bPrice) : null,
          c: s.cPrice ? Number(s.cPrice) : null,
          distancePct: Math.round(distPct * 100) / 100,
          createdAt: s.createdAt,
          hasOrder,
          blocked,
          rr,
          paperOnly: s.status === "paper_only",
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null && s.distancePct <= 50)
      .sort((a, b) => a.distancePct - b.distancePct);

    res.json(enriched);
  } catch (err) {
    console.error("[API] Failed to fetch approaching trades:", err);
    res.status(500).json({ error: "Failed to fetch approaching trades" });
  }
});

/**
 * POST /api/signals/clear — Delete all signals from the database.
 * Used to reset the live scanner feed on manual request.
 */
router.post("/signals/clear", async (_req, res) => {
  try {
    await db.delete(liveSignals);
    console.log("[API] Signals cleared");
    res.json({ ok: true, message: "All signals cleared" });
  } catch (err) {
    console.error("[API] Failed to clear signals:", err);
    res.status(500).json({ error: "Failed to clear signals" });
  }
});

/**
 * POST /api/fix-exits/:id — Manually fix a stuck position.
 * Cancels all open Alpaca orders for the symbol, queries actual
 * position qty, and places fresh TP1 + TP2 limit exits.
 */
router.post("/fix-exits/:id", async (req, res) => {
  try {
    const signalId = Number(req.params.id);
    if (!Number.isFinite(signalId) || signalId <= 0) {
      res.status(400).json({ error: "Invalid signal ID" });
      return;
    }
    const result = await fixStuckExits(signalId);
    console.log(`[API] fix-exits: ${result}`);
    res.json({ ok: true, result });
  } catch (err) {
    console.error("[API] fix-exits failed:", err);
    res.status(500).json({ error: "Failed to fix exits" });
  }
});

/**
 * GET /api/scan-state — Tiered scanner stats for the dashboard.
 * Shows phase distribution, hot symbols, scheduling info, and universe context.
 */
router.get("/scan-state", async (_req, res) => {
  const cached = getCachedResponse("scan_state");
  if (cached) return res.json(cached);
  try {
    const { getScanStateStats } = await import("./scan-scheduler");
    const stats = await getScanStateStats();

    // Add universe context
    let totalUniverse = 0;
    try {
      const { getUniverseStats } = await import("./universe");
      const uStats = await getUniverseStats();
      totalUniverse = uStats.totalFiltered;
    } catch {}

    // Add favorite symbols from watchlist
    const favorites = await db.select({ symbol: watchlist.symbol }).from(watchlist);
    const favoriteSymbols = favorites.map((f) => f.symbol);

    const result = { ...stats, totalUniverse, favoriteSymbols };
    setCacheResponse("scan_state", result, 30_000); // 30s
    res.json(result);
  } catch (err) {
    console.error("[API] Failed to fetch scan state:", err);
    res.status(500).json({ error: "Failed to fetch scan state" });
  }
});

/**
 * GET /api/universe/stats — Universe discovery stats.
 */
router.get("/universe/stats", async (_req, res) => {
  try {
    const { getUniverseStats } = await import("./universe");
    const stats = await getUniverseStats();
    res.json(stats);
  } catch (err) {
    console.error("[API] Failed to fetch universe stats:", err);
    res.status(500).json({ error: "Failed to fetch universe stats" });
  }
});

/**
 * POST /api/universe/refresh — Manually trigger a universe refresh.
 */
router.post("/universe/refresh", async (_req, res) => {
  try {
    const { getFullUniverse } = await import("./universe");
    const { seedUniverse } = await import("./scan-scheduler");
    const universe = await getFullUniverse();
    const result = await seedUniverse(universe);
    res.json({ ok: true, ...result, totalUniverse: universe.length });
  } catch (err) {
    console.error("[API] Universe refresh failed:", err);
    res.status(500).json({ error: "Failed to refresh universe" });
  }
});

/**
 * GET /api/scan-state/full — Detailed scan state for every symbol × timeframe.
 */
router.get("/scan-state/full", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(symbolScanState)
      .orderBy(desc(symbolScanState.updatedAt));

    res.json(rows.map(r => ({
      symbol: r.symbol,
      timeframe: r.timeframe,
      phase: r.phase,
      bestPattern: r.bestPattern,
      bestDirection: r.bestDirection,
      xPrice: r.xPrice ? Number(r.xPrice) : null,
      aPrice: r.aPrice ? Number(r.aPrice) : null,
      bPrice: r.bPrice ? Number(r.bPrice) : null,
      cPrice: r.cPrice ? Number(r.cPrice) : null,
      projectedD: r.projectedD ? Number(r.projectedD) : null,
      distanceToDPct: r.distanceToDPct ? Number(r.distanceToDPct) : null,
      pivotCount: r.pivotCount,
      lastScannedAt: r.lastScannedAt,
      nextScanDue: r.nextScanDue,
      scanIntervalMs: r.scanIntervalMs,
      isDue: new Date(r.nextScanDue) <= new Date(),
    })));
  } catch (err) {
    console.error("[API] Failed to fetch full scan state:", err);
    res.status(500).json({ error: "Failed to fetch full scan state" });
  }
});

/**
 * GET /api/pipeline — Live scan pipeline stats for the dashboard.
 */
router.get("/pipeline", (_req, res) => {
  res.json({
    ...pipelineStats,
    lastUpdatedAgo: pipelineStats.lastUpdated > 0
      ? Math.floor((Date.now() - pipelineStats.lastUpdated) / 1000)
      : null,
    websocket: getStreamStatus(),
  });
});

/**
 * GET /api/diagnostics/equity — One-shot diagnostic for equity signal verification.
 * Returns equity signals, equity shorts, scan states, and summary counts.
 */
router.get("/diagnostics/equity", async (_req, res) => {
  try {
    // Query 1: All equity signals (most recent 20)
    const equitySignals = await db.execute(sql`
      SELECT symbol, pattern_type, direction, timeframe, status, entry_price, entry_order_id, created_at
      FROM live_signals
      WHERE symbol NOT LIKE '%/%'
      ORDER BY created_at DESC
      LIMIT 20
    `);

    // Query 2: Equity SHORT signals
    const equityShorts = await db.execute(sql`
      SELECT symbol, pattern_type, direction, timeframe, status, entry_price, entry_order_id, created_at
      FROM live_signals
      WHERE symbol NOT LIKE '%/%' AND direction = 'short'
      ORDER BY created_at DESC
      LIMIT 20
    `);

    // Query 3: Equity scan states ordered by phase priority
    const equityScanStates = await db.execute(sql`
      SELECT symbol, timeframe, phase, best_pattern, best_direction, projected_d, distance_to_d_pct, last_scanned_at, next_scan_due
      FROM symbol_scan_state
      WHERE symbol NOT LIKE '%/%'
      ORDER BY
        CASE phase
          WHEN 'D_APPROACHING' THEN 1
          WHEN 'CD_PROJECTED' THEN 2
          WHEN 'BC_FORMING' THEN 3
          WHEN 'AB_FORMING' THEN 4
          WHEN 'XA_FORMING' THEN 5
          ELSE 6
        END,
        next_scan_due ASC
    `);

    // Query 4: Signal summary by asset class + direction + status
    const summary = await db.execute(sql`
      SELECT
        CASE WHEN symbol LIKE '%/%' THEN 'crypto' ELSE 'equity' END as asset_class,
        direction,
        status,
        COUNT(*) as count
      FROM live_signals
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `);

    res.json({
      equitySignals: equitySignals.rows,
      equityShorts: equityShorts.rows,
      equityScanStates: equityScanStates.rows,
      signalSummary: summary.rows,
    });
  } catch (err) {
    console.error("[API] Equity diagnostics failed:", err);
    res.status(500).json({ error: "Diagnostics query failed" });
  }
});

// ============================================================
// Signal Pipeline — full lifecycle view of every signal
// ============================================================

function getSignalStage(signal: any, isCrypto: boolean) {
  const status = signal.status;

  if (status === "outranked") {
    return {
      label: "Outranked",
      detail: `Beaten by higher-scored pattern on ${signal.symbol}`,
      color: "gray",
      blockedReason: "A better pattern was found on this symbol",
    };
  }

  if (status === "paper_only") {
    return {
      label: "Paper Only",
      detail: "Crypto SHORT — Alpaca doesn't support crypto shorting",
      color: "yellow",
      blockedReason: "Crypto shorts tracked for validation only",
    };
  }

  if (status === "expired") {
    return {
      label: "Expired",
      detail: "Signal aged out without filling",
      color: "gray",
      blockedReason: null,
    };
  }

  if (status === "dismissed") {
    return {
      label: "Dismissed",
      detail: "Manually dismissed or quality-rejected",
      color: "gray",
      blockedReason: null,
    };
  }

  if (status === "closed") {
    const pnl = signal.realizedPnl ? Number(signal.realizedPnl) : null;
    return {
      label: "Closed",
      detail: `Trade completed${pnl != null ? ` — P/L: $${pnl.toFixed(2)}` : ""}`,
      color: pnl != null && pnl > 0 ? "green" : "red",
      blockedReason: null,
    };
  }

  if (status === "filled" || status === "partial_exit") {
    if (signal.tp1OrderId || signal.tp2OrderId || signal.slOrderId) {
      return {
        label: "Exiting",
        detail: "Position open — waiting for TP/SL to hit",
        color: "blue",
        blockedReason: null,
      };
    }
    return {
      label: "Filled",
      detail: "Entry filled — setting up exit orders",
      color: "blue",
      blockedReason: null,
    };
  }

  if (status === "pending" && signal.entryOrderId) {
    return {
      label: "Order Placed",
      detail: "Limit order active on Alpaca — waiting for price to reach entry",
      color: "orange",
      blockedReason: null,
    };
  }

  if (status === "pending" && !signal.entryOrderId) {
    if (!isCrypto && !isStockMarketOpen()) {
      return {
        label: "Market Closed",
        detail: "Equity signal detected — order will be placed when market opens",
        color: "yellow",
        blockedReason: "Stock market is closed",
      };
    }
    return {
      label: "Detected",
      detail: "Signal detected — awaiting order placement",
      color: "purple",
      blockedReason: null,
    };
  }

  return {
    label: status || "Unknown",
    detail: `Status: ${status}`,
    color: "gray",
    blockedReason: null,
  };
}

/**
 * GET /api/signals/pipeline — Full signal lifecycle with stage enrichment.
 */
router.get("/signals/pipeline", async (_req, res) => {
  const cached = getCachedResponse("signals_pipeline");
  if (cached) return res.json(cached);
  try {
    const signals = await db
      .select()
      .from(liveSignals)
      .where(sql`${liveSignals.createdAt} > NOW() - INTERVAL '7 days'`)
      .orderBy(desc(liveSignals.createdAt))
      .limit(200);

    const enriched = signals.map((signal) => {
      const isCrypto = signal.symbol.includes("/");
      const stage = getSignalStage(signal, isCrypto);

      return {
        id: signal.id,
        symbol: signal.symbol,
        pattern: signal.patternType,
        timeframe: signal.timeframe,
        direction: signal.direction,
        status: signal.status,
        stage: stage.label,
        stageDetail: stage.detail,
        stageColor: stage.color,
        entryPrice: signal.entryPrice ? Number(signal.entryPrice) : null,
        stopLoss: signal.stopLossPrice ? Number(signal.stopLossPrice) : null,
        tp1: signal.tp1Price ? Number(signal.tp1Price) : null,
        tp2: signal.tp2Price ? Number(signal.tp2Price) : null,
        score: signal.score ?? null,
        entryOrderId: signal.entryOrderId ?? null,
        hasOrder: !!signal.entryOrderId,
        detectedAt: signal.createdAt,
        filledAt: signal.executedAt ?? null,
        blockedReason: stage.blockedReason ?? null,
      };
    });

    const stages = [
      "Detected", "Outranked", "Paper Only", "Market Closed",
      "Order Placed", "Filled", "Exiting", "Closed", "Expired", "Dismissed",
    ];
    const byStage: Record<string, number> = {};
    for (const s of stages) byStage[s] = 0;
    for (const e of enriched) byStage[e.stage] = (byStage[e.stage] ?? 0) + 1;

    const result = { signals: enriched, summary: { total: enriched.length, byStage } };
    setCacheResponse("signals_pipeline", result, 15_000); // 15s
    res.json(result);
  } catch (err) {
    console.error("[API] /api/signals/pipeline error:", err);
    res.status(500).json({ error: "Failed to fetch signal pipeline" });
  }
});

/**
 * GET /api/diagnostics/full — Comprehensive system diagnostics aggregator.
 * Single endpoint that pulls scanner health, pipeline, orders, signals, account,
 * websocket, and scan-state data for the diagnostics page.
 */
router.get("/diagnostics/full", async (_req, res) => {
  try {
    const headers = alpacaHeaders();

    const dbAndApiPromises: Promise<any>[] = [
      db.execute(sql`
        SELECT
          CASE WHEN symbol LIKE '%/%' THEN 'crypto' ELSE 'equity' END as asset_class,
          direction,
          status,
          COUNT(*) as count
        FROM live_signals
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3
      `),
      db.execute(sql`
        SELECT phase, COUNT(*) as count,
               COUNT(*) FILTER (WHERE next_scan_due <= NOW()) as due_now
        FROM symbol_scan_state
        GROUP BY phase
      `),
      db.execute(sql`
        SELECT symbol, timeframe, phase,
               EXTRACT(EPOCH FROM (NOW() - next_scan_due)) / 60 as overdue_minutes
        FROM symbol_scan_state
        WHERE next_scan_due < NOW() - INTERVAL '5 minutes'
        ORDER BY next_scan_due ASC
        LIMIT 10
      `),
      db.execute(sql`
        SELECT id, symbol, status, entry_order_id, created_at
        FROM live_signals
        WHERE status IN ('pending', 'paper_only')
          AND created_at < NOW() - INTERVAL '48 hours'
        ORDER BY created_at ASC
        LIMIT 20
      `),
      db.execute(sql`SELECT COUNT(*) as total FROM symbol_scan_state`),
    ];

    if (headers) {
      dbAndApiPromises.push(
        fetch(`${ALPACA_BASE_URL}/v2/orders?status=open&limit=200`, { headers }).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${ALPACA_BASE_URL}/v2/account`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      );
    }

    const results = await Promise.allSettled(dbAndApiPromises);
    const val = (i: number, fallback: any = { rows: [] }) => results[i]?.status === "fulfilled" ? results[i].value : fallback;

    const signalSummaryResult = val(0);
    const phaseAggResult = val(1);
    const overdueResult = val(2);
    const staleSignalsResult = val(3);
    const totalSlotsResult = val(4);
    const openOrders: any[] = headers ? (val(5, []) as any[]) : [];
    const accountData: any = headers ? val(6, null) : null;

    const wsStatus = getStreamStatus();
    const cacheStats = getCacheStats();
    const uptimeSeconds = Math.floor(process.uptime());

    const phaseRows = phaseAggResult.rows as any[];
    const phaseDistribution: Record<string, number> = {};
    let dueNow = 0;
    for (const r of phaseRows) {
      phaseDistribution[r.phase ?? "UNKNOWN"] = Number(r.count ?? 0);
      dueNow += Number(r.due_now ?? 0);
    }
    const totalScanSlots = Number((totalSlotsResult.rows?.[0] as any)?.total ?? 0);

    const overdueScanners = (overdueResult.rows as any[]).map((r: any) => ({
      symbol: r.symbol,
      timeframe: r.timeframe,
      phase: r.phase,
      overdueMinutes: Math.round(Number(r.overdue_minutes ?? 0)),
    }));

    const ordersSummary = {
      total: openOrders.length,
      buy: openOrders.filter((o: any) => o.side === "buy").length,
      sell: openOrders.filter((o: any) => o.side === "sell").length,
      totalNotional: openOrders.reduce((sum: number, o: any) => {
        const qty = parseFloat(o.qty || "0");
        const price = parseFloat(o.limit_price || o.stop_price || "0");
        return sum + qty * price;
      }, 0),
      orders: openOrders.slice(0, 20).map((o: any) => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        limitPrice: o.limit_price,
        type: o.type,
        status: o.status,
        submittedAt: o.submitted_at,
        ageMinutes: o.submitted_at ? Math.floor((Date.now() - new Date(o.submitted_at).getTime()) / 60000) : null,
      })),
    };

    res.json({
      system: {
        uptime: uptimeSeconds,
        uptimeFormatted: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
        scanCount: totalScanCount,
        lastScanAgeSeconds: lastScanTimestamp > 0 ? Math.floor((Date.now() - lastScanTimestamp) / 1000) : null,
        lastScanCandidates,
        lastScanPassedFilter,
        filterPassRate: lastScanCandidates > 0 ? Math.round((lastScanPassedFilter / lastScanCandidates) * 100) : 0,
        marketOpen: isStockMarketOpen(),
      },
      websocket: wsStatus,
      cache: cacheStats,
      pipeline: {
        ...pipelineStats,
        lastUpdatedAgo: pipelineStats.lastUpdated > 0
          ? Math.floor((Date.now() - pipelineStats.lastUpdated) / 1000)
          : null,
      },
      scanner: {
        totalSlots: totalScanSlots,
        dueNow,
        phaseDistribution,
        overdueScanners,
      },
      orders: ordersSummary,
      account: accountData ? {
        equity: parseFloat(accountData.equity ?? "0"),
        buyingPower: parseFloat(accountData.buying_power ?? "0"),
        cash: parseFloat(accountData.cash ?? "0"),
        portfolioValue: parseFloat(accountData.portfolio_value ?? "0"),
        daytradeCount: accountData.daytrade_count ?? 0,
        patternDayTrader: accountData.pattern_day_trader ?? false,
      } : null,
      signals: {
        summary: signalSummaryResult.rows,
        stale: staleSignalsResult.rows,
      },
    });
  } catch (err) {
    console.error("[API] Full diagnostics failed:", err);
    res.status(500).json({ error: "Diagnostics query failed" });
  }
});

/**
 * GET /api/health — Simple health check for Render.
 */
/**
 * GET /api/candles/:symbol — OHLC candle data for charting.
 * Query params: timeframe=4H|1D (default 4H)
 * Symbol format: "AAPL" for stocks, "BTC/USD" for crypto (use BTC%2FUSD in URL).
 */
router.get("/candles/:symbol", async (req, res) => {
  try {
    const symbol = decodeURIComponent(req.params.symbol);
    const timeframe = (req.query.timeframe as string) === "1D" ? "1D" : "4H";

    const data = await fetchWatchlist([symbol], timeframe as "1D" | "4H");
    const candles = data.get(symbol) ?? [];

    if (candles.length === 0) {
      return res.json({ candles: [], symbol, timeframe, error: "No data" });
    }

    // Format for lightweight-charts: { time, open, high, low, close }
    const formatted = candles.map((c) => ({
      time: Math.floor(c.timestamp / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    }));

    // Sort ascending by time (lightweight-charts requires this)
    formatted.sort((a, b) => a.time - b.time);

    // Deduplicate by time (same timestamp = keep last)
    const deduped = [];
    for (let i = 0; i < formatted.length; i++) {
      if (i === formatted.length - 1 || formatted[i].time !== formatted[i + 1].time) {
        deduped.push(formatted[i]);
      }
    }

    res.json({ candles: deduped, symbol, timeframe });
  } catch (err: any) {
    console.error("[API] /api/candles error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/signal/:id — Full signal details for chart overlay.
 */
router.get("/signal/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [signal] = await db
      .select()
      .from(liveSignals)
      .where(eq(liveSignals.id, id))
      .limit(1);

    if (!signal) return res.status(404).json({ error: "Signal not found" });
    res.json(signal);
  } catch (err: any) {
    console.error(`[API] /api/signal/${req.params.id} error:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/cancel/:orderId — Cancel an open Alpaca order.
 */
router.post("/orders/cancel/:orderId", async (req, res) => {
  try {
    const headers = alpacaHeaders();
    if (!headers) {
      return res.status(500).json({ error: "Alpaca keys not configured" });
    }

    const cancelRes = await fetch(`${ALPACA_BASE_URL}/v2/orders/${req.params.orderId}`, {
      method: "DELETE",
      headers,
    });

    if (cancelRes.ok || cancelRes.status === 204) {
      await db
        .update(liveSignals)
        .set({ status: "cancelled" })
        .where(eq(liveSignals.entryOrderId, req.params.orderId));
      res.json({ success: true });
    } else {
      const body = await cancelRes.text();
      res.status(cancelRes.status).json({ error: body });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/place — Manually place a limit order on Alpaca.
 * Body: { symbol, side, qty, limit_price, time_in_force }
 */
router.post("/orders/place", async (req, res) => {
  try {
    const headers = alpacaHeaders();
    if (!headers) {
      return res.status(500).json({ error: "Alpaca keys not configured" });
    }

    const { symbol, side, qty, limit_price, time_in_force } = req.body;
    if (!symbol || !side || !qty || !limit_price) {
      return res.status(400).json({ error: "Missing required fields: symbol, side, qty, limit_price" });
    }

    const orderRes = await fetch(`${ALPACA_BASE_URL}/v2/orders`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: symbol.replace("/", ""),
        side,
        qty: String(qty),
        type: "limit",
        time_in_force: time_in_force || "gtc",
        limit_price: String(limit_price),
      }),
    });

    const body = await orderRes.json();
    if (orderRes.ok) {
      res.json({ success: true, order: body });
    } else {
      res.status(orderRes.status).json({ error: body });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ============================================================
// Price Health — freshness status of all tracked prices
// ============================================================
router.get("/price-health", (_req, res) => {
  const stats = getPriceFreshnessStats();
  const prices = getAllStreamPrices();
  const now = Date.now();

  const details: Array<{ symbol: string; price: number; ageMs: number; status: string }> = [];
  for (const [symbol, entry] of prices) {
    const age = now - entry.timestamp;
    details.push({
      symbol,
      price: entry.price,
      ageMs: age,
      status: age < 60_000 ? "fresh" : age < 300_000 ? "stale" : "dead",
    });
  }

  details.sort((a, b) => b.ageMs - a.ageMs); // stalest first

  res.json({
    ...stats,
    healthy: stats.stale === 0 && stats.dead === 0,
    details,
  });
});

// ============================================================
// Ticker tape — streaming prices for top watchlist symbols
// ============================================================
router.get("/ticker", (_req, res) => {
  const prices = getAllStreamPrices();
  const now = Date.now();
  const wl = ["BTC/USD","ETH/USD","SOL/USD","DOGE/USD","XRP/USD","TSLA","NVDA","AMZN","META","AAPL","MSFT","SPY","QQQ","AMD","GOOGL"];

  const ticker = wl.map(symbol => {
    const entry = prices.get(symbol) ?? prices.get(symbol.replace(/\//g, ""));
    if (!entry) return null;
    const ageMs = now - entry.timestamp;
    return {
      symbol: symbol.replace("/USD", ""),
      price: entry.price,
      timestamp: entry.timestamp,
      ageMs,
      freshness: ageMs < 60_000 ? "fresh" : ageMs < 300_000 ? "stale" : "dead",
    };
  }).filter((t): t is NonNullable<typeof t> => t !== null);

  res.json(ticker);
});

export default router;
