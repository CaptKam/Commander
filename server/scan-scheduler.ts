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
import type { PatternPhaseResult, PatternPhase } from "./patterns";
import { eq, and, lte, sql } from "drizzle-orm";

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

// ============================================================
// Scan Job — what the orchestrator receives from the scheduler
// ============================================================
export interface ScanJob {
  symbol: string;
  timeframe: "1D" | "4H";
  currentPhase: string;
  isNew: boolean;        // true if no scan_state row exists yet
  scanStateId: number | null; // null if isNew
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
    });
  }

  // ---- 2. Find watchlist symbols with no scan_state entry (new symbols) ----
  const allWatchlist = await db.select().from(watchlist);
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

  return jobs;
}

/**
 * Updates or inserts a scan state row after a symbol has been scanned.
 * Sets the next scan due time based on the detected phase.
 */
export async function updateScanState(
  symbol: string,
  timeframe: "1D" | "4H",
  phaseResult: PatternPhaseResult,
): Promise<void> {
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
}

/**
 * Returns a summary of scan states for monitoring/dashboard.
 * Groups by phase and counts how many symbols are in each.
 */
export async function getScanStateSummary(): Promise<Record<string, number>> {
  const rows = await db
    .select({
      phase: symbolScanState.phase,
      count: sql<number>`count(*)::int`,
    })
    .from(symbolScanState)
    .groupBy(symbolScanState.phase);

  const summary: Record<string, number> = {};
  for (const row of rows) {
    summary[row.phase] = row.count;
  }
  return summary;
}
