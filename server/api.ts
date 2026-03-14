/**
 * Dashboard API Router
 * Serves live signal data, Alpaca account info, and system health.
 */

import { Router } from "express";
import { db } from "./db";
import { liveSignals, watchlist, systemSettings } from "../shared/schema";
import { desc, eq } from "drizzle-orm";
import { getCacheStats } from "./alpaca-data";

const router = Router();

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

    // For each signal, check if we have enough order data to compute outcome
    for (const sig of allSignals) {
      const entry = Number(sig.entryPrice);
      const tp1 = Number(sig.tp1Price);
      const sl = Number(sig.stopLossPrice);
      if (!entry || !tp1 || !sl) continue;

      // Estimate R/R based on signal targets
      const risk = Math.abs(entry - sl);
      const reward = Math.abs(tp1 - entry);
      if (risk === 0) continue;

      // Find matching filled order
      const symOrders = symbolOrders.get(sig.symbol);
      if (!symOrders) continue;

      const matchedOrder = symOrders.find((o) => {
        const filledPrice = Number(o.filled_avg_price);
        // Match if filled price is within 2% of signal entry
        return Math.abs(filledPrice - entry) / entry < 0.02;
      });

      if (!matchedOrder) continue;

      // Use the signal's R/R to estimate outcome
      // If TP was closer to entry than SL, it's a favorable setup
      const rr = reward / risk;
      if (sig.status === "executed" || matchedOrder.status === "filled") {
        // Simple heuristic: count as win if R:R >= 1
        if (rr >= 1) {
          wins++;
          grossProfit += reward;
        } else {
          losses++;
          grossLoss += risk;
        }
      }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    res.json({
      win_rate: Math.round(winRate * 10) / 10,
      profit_factor: Math.round(profitFactor * 100) / 100,
      total_trades: totalTrades,
      wins,
      losses,
    });
  } catch (err) {
    console.error("[API] Failed to compute metrics:", err);
    res.status(500).json({ error: "Failed to compute metrics" });
  }
});

/**
 * GET /api/history — Closed orders from Alpaca for the Trade History graveyard.
 */
router.get("/history", async (_req, res) => {
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

    res.json(history);
  } catch (err) {
    console.error("[API] Failed to fetch history:", err);
    res.status(500).json({ error: "Failed to fetch history" });
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
  try {
    const rows = await db.select().from(systemSettings).limit(1);
    if (rows.length === 0) {
      return res.json({
        trading_enabled: true,
        equity_allocation: 0.05,
        crypto_allocation: 0.07,
        enabled_patterns: ["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"],
      });
    }
    const s = rows[0];
    res.json({
      trading_enabled: s.tradingEnabled,
      equity_allocation: Number(s.equityAllocation),
      crypto_allocation: Number(s.cryptoAllocation),
      enabled_patterns: s.enabledPatterns as string[],
    });
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

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    await db.update(systemSettings).set(updates).where(eq(systemSettings.id, 1));
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
  });
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
 * GET /api/health — Simple health check for Render.
 */
router.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

export default router;
