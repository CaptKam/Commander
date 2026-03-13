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
 * GET /api/positions — Current open positions from Alpaca.
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
    res.json(
      positions.map((p) => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        side: p.side,
        entry_price: Number(p.avg_entry_price),
        current_price: Number(p.current_price),
        market_value: Number(p.market_value),
        unrealized_pl: Number(p.unrealized_pl),
        unrealized_pl_pct: Number(p.unrealized_plpc) * 100,
      })),
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
