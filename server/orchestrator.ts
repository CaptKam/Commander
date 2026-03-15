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
import { detectHarmonics, detectCompletedPatterns } from "./patterns";
import { processPhaseCSignals } from "./screener";
import type { PhaseCSignal } from "./screener";
import { runExitCycle } from "./exit-manager";
import { runCryptoMonitor } from "./crypto-monitor";
import { validateSignalQuality, AGE_WINDOW_MS } from "./quality-filters";
import { startPriceStreams, stopPriceStreams } from "./websocket-stream";
import { placePhaseCLimitOrder, getAccountEquity } from "./alpaca";
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
function isStockMarketOpen(): boolean {
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
  sentSignals.set(key, now + SIGNAL_CACHE_TTL_MS);
  // Lazy cleanup
  if (sentSignals.size > 500) {
    for (const [k, v] of sentSignals) {
      if (v <= now) sentSignals.delete(k);
    }
  }
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

  try {
    scanCount++;

    // ---- Heartbeat: every 10th scan (~5 min at 30s intervals) ----
    if (scanCount % HEARTBEAT_EVERY_N_SCANS === 0) {
      console.log(
        `[Orchestrator] 💓 Heartbeat: ${scanCount} scans completed. ` +
          `Engine is alive. ${new Date().toISOString()}`,
      );
    }

    // ============================================================
    // Step 0: Load settings from DB
    // ============================================================
    const settings = await getSettings();

    // ============================================================
    // Step 1: Determine which symbols to scan based on market hours
    // Crypto: always. Equities: only during extended market hours
    // or once after close for the daily candle.
    // ============================================================
    const activeSymbols = await getActiveWatchlist();
    const marketOpen = isStockMarketOpen();
    const postClose = isPostCloseWindow();
    const todayDate = getEasternTime().toISOString().slice(0, 10);
    const dailyScanDone = lastDailyStockScanDate === todayDate;

    // Decide which symbols to scan
    const cryptoSymbols = activeSymbols.filter((s) => s.includes("/"));
    const equitySymbols = activeSymbols.filter((s) => !s.includes("/"));

    // Include equities if market is open, OR during post-close window for daily candle (once)
    const includeEquities = marketOpen || (postClose && !dailyScanDone);
    const symbolsToScan = includeEquities
      ? activeSymbols
      : cryptoSymbols;

    // Decide timeframes: if post-close only scan, only fetch 1D for stocks
    const timeframesToScan: Array<"1D" | "4H"> = [...TIMEFRAMES];

    if (!marketOpen && postClose && !dailyScanDone) {
      console.log(
        `[Orchestrator] Market CLOSED — post-close daily scan for ${equitySymbols.length} equities`,
      );
    }

    console.log(
      `[Orchestrator] Scan #${scanCount}: Market ${marketOpen ? "OPEN" : "CLOSED"} — ` +
        `scanning ${symbolsToScan.length}/${activeSymbols.length} symbols ` +
        `(${cryptoSymbols.length} crypto${includeEquities ? ` + ${equitySymbols.length} equity` : ", equities skipped"})`,
    );

    const allCandleData = new Map<
      string,
      { candles: Awaited<ReturnType<typeof fetchWatchlist>> extends Map<string, infer V> ? V : never; timeframe: "1D" | "4H" }[]
    >();

    for (const tf of timeframesToScan) {
      // For post-close daily scan: only fetch 1D for equities, all TFs for crypto
      let fetchSymbols: string[];
      if (!marketOpen && postClose && !dailyScanDone) {
        // Post-close: crypto gets all TFs, equities only get 1D
        fetchSymbols = tf === "1D" ? symbolsToScan : cryptoSymbols;
      } else {
        fetchSymbols = symbolsToScan;
      }
      if (fetchSymbols.length === 0) continue;

      const watchlistData = await fetchWatchlist(fetchSymbols, tf);
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
    // Step 2: Run harmonic detection on all fetched data
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

    console.log(
      `[Orchestrator] Scan #${scanCount}: ${candidates.length} raw candidates found`,
    );

    if (candidates.length === 0) {
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

    // ============================================================
    // Step 3: Filter through Phase C screener (kills Crab/Deep Crab)
    // ============================================================
    const validSignals = await processPhaseCSignals(qualityPassed, settings.enabledPatterns);

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
              inArray(liveSignals.status, ["pending", "filled", "partial_exit", "closed", "cancelled"]),
              gte(liveSignals.createdAt, timeWindow),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          console.log(
            `[Orchestrator] Skipping duplicate signal: ${signal.symbol} ${signal.pattern} ${signal.timeframe} (exists in DB within age window)`,
          );
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

        // ---- Place limit order on Alpaca (only if equity was fetched AND trading enabled) ----
        if (!settings.tradingEnabled) {
          console.log(
            `[Orchestrator] Trading PAUSED — signal saved but order skipped for ${signal.symbol}`,
          );
        } else if (isCrypto && signal.direction === "short") {
          console.log(
            `[Alpaca] Crypto SHORT signal saved but not traded — Alpaca does not support crypto shorting: ${signal.symbol} ${signal.pattern} ${signal.timeframe}`,
          );
        } else if (equity !== null) {
          const order = await placePhaseCLimitOrder(signal, equity, isCrypto, {
            equity: settings.equityAllocation,
            crypto: settings.cryptoAllocation,
          }, buyingPower ?? undefined);
          // Save the Alpaca order ID so exit-manager can track fills
          await db
            .update(liveSignals)
            .set({ entryOrderId: order.id })
            .where(eq(liveSignals.id, inserted.id));
        } else {
          console.warn(
            `[Orchestrator] Skipping order for ${signal.symbol} — no equity data`,
          );
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

    // ALWAYS release the lock, even if the scan threw
    isScanning = false;
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
