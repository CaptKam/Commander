/**
 * Phase C Screener — Forming Pattern Detection
 * Scans candle data for XABCD harmonic structures approaching point D.
 *
 * CLAUDE.md Rule #3: Crab and Deep Crab are globally DISABLED.
 * CLAUDE.md Rule #4: Telegram notification failures must not crash the scan loop.
 */

import { sendPhaseCSignal, sendError } from "./utils/notifier";

// ============================================================
// Rule #3: Globally disabled patterns (low win rate)
// ============================================================
const DISABLED_PATTERNS = new Set(["Crab", "Deep Crab"]);

const VALID_PATTERNS = [
  "Gartley",
  "Bat",
  "Alt Bat",
  "Butterfly",
  "ABCD",
] as const;

export type HarmonicPattern = (typeof VALID_PATTERNS)[number];
export type Timeframe = "1D" | "4H";
export type Direction = "long" | "short";

export interface PhaseCSignal {
  symbol: string;
  timeframe: Timeframe;
  pattern: HarmonicPattern;
  direction: Direction;
  limitPrice: number;
  xPrice: number;
  aPrice: number;
  bPrice: number;
  cPrice: number;
  projectedD: number;
  tp1Price: number;
  tp2Price: number;
  stopLossPrice: number;
}

// ============================================================
// Pattern filter — enforces Rule #3 before any computation
// ============================================================
export function isPatternAllowed(
  patternName: string,
): patternName is HarmonicPattern {
  if (DISABLED_PATTERNS.has(patternName)) {
    console.warn(
      `[Screener] Blocked disabled pattern: "${patternName}" (CLAUDE.md Rule #3)`,
    );
    return false;
  }
  return VALID_PATTERNS.includes(patternName as HarmonicPattern);
}

// ============================================================
// Phase C scan — detects forming patterns and fires alerts
// ============================================================
export async function processPhaseCSignals(
  candidates: PhaseCSignal[],
): Promise<PhaseCSignal[]> {
  const validSignals: PhaseCSignal[] = [];

  for (const candidate of candidates) {
    // ---- Rule #3 gate: skip Crab / Deep Crab ----
    if (!isPatternAllowed(candidate.pattern)) {
      continue;
    }

    validSignals.push(candidate);

    // ---- Fire Telegram alert (non-blocking) ----
    // Uses .catch() instead of await to prevent notification failures
    // from blocking the scan loop (CLAUDE.md Rule #4: Decoupled Architecture)
    sendPhaseCSignal(
      candidate.symbol,
      candidate.timeframe,
      candidate.pattern,
      candidate.direction,
      candidate.limitPrice,
    ).catch((err) => {
      sendError(
        `Telegram alert failed for ${candidate.symbol} ${candidate.pattern}`,
        err,
      ).catch(() => {
        // Last resort: if even the error notification fails, just log
        console.error("[Screener] Failed to send error notification:", err);
      });
    });
  }

  return validSignals;
}
