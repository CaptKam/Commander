/**
 * Dashboard API Router
 * Serves live signal data, Alpaca account info, and system health.
 */

import { Router } from "express";
import { db } from "./db";
import { liveSignals } from "../shared/schema";
import { desc } from "drizzle-orm";
import { getCacheStats } from "./fmp";

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
          entry_price: Number(p.avg_entry_price),
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
 */
router.get("/signals", async (_req, res) => {
  try {
    const signals = await db
      .select()
      .from(liveSignals)
      .orderBy(desc(liveSignals.createdAt))
      .limit(50);
    res.json(signals);
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
 * GET /api/health — Simple health check for Render.
 */
router.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

export default router;
