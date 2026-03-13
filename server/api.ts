/**
 * Dashboard API Router
 * Serves live signal data and system health to the frontend.
 */

import { Router } from "express";
import { db } from "./db";
import { liveSignals } from "../shared/schema";
import { desc } from "drizzle-orm";
import { getCacheStats } from "./fmp";

const router = Router();

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
 * GET /api/health — System health check for Render and monitoring.
 */
router.get("/health", (_req, res) => {
  const cacheStats = getCacheStats();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    cache: cacheStats,
    timestamp: new Date().toISOString(),
  });
});

export default router;
