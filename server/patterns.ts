/**
 * Harmonic Pattern Detection Engine — Phase 8
 * Translates TradingView Pine Script pivot logic into TypeScript.
 *
 * Pipeline: Candle[] → findPivots() → detectHarmonics() → PhaseCSignal[]
 *
 * CLAUDE.md Rule #3: Crab and Deep Crab are NOT implemented here.
 * Only Gartley, Bat, Alt Bat, Butterfly, and ABCD are computed.
 */

import type { Candle } from "./fmp";
import type { PhaseCSignal, HarmonicPattern, Direction } from "./screener";
import { calcRetrace, ratioInRange, FIB } from "./harmonics";

// ============================================================
// Pivot types
// ============================================================
export interface Pivot {
  price: number;
  index: number;
  type: 1 | -1; // 1 = Swing High, -1 = Swing Low
}

// ============================================================
// Pivot detection — equivalent to ta.pivothigh / ta.pivotlow
// ============================================================
export function findPivots(
  candles: Candle[],
  leftBars: number = 5,
  rightBars: number = 5,
): Pivot[] {
  const pivots: Pivot[] = [];
  const len = candles.length;

  // Need at least leftBars + 1 + rightBars candles to detect a pivot
  for (let i = leftBars; i < len - rightBars; i++) {
    const candle = candles[i];

    // ---- Check for Swing High ----
    let isHigh = true;
    for (let l = 1; l <= leftBars; l++) {
      if (candles[i - l].high >= candle.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      for (let r = 1; r <= rightBars; r++) {
        if (candles[i + r].high >= candle.high) {
          isHigh = false;
          break;
        }
      }
    }
    if (isHigh) {
      pivots.push({ price: candle.high, index: i, type: 1 });
    }

    // ---- Check for Swing Low ----
    let isLow = true;
    for (let l = 1; l <= leftBars; l++) {
      if (candles[i - l].low <= candle.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      for (let r = 1; r <= rightBars; r++) {
        if (candles[i + r].low <= candle.low) {
          isLow = false;
          break;
        }
      }
    }
    if (isLow) {
      pivots.push({ price: candle.low, index: i, type: -1 });
    }
  }

  // Sort by index (chronological order)
  return pivots.sort((a, b) => a.index - b.index);
}

// ============================================================
// Pattern ratio definitions — Fibonacci rules per pattern
// Each pattern defines the valid ratio ranges for XAB, ABC,
// and the projected D extension/retracement of XA.
// ============================================================
interface PatternRules {
  name: HarmonicPattern;
  xab: { min: number; max: number };
  abc: { min: number; max: number };
  xad: { min: number; max: number }; // Used to project D
}

const PATTERN_DEFS: PatternRules[] = [
  {
    name: "Gartley",
    xab: { min: FIB._0618, max: FIB._0618 },
    abc: { min: FIB._0382, max: FIB._0886 },
    xad: { min: FIB._0786, max: FIB._0786 },
  },
  {
    name: "Bat",
    xab: { min: FIB._0382, max: FIB._0500 },
    abc: { min: FIB._0382, max: FIB._0886 },
    xad: { min: FIB._0886, max: FIB._0886 },
  },
  {
    name: "Alt Bat",
    xab: { min: FIB._0382, max: FIB._0382 },
    abc: { min: FIB._0382, max: FIB._0886 },
    xad: { min: FIB._1130, max: FIB._1130 },
  },
  {
    name: "Butterfly",
    xab: { min: FIB._0786, max: FIB._0786 },
    abc: { min: FIB._0382, max: FIB._0886 },
    xad: { min: FIB._1272, max: FIB._1618 },
  },
  {
    name: "ABCD",
    xab: { min: FIB._0618, max: FIB._0786 },
    abc: { min: FIB._0618, max: FIB._0786 },
    xad: { min: FIB._1272, max: FIB._1618 },
  },
];

// ============================================================
// Pattern detection tolerance
// ============================================================
const RATIO_TOLERANCE = 0.05;

// ============================================================
// The main detection engine
// ============================================================

/**
 * Detects forming XABCD harmonic patterns from candle data.
 *
 * "Forming" = we have confirmed X, A, B, C points and project
 * where D should complete. These are Phase C signals — the pattern
 * is NOT yet complete, but we know the limit price to set.
 *
 * @param candles  Chronologically sorted candles (oldest first)
 * @param symbol   Ticker symbol (e.g., "AAPL", "BTC/USD")
 * @param timeframe  "1D" or "4H"
 * @returns Array of Phase C signals with projected D prices
 */
export function detectHarmonics(
  candles: Candle[],
  symbol: string,
  timeframe: "1D" | "4H",
): PhaseCSignal[] {
  const signals: PhaseCSignal[] = [];
  const pivots = findPivots(candles);

  // Need at least 4 pivots to form X-A-B-C
  if (pivots.length < 4) {
    return signals;
  }

  // Scan the last N pivots to find forming patterns
  // We look at recent pivots only (last 20) to avoid ancient patterns
  const recentPivots = pivots.slice(-20);

  for (let xi = 0; xi < recentPivots.length - 3; xi++) {
    const X = recentPivots[xi];
    const A = recentPivots[xi + 1];
    const B = recentPivots[xi + 2];
    const C = recentPivots[xi + 3];

    // ---- Structural validation: must alternate high/low ----
    if (X.type === A.type || A.type === B.type || B.type === C.type) {
      continue;
    }

    // ---- Calculate leg ratios ----
    const xabRatio = calcRetrace(X.price, A.price, B.price);
    const abcRatio = calcRetrace(A.price, B.price, C.price);

    // ---- Test each pattern definition ----
    for (const pattern of PATTERN_DEFS) {
      if (
        !ratioInRange(
          xabRatio,
          pattern.xab.min,
          pattern.xab.max,
          RATIO_TOLERANCE,
        ) ||
        !ratioInRange(
          abcRatio,
          pattern.abc.min,
          pattern.abc.max,
          RATIO_TOLERANCE,
        )
      ) {
        continue;
      }

      // ---- Project D ----
      // D completes as a retracement/extension of XA from C
      // For patterns where XAD < 1: D retraces into XA range
      // For patterns where XAD > 1: D extends beyond X
      const xaLeg = A.price - X.price;
      const midXAD = (pattern.xad.min + pattern.xad.max) / 2;
      const projectedD = X.price + xaLeg * midXAD;

      // ---- Determine direction ----
      // If A is a high (X was low → XA went up), D will be a low → long
      // If A is a low (X was high → XA went down), D will be a high → short
      const direction: Direction = A.type === 1 ? "long" : "short";

      // ---- Validate projected D is reasonable ----
      if (!Number.isFinite(projectedD) || projectedD <= 0) {
        continue;
      }

      // ---- Check D hasn't already been hit (still forming) ----
      const lastCandle = candles[candles.length - 1];
      if (direction === "long" && lastCandle.low <= projectedD) {
        continue; // D zone already reached — no longer "forming"
      }
      if (direction === "short" && lastCandle.high >= projectedD) {
        continue; // D zone already reached
      }

      // ---- Calculate TP and SL (Anti-NULL Rule: CLAUDE.md Rule #2) ----
      // TP uses Fibonacci retracement of the AD leg from D.
      // This gives meaningful targets regardless of how tight C→D is.
      //   TP1 = 0.382 retracement of AD from D
      //   TP2 = 0.618 retracement of AD from D
      // SL = 13% of XA extended beyond D (against the trade direction).
      const adRange = Math.abs(A.price - projectedD);
      const xaRange = Math.abs(A.price - X.price);
      let tp1Price: number;
      let tp2Price: number;
      let stopLossPrice: number;

      if (direction === "long") {
        // Long: D is a low, we expect price to rise toward A
        tp1Price = projectedD + adRange * 0.382;
        tp2Price = projectedD + adRange * 0.618;
        stopLossPrice = projectedD - xaRange * 0.13;
      } else {
        // Short: D is a high, we expect price to fall toward A
        tp1Price = projectedD - adRange * 0.382;
        tp2Price = projectedD - adRange * 0.618;
        stopLossPrice = projectedD + xaRange * 0.13;
      }

      // Validate all exits are positive — skip if math produces bad values
      if (tp1Price <= 0 || tp2Price <= 0 || stopLossPrice <= 0) {
        continue;
      }

      signals.push({
        symbol,
        timeframe,
        pattern: pattern.name,
        direction,
        limitPrice: projectedD,
        xPrice: X.price,
        aPrice: A.price,
        bPrice: B.price,
        cPrice: C.price,
        projectedD,
        tp1Price,
        tp2Price,
        stopLossPrice,
      });
    }
  }

  return signals;
}
