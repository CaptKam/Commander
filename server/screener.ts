/**
 * Phase C Screener — Forming Pattern Detection
 * Filters XABCD harmonic candidates by pattern rules.
 *
 * CLAUDE.md Rule #3: Crab and Deep Crab are globally DISABLED.
 *
 * NOTE: Telegram alerts are NOT sent here. Alerts are sent by the
 * orchestrator AFTER the DB dedup check passes, to prevent duplicate
 * notifications on restarts or repeated scans.
 */

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
// Phase C scan — filters valid forming patterns (no alerts here)
// ============================================================
export async function processPhaseCSignals(
  candidates: PhaseCSignal[],
  enabledPatterns?: string[],
): Promise<PhaseCSignal[]> {
  const validSignals: PhaseCSignal[] = [];

  for (const candidate of candidates) {
    // ---- Rule #3 gate: skip Crab / Deep Crab ----
    if (!isPatternAllowed(candidate.pattern)) {
      continue;
    }

    // ---- Dynamic pattern filter from system_settings ----
    if (enabledPatterns && !enabledPatterns.includes(candidate.pattern)) {
      console.log(
        `[Screener] Skipping ${candidate.pattern} — disabled in settings`,
      );
      continue;
    }

    validSignals.push(candidate);
  }

  return validSignals;
}
