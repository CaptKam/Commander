/**
 * Quality Filters — 7-Rule Signal Validation Gate
 *
 * Every candidate from detectHarmonics() / detectCompletedPatterns()
 * must pass through validateSignalQuality() BEFORE becoming a signal
 * in the orchestrator. These rules eliminate low-probability setups.
 *
 * CLAUDE.md Rule #3: Crab/Deep Crab are already blocked upstream in screener.ts.
 * This module adds structural and statistical quality checks on top.
 */

import type { PhaseCSignal, HarmonicPattern, Timeframe } from "./screener";
import { calcRetrace } from "./harmonics";

// ============================================================
// Pattern-specific XD ratio bounds (Rule 2)
// ============================================================
const XD_BOUNDS: Record<HarmonicPattern, { min: number; max: number }> = {
  Gartley:   { min: 0.60, max: 0.90 },
  Bat:       { min: 0.75, max: 1.00 },
  "Alt Bat": { min: 1.00, max: 1.25 },
  Butterfly: { min: 1.15, max: 1.75 },
  ABCD:      { min: 0.60, max: 1.80 },
};

// ============================================================
// Ideal Fibonacci ratios for proximity scoring (Rule 6)
// { XB ideal, XD ideal }
// ============================================================
const IDEAL_RATIOS: Record<HarmonicPattern, { xb: number; xd: number }> = {
  Gartley:   { xb: 0.618, xd: 0.786 },
  Bat:       { xb: 0.441, xd: 0.886 },
  "Alt Bat": { xb: 0.382, xd: 1.130 },
  Butterfly: { xb: 0.786, xd: 1.445 },
  ABCD:      { xb: 0.618, xd: 1.000 },
};

// ============================================================
// Age windows for pattern freshness (Rule 7)
// ============================================================
const AGE_WINDOW_MS: Record<Timeframe, number> = {
  "1D": 14 * 24 * 60 * 60 * 1000, // 14 days
  "4H": 7 * 24 * 60 * 60 * 1000,  // 7 days
};

// ============================================================
// Extended signal type — includes candle timestamp for age check
// ============================================================
export interface QualityCandidate extends PhaseCSignal {
  /** Unix ms timestamp of the candle at D (or last candle for forming) */
  dTimestamp?: number;
}

// ============================================================
// Rejection result — carries the specific rule that failed
// ============================================================
interface RejectionResult {
  passed: false;
  rule: number;
  reason: string;
}

interface PassResult {
  passed: true;
}

type QualityResult = PassResult | RejectionResult;

/**
 * Validates a single signal against all 7 quality rules.
 * Returns { passed: true } or { passed: false, rule, reason }.
 */
function checkQuality(signal: QualityCandidate): QualityResult {
  const { xPrice, aPrice, bPrice, cPrice, projectedD, pattern, direction, timeframe } = signal;

  // Compute ratios
  const xbRatio = calcRetrace(xPrice, aPrice, bPrice);
  const xdRatio = calcRetrace(xPrice, aPrice, projectedD);
  const acRatio = calcRetrace(aPrice, bPrice, cPrice);

  // ---- Rule 1: XB must be 0.2–1.0 (B retraces, doesn't extend past A) ----
  if (xbRatio < 0.2 || xbRatio > 1.0) {
    return {
      passed: false,
      rule: 1,
      reason: `XB ratio ${xbRatio.toFixed(3)} outside 0.2–1.0`,
    };
  }

  // ---- Rule 2: XD within pattern-specific bounds ----
  const bounds = XD_BOUNDS[pattern];
  if (xdRatio < bounds.min || xdRatio > bounds.max) {
    return {
      passed: false,
      rule: 2,
      reason: `XD ratio ${xdRatio.toFixed(3)} outside ${pattern} bounds ${bounds.min}–${bounds.max}`,
    };
  }

  // ---- Rule 3: AC must be 0.2–1.0 (C retraces, doesn't extend past B) ----
  if (acRatio < 0.2 || acRatio > 1.0) {
    return {
      passed: false,
      rule: 3,
      reason: `AC ratio ${acRatio.toFixed(3)} outside 0.2–1.0`,
    };
  }

  // ---- Rule 4: R:R >= 1.0 (reward must exceed risk) ----
  const reward = Math.abs(signal.tp1Price - projectedD);
  const risk = Math.abs(projectedD - signal.stopLossPrice);
  if (risk === 0 || reward / risk < 1.0) {
    return {
      passed: false,
      rule: 4,
      reason: `R:R ${risk === 0 ? "∞ (zero risk)" : (reward / risk).toFixed(2)} < 1.0`,
    };
  }

  // ---- Rule 5: Profit target >= 2.0% (blocks thin signals eaten by fees) ----
  const profitPct = (Math.abs(signal.tp1Price - projectedD) / projectedD) * 100;
  if (profitPct < 2.0) {
    return {
      passed: false,
      rule: 5,
      reason: `Profit target ${profitPct.toFixed(2)}% < 2.0% minimum`,
    };
  }

  // ---- Rule 6: Fibonacci proximity — avg deviation <= 15% ----
  const ideal = IDEAL_RATIOS[pattern];
  if (pattern === "ABCD") {
    // ABCD: skip XD proximity (meaningless), only check XB
    const xbDev = Math.abs(xbRatio - ideal.xb) / ideal.xb;
    if (xbDev > 0.15) {
      return {
        passed: false,
        rule: 6,
        reason: `Fib proximity: XB deviation ${(xbDev * 100).toFixed(1)}% > 15%`,
      };
    }
  } else {
    const xbDev = Math.abs(xbRatio - ideal.xb) / ideal.xb;
    const xdDev = Math.abs(xdRatio - ideal.xd) / ideal.xd;
    const avgDev = (xbDev + xdDev) / 2;
    if (avgDev > 0.15) {
      return {
        passed: false,
        rule: 6,
        reason: `Fib proximity: avg deviation ${(avgDev * 100).toFixed(1)}% > 15% (XB=${(xbDev * 100).toFixed(1)}%, XD=${(xdDev * 100).toFixed(1)}%)`,
      };
    }
  }

  // ---- Rule 7: Age window — D must have formed recently ----
  if (signal.dTimestamp) {
    const age = Date.now() - signal.dTimestamp;
    const maxAge = AGE_WINDOW_MS[timeframe];
    if (age > maxAge) {
      return {
        passed: false,
        rule: 7,
        reason: `Pattern age ${(age / (24 * 60 * 60 * 1000)).toFixed(1)}d exceeds ${timeframe} window of ${maxAge / (24 * 60 * 60 * 1000)}d`,
      };
    }
  }

  return { passed: true };
}

/**
 * Filters an array of candidates through all 7 quality rules.
 * Logs each rejection with the specific rule that failed.
 *
 * @param candidates  Raw signals from detectHarmonics() or detectCompletedPatterns()
 * @returns           Only signals that pass all 7 rules
 */
export function validateSignalQuality(
  candidates: QualityCandidate[],
): PhaseCSignal[] {
  const passed: PhaseCSignal[] = [];

  for (const candidate of candidates) {
    const result = checkQuality(candidate);
    if (result.passed) {
      console.log(
        `[Quality] PASS: ${candidate.symbol} ${candidate.pattern} ${candidate.timeframe} ` +
        `${candidate.direction.toUpperCase()} — all 7 rules passed`,
      );
      passed.push(candidate);
    } else {
      console.log(
        `[Quality] REJECTED: ${candidate.symbol} ${candidate.pattern} ${candidate.timeframe} ` +
        `${candidate.direction.toUpperCase()} — Rule ${result.rule}: ${result.reason}`,
      );
    }
  }

  console.log(
    `[Quality] ${passed.length}/${candidates.length} candidates passed quality filters`,
  );

  return passed;
}

export { AGE_WINDOW_MS };
