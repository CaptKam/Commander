/**
 * Harmonic Pattern Detection Engine — Phase 8
 * Translates TradingView Pine Script pivot logic into TypeScript.
 *
 * Pipeline: Candle[] → findPivots() → detectHarmonics() → PhaseCSignal[]
 *
 * CLAUDE.md Rule #3: Crab and Deep Crab are NOT implemented here.
 * Only Gartley, Bat, Alt Bat, Butterfly, and ABCD are computed.
 */

import type { Candle } from "./alpaca-data";
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
// Pattern detection tolerance & minimum leg filters
// ============================================================
const RATIO_TOLERANCE = 0.05;

/**
 * Minimum XA leg size as a percentage of price.
 * Filters out micro-noise pivots that are too close together
 * to form a real harmonic pattern. 1.5% ensures the XA swing
 * is structurally significant (e.g., $3.75 on a $250 stock).
 */
const MIN_XA_LEG_PCT = 0.015;

/**
 * Minimum AD range as a percentage of price.
 * Ensures projected D is far enough from A to produce
 * meaningful TP/SL targets (not 3-cent spreads).
 */
const MIN_AD_RANGE_PCT = 0.01;

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
  // With 365-day lookback we have enough density for 40 pivots
  const recentPivots = pivots.slice(-40);

  for (let xi = 0; xi < recentPivots.length - 3; xi++) {
    const X = recentPivots[xi];
    const A = recentPivots[xi + 1];
    const B = recentPivots[xi + 2];
    const C = recentPivots[xi + 3];

    // ---- Structural validation: must alternate high/low ----
    if (X.type === A.type || A.type === B.type || B.type === C.type) {
      continue;
    }

    // ---- Minimum leg filter: reject micro-noise pivots ----
    const xaSize = Math.abs(X.price - A.price);
    const midPrice = (X.price + A.price) / 2;
    if (xaSize / midPrice < MIN_XA_LEG_PCT) {
      continue; // XA leg too small — noise, not structure
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
      // D completes as a retracement of the XA leg measured FROM A back
      // toward X. For retracement patterns (XAD < 1), D falls between
      // A and X. For extension patterns (XAD > 1), D extends beyond X.
      const xaLeg = X.price - A.price; // signed: positive if X > A
      const midXAD = (pattern.xad.min + pattern.xad.max) / 2;
      const projectedD = A.price + xaLeg * midXAD;

      // ---- Determine direction ----
      // If A is a high (X was low → XA went up), D will be a low → long
      // If A is a low (X was high → XA went down), D will be a high → short
      const direction: Direction = A.type === 1 ? "long" : "short";

      // ---- Validate projected D is reasonable ----
      if (!Number.isFinite(projectedD) || projectedD <= 0) {
        continue;
      }

      // ---- Minimum AD range: reject compressed targets ----
      const adRangePct = Math.abs(A.price - projectedD) / A.price;
      if (adRangePct < MIN_AD_RANGE_PCT) {
        console.log(
          `[Harmonics] Skipping ${symbol} ${timeframe} ${pattern.name} — AD range too small (${(adRangePct * 100).toFixed(2)}%)`,
        );
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

      // Hard guard: TP/SL must be on the correct side of entry
      if (direction === "long") {
        if (tp1Price <= projectedD || tp2Price <= projectedD || stopLossPrice >= projectedD) {
          console.error(
            `[CRITICAL] Inverted TP/SL for LONG ${symbol} ${pattern.name} ${timeframe}: ` +
              `entry=$${projectedD.toFixed(2)} TP1=$${tp1Price.toFixed(2)} TP2=$${tp2Price.toFixed(2)} SL=$${stopLossPrice.toFixed(2)} — SKIPPING`,
          );
          continue;
        }
      } else {
        if (tp1Price >= projectedD || tp2Price >= projectedD || stopLossPrice <= projectedD) {
          console.error(
            `[CRITICAL] Inverted TP/SL for SHORT ${symbol} ${pattern.name} ${timeframe}: ` +
              `entry=$${projectedD.toFixed(2)} TP1=$${tp1Price.toFixed(2)} TP2=$${tp2Price.toFixed(2)} SL=$${stopLossPrice.toFixed(2)} — SKIPPING`,
          );
          continue;
        }
      }

      console.log(
        `[Harmonics] ${symbol} ${timeframe} ${pattern.name} ${direction.toUpperCase()} — ` +
          `X=$${X.price.toFixed(2)}(idx${X.index}) A=$${A.price.toFixed(2)}(idx${A.index}) ` +
          `B=$${B.price.toFixed(2)}(idx${B.index}) C=$${C.price.toFixed(2)}(idx${C.index}) → ` +
          `D=$${projectedD.toFixed(2)} | XAB=${xabRatio.toFixed(3)} ABC=${abcRatio.toFixed(3)} ` +
          `XAD=${midXAD.toFixed(3)} | SL=$${stopLossPrice.toFixed(2)} TP1=$${tp1Price.toFixed(2)} TP2=$${tp2Price.toFixed(2)}`,
      );

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

// ============================================================
// Completed Pattern Detection — All 5 pivots (X,A,B,C,D) confirmed
// ============================================================

/**
 * Detects COMPLETED XABCD harmonic patterns from candle data.
 *
 * "Completed" = all 5 pivots (X, A, B, C, D) are confirmed swing points.
 * D is a real pivot, not a projection. Entry uses D's actual price.
 * These are immediate-execution signals (market order if within slippage).
 *
 * @param candles    Chronologically sorted candles (oldest first)
 * @param symbol     Ticker symbol (e.g., "AAPL", "BTC/USD")
 * @param timeframe  "1D" or "4H"
 * @returns Array of completed pattern signals with confirmed D prices
 */
export function detectCompletedPatterns(
  candles: Candle[],
  symbol: string,
  timeframe: "1D" | "4H",
): PhaseCSignal[] {
  const signals: PhaseCSignal[] = [];
  const pivots = findPivots(candles);

  // Need at least 5 pivots for a completed XABCD
  if (pivots.length < 5) {
    return signals;
  }

  // With 365-day lookback we have enough density for 40 pivots
  const recentPivots = pivots.slice(-40);

  for (let xi = 0; xi < recentPivots.length - 4; xi++) {
    const X = recentPivots[xi];
    const A = recentPivots[xi + 1];
    const B = recentPivots[xi + 2];
    const C = recentPivots[xi + 3];
    const D = recentPivots[xi + 4];

    // ---- Structural validation: must alternate high/low ----
    if (X.type === A.type || A.type === B.type || B.type === C.type || C.type === D.type) {
      continue;
    }

    // ---- Minimum leg filter: reject micro-noise pivots ----
    const xaSize = Math.abs(X.price - A.price);
    const midPrice = (X.price + A.price) / 2;
    if (xaSize / midPrice < MIN_XA_LEG_PCT) {
      continue;
    }

    // ---- Calculate leg ratios ----
    const xabRatio = calcRetrace(X.price, A.price, B.price);
    const abcRatio = calcRetrace(A.price, B.price, C.price);
    const xadRatio = calcRetrace(X.price, A.price, D.price);

    // ---- Test each pattern definition ----
    for (const pattern of PATTERN_DEFS) {
      if (
        !ratioInRange(xabRatio, pattern.xab.min, pattern.xab.max, RATIO_TOLERANCE) ||
        !ratioInRange(abcRatio, pattern.abc.min, pattern.abc.max, RATIO_TOLERANCE) ||
        !ratioInRange(xadRatio, pattern.xad.min, pattern.xad.max, RATIO_TOLERANCE)
      ) {
        continue;
      }

      // ---- Determine direction ----
      const direction: Direction = A.type === 1 ? "long" : "short";

      // ---- Validate D price ----
      if (!Number.isFinite(D.price) || D.price <= 0) {
        continue;
      }

      // ---- Minimum AD range: reject compressed targets ----
      const adRangePct = Math.abs(A.price - D.price) / A.price;
      if (adRangePct < MIN_AD_RANGE_PCT) {
        continue;
      }

      // ---- Calculate TP and SL (same logic as forming patterns) ----
      const adRange = Math.abs(A.price - D.price);
      const xaRange = Math.abs(A.price - X.price);
      let tp1Price: number;
      let tp2Price: number;
      let stopLossPrice: number;

      if (direction === "long") {
        tp1Price = D.price + adRange * 0.382;
        tp2Price = D.price + adRange * 0.618;
        stopLossPrice = D.price - xaRange * 0.13;
      } else {
        tp1Price = D.price - adRange * 0.382;
        tp2Price = D.price - adRange * 0.618;
        stopLossPrice = D.price + xaRange * 0.13;
      }

      if (tp1Price <= 0 || tp2Price <= 0 || stopLossPrice <= 0) {
        continue;
      }

      // Hard guard: TP/SL must be on the correct side of entry
      if (direction === "long") {
        if (tp1Price <= D.price || tp2Price <= D.price || stopLossPrice >= D.price) {
          console.error(
            `[CRITICAL] Inverted TP/SL for LONG ${symbol} ${pattern.name} ${timeframe}: ` +
              `entry=$${D.price.toFixed(2)} TP1=$${tp1Price.toFixed(2)} TP2=$${tp2Price.toFixed(2)} SL=$${stopLossPrice.toFixed(2)} — SKIPPING`,
          );
          continue;
        }
      } else {
        if (tp1Price >= D.price || tp2Price >= D.price || stopLossPrice <= D.price) {
          console.error(
            `[CRITICAL] Inverted TP/SL for SHORT ${symbol} ${pattern.name} ${timeframe}: ` +
              `entry=$${D.price.toFixed(2)} TP1=$${tp1Price.toFixed(2)} TP2=$${tp2Price.toFixed(2)} SL=$${stopLossPrice.toFixed(2)} — SKIPPING`,
          );
          continue;
        }
      }

      // ---- Slippage check: is current price still near D? ----
      // Only signal if the last close is within 1.5% of D's price
      const lastClose = candles[candles.length - 1].close;
      const slippagePct = Math.abs(lastClose - D.price) / D.price;
      if (slippagePct > 0.015) {
        continue; // Price has moved too far from D — missed entry
      }

      console.log(
        `[Harmonics] COMPLETED ${symbol} ${timeframe} ${pattern.name} ${direction.toUpperCase()} — ` +
          `X=$${X.price.toFixed(2)} A=$${A.price.toFixed(2)} B=$${B.price.toFixed(2)} ` +
          `C=$${C.price.toFixed(2)} D=$${D.price.toFixed(2)} | ` +
          `XAB=${xabRatio.toFixed(3)} ABC=${abcRatio.toFixed(3)} XAD=${xadRatio.toFixed(3)} | ` +
          `SL=$${stopLossPrice.toFixed(2)} TP1=$${tp1Price.toFixed(2)} TP2=$${tp2Price.toFixed(2)}`,
      );

      signals.push({
        symbol,
        timeframe,
        pattern: pattern.name,
        direction,
        limitPrice: D.price, // Use actual D price as entry
        xPrice: X.price,
        aPrice: A.price,
        bPrice: B.price,
        cPrice: C.price,
        projectedD: D.price, // D is confirmed, not projected
        tp1Price,
        tp2Price,
        stopLossPrice,
      });
    }
  }

  return signals;
}
