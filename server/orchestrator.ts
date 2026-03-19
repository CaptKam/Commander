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
import { fetchWatchlist, getLatestCachedPrice } from "./alpaca-data";
import { detectHarmonics, detectCompletedPatterns, detectPatternPhase } from "./patterns";
import { processPhaseCSignals } from "./screener";
import type { PhaseCSignal } from "./screener";
import { runExitCycle } from "./exit-manager";
import { runCryptoMonitor } from "./crypto-monitor";
import { validateSignalQuality, AGE_WINDOW_MS } from "./quality-filters";
import { startPriceStreams, stopPriceStreams, getStreamPrice, setStreamPriceIfStale } from "./websocket-stream";
import { placePhaseCLimitOrder, getAccountEquity } from "./alpaca";
import { checkTradingRateLimit } from "./utils/tradingRateLimiter";
import { selectBestSignals } from "./signal-ranker";
import { getSymbolsDueForScan, updateScanState, initializeScanStates, getScanStateStats } from "./scan-scheduler";
import { db, ensureTablesExist } from "./db";
import { liveSignals, insertLiveSignalSchema, watchlist, systemSettings } from "../shared/schema";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";

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
// Market hours — controls ORDER PLACEMENT for equities only.
// Pattern scanning runs 24/7 for all symbols (crypto + equities).
// SIP WebSocket still only connects during market hours.
// ============================================================
function getEasternTime(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

/**
 * Returns true if within the extended stock trading window:
 * Mon-Fri 9:00 AM – 4:30 PM Eastern (30-min buffer each side of 9:30–4:00).
 * Used to gate equity ORDER PLACEMENT only — scanning runs 24/7.
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
  projectedCount: 0,
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
  const key = signal.symbol; // Symbol-only — one signal per symbol
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
  const key = signal.symbol; // Symbol-only — one signal per symbol
  sentSignals.set(key, Date.now() + SIGNAL_CACHE_TTL_MS);
}
// ============================================================
// Max Open Orders Cap — prevent capital lockup
// ============================================================
const MAX_OPEN_ORDERS = 5; // Industry standard: 3-10 concurrent
let cachedOpenOrderCount: number | null = null;
let cachedOpenOrderCountTs = 0;

async function getOpenOrderCount(): Promise<number> {
  // Cache for 30 seconds to avoid hammering Alpaca API
  if (cachedOpenOrderCount !== null && Date.now() - cachedOpenOrderCountTs < 30_000) {
    return cachedOpenOrderCount;
  }
  try {
    const res = await fetch(`${process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets"}/v2/orders?status=open`, {
      headers: {
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY!,
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET!,
      },
    });
    if (res.ok) {
      const orders = await res.json() as any[];
      cachedOpenOrderCount = orders.length;
      cachedOpenOrderCountTs = Date.now();
      return orders.length;
    }
  } catch {}
  return cachedOpenOrderCount ?? 0;
}

// ============================================================
// Proximity Gate — only place orders when price is near projected D
// ============================================================
const PROXIMITY_THRESHOLD_PCT = 0.02; // 2% from entry price — industry standard (Freqtrade default) // 5% from entry price

/**
 * Checks if the current market price is within proximity of the signal's
 * projected D entry price. Only signals near their entry deserve a live
 * limit order on Alpaca — distant signals waste buying power.
 *
 * Threshold: 5% of entry price. A BTC signal at D=$66,000 won't place
 * an order until BTC is within $69,300 (for long) or $62,700 (for short).
 */
function isWithinProximity(signal: PhaseCSignal): boolean {
  // Try WebSocket price first, then candle cache
  let currentPrice = getStreamPrice(signal.symbol);

  // Fallback: try candle cache if WebSocket has nothing
  if (currentPrice === null || currentPrice <= 0) {
    const cachedPrice = getLatestCachedPrice(signal.symbol);
    if (cachedPrice !== null && cachedPrice > 0) {
      currentPrice = cachedPrice;
    }
  }

  if (currentPrice === null || currentPrice <= 0) {
    // No price data AT ALL — do NOT place an order blind.
    // Save as projected, will check again when we have price data.
    console.log(
      `[Orchestrator] No current price for ${signal.symbol} — saving as projected (NOT placing order)`,
    );
    return false;
  }

  const entryPrice = signal.limitPrice;
  const distancePct = Math.abs(currentPrice - entryPrice) / entryPrice;

  if (distancePct <= PROXIMITY_THRESHOLD_PCT) {
    console.log(
      `[Orchestrator] ${signal.symbol} within proximity: current=$${currentPrice.toFixed(4)} ` +
      `entry=$${entryPrice.toFixed(4)} (${(distancePct * 100).toFixed(1)}% away, threshold=${(PROXIMITY_THRESHOLD_PCT * 100)}%)`,
    );
    return true;
  }

  console.log(
    `[Orchestrator] ${signal.symbol} NOT within proximity: current=$${currentPrice.toFixed(4)} ` +
    `entry=$${entryPrice.toFixed(4)} (${(distancePct * 100).toFixed(1)}% away > ${(PROXIMITY_THRESHOLD_PCT * 100)}% threshold)`,
  );
  return false;
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
    // Step 0: Initialize scan states on first run — seed from universe
    // ============================================================
    if (scanCount === 1) {
      // Step 1: Seed from Alpaca's full asset list (or keep existing if fetch fails)
      try {
        const { getFullUniverse } = await import("./universe");
        const universe = await getFullUniverse();
        if (universe.length > 0) {
          const { seedUniverse } = await import("./scan-scheduler");
          const result = await seedUniverse(universe);
          console.log(
            `[Orchestrator] Universe seeded: ${result.seeded} new, ${result.existing} existing, ${result.removed} paused`,
          );
        } else {
          console.warn("[Orchestrator] Universe fetch returned empty — using existing scan states");
        }
      } catch (err) {
        console.error("[Orchestrator] Universe seed failed — using existing scan states:", err);
      }

      // Step 2: Also ensure watchlist favorites are in scan_state (backward compat)
      try {
        const watchlistSymbols = await getActiveWatchlist();
        await initializeScanStates(watchlistSymbols, TIMEFRAMES);
      } catch (err) {
        console.error("[Orchestrator] Failed to initialize scan states (non-fatal):", err);
      }
    }

    // ============================================================
    // Step 0.1: Daily universe refresh (~every 24h at 30s intervals)
    // ============================================================
    if (scanCount > 1 && scanCount % (24 * 60 * 2) === 0) {
      try {
        const { getFullUniverse } = await import("./universe");
        const universe = await getFullUniverse();
        if (universe.length > 0) {
          const { seedUniverse } = await import("./scan-scheduler");
          const result = await seedUniverse(universe);
          console.log(`[Orchestrator] Daily universe refresh: ${result.seeded} new, ${result.removed} paused`);
        }
      } catch (err) {
        console.error("[Orchestrator] Daily universe refresh failed:", err);
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

    let usedScheduler = false;
    let filteredJobs: Array<{ symbol: string; timeframe: "1D" | "4H"; currentPhase: string }> = [];

    try {
      // All symbols scan 24/7 for pattern detection
      // Market hours only restrict ORDER PLACEMENT (handled in execution loop)
      filteredJobs = await getSymbolsDueForScan();
      usedScheduler = true;
    } catch (err) {
      console.error("[Orchestrator] Scheduler failed, falling back to full watchlist:", err);
    }

    // Fallback: if scheduler failed, build jobs from full watchlist
    if (!usedScheduler) {
      for (const symbol of activeSymbols) {
        for (const tf of TIMEFRAMES) {
          filteredJobs.push({ symbol, timeframe: tf, currentPhase: "UNKNOWN" });
        }
      }
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

    const marketStatus = marketOpen ? "OPEN" : "CLOSED";
    console.log(
      `[Orchestrator] Scan #${scanCount}: Market ${marketStatus} — ${filteredJobs.length} jobs due ` +
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

    // ============================================================
    // Step 2.5: Update scan state for every scanned symbol
    // Detect pattern phase and update the scheduler (sets next scan due)
    // ============================================================
    for (const [symbol, datasets] of allCandleData) {
      for (const { candles, timeframe } of datasets) {
        if (candles.length < 20) continue;

        // Seed price cache from latest candle close (fallback when WebSocket has no data)
        const lastClose = (candles[candles.length - 1] as { close?: number }).close;
        if (lastClose && lastClose > 0) {
          setStreamPriceIfStale(symbol, lastClose);
        }

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
    // Step 5.5: Rank signals — pick best pattern per symbol
    // If AAVE/USD has 7 qualifying patterns, only the highest-scoring
    // one gets an order. Others are saved as "outranked" for analysis.
    // ============================================================
    const { selected: bestSignals, outranked } = selectBestSignals(validSignals);

    console.log(
      `[Orchestrator] Ranking: ${validSignals.length} valid → ${bestSignals.length} best (${outranked.length} outranked)`,
    );

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

    for (const scored of bestSignals) {
      const signal = scored.signal;
      const signalScore = scored.score;

      // ---- Layer 1: In-memory cache (fast, survives within process) ----
      if (isSignalAlreadySent(signal)) {
        console.log(
          `[Orchestrator] Skipping duplicate signal: ${signal.symbol} ${signal.pattern} ${signal.timeframe} (in-memory cache)`,
        );
        try { pipelineStats.dedupSkipped++; } catch {}
        continue;
      }

      // ---- Layer 2: DB dedup (authoritative, survives restarts) ----
      // One signal per symbol — if ANY active signal exists for this symbol, skip.
      // Only active statuses block; dismissed/expired/outranked do NOT block new signals.
      try {
        const timeWindow = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7-day window

        const existing = await db
          .select({ id: liveSignals.id, patternType: liveSignals.patternType, timeframe: liveSignals.timeframe, status: liveSignals.status })
          .from(liveSignals)
          .where(
            and(
              eq(liveSignals.symbol, signal.symbol),
              inArray(liveSignals.status, ["pending", "filled", "partial_exit", "projected"]),
              gte(liveSignals.createdAt, timeWindow),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          console.log(
            `[Orchestrator] Skipping signal: ${signal.symbol} already has active signal (${existing[0].patternType} ${existing[0].timeframe} ${existing[0].status})`,
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

        // ---- Insert into Neon DB (returning ID for exit manager tracking) ----
        const [inserted] = await db.insert(liveSignals).values({ ...parsed, score: signalScore }).returning({ id: liveSignals.id });
        console.log(
          `[Orchestrator] Signal saved to DB: ${signal.symbol} ${signal.pattern} score=${signalScore.toFixed(1)} (id=${inserted.id})`,
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
        } else if (!isCrypto && !isStockMarketOpen()) {
          // Equity signal detected outside market hours — save but don't place order
          // Leave status as "pending" — exit-manager won't touch it since there's no entryOrderId
          console.log(
            `[Orchestrator] Equity signal saved, order deferred until market open: ${signal.symbol} ${signal.pattern} ${signal.direction}`,
          );
          try { pipelineStats.ordersSkipped++; } catch {}
        } else if (!isWithinProximity(signal)) {
          // Price is too far from projected D — save as "projected", don't place order yet
          // This preserves buying power for signals that are actually close to triggering
          await db.update(liveSignals).set({ status: "projected" }).where(eq(liveSignals.id, inserted.id));
          console.log(
            `[Orchestrator] Signal saved as PROJECTED (price not near D): ${signal.symbol} ${signal.pattern} ` +
            `${signal.direction} — D=$${signal.limitPrice.toFixed(2)}, proximity threshold not met`,
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
          // ---- Max open orders cap ----
          const openCount = await getOpenOrderCount();
          if (openCount >= MAX_OPEN_ORDERS) {
            console.warn(`[Orchestrator] MAX_OPEN_ORDERS (${MAX_OPEN_ORDERS}) reached — skipping ${signal.symbol}`);
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
            // Telegram alert — only when order is actually placed
            sendPhaseCSignal(
              signal.symbol,
              signal.timeframe,
              signal.pattern,
              signal.direction,
              signal.limitPrice,
            ).catch(() => {});
          }
          }
        } else {
          console.warn(
            `[Orchestrator] Skipping order for ${signal.symbol} — no equity data`,
          );
          try { pipelineStats.ordersSkipped++; } catch {}
        }
      } catch (err: any) {
        if (err?.notShortable && inserted?.id) {
          await db.update(liveSignals)
            .set({ status: "paper_only" })
            .where(eq(liveSignals.id, inserted.id));
          console.warn(`[Orchestrator] ${signal.symbol} marked paper_only (not shortable)`);
          try { pipelineStats.ordersSkipped++; } catch {}
        } else if (err?.insufficientBP) {
          console.warn(`[Orchestrator] Skipping ${signal.symbol}: insufficient buying power`);
          try { pipelineStats.ordersSkipped++; } catch {}
        } else {
          console.error(
            `[Orchestrator] Failed to execute signal ${signal.symbol}:`,
            err,
          );
          sendError(
            `Signal execution failed: ${signal.symbol} ${signal.pattern}`,
            err,
          ).catch(() => {
            console.error("[Orchestrator] Failed to send error notification");
          });
        }
      }
    }

    // Log outranked signals but don't persist to DB (reduces writes by ~60%)
    // Previously saved all outranked to live_signals — 1,693+ rows of diagnostic data
    // that was rarely referenced and consumed significant Neon transfer budget.
    if (outranked.length > 0) {
      console.log(`[Orchestrator] ${outranked.length} outranked signals (not persisted): ${outranked.map((s) => `${s.signal.symbol}/${s.signal.pattern}`).join(", ")}`);
    }

    // ============================================================
    // CATCH-UP: Place orders for pending signals that have no order yet
    // Handles equity signals saved during off-hours + any crypto longs
    // that were saved but missed order placement for any reason.
    // ============================================================
    try {
      const marketOpen = isStockMarketOpen();
      const pendingNoOrder = await db
        .select()
        .from(liveSignals)
        .where(
          and(
            eq(liveSignals.status, "pending"),
            isNull(liveSignals.entryOrderId),
          ),
        )
        .limit(20);

      if (pendingNoOrder.length > 0) {
        const equityData = await getAccountEquity();
        const catchupEquity = equityData?.equity ?? null;
        const catchupBp = equityData?.buyingPower ?? null;

        const existingOrderSymbols = new Set<string>();
        try {
          const alpacaBase = (process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets").replace(/\/v2\/?$/, "");
          const orderRes = await fetch(`${alpacaBase}/v2/orders?status=open&limit=500`, {
            headers: { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY!, "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET! },
          });
          if (orderRes.ok) {
            const openOrders = await orderRes.json() as any[];
            for (const o of openOrders) existingOrderSymbols.add(o.symbol);
          }
        } catch {}

        let placed = 0;
        let skipped = 0;
        for (const sig of pendingNoOrder) {
          try {
            const isCrypto = sig.symbol.includes("/");

            if (isCrypto && sig.direction === "short") {
              await db.update(liveSignals).set({ status: "paper_only" }).where(eq(liveSignals.id, sig.id));
              skipped++;
              continue;
            }

            const alpacaSymbol = sig.symbol.replace("/", "");
            if (existingOrderSymbols.has(alpacaSymbol) || existingOrderSymbols.has(sig.symbol)) {
              skipped++;
              continue;
            }

            if (!isCrypto && !marketOpen) {
              skipped++;
              continue;
            }

            if (!settings.tradingEnabled) {
              skipped++;
              continue;
            }

            if (catchupEquity === null) {
              skipped++;
              continue;
            }

            const allocation = isCrypto ? settings.cryptoAllocation : settings.equityAllocation;
            const notional = catchupEquity * allocation;
            if (catchupBp !== null && notional > catchupBp) {
              console.warn(`[Catchup] Skipping ${sig.symbol}: notional $${notional.toFixed(2)} > BP $${catchupBp.toFixed(2)}`);
              skipped++;
              continue;
            }

            const pseudoSignal = {
              symbol: sig.symbol,
              pattern: sig.patternType as any,
              timeframe: sig.timeframe as any,
              direction: sig.direction as any,
              limitPrice: Number(sig.entryPrice),
              stopLossPrice: Number(sig.stopLossPrice),
              tp1Price: Number(sig.tp1Price),
              tp2Price: Number(sig.tp2Price),
              xPrice: Number(sig.xPrice ?? 0),
              aPrice: Number(sig.aPrice ?? 0),
              bPrice: Number(sig.bPrice ?? 0),
              cPrice: Number(sig.cPrice ?? 0),
            };
            // ---- Max open orders cap ----
            const catchupOpenCount = await getOpenOrderCount();
            if (catchupOpenCount >= MAX_OPEN_ORDERS) {
              console.warn(`[Orchestrator] MAX_OPEN_ORDERS reached — skipping catch-up for ${sig.symbol}`);
              continue;
            }

            const order = await placePhaseCLimitOrder(pseudoSignal as any, catchupEquity, isCrypto, {
              equity: settings.equityAllocation,
              crypto: settings.cryptoAllocation,
            }, catchupBp ?? undefined);

            await db.update(liveSignals)
              .set({ entryOrderId: order.id })
              .where(eq(liveSignals.id, sig.id));
            existingOrderSymbols.add(alpacaSymbol);
            placed++;
            console.log(`[Catchup] Order placed for ${sig.symbol} ${sig.patternType} ${sig.direction} (id=${order.id})`);
            // Telegram alert — only when order is actually placed
            sendPhaseCSignal(
              sig.symbol,
              sig.timeframe as "1D" | "4H",
              sig.patternType,
              sig.direction as "long" | "short",
              Number(sig.entryPrice),
            ).catch(() => {});
          } catch (err: any) {
            if (err?.notShortable) {
              await db.update(liveSignals)
                .set({ status: "paper_only" })
                .where(eq(liveSignals.id, sig.id));
              console.warn(`[Catchup] ${sig.symbol} marked paper_only (not shortable)`);
              skipped++;
            } else if (err?.insufficientBP) {
              console.warn(`[Catchup] Stopping: insufficient buying power (failed on ${sig.symbol})`);
              skipped += pendingNoOrder.length - pendingNoOrder.indexOf(sig);
              break;
            } else {
              console.error(`[Catchup] Failed to place order for ${sig.symbol}:`, err);
            }
          }
        }
        if (placed > 0 || pendingNoOrder.length > 0) {
          console.log(`[Catchup] ${placed} orders placed, ${skipped} skipped, ${pendingNoOrder.length} total pending without orders`);
        }
      }
    } catch (err) {
      console.error("[Catchup] Catch-up cycle failed:", err);
    }

    const elapsed = Date.now() - cycleStart;
    console.log(
      `[Orchestrator] Scan #${scanCount} complete (${elapsed}ms) — ` +
        `${bestSignals.length} best signals processed (${outranked.length} outranked)`,
    );
  } catch (err) {
    console.error("[Orchestrator] Scan cycle failed:", err);
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes("TradingRateLimit")) {
      sendError(`Scan cycle #${scanCount} failed`, err).catch(() => {
        console.error("[Orchestrator] Failed to send error notification");
      });
    }
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

    // ---- Promote projected signals that are now within proximity ----
    try {
      const projectedSignals = await db
        .select()
        .from(liveSignals)
        .where(eq(liveSignals.status, "projected"))
        .limit(50);

      if (projectedSignals.length > 0) {
        // Fetch fresh equity/buying power for promotion decisions
        let promoEquity: number | null = null;
        let promoBuyingPower: number | null = null;
        try {
          const acct = await getAccountEquity();
          promoEquity = acct.equity;
          promoBuyingPower = acct.buyingPower;
        } catch { /* equity fetch failed — skip promotions this cycle */ }

        const promoSettings = await getSettings();

        for (const sig of projectedSignals) {
          const sigIsCrypto = sig.symbol.includes("/");
          const entryPrice = Number(sig.entryPrice);
          const currentPrice = getStreamPrice(sig.symbol);

          if (currentPrice === null || currentPrice <= 0) continue;

          const distancePct = Math.abs(currentPrice - entryPrice) / entryPrice;
          if (distancePct > PROXIMITY_THRESHOLD_PCT) continue;

          // Price is now close — check market hours for equities
          if (!sigIsCrypto && !isStockMarketOpen()) continue;

          if (!promoSettings.tradingEnabled || promoEquity === null) continue;

          // Check buying power
          const allocation = sigIsCrypto ? promoSettings.cryptoAllocation : promoSettings.equityAllocation;
          const notional = promoEquity * allocation;
          if (promoBuyingPower !== null && notional > promoBuyingPower) {
            console.warn(`[Orchestrator] Cannot promote ${sig.symbol}: insufficient buying power`);
            continue;
          }

          // ---- Max open orders cap ----
          const promoOpenCount = await getOpenOrderCount();
          if (promoOpenCount >= MAX_OPEN_ORDERS) {
            console.warn("[Orchestrator] MAX_OPEN_ORDERS reached — skipping promotion for " + sig.symbol);
            continue;
          }

          try {
            const order = await placePhaseCLimitOrder(
              {
                symbol: sig.symbol,
                timeframe: sig.timeframe as "1D" | "4H",
                pattern: sig.patternType,
                direction: sig.direction as "long" | "short",
                limitPrice: entryPrice,
                projectedD: entryPrice,
                stopLossPrice: Number(sig.stopLossPrice),
                tp1Price: Number(sig.tp1Price),
                tp2Price: Number(sig.tp2Price),
                xPrice: Number(sig.xPrice),
                aPrice: Number(sig.aPrice),
                bPrice: Number(sig.bPrice),
                cPrice: Number(sig.cPrice),
              } as PhaseCSignal,
              promoEquity,
              sigIsCrypto,
              { equity: promoSettings.equityAllocation, crypto: promoSettings.cryptoAllocation },
              promoBuyingPower ?? undefined,
            );

            await db.update(liveSignals).set({
              status: "pending",
              entryOrderId: order.id,
            }).where(eq(liveSignals.id, sig.id));

            console.log(
              `[Orchestrator] PROMOTED projected → pending: ${sig.symbol} ${sig.patternType} ` +
              `(price now ${(distancePct * 100).toFixed(1)}% from D) — order placed`,
            );
            try { pipelineStats.ordersPlaced++; } catch {}
            // Telegram alert — only when order is actually placed
            sendPhaseCSignal(
              sig.symbol,
              sig.timeframe as "1D" | "4H",
              sig.patternType,
              sig.direction as "long" | "short",
              Number(sig.entryPrice),
            ).catch(() => {});
          } catch (err: any) {
            if (err?.notShortable) {
              await db.update(liveSignals)
                .set({ status: "paper_only" })
                .where(eq(liveSignals.id, sig.id));
              console.warn(`[Orchestrator] ${sig.symbol} marked paper_only (not shortable)`);
            } else if (err?.insufficientBP) {
              console.warn(`[Orchestrator] Cannot promote ${sig.symbol}: insufficient buying power`);
            } else {
              console.error(`[Orchestrator] Failed to promote ${sig.symbol}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.error("[Orchestrator] Projected promotion check failed:", err);
    }

    // ---- Pipeline stats: final status counts from DB (every 5th cycle to reduce DB load) ----
    if (scanCount % 5 === 0) {
      try {
        pipelineStats.exitCycleRan = true;
        const allActive = await db
          .select({ status: liveSignals.status })
          .from(liveSignals)
          .where(inArray(liveSignals.status, ["pending", "filled", "partial_exit", "closed", "paper_only", "projected"]));
        pipelineStats.pendingFills = allActive.filter((r) => r.status === "pending" || r.status === "paper_only").length;
        pipelineStats.filledPositions = allActive.filter((r) => r.status === "filled").length;
        pipelineStats.partialExits = allActive.filter((r) => r.status === "partial_exit").length;
        pipelineStats.closedTrades = allActive.filter((r) => r.status === "closed").length;
        pipelineStats.projectedCount = allActive.filter((r) => r.status === "projected").length;
        pipelineStats.lastUpdated = Date.now();
      } catch (err) {
        console.error("[Orchestrator] Pipeline stats query failed (non-fatal):", err);
        pipelineStats.lastUpdated = Date.now();
      }
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
