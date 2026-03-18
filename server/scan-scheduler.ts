/**
 * Scan Scheduler — Tiered Scanning System
 *
 * Manages the symbol_scan_state table to determine WHEN each symbol
 * needs to be scanned next, based on its current pattern phase.
 *
 * Symbols in early formation (NO_PATTERN, XA, AB) scan infrequently.
 * Symbols approaching trade entry (CD, D_APPROACHING) scan aggressively.
 * This frees API budget to scan a much larger universe.
 */

import { db } from "./db";
import { symbolScanState, watchlist } from "../shared/schema";
import type { PatternPhaseResult } from "./patterns";
import type { FilteredAsset } from "./universe";
import { and, lte, inArray, asc, sql } from "drizzle-orm";

// ============================================================
// Scan Interval Lookup — milliseconds between scans per phase
// ============================================================
const SCAN_INTERVALS: Record<string, Record<string, number>> = {
  "1D": {
    "NO_PATTERN":    24 * 60 * 60 * 1000,   // 24 hours
    "XA_FORMING":    24 * 60 * 60 * 1000,   // 24 hours
    "AB_FORMING":    24 * 60 * 60 * 1000,   // 24 hours
    "BC_FORMING":    12 * 60 * 60 * 1000,   // 12 hours
    "CD_PROJECTED":   4 * 60 * 60 * 1000,   // 4 hours
    "D_APPROACHING":      30 * 60 * 1000,   // 30 minutes
  },
  "4H": {
    "NO_PATTERN":     8 * 60 * 60 * 1000,   // 8 hours
    "XA_FORMING":     8 * 60 * 60 * 1000,   // 8 hours
    "AB_FORMING":     4 * 60 * 60 * 1000,   // 4 hours
    "BC_FORMING":     2 * 60 * 60 * 1000,   // 2 hours
    "CD_PROJECTED":       30 * 60 * 1000,   // 30 minutes
    "D_APPROACHING":       1 * 60 * 1000,   // 1 minute
  },
};

// Default fallback: 8 hours
const DEFAULT_INTERVAL_MS = 8 * 60 * 60 * 1000;

/**
 * Returns the scan interval in milliseconds for a given phase and timeframe.
 */
export function getScanIntervalMs(phase: string, timeframe: string): number {
  return SCAN_INTERVALS[timeframe]?.[phase] ?? DEFAULT_INTERVAL_MS;
}

/** Human-readable interval for logging */
function formatInterval(ms: number): string {
  if (ms >= 24 * 60 * 60 * 1000) return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
  if (ms >= 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
  if (ms >= 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  return `${Math.round(ms / 1000)}s`;
}

// ============================================================
// Scan Job — what the orchestrator receives from the scheduler
// ============================================================
export interface ScanJob {
  symbol: string;
  timeframe: "1D" | "4H";
  currentPhase: string;
  isNew: boolean;        // true if no scan_state row exists yet
  scanStateId: number | null; // null if isNew
  isFavorite: boolean;   // true if this symbol is in the watchlist table
}

// Phase priority for sorting (higher = more urgent)
const PHASE_PRIORITY: Record<string, number> = {
  "D_APPROACHING": 5,
  "CD_PROJECTED": 4,
  "BC_FORMING": 3,
  "AB_FORMING": 2,
  "XA_FORMING": 1,
  "NO_PATTERN": 0,
};

/**
 * Queries symbol_scan_state for all rows where next_scan_due <= NOW().
 * Also discovers new watchlist symbols that have no scan state yet.
 * Returns jobs sorted by priority: D_APPROACHING first, then CD_PROJECTED, etc.
 */
export async function getSymbolsDueForScan(): Promise<ScanJob[]> {
  const jobs: ScanJob[] = [];

  // ---- Build favorites set for isFavorite tagging ----
  const allWatchlist = await db.select().from(watchlist);
  const favoriteSymbols = new Set(allWatchlist.map((w) => w.symbol));

  // ---- 1. Get all rows where next_scan_due has passed ----
  const dueRows = await db
    .select()
    .from(symbolScanState)
    .where(lte(symbolScanState.nextScanDue, new Date()));

  for (const row of dueRows) {
    jobs.push({
      symbol: row.symbol,
      timeframe: row.timeframe as "1D" | "4H",
      currentPhase: row.phase,
      isNew: false,
      scanStateId: row.id,
      isFavorite: favoriteSymbols.has(row.symbol),
    });
  }

  // ---- 2. Find watchlist symbols with no scan_state entry (new symbols) ----
  const existingKeys = new Set(
    (await db
      .select({ symbol: symbolScanState.symbol, timeframe: symbolScanState.timeframe })
      .from(symbolScanState)
    ).map((r) => `${r.symbol}:${r.timeframe}`),
  );

  for (const entry of allWatchlist) {
    for (const tf of ["1D", "4H"] as const) {
      const key = `${entry.symbol}:${tf}`;
      if (!existingKeys.has(key)) {
        jobs.push({
          symbol: entry.symbol,
          timeframe: tf,
          currentPhase: "NO_PATTERN",
          isNew: true,
          scanStateId: null,
          isFavorite: true, // watchlist symbols are always favorites
        });
      }
    }
  }

  // ---- 3. Sort by priority: D_APPROACHING first, then CD_PROJECTED, etc. ----
  jobs.sort((a, b) => {
    const pa = PHASE_PRIORITY[a.currentPhase] ?? 0;
    const pb = PHASE_PRIORITY[b.currentPhase] ?? 0;
    return pb - pa; // Higher priority first
  });

  // ---- 4. Cap per-cycle to avoid overwhelming Alpaca API ----
  // 150 symbols × ~3 calls each = ~450 calls per 30s cycle
  // 2 cycles/min = ~900 calls/min — within 1000 limit with headroom
  // Hot symbols (D_APPROACHING, CD_PROJECTED) always get slots first due to sort above
  const MAX_JOBS_PER_CYCLE = 150;
  if (jobs.length > MAX_JOBS_PER_CYCLE) {
    const deferred = jobs.length - MAX_JOBS_PER_CYCLE;
    console.log(
      `[Scheduler] Capped: ${MAX_JOBS_PER_CYCLE} of ${jobs.length} due jobs selected (${deferred} deferred to next cycle)`,
    );
    return jobs.slice(0, MAX_JOBS_PER_CYCLE);
  }

  return jobs;
}

/**
 * Updates or inserts a scan state row after a symbol has been scanned.
 * Sets the next scan due time based on the detected phase.
 * Only logs when the phase CHANGES (not on every update — too noisy).
 */
export async function updateScanState(
  symbol: string,
  timeframe: "1D" | "4H",
  phaseResult: PatternPhaseResult,
): Promise<void> {
  try {
    const now = new Date();
    const intervalMs = getScanIntervalMs(phaseResult.phase, timeframe);
    const nextDue = new Date(now.getTime() + intervalMs);

    const values = {
      symbol,
      timeframe,
      phase: phaseResult.phase,
      bestPattern: phaseResult.bestPattern,
      bestDirection: phaseResult.bestDirection,
      xPrice: phaseResult.xPrice != null ? String(phaseResult.xPrice) : null,
      aPrice: phaseResult.aPrice != null ? String(phaseResult.aPrice) : null,
      bPrice: phaseResult.bPrice != null ? String(phaseResult.bPrice) : null,
      cPrice: phaseResult.cPrice != null ? String(phaseResult.cPrice) : null,
      projectedD: phaseResult.projectedD != null ? String(phaseResult.projectedD) : null,
      distanceToDPct: phaseResult.distanceToDPct != null ? String(phaseResult.distanceToDPct) : null,
      lastScannedAt: now,
      nextScanDue: nextDue,
      scanIntervalMs: intervalMs,
      pivotCount: phaseResult.pivotCount,
      updatedAt: now,
    };

    // Check previous phase for change logging
    const existing = await db
      .select({ phase: symbolScanState.phase })
      .from(symbolScanState)
      .where(
        sql`${symbolScanState.symbol} = ${symbol} AND ${symbolScanState.timeframe} = ${timeframe}`,
      )
      .limit(1);

    const previousPhase = existing.length > 0 ? existing[0].phase : null;

    // Upsert: insert if new, update if exists (keyed on unique symbol+timeframe)
    await db
      .insert(symbolScanState)
      .values(values)
      .onConflictDoUpdate({
        target: [symbolScanState.symbol, symbolScanState.timeframe],
        set: {
          phase: values.phase,
          bestPattern: values.bestPattern,
          bestDirection: values.bestDirection,
          xPrice: values.xPrice,
          aPrice: values.aPrice,
          bPrice: values.bPrice,
          cPrice: values.cPrice,
          projectedD: values.projectedD,
          distanceToDPct: values.distanceToDPct,
          lastScannedAt: values.lastScannedAt,
          nextScanDue: values.nextScanDue,
          scanIntervalMs: values.scanIntervalMs,
          pivotCount: values.pivotCount,
          updatedAt: values.updatedAt,
        },
      });

    // Only log on phase CHANGES
    if (previousPhase !== null && previousPhase !== phaseResult.phase) {
      console.log(
        `[Scheduler] ${symbol} ${timeframe}: ${previousPhase} → ${phaseResult.phase} (next scan in ${formatInterval(intervalMs)})`,
      );
    }
  } catch (err) {
    console.error(`[Scheduler] Failed to update scan state for ${symbol} ${timeframe}:`, err);
  }
}

/**
 * Called once at boot. For every symbol × timeframe combination that
 * doesn't already have a scan_state row, inserts a default row with
 * phase = NO_PATTERN and nextScanDue = NOW() (immediate first scan).
 * Existing rows are NOT touched — preserves phase tracking across restarts.
 */
export async function initializeScanStates(
  symbols: string[],
  timeframes: readonly string[],
): Promise<void> {
  try {
    const existing = new Set(
      (await db
        .select({ symbol: symbolScanState.symbol, timeframe: symbolScanState.timeframe })
        .from(symbolScanState)
      ).map((r) => `${r.symbol}:${r.timeframe}`),
    );

    let insertedCount = 0;
    const now = new Date();

    for (const symbol of symbols) {
      for (const tf of timeframes) {
        const key = `${symbol}:${tf}`;
        if (existing.has(key)) continue;

        const intervalMs = getScanIntervalMs("NO_PATTERN", tf);
        await db.insert(symbolScanState).values({
          symbol,
          timeframe: tf,
          phase: "NO_PATTERN",
          lastScannedAt: now,
          nextScanDue: now, // Scan immediately on first boot
          scanIntervalMs: intervalMs,
          pivotCount: 0,
          updatedAt: now,
        }).onConflictDoNothing();
        insertedCount++;
      }
    }

    if (insertedCount > 0) {
      console.log(`[Scheduler] Initialized ${insertedCount} new scan state rows (${symbols.length} symbols × ${timeframes.length} timeframes)`);
    }
  } catch (err) {
    console.error("[Scheduler] Failed to initialize scan states:", err);
  }
}

// ============================================================
// Universe Seeding — populate scan_state from full asset list
// ============================================================

/**
 * Seeds symbol_scan_state from the full Alpaca universe.
 * New symbols get staggered nextScanDue to prevent thundering herd.
 * Delisted symbols get paused (nextScanDue pushed 30 days out).
 */
export async function seedUniverse(
  assets: FilteredAsset[],
): Promise<{ seeded: number; existing: number; removed: number }> {
  // 1. Get all existing rows
  const existingRows = await db
    .select({ symbol: symbolScanState.symbol, timeframe: symbolScanState.timeframe })
    .from(symbolScanState);
  const existingKeys = new Set(existingRows.map((r) => `${r.symbol}:${r.timeframe}`));

  // Build set of all symbols in the new universe
  const universeSymbols = new Set(assets.map((a) => a.symbol));

  // 2. Insert new symbols with staggered nextScanDue
  const newInserts: Array<{ symbol: string; timeframe: string }> = [];
  for (const asset of assets) {
    for (const tf of ["1D", "4H"] as const) {
      const key = `${asset.symbol}:${tf}`;
      if (!existingKeys.has(key)) {
        newInserts.push({ symbol: asset.symbol, timeframe: tf });
      }
    }
  }

  const now = Date.now();
  let seeded = 0;

  // Batch inserts for performance (chunks of 50)
  for (let i = 0; i < newInserts.length; i++) {
    const { symbol, timeframe } = newInserts[i];
    const intervalMs = getScanIntervalMs("NO_PATTERN", timeframe);
    // Stagger: spread evenly across the interval window
    const staggerMs = Math.floor((i / Math.max(newInserts.length, 1)) * intervalMs);
    const nextScanDue = new Date(now + staggerMs);

    try {
      await db.insert(symbolScanState).values({
        symbol,
        timeframe,
        phase: "NO_PATTERN",
        lastScannedAt: new Date(0), // epoch — never scanned
        nextScanDue,
        scanIntervalMs: intervalMs,
        pivotCount: 0,
        updatedAt: new Date(now),
      }).onConflictDoNothing();
      seeded++;
    } catch (err) {
      // Non-fatal: skip individual insert failures
      console.error(`[Scheduler] Failed to seed ${symbol} ${timeframe}:`, err);
    }
  }

  // 3. Pause delisted symbols (push nextScanDue 30 days out)
  const PAUSE_MS = 30 * 24 * 60 * 60 * 1000;
  const pauseDate = new Date(now + PAUSE_MS);
  let removed = 0;

  // Find existing symbols not in the new universe
  const existingSymbolSet = new Set(existingRows.map((r) => r.symbol));
  const delistedSymbols: string[] = [];
  for (const existingSym of existingSymbolSet) {
    if (!universeSymbols.has(existingSym)) {
      try {
        await db
          .update(symbolScanState)
          .set({ nextScanDue: pauseDate, updatedAt: new Date(now) })
          .where(sql`${symbolScanState.symbol} = ${existingSym}`);
        removed++;
        delistedSymbols.push(existingSym);
      } catch (err) {
        console.error(`[Scheduler] Failed to pause delisted symbol ${existingSym}:`, err);
      }
    }
  }
  if (delistedSymbols.length > 0) {
    console.log(`[Scheduler] Paused ${delistedSymbols.length} delisted symbols (e.g. ${delistedSymbols.slice(0, 5).join(", ")})`);
  }

  const existing = existingKeys.size - (removed * 2); // approximate existing (both timeframes)

  if (seeded > 0) {
    console.log(`[Scheduler] Universe seeded: ${seeded} new scan_state rows, ${newInserts.length} symbol×timeframe combos`);
  }

  return { seeded, existing: Math.max(0, existing), removed };
}

// ============================================================
// Dashboard Stats
// ============================================================
export interface ScanStateStats {
  total: number;
  byPhase: Record<string, number>;
  dueNow: number;
  nextDue: string | null;
  hotSymbols: Array<{
    symbol: string;
    timeframe: string;
    phase: string;
    bestPattern: string | null;
    bestDirection: string | null;
    projectedD: string | null;
    distanceToDPct: string | null;
    nextScanDue: string;
    tier: "IMMINENT" | "APPROACHING";
  }>;
}

/**
 * Returns a summary of scan states for the dashboard API.
 * Includes phase distribution, due count, and hot symbols
 * (CD_PROJECTED or D_APPROACHING).
 */
export async function getScanStateStats(): Promise<ScanStateStats> {
  try {
    // Phase distribution
    const phaseCounts = await db
      .select({
        phase: symbolScanState.phase,
        count: sql<number>`count(*)::int`,
      })
      .from(symbolScanState)
      .groupBy(symbolScanState.phase);

    const byPhase: Record<string, number> = {};
    let total = 0;
    for (const row of phaseCounts) {
      byPhase[row.phase] = row.count;
      total += row.count;
    }

    // Due now
    const dueRows = await db
      .select({ id: symbolScanState.id })
      .from(symbolScanState)
      .where(lte(symbolScanState.nextScanDue, new Date()));
    const dueNow = dueRows.length;

    // Next due
    const nextDueRows = await db
      .select({ nextScanDue: symbolScanState.nextScanDue })
      .from(symbolScanState)
      .orderBy(asc(symbolScanState.nextScanDue))
      .limit(1);
    const nextDue = nextDueRows.length > 0 ? nextDueRows[0].nextScanDue.toISOString() : null;

    // Hot symbols: CD_PROJECTED or D_APPROACHING within 15% of projected D
    // Symbols 15%+ away are just projected, not actionably "hot"
    const hotRows = await db
      .select()
      .from(symbolScanState)
      .where(
        and(
          inArray(symbolScanState.phase, ["CD_PROJECTED", "D_APPROACHING"]),
          lte(symbolScanState.distanceToDPct, "15"),
        ),
      );

    const hotSymbols = hotRows
      .map((r) => ({
        symbol: r.symbol,
        timeframe: r.timeframe,
        phase: r.phase,
        bestPattern: r.bestPattern,
        bestDirection: r.bestDirection,
        projectedD: r.projectedD,
        distanceToDPct: r.distanceToDPct,
        nextScanDue: r.nextScanDue.toISOString(),
        tier: (Number(r.distanceToDPct) <= 5 ? "IMMINENT" : "APPROACHING") as "IMMINENT" | "APPROACHING",
      }))
      .sort((a, b) => Number(a.distanceToDPct) - Number(b.distanceToDPct));

    return { total, byPhase, dueNow, nextDue, hotSymbols };
  } catch (err) {
    console.error("[Scheduler] Failed to get scan state stats:", err);
    return { total: 0, byPhase: {}, dueNow: 0, nextDue: null, hotSymbols: [] };
  }
}
