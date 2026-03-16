/**
 * Orchestrator — The Unkillable Scanner Loop
 * Central brain that ties Alpaca market data, harmonic detection, Phase C
 * screening, and Alpaca execution into a single resilient loop.
 *
 * Key safety feature: Mutex lock prevents overlapping scans. If Alpaca takes
 * 40 seconds and the 30-second interval fires again, it skips gracefully
 * instead of stacking requests until Node.js OOMs.
 */

import { sendSystemBoot, sendError, sendPhaseCSignal } from "./utils/notifier";
import { fetchWatchlist } from "./alpaca-data";
import { detectHarmonics, detectCompletedPatterns, detectPatternPhase } from "./patterns";
import { processPhaseCSignals } from "./screener";
import type { PhaseCSignal } from "./screener";
import { runExitCycle } from "./exit-manager";
import { runCryptoMonitor } from "./crypto-monitor";
import { validateSignalQuality, AGE_WINDOW_MS } from "./quality-filters";
import { startPriceStreams, stopPriceStreams } from "./websocket-stream";
import { placePhaseCLimitOrder, getAccountEquity } from "./alpaca";
import { checkTradingRateLimit } from "./utils/tradingRateLimiter";
import { getSymbolsDueForScan, updateScanState, initializeScanStates, getScanStateStats } from "./scan-scheduler";
import { db, ensureTablesExist } from "./db";
import { liveSignals, insertLiveSignalSchema, watchlist, systemSettings } from "../shared/schema";
import { and, eq, gte, inArray } from "drizzle-orm";

// ============================================================
// Scan interval and heartbeat configuration
// ============================================================
const SCAN_INTERVAL_MS = 30_000; // 30 seconds between scans
const HEARTBEAT_EVERY_N_SCANS = 10; // Log heartbeat every 10th cycle (~5 min)

// ============================================================
// Watchlist — loaded from DB at the start of each scan cycle
// Fallback to defaults if DB query fails
// ============================================================
const FALLBACK_WATCHLIST = ["BTC/USD", "ETH/USD", "AAPL", "TSLA"];
const TIMEFRAMES = ["1D", "4H"] as const;

// Known crypto base symbols — if these appear without "/USD", auto-append it
const KNOWN_CRYPTO_BASES = new Set([
  "BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "AVAX", "LINK", "LTC", "SUI",
]);

async function getActiveWatchlist(): Promise<string[]> {
  try {
    const entries = await db.select().from(watchlist);
    if (entries.length === 0) return FALLBACK_WATCHLIST;
    return entries.map((e) => {
      let sym = e.symbol;
      // Auto-correct USDT pairs → USD (Alpaca only supports USD pairs)
      sym = sym.replace(/\/USDT$/, "/USD");
      // Auto-correct bare crypto tickers: "XRP" → "XRP/USD"
      if (!sym.includes("/") && KNOWN_CRYPTO_BASES.has(sym.toUpperCase())) {
        console.warn(`[Orchestrator] Auto-correcting bare crypto symbol: "${sym}" → "${sym.toUpperCase()}/USD"`);
        sym = `${sym.toUpperCase()}/USD`;
      }
      return sym;
    });
  } catch (err) {
    console.error("[Orchestrator] Failed to load watchlist from DB, using fallback:", err);
    return FALLBACK_WATCHLIST;
  }
}

// ============================================================
// Settings — loaded from DB at the start of each scan cycle
// ============================================================
interface BotSettings {
  tradingEnabled: boolean;
  equityAllocation: number;
  cryptoAllocation: number;
  enabledPatterns: string[];
}

const DEFAULT_SETTINGS: BotSettings = {
  tradingEnabled: true,
  equityAllocation: 0.05,
  cryptoAllocation: 0.07,
  enabledPatterns: ["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"],
};

async function getSettings(): Promise<BotSettings> {
  try {
    const rows = await db.select().from(systemSettings).limit(1);
    if (rows.length === 0) return DEFAULT_SETTINGS;
    const s = rows[0];
    return {
      tradingEnabled: s.tradingEnabled,
      equityAllocation: Number(s.equityAllocation) || DEFAULT_SETTINGS.equityAllocation,
      cryptoAllocation: Number(s.cryptoAllocation) || DEFAULT_SETTINGS.cryptoAllocation,
      enabledPatterns: (s.enabledPatterns as string[]) ?? DEFAULT_SETTINGS.enabledPatterns,
    };
  } catch (err) {
    console.error("[Orchestrator] Failed to load settings, using defaults:", err);
    return DEFAULT_SETTINGS;
  }
}

// ============================================================
// Market hours — skip equity symbols when US stock market is closed
// Crypto scans 24/7 regardless.
// ============================================================
function getEasternTime(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

/**
 * Returns true if within the extended stock scanning window:
 * Mon-Fri 9:00 AM – 4:30 PM Eastern (30-min buffer each side of 9:30–4:00).
 */
export function isStockMarketOpen(): boolean {
  const eastern = getEasternTime();
  const day = eastern.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;

  const timeInMinutes = eastern.getHours() * 60 + eastern.getMinutes();
  // 9:00 AM = 540 min, 4:30 PM = 990 min
  if (timeInMinutes < 540 || timeInMinutes > 990) return false;

  return true;
}

/**
 * Returns true once per trading day during the 4:30–5:00 PM window.
 * Used to trigger a final daily-candle scan for stocks after close.
 */
function isPostCloseWindow(): boolean {
  const eastern = getEasternTime();
  const day = eastern.getDay();
  if (day === 0 || day === 6) return false;

  const timeInMinutes = eastern.getHours() * 60 + eastern.getMinutes();
  // 4:30 PM = 990, 5:00 PM = 1020
  return timeInMinutes >= 990 && timeInMinutes <= 1020;
}

// Track daily stock scan: stores the date string (YYYY-MM-DD) of the last
// completed post-close daily scan so we only do it once per day.
// Resets naturally each calendar day. Ephemeral — not trade state.
let lastDailyStockScanDate: string | null = null;

// ============================================================
// State lock — prevents overlapping scans (CLAUDE.md Rule #2)
// These are ephemeral by nature (reset on restart) and do not
// represent trade data, so they comply with Rule #2.
// ============================================================
let isScanning = false;
let scanCount = 0;
let scanIntervalId: ReturnType<typeof setInterval> | null = null;

// Exported scan metrics for /api/status
export let lastScanTimestamp: number = 0;
export let lastScanCandidates: number = 0;
export let lastScanPassedFilter: number = 0;
export { scanCount as totalScanCount };

// ============================================================
// Pipeline Stats — exported for GET /api/pipeline
// Tracks each step of the scan cycle for the dashboard view.
// Ephemeral (resets on restart) — not trade state.
// ============================================================
export let pipelineStats = {
  lastUpdated: 0,
  symbolsScanned: 0,
  cryptoCount: 0,
  equityCount: 0,
  marketOpen: false,
  timeframes: ["1D", "4H"] as string[],
  rawCandidates: 0,
  qualityPassed: 0,
  qualityRejected: 0,
  screenerPassed: 0,
  dedupSkipped: 0,
  newSignalsSaved: 0,
  ordersPlaced: 0,
  ordersSkipped: 0,
  paperOnlyCount: 0,
  exitCycleRan: false,
  pendingFills: 0,
  filledPositions: 0,
  partialExits: 0,
  closedTrades: 0,
};

// ============================================================
// Sent Signals Cache — prevents re-processing the same forming
// pattern every scan cycle while the candle is still open.
// Key: "symbol:timeframe:pattern:direction", Value: expiry timestamp.
// 4-hour TTL so a signal is only acted on once per candle.
// ============================================================
const sentSignals = new Map<string, number>();
const SIGNAL_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function isSignalAlreadySent(signal: PhaseCSignal): boolean {
  const key = `${signal.symbol}:${signal.timeframe}:${signal.pattern}:${signal.direction}`;
  const now = Date.now();
  const expiresAt = sentSignals.get(key);
  if (expiresAt && expiresAt > now) return true;
  // NOTE: Do NOT set the cache here — only mark after the signal is
  // actually processed (DB dedup passed + DB insert succeeded).
  // Lazy cleanup
  if (sentSignals.size > 500) {
    for (const [k, v] of sentSignals) {
      if (v <= now) sentSignals.delete(k);
    }
  }
  return false;
}

function markSignalSent(signal: PhaseCSignal): void {
  const key = `${signal.symbol}:${signal.timeframe}:${signal.pattern}:${signal.direction}`;
  sentSignals.set(key, Date.now() + SIGNAL_CACHE_TTL_MS);
}

// ============================================================
// The Scan Cycle — mutex-guarded, never overlaps
// ============================================================
async function runScanCycle(): Promise<void> {
  if (isScanning) {
    console.warn(
      "[Orchestrator] Scan already in progress — skipping this interval",
    );
    return;
  }

  isScanning = true;
  const cycleStart = Date.now();
  lastScanTimestamp = cycleStart;

  try {
    scanCount++;

    // ============================================================
    // Step 0: Initialize scan states on first run
    // ============================================================
    if (scanCount === 1) {
      try {
        const activeSymbols = await getActiveWatchlist();
        await initializeScanStates(activeSymbols, TIMEFRAMES);
      } catch (err) {
        console.error("[Orchestrator] Failed to initialize scan states (non-fatal):", err);
      }
    }

    // ---- Heartbeat: every 10th scan (~5 min at 30s intervals) ----
    if (scanCount % HEARTBEAT_EVERY_N_SCANS === 0) {
      try {
        const stats = await getScanStateStats();
        console.log(
          `[Orchestrator] 💓 Heartbeat: ${scanCount} scans. ` +
          `${stats.dueNow} due now, ${stats.hotSymbols.length} hot, ` +
          `${stats.byPhase["D_APPROACHING"] || 0} approaching D. ` +
          `Phase distribution: ${Object.entries(stats.byPhase).map(([p,c]) => `${p}=${c}`).join(", ")}`,
        );
      } catch {
        console.log(
          `[Orchestrator] 💓 Heartbeat: ${scanCount} scans completed. ` +
            `Engine is alive. ${new Date().toISOString()}`,
        );
      }
    }

    // ============================================================
    // Step 0.5: Load settings from DB
    // ============================================================
    const settings = await getSettings();

    // ============================================================
    // Step 1: Get symbols due for scanning (priority queue)
    // Falls back to full watchlist if scheduler fails.
    // ============================================================
    const activeSymbols = await getActiveWatchlist();
    const marketOpen = isStockMarketOpen();
    const postClose = isPostCloseWindow();
    const todayDate = getEasternTime().toISOString().slice(0, 10);
    const dailyScanDone = lastDailyStockScanDate === todayDate;
    const includeEquities = marketOpen || (postClose && !dailyScanDone);

    const cryptoSymbols = activeSymbols.filter((s) => s.includes("/"));
    const equitySymbols = activeSymbols.filter((s) => !s.includes("/"));

    let usedScheduler = false;
    let filteredJobs: Array<{ symbol: string; timeframe: "1D" | "4H"; currentPhase: string }> = [];

    try {
      const scanJobs = await getSymbolsDueForScan();

      // Apply market hours filter: remove equity jobs if market is closed
      filteredJobs = scanJobs.filter(job => {
        if (job.symbol.includes("/")) return true; // crypto always scans
        return includeEquities;
      });
      usedScheduler = true;
    } catch (err) {
      console.error("[Orchestrator] Scheduler failed, falling back to full watchlist:", err);
    }

    // Fallback: if scheduler failed, build jobs from full watchlist (old behavior)
    if (!usedScheduler) {
      const symbolsToScan = includeEquities ? activeSymbols : cryptoSymbols;
      for (const symbol of symbolsToScan) {
        for (const tf of TIMEFRAMES) {
          filteredJobs.push({ symbol, timeframe: tf, currentPhase: "UNKNOWN" });
        }
      }
    }

    if (!marketOpen && postClose && !dailyScanDone) {
      console.log(
        `[Orchestrator] Market CLOSED — post-close daily scan for ${equitySymbols.length} equities`,
      );
    }

    // Pipeline stats: Step 1 — what we're scanning
    const uniqueSymbolsThisCycle = new Set(filteredJobs.map(j => j.symbol));
    try {
      pipelineStats.symbolsScanned = uniqueSymbolsThisCycle.size;
      pipelineStats.cryptoCount = [...uniqueSymbolsThisCycle].filter(s => s.includes("/")).length;
      pipelineStats.equityCount = [...uniqueSymbolsThisCycle].filter(s => !s.includes("/")).length;
      pipelineStats.marketOpen = marketOpen;
      // Reset per-cycle counters
      pipelineStats.rawCandidates = 0;
      pipelineStats.qualityPassed = 0;
      pipelineStats.qualityRejected = 0;
      pipelineStats.screenerPassed = 0;
      pipelineStats.dedupSkipped = 0;
      pipelineStats.newSignalsSaved = 0;
      pipelineStats.ordersPlaced = 0;
      pipelineStats.ordersSkipped = 0;
      pipelineStats.paperOnlyCount = 0;
    } catch {}

    if (filteredJobs.length === 0) {
      // Nothing due this cycle — quick exit
      return;
    }

    console.log(
      `[Orchestrator] Scan #${scanCount}: ${filteredJobs.length} jobs due ` +
      `(${filteredJobs.filter(j => j.currentPhase === "D_APPROACHING").length} approaching D, ` +
      `${filteredJobs.filter(j => j.currentPhase === "CD_PROJECTED").length} projected, ` +
      `${filteredJobs.filter(j => ["NO_PATTERN","XA_FORMING","AB_FORMING"].includes(j.currentPhase)).length} cold)`,
    );

    // ============================================================
    // Step 2: Fetch candles ONLY for due symbols
    // ============================================================
    // Group jobs by timeframe for batched fetching
    const jobsByTf = new Map<"1D" | "4H", Set<string>>();
    for (const job of filteredJobs) {
      if (!jobsByTf.has(job.timeframe)) jobsByTf.set(job.timeframe, new Set());
      jobsByTf.get(job.timeframe)!.add(job.symbol);
    }

    const allCandleData = new Map<
      string,
      { candles: Awaited<ReturnType<typeof fetchWatchlist>> extends Map<string, infer V> ? V : never; timeframe: "1D" | "4H" }[]
    >();

    for (const [tf, symbolSet] of jobsByTf) {
      const symbols = [...symbolSet];
      if (symbols.length === 0) continue;

      const watchlistData = await fetchWatchlist(symbols, tf);
      for (const [symbol, candles] of watchlistData) {
        if (!allCandleData.has(symbol)) allCandleData.set(symbol, []);
        allCandleData.get(symbol)!.push({ candles, timeframe: tf });
      }
    }

    // Mark daily stock scan as done if we just ran the post-close scan
    if (!marketOpen && postClose && !dailyScanDone && includeEquities) {
      lastDailyStockScanDate = todayDate;
      console.log(`[Orchestrator] Post-close daily stock scan complete for ${todayDate}`);
    }

    // ============================================================
    // Step 2.5: Update scan state for every scanned symbol
    // Detect pattern phase and update the scheduler (sets next scan due)
    // ============================================================
    for (const [symbol, datasets] of allCandleData) {
      for (const { candles, timeframe } of datasets) {
        if (candles.length < 20) continue;
        try {
          const phaseResult = detectPatternPhase(candles, symbol, timeframe);
          await updateScanState(symbol, timeframe, phaseResult);
        } catch (err) {
          // Non-fatal: scheduler update failure doesn't block signal detection
          console.error(`[Orchestrator] Phase detection failed for ${symbol} ${timeframe}:`, err);
        }
      }
    }

    // ============================================================
    // Step 3: Run harmonic detection on all fetched data
    // Both forming (Phase C) and completed (all 5 pivots confirmed)
    // ============================================================
    const candidates: PhaseCSignal[] = [];

    for (const [symbol, datasets] of allCandleData) {
      for (const { candles, timeframe } of datasets) {
        if (candles.length < 20) continue; // Not enough data for pivots

        // Mode 1: Completed patterns (D is a real pivot → market order)
        const completed = detectCompletedPatterns(candles, symbol, timeframe);
        candidates.push(...completed);

        // Mode 2: Forming patterns (D is projected → limit order)
        const forming = detectHarmonics(candles, symbol, timeframe);
        candidates.push(...forming);
      }
    }

    lastScanCandidates = candidates.length;

    // Pipeline stats: Step 3 — raw candidates
    try { pipelineStats.rawCandidates = candidates.length; } catch {}

    console.log(
      `[Orchestrator] Scan #${scanCount}: ${candidates.length} raw candidates found`,
    );

    if (candidates.length === 0) {
      lastScanPassedFilter = 0;
      const elapsed = Date.now() - cycleStart;
      console.log(
        `[Orchestrator] Scan #${scanCount} complete (${elapsed}ms) — no signals`,
      );
      return;
    }

    // ============================================================
    // Step 2.5: Quality filters — 7-rule validation gate
    // Applied BEFORE dedup so bad signals never hit the database.
    // ============================================================
    const qualityPassed = validateSignalQuality(candidates);
    lastScanPassedFilter = qualityPassed.length;

    // Pipeline stats: Step 4 — quality filter results
    try {
      pipelineStats.qualityPassed = qualityPassed.length;
      pipelineStats.qualityRejected = candidates.length - qualityPassed.length;
    } catch {}

    // ============================================================
    // Step 3: Filter through Phase C screener (kills Crab/Deep Crab)
    // ============================================================
    const validSignals = await processPhaseCSignals(qualityPassed, settings.enabledPatterns);

    // Pipeline stats: Step 5 — screener results
    try { pipelineStats.screenerPassed = validSignals.length; } catch {}

    if (validSignals.length === 0) {
      const elapsed = Date.now() - cycleStart;
      console.log(
        `[Orchestrator] Scan #${scanCount} complete (${elapsed}ms) — no valid signals`,
      );
      return;
    }

    // ============================================================
    // Step 4: Fetch equity, save to DB, execute orders
    // Equity fetch is wrapped in try/catch so a temporary Alpaca
    // outage doesn't kill the scan — signals still get logged.
    // ============================================================
    let equity: number | null = null;
    let buyingPower: number | null = null;
    try {
      const acct = await getAccountEquity();
      equity = acct.equity;
      buyingPower = acct.buyingPower;
      console.log(`[Orchestrator] Account equity: $${equity.toFixed(2)}, buying power: $${buyingPower.toFixed(2)}`);
    } catch (err) {
      console.error("[Orchestrator] Failed to fetch Alpaca equity:", err);
      sendError("Alpaca equity fetch failed — signals detected but orders skipped", err).catch(() => {
        console.error("[Orchestrator] Failed to send error notification");
      });
    }

    for (const signal of validSignals) {
      // ---- Layer 1: In-memory cache (fast, survives within process) ----
      if (isSignalAlreadySent(signal)) {
        console.log(
          `[Orchestrator] Skipping duplicate signal: ${signal.symbol} ${signal.pattern} ${signal.timeframe} (in-memory cache)`,
        );
        try { pipelineStats.dedupSkipped++; } catch {}
        continue;
      }

      // ---- Layer 2: DB dedup (authoritative, survives restarts) ----
      // Uses the age window from quality-filters: 1D=14 days, 4H=7 days
      try {
        const windowMs = AGE_WINDOW_MS[signal.timeframe as keyof typeof AGE_WINDOW_MS] ?? (14 * 24 * 60 * 60 * 1000);
        const timeWindow = new Date(Date.now() - windowMs);

        const existing = await db
          .select({ id: liveSignals.id })
          .from(liveSignals)
          .where(
            and(
              eq(liveSignals.symbol, signal.symbol),
              eq(liveSignals.timeframe, signal.timeframe),
              eq(liveSignals.patternType, signal.pattern),
              eq(liveSignals.direction, signal.direction),
              inArray(liveSignals.status, ["pending", "filled", "partial_exit", "paper_only"]),
              gte(liveSignals.createdAt, timeWindow),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          console.log(
            `[Orchestrator] Skipping duplicate signal: ${signal.symbol} ${signal.pattern} ${signal.timeframe} (exists in DB within age window)`,
          );
          try { pipelineStats.dedupSkipped++; } catch {}
          continue;
        }
      } catch (err) {
        console.error("[Orchestrator] DB dedup check failed, proceeding with caution:", err);
      }

      const isCrypto = signal.symbol.includes("/");

      try {
        // ---- Zod validation (Anti-NULL Rule: CLAUDE.md Rule #2) ----
        const parsed = insertLiveSignalSchema.parse({
          symbol: signal.symbol,
          patternType: signal.pattern,
          timeframe: signal.timeframe,
          direction: signal.direction,
          entryPrice: String(signal.limitPrice),
          stopLossPrice: String(signal.stopLossPrice),
          tp1Price: String(signal.tp1Price),
          tp2Price: String(signal.tp2Price),
          xPrice: String(signal.xPrice),
          aPrice: String(signal.aPrice),
          bPrice: String(signal.bPrice),
          cPrice: String(signal.cPrice),
        });

        // ---- Telegram alert: only fires for truly new signals ----
        sendPhaseCSignal(
          signal.symbol,
          signal.timeframe,
          signal.pattern,
          signal.direction,
          signal.limitPrice,
        ).catch((alertErr) => {
          console.error(`[Orchestrator] Telegram alert failed for ${signal.symbol}:`, alertErr);
        });

        // ---- Insert into Neon DB (returning ID for exit manager tracking) ----
        const [inserted] = await db.insert(liveSignals).values(parsed).returning({ id: liveSignals.id });
        console.log(
          `[Orchestrator] Signal saved to DB: ${signal.symbol} ${signal.pattern} (id=${inserted.id})`,
        );
        try { pipelineStats.newSignalsSaved++; } catch {}

        // Mark in-memory cache AFTER successful DB insert (not before)
        markSignalSent(signal);

        // ---- Place limit order on Alpaca (only if equity was fetched AND trading enabled) ----
        if (isCrypto && signal.direction === "short") {
          // Crypto SHORTs: save for paper trading validation but no Alpaca order
          console.log(
            `[Orchestrator] Crypto SHORT tracked as paper_only (no Alpaca order): ${signal.symbol} ${signal.pattern} ${signal.timeframe}`,
          );
          await db.update(liveSignals).set({ status: "paper_only" }).where(eq(liveSignals.id, inserted.id));
          try { pipelineStats.paperOnlyCount++; } catch {}
        } else if (!settings.tradingEnabled) {
          console.log(
            `[Orchestrator] Trading PAUSED — signal saved but order skipped for ${signal.symbol}`,
          );
          try { pipelineStats.ordersSkipped++; } catch {}
        } else if (equity !== null) {
          // Pre-check: skip if order notional exceeds available buying power
          // This prevents 403 spam when GTC orders have locked up most cash
          const allocation = isCrypto ? settings.cryptoAllocation : settings.equityAllocation;
          const notional = equity * allocation;
          if (buyingPower !== null && notional > buyingPower) {
            console.warn(
              `[Orchestrator] Skipping order for ${signal.symbol}: notional $${notional.toFixed(2)} ` +
              `exceeds available buying power $${buyingPower.toFixed(2)}`,
            );
            try { pipelineStats.ordersSkipped++; } catch {}
          } else {
          const order = await placePhaseCLimitOrder(signal, equity, isCrypto, {
              equity: settings.equityAllocation,
              crypto: settings.cryptoAllocation,
            }, buyingPower ?? undefined);
            // Save the Alpaca order ID so exit-manager can track fills
            await db
              .update(liveSignals)
              .set({ entryOrderId: order.id })
              .where(eq(liveSignals.id, inserted.id));
            try { pipelineStats.ordersPlaced++; } catch {}
          }
        } else {
          console.warn(
            `[Orchestrator] Skipping order for ${signal.symbol} — no equity data`,
          );
          try { pipelineStats.ordersSkipped++; } catch {}
        }
      } catch (err) {
        console.error(
          `[Orchestrator] Failed to execute signal ${signal.symbol}:`,
          err,
        );
        // Fire Telegram alert — per-signal failure doesn't kill the loop
        sendError(
          `Signal execution failed: ${signal.symbol} ${signal.pattern}`,
          err,
        ).catch(() => {
          console.error("[Orchestrator] Failed to send error notification");
        });
      }
    }

    const elapsed = Date.now() - cycleStart;
    console.log(
      `[Orchestrator] Scan #${scanCount} complete (${elapsed}ms) — ` +
        `${validSignals.length} signals processed`,
    );
  } catch (err) {
    console.error("[Orchestrator] Scan cycle failed:", err);
    // Fire Telegram alert — but don't let a notification failure crash the loop
    sendError(`Scan cycle #${scanCount} failed`, err).catch(() => {
      console.error("[Orchestrator] Failed to send error notification");
    });
  } finally {
    // ---- Exit Manager: check fills, place TP/SL, manage lifecycle ----
    // Runs in finally so it executes even if the scan portion threw.
    // Its own errors are caught internally — won't block the lock release.
    try {
      await runExitCycle();
    } catch (err) {
      console.error("[Orchestrator] Exit cycle failed:", err);
    }

    // ---- Position Monitor: real-time TP/SL checks via WebSocket prices ----
    try {
      await runCryptoMonitor();
    } catch (err) {
      console.error("[Orchestrator] Position monitor failed:", err);
    }

    // ---- Stale GTC Cleanup: cancel orders older than 7 days ----
    try {
      await cancelStaleGtcOrders();
    } catch (err) {
      console.error("[Orchestrator] Stale GTC cleanup failed:", err);
    }

    // ---- Pipeline stats: final status counts from DB ----
    try {
      pipelineStats.exitCycleRan = true;
      const allActive = await db
        .select({ status: liveSignals.status })
        .from(liveSignals)
        .where(inArray(liveSignals.status, ["pending", "filled", "partial_exit", "closed", "paper_only"]));
      pipelineStats.pendingFills = allActive.filter((r) => r.status === "pending" || r.status === "paper_only").length;
      pipelineStats.filledPositions = allActive.filter((r) => r.status === "filled").length;
      pipelineStats.partialExits = allActive.filter((r) => r.status === "partial_exit").length;
      pipelineStats.closedTrades = allActive.filter((r) => r.status === "closed").length;
      pipelineStats.lastUpdated = Date.now();
    } catch (err) {
      console.error("[Orchestrator] Pipeline stats query failed (non-fatal):", err);
      pipelineStats.lastUpdated = Date.now();
    }

    // ALWAYS release the lock, even if the scan threw
    isScanning = false;
  }
}

// ============================================================
// Stale GTC Order Cleanup — cancels orders older than 7 days
// ============================================================
const STALE_GTC_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function cancelStaleGtcOrders(): Promise<void> {
  const ALPACA_API_KEY = process.env.ALPACA_API_KEY;
  const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;
  const ALPACA_BASE_URL = (process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets").replace(/\/v2\/?$/, "");

  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    console.warn("[Orchestrator] Skipping stale GTC cleanup — Alpaca keys not set");
    return;
  }

  try {
    // Step 1: Fetch all open orders
    checkTradingRateLimit();
    const res = await fetch(`${ALPACA_BASE_URL}/v2/orders?status=open&limit=200`, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Orchestrator] Failed to fetch open orders for stale GTC cleanup: ${res.status} — ${body}`);
      return;
    }

    const orders = (await res.json()) as Array<{
      id: string;
      symbol: string;
      side: string;
      time_in_force: string;
      created_at: string;
    }>;

    const now = Date.now();
    let cancelledCount = 0;

    for (const order of orders) {
      if (order.time_in_force !== "gtc") continue;

      const ageMs = now - new Date(order.created_at).getTime();
      if (ageMs < STALE_GTC_AGE_MS) continue;

      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

      try {
        // Step 2: Cancel the stale order
        checkTradingRateLimit();
        const cancelRes = await fetch(`${ALPACA_BASE_URL}/v2/orders/${order.id}`, {
          method: "DELETE",
          headers: {
            "APCA-API-KEY-ID": ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
          },
        });

        if (!cancelRes.ok && cancelRes.status !== 404) {
          const body = await cancelRes.text();
          console.error(`[Orchestrator] Failed to cancel stale order ${order.id}: ${cancelRes.status} — ${body}`);
          continue;
        }

        console.log(
          `[Orchestrator] Cancelled stale GTC order: ${order.symbol} ${order.side} age=${ageDays}d orderId=${order.id}`,
        );
        cancelledCount++;

        // Step 3: Update matching live_signals row to "expired" (only pending — not paper_only)
        try {
          await db
            .update(liveSignals)
            .set({ status: "expired" })
            .where(and(eq(liveSignals.entryOrderId, order.id), eq(liveSignals.status, "pending")));
        } catch (dbErr) {
          console.error(`[Orchestrator] Failed to update signal status for cancelled order ${order.id}:`, dbErr);
        }
      } catch (err) {
        // Rate limit exhausted or network error — stop cancelling, try next cycle
        console.error(`[Orchestrator] Error cancelling stale order ${order.id}:`, err);
        break;
      }
    }

    if (cancelledCount > 0) {
      console.log(`[Orchestrator] Stale GTC cleanup: cancelled ${cancelledCount} order(s)`);
    }
  } catch (err) {
    console.error("[Orchestrator] Stale GTC cleanup failed:", err);
  }
}

// ============================================================
// Boot Sequence — the single entry point for the entire bot
// ============================================================
export async function startEngine(): Promise<void> {
  console.log("[Orchestrator] Booting Pattern Bot engine — build 2026-03-13-v2 (market-hours + pagination + quality-logs)");

  // Ensure DB tables exist before first scan
  await ensureTablesExist();

  // Verify watchlist populated correctly
  try {
    const symbols = await getActiveWatchlist();
    console.log(`[Orchestrator] Watchlist loaded: ${symbols.length} symbols → ${symbols.join(", ")}`);
  } catch (err) {
    console.error("[Orchestrator] Watchlist verification failed:", err);
  }

  // Fire the green "online" Telegram notification
  try {
    await sendSystemBoot();
  } catch (err) {
    // Boot notification failure is non-fatal — keep going
    console.error("[Orchestrator] Failed to send boot notification:", err);
  }

  // Start WebSocket price streams for real-time TP/SL monitoring
  try {
    const activeSymbols = await getActiveWatchlist();
    startPriceStreams(activeSymbols);
  } catch (err) {
    console.error("[Orchestrator] Failed to start price streams (non-fatal):", err);
  }

  // Run the first scan immediately (don't wait 30s)
  await runScanCycle();

  // Start the interval loop
  scanIntervalId = setInterval(() => {
    runScanCycle();
  }, SCAN_INTERVAL_MS);

  console.log(
    `[Orchestrator] Scanner loop started: every ${SCAN_INTERVAL_MS / 1000}s. ` +
      `Heartbeat every ${HEARTBEAT_EVERY_N_SCANS} scans.`,
  );
}

/**
 * Graceful shutdown — clears the interval and WebSocket connections.
 */
export function stopEngine(): void {
  if (scanIntervalId !== null) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
    console.log("[Orchestrator] Scanner loop stopped.");
  }
  stopPriceStreams();
}
