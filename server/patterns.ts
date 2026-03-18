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

    // ---- Recency filter: reject stale patterns from months ago ----
    // Point C must be within the last N candles, otherwise the pattern
    // formed too long ago and projected D is no longer actionable.
    const MAX_C_AGE = timeframe === "1D" ? 40 : 60; // 40 daily or 60 4H candles
    if (C.index < candles.length - MAX_C_AGE) {
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

      // ---- Check D hasn't already been hit AND is far enough from current price ----
      const lastCandle = candles[candles.length - 1];
      const lastClose = lastCandle.close;

      // D already reached — pattern is complete, not forming
      if (direction === "long" && lastCandle.low <= projectedD) {
        continue;
      }
      if (direction === "short" && lastCandle.high >= projectedD) {
        continue;
      }

      // D must be meaningfully away from current price in the correct direction.
      // For LONG: D should be BELOW current price (buy the dip)
      // For SHORT: D should be ABOVE current price (sell the rally)
      // Minimum 1% distance prevents orders that fill instantly like market orders.
      const MIN_D_DISTANCE_PCT = 0.01; // 1% minimum distance

      if (direction === "long" && projectedD >= lastClose * (1 - MIN_D_DISTANCE_PCT)) {
        continue; // D is at or above current price — would fill instantly
      }
      if (direction === "short" && projectedD <= lastClose * (1 + MIN_D_DISTANCE_PCT)) {
        continue; // D is at or below current price — would fill instantly
      }

      // ---- Calculate TP and SL (Pine Script v6 alignment) ----
      // TP: based on CD range (not AD). Matches Pine Script's tpRatio = 0.618.
      //   TP1 = 0.382 × CD from D (conservative, take half profit early)
      //   TP2 = 0.618 × CD from D (matches Pine Script's single target exactly)
      // SL: always D ± 13% of XA range. Matches Pine Script's slBuffer = 1.13.
      const cdRange = Math.abs(C.price - projectedD);
      const xaRange = Math.abs(X.price - A.price);
      const SL_BUFFER = 0.13; // 13% of XA range = Pine Script slBuffer(1.13) - 1.0
      let tp1Price: number;
      let tp2Price: number;
      let stopLossPrice: number;

      if (direction === "long") {
        tp1Price = projectedD + cdRange * 0.382;
        tp2Price = projectedD + cdRange * 0.618;
        stopLossPrice = projectedD - xaRange * SL_BUFFER;
      } else {
        tp1Price = projectedD - cdRange * 0.382;
        tp2Price = projectedD - cdRange * 0.618;
        stopLossPrice = projectedD + xaRange * SL_BUFFER;
      }

      // Validate all exits are positive — skip if math produces bad values
      if (tp1Price <= 0 || tp2Price <= 0 || stopLossPrice <= 0) {
        continue;
      }

      // Hard guard: TP/SL must be on the correct side of entry
      if (direction === "long") {
        const issues: string[] = [];
        if (tp1Price <= projectedD) issues.push(`TP1 $${tp1Price.toFixed(2)} <= entry`);
        if (tp2Price <= projectedD) issues.push(`TP2 $${tp2Price.toFixed(2)} <= entry`);
        if (stopLossPrice >= projectedD) issues.push(`SL $${stopLossPrice.toFixed(2)} >= entry (should be below)`);
        if (issues.length > 0) {
          console.error(
            `[CRITICAL] Bad exits for LONG ${symbol} ${pattern.name} ${timeframe}: ` +
              `entry=$${projectedD.toFixed(2)} — ${issues.join("; ")} — SKIPPING`,
          );
          continue;
        }
      } else {
        const issues: string[] = [];
        if (tp1Price >= projectedD) issues.push(`TP1 $${tp1Price.toFixed(2)} >= entry`);
        if (tp2Price >= projectedD) issues.push(`TP2 $${tp2Price.toFixed(2)} >= entry`);
        if (stopLossPrice <= projectedD) issues.push(`SL $${stopLossPrice.toFixed(2)} <= entry (should be above)`);
        if (issues.length > 0) {
          console.error(
            `[CRITICAL] Bad exits for SHORT ${symbol} ${pattern.name} ${timeframe}: ` +
              `entry=$${projectedD.toFixed(2)} — ${issues.join("; ")} — SKIPPING`,
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

    // ---- Special case: ABCD detection (different math from 5-point harmonics) ----
    // ABCD checks: AC ratio 0.382-0.886, then projects D = C ± |AB|
    const abcRatioForABCD = calcRetrace(A.price, B.price, C.price);
    if (ratioInRange(abcRatioForABCD, 0.382, 0.886, RATIO_TOLERANCE)) {
      const abLen = Math.abs(A.price - B.price);
      const direction: Direction = A.type === 1 ? "long" : "short";
      // Bullish (long): D below C by AB length. Bearish (short): D above C by AB length.
      const projectedD_ABCD = direction === "long"
        ? C.price - abLen
        : C.price + abLen;

      if (Number.isFinite(projectedD_ABCD) && projectedD_ABCD > 0) {
        // Minimum AD range check
        const adRangePct = Math.abs(A.price - projectedD_ABCD) / A.price;
        if (adRangePct >= MIN_AD_RANGE_PCT) {
          const lastCandle = candles[candles.length - 1];
          const lastClose = lastCandle.close;

          // D not already hit
          const dNotHit = direction === "long"
            ? lastCandle.low > projectedD_ABCD
            : lastCandle.high < projectedD_ABCD;

          // D far enough from current price
          const MIN_D_DISTANCE_PCT = 0.01;
          const dFarEnough = direction === "long"
            ? projectedD_ABCD < lastClose * (1 - MIN_D_DISTANCE_PCT)
            : projectedD_ABCD > lastClose * (1 + MIN_D_DISTANCE_PCT);

          if (dNotHit && dFarEnough) {
            // TP/SL using same Pine Script v6 formulas
            const cdRange = Math.abs(C.price - projectedD_ABCD);
            const xaRange = Math.abs(X.price - A.price);
            const SL_BUFFER = 0.13;
            let tp1Price: number;
            let tp2Price: number;
            let stopLossPrice: number;

            if (direction === "long") {
              tp1Price = projectedD_ABCD + cdRange * 0.382;
              tp2Price = projectedD_ABCD + cdRange * 0.618;
              stopLossPrice = projectedD_ABCD - xaRange * SL_BUFFER;
            } else {
              tp1Price = projectedD_ABCD - cdRange * 0.382;
              tp2Price = projectedD_ABCD - cdRange * 0.618;
              stopLossPrice = projectedD_ABCD + xaRange * SL_BUFFER;
            }

            if (tp1Price > 0 && tp2Price > 0 && stopLossPrice > 0) {
              // Hard guard: TP/SL correct side
              const valid = direction === "long"
                ? tp1Price > projectedD_ABCD && tp2Price > projectedD_ABCD && stopLossPrice < projectedD_ABCD
                : tp1Price < projectedD_ABCD && tp2Price < projectedD_ABCD && stopLossPrice > projectedD_ABCD;

              if (valid) {
                console.log(
                  `[Harmonics] ${symbol} ${timeframe} ABCD ${direction.toUpperCase()} — ` +
                    `X=$${X.price.toFixed(2)} A=$${A.price.toFixed(2)} B=$${B.price.toFixed(2)} C=$${C.price.toFixed(2)} → ` +
                    `D=$${projectedD_ABCD.toFixed(2)} | AC=${abcRatioForABCD.toFixed(3)} AB_len=${abLen.toFixed(2)} | ` +
                    `SL=$${stopLossPrice.toFixed(2)} TP1=$${tp1Price.toFixed(2)} TP2=$${tp2Price.toFixed(2)}`,
                );

                signals.push({
                  symbol,
                  timeframe,
                  pattern: "ABCD",
                  direction,
                  limitPrice: projectedD_ABCD,
                  xPrice: X.price,
                  aPrice: A.price,
                  bPrice: B.price,
                  cPrice: C.price,
                  projectedD: projectedD_ABCD,
                  tp1Price,
                  tp2Price,
                  stopLossPrice,
                });
              }
            }
          }
        }
      }
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

    // ---- Recency filter: reject completed patterns where D was hit long ago ----
    // Match the Phase C recency thresholds: 40 candles for 1D, 60 for 4H
    const MAX_D_AGE = timeframe === "1D" ? 40 : 60;
    if (D.index < candles.length - MAX_D_AGE) {
      continue; // D was hit too long ago — stale completed pattern
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

      // ---- Calculate TP and SL (Pine Script v6 alignment) ----
      const cdRange = Math.abs(C.price - D.price);
      const xaRange = Math.abs(X.price - A.price);
      const SL_BUFFER = 0.13;
      let tp1Price: number;
      let tp2Price: number;
      let stopLossPrice: number;

      if (direction === "long") {
        tp1Price = D.price + cdRange * 0.382;
        tp2Price = D.price + cdRange * 0.618;
        stopLossPrice = D.price - xaRange * SL_BUFFER;
      } else {
        tp1Price = D.price - cdRange * 0.382;
        tp2Price = D.price - cdRange * 0.618;
        stopLossPrice = D.price + xaRange * SL_BUFFER;
      }

      if (tp1Price <= 0 || tp2Price <= 0 || stopLossPrice <= 0) {
        continue;
      }

      // Hard guard: TP/SL must be on the correct side of entry
      if (direction === "long") {
        const issues: string[] = [];
        if (tp1Price <= D.price) issues.push(`TP1 $${tp1Price.toFixed(2)} <= entry`);
        if (tp2Price <= D.price) issues.push(`TP2 $${tp2Price.toFixed(2)} <= entry`);
        if (stopLossPrice >= D.price) issues.push(`SL $${stopLossPrice.toFixed(2)} >= entry (should be below)`);
        if (issues.length > 0) {
          console.error(
            `[CRITICAL] Bad exits for LONG ${symbol} ${pattern.name} ${timeframe}: ` +
              `entry=$${D.price.toFixed(2)} — ${issues.join("; ")} — SKIPPING`,
          );
          continue;
        }
      } else {
        const issues: string[] = [];
        if (tp1Price >= D.price) issues.push(`TP1 $${tp1Price.toFixed(2)} >= entry`);
        if (tp2Price >= D.price) issues.push(`TP2 $${tp2Price.toFixed(2)} >= entry`);
        if (stopLossPrice <= D.price) issues.push(`SL $${stopLossPrice.toFixed(2)} <= entry (should be above)`);
        if (issues.length > 0) {
          console.error(
            `[CRITICAL] Bad exits for SHORT ${symbol} ${pattern.name} ${timeframe}: ` +
              `entry=$${D.price.toFixed(2)} — ${issues.join("; ")} — SKIPPING`,
          );
          continue;
        }
      }

      // ---- Slippage check: is current price still near D? ----
      // Only signal if the last close is within 3% of D's price.
      // Previous 1.5% was too tight for volatile crypto on 30s scan cycles
      // combined with 5-minute cache TTLs on 4H candles.
      const lastClose = candles[candles.length - 1].close;
      const slippagePct = Math.abs(lastClose - D.price) / D.price;
      if (slippagePct > 0.03) {
        console.log(
          `[Harmonics] Skipping completed ${symbol} ${timeframe} ${pattern.name} — ` +
          `slippage ${(slippagePct * 100).toFixed(2)}% > 3% (close=$${lastClose.toFixed(2)}, D=$${D.price.toFixed(2)})`,
        );
        continue;
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

    // ---- Special case: ABCD completed detection ----
    // ABCD uses AC ratio (0.382-0.886) and CD/AB ratio (0.786-1.618)
    const abcRatioForABCD = calcRetrace(A.price, B.price, C.price);
    const abLen = Math.abs(A.price - B.price);
    const cdLen = Math.abs(C.price - D.price);
    const abcdRatio = cdLen / Math.max(abLen, 0.0001);

    if (
      ratioInRange(abcRatioForABCD, 0.382, 0.886, RATIO_TOLERANCE) &&
      ratioInRange(abcdRatio, 0.786, 1.618, RATIO_TOLERANCE)
    ) {
      const direction: Direction = A.type === 1 ? "long" : "short";

      if (Number.isFinite(D.price) && D.price > 0) {
        const adRangePct = Math.abs(A.price - D.price) / A.price;
        if (adRangePct >= MIN_AD_RANGE_PCT) {
          // TP/SL using Pine Script v6 formulas
          const cdRange_abcd = Math.abs(C.price - D.price);
          const xaRange_abcd = Math.abs(X.price - A.price);
          const SL_BUFFER = 0.13;
          let tp1Price: number;
          let tp2Price: number;
          let stopLossPrice: number;

          if (direction === "long") {
            tp1Price = D.price + cdRange_abcd * 0.382;
            tp2Price = D.price + cdRange_abcd * 0.618;
            stopLossPrice = D.price - xaRange_abcd * SL_BUFFER;
          } else {
            tp1Price = D.price - cdRange_abcd * 0.382;
            tp2Price = D.price - cdRange_abcd * 0.618;
            stopLossPrice = D.price + xaRange_abcd * SL_BUFFER;
          }

          if (tp1Price > 0 && tp2Price > 0 && stopLossPrice > 0) {
            const valid = direction === "long"
              ? tp1Price > D.price && tp2Price > D.price && stopLossPrice < D.price
              : tp1Price < D.price && tp2Price < D.price && stopLossPrice > D.price;

            if (valid) {
              // Slippage check: is current price still near D?
              const lastClose = candles[candles.length - 1].close;
              const slippagePct = Math.abs(lastClose - D.price) / D.price;
              if (slippagePct <= 0.03) {
                console.log(
                  `[Harmonics] COMPLETED ${symbol} ${timeframe} ABCD ${direction.toUpperCase()} — ` +
                    `X=$${X.price.toFixed(2)} A=$${A.price.toFixed(2)} B=$${B.price.toFixed(2)} ` +
                    `C=$${C.price.toFixed(2)} D=$${D.price.toFixed(2)} | ` +
                    `AC=${abcRatioForABCD.toFixed(3)} CD/AB=${abcdRatio.toFixed(3)} | ` +
                    `SL=$${stopLossPrice.toFixed(2)} TP1=$${tp1Price.toFixed(2)} TP2=$${tp2Price.toFixed(2)}`,
                );

                signals.push({
                  symbol,
                  timeframe,
                  pattern: "ABCD",
                  direction,
                  limitPrice: D.price,
                  xPrice: X.price,
                  aPrice: A.price,
                  bPrice: B.price,
                  cPrice: C.price,
                  projectedD: D.price,
                  tp1Price,
                  tp2Price,
                  stopLossPrice,
                });
              }
            }
          }
        }
      }
    }
  }

  return signals;
}

// ============================================================
// Pattern Phase Detection — for tiered scanner scheduling
// Determines the deepest harmonic formation phase for a symbol.
// Does NOT generate signals — purely for scan interval decisions.
// ============================================================

export type PatternPhase = "NO_PATTERN" | "XA_FORMING" | "AB_FORMING" | "BC_FORMING" | "CD_PROJECTED" | "D_APPROACHING";

export interface PatternPhaseResult {
  phase: PatternPhase;
  bestPattern: string | null;
  bestDirection: string | null;
  pivotCount: number;
  xPrice: number | null;
  aPrice: number | null;
  bPrice: number | null;
  cPrice: number | null;
  projectedD: number | null;
  distanceToDPct: number | null;
}

const PHASE_DEPTH: Record<PatternPhase, number> = {
  NO_PATTERN: 0,
  XA_FORMING: 1,
  AB_FORMING: 2,
  BC_FORMING: 3,
  CD_PROJECTED: 4,
  D_APPROACHING: 5,
};

/**
 * Detects the deepest harmonic formation phase across all pattern
 * definitions, for a given symbol's candle data. Used by the tiered
 * scanner to decide how frequently to re-scan each symbol.
 *
 * Fast path — no quality filters, no screener, no signal generation.
 * No console.log — called thousands of times per cycle.
 */
export function detectPatternPhase(
  candles: Candle[],
  symbol: string,
  timeframe: "1D" | "4H",
): PatternPhaseResult {
  const empty: PatternPhaseResult = {
    phase: "NO_PATTERN",
    bestPattern: null,
    bestDirection: null,
    pivotCount: 0,
    xPrice: null,
    aPrice: null,
    bPrice: null,
    cPrice: null,
    projectedD: null,
    distanceToDPct: null,
  };

  const pivots = findPivots(candles);
  empty.pivotCount = pivots.length;

  if (pivots.length < 2) {
    return empty;
  }

  const recentPivots = pivots.slice(-40);
  const lastClose = candles[candles.length - 1].close;

  let deepest: PatternPhaseResult = { ...empty };

  // Track the best fib deviation for tie-breaking same-depth matches
  let bestFibDeviation = Infinity;

  for (let xi = 0; xi < recentPivots.length - 1; xi++) {
    const X = recentPivots[xi];
    const A = recentPivots[xi + 1];

    // Must alternate high/low
    if (X.type === A.type) continue;

    // Minimum XA leg size
    const xaSize = Math.abs(X.price - A.price);
    const midPrice = (X.price + A.price) / 2;
    if (midPrice <= 0 || xaSize / midPrice < MIN_XA_LEG_PCT) continue;

    // At minimum we have an XA pair
    if (PHASE_DEPTH.XA_FORMING > PHASE_DEPTH[deepest.phase]) {
      deepest = {
        ...empty,
        phase: "XA_FORMING",
        xPrice: X.price,
        aPrice: A.price,
      };
      bestFibDeviation = Infinity;
    }

    // Need B to go further
    if (xi + 2 >= recentPivots.length) continue;
    const B = recentPivots[xi + 2];
    if (A.type === B.type) continue;

    const xabRatio = calcRetrace(X.price, A.price, B.price);

    // Check if XAB ratio matches ANY pattern
    let anyXabMatch = false;
    for (const pat of PATTERN_DEFS) {
      if (ratioInRange(xabRatio, pat.xab.min, pat.xab.max, RATIO_TOLERANCE)) {
        anyXabMatch = true;
        break;
      }
    }
    if (!anyXabMatch) continue;

    if (PHASE_DEPTH.AB_FORMING > PHASE_DEPTH[deepest.phase]) {
      deepest = {
        ...empty,
        phase: "AB_FORMING",
        xPrice: X.price,
        aPrice: A.price,
        bPrice: B.price,
      };
      bestFibDeviation = Infinity;
    }

    // Need C to go further
    if (xi + 3 >= recentPivots.length) continue;
    const C = recentPivots[xi + 3];
    if (B.type === C.type) continue;

    const abcRatio = calcRetrace(A.price, B.price, C.price);

    // Check if BOTH XAB and ABC match some pattern
    for (const pat of PATTERN_DEFS) {
      if (
        !ratioInRange(xabRatio, pat.xab.min, pat.xab.max, RATIO_TOLERANCE) ||
        !ratioInRange(abcRatio, pat.abc.min, pat.abc.max, RATIO_TOLERANCE)
      ) {
        continue;
      }

      // Both ratios match this pattern — at least BC_FORMING
      const direction: Direction = A.type === 1 ? "long" : "short";

      // Fib deviation for tie-breaking: how close are the ratios to ideal?
      const xabMid = (pat.xab.min + pat.xab.max) / 2;
      const abcMid = (pat.abc.min + pat.abc.max) / 2;
      const fibDev = Math.abs(xabRatio - xabMid) + Math.abs(abcRatio - abcMid);

      // Record BC_FORMING as a floor — even if D is already hit or invalid,
      // we know XABC are valid and the symbol is worth scanning more often.
      if (
        PHASE_DEPTH.BC_FORMING > PHASE_DEPTH[deepest.phase] ||
        (PHASE_DEPTH.BC_FORMING === PHASE_DEPTH[deepest.phase] && fibDev < bestFibDeviation)
      ) {
        deepest = {
          phase: "BC_FORMING",
          bestPattern: pat.name,
          bestDirection: direction,
          pivotCount: pivots.length,
          xPrice: X.price,
          aPrice: A.price,
          bPrice: B.price,
          cPrice: C.price,
          projectedD: null,
          distanceToDPct: null,
        };
        bestFibDeviation = fibDev;
      }

      // Project D
      const xaLeg = X.price - A.price;
      const midXAD = (pat.xad.min + pat.xad.max) / 2;
      const projD = A.price + xaLeg * midXAD;

      if (!Number.isFinite(projD) || projD <= 0) continue;

      // Check if D has already been hit
      const dAlreadyHit = direction === "long"
        ? lastClose <= projD
        : lastClose >= projD;

      if (dAlreadyHit) continue;

      // Distance to D
      const distPct = Math.abs(lastClose - projD) / lastClose * 100;

      // Determine phase
      let candidatePhase: PatternPhase;
      if (distPct <= 5) {
        candidatePhase = "D_APPROACHING";
      } else {
        candidatePhase = "CD_PROJECTED";
      }

      // Update deepest if this is deeper, or same depth with closer fib ratios
      if (
        PHASE_DEPTH[candidatePhase] > PHASE_DEPTH[deepest.phase] ||
        (PHASE_DEPTH[candidatePhase] === PHASE_DEPTH[deepest.phase] && fibDev < bestFibDeviation)
      ) {
        deepest = {
          phase: candidatePhase,
          bestPattern: pat.name,
          bestDirection: direction,
          pivotCount: pivots.length,
          xPrice: X.price,
          aPrice: A.price,
          bPrice: B.price,
          cPrice: C.price,
          projectedD: projD,
          distanceToDPct: Math.round(distPct * 100) / 100,
        };
        bestFibDeviation = fibDev;
      }
    }

    // ---- Special case: ABCD phase detection ----
    // ABCD uses AC ratio (0.382-0.886) and projects D = C ± |AB|
    if (ratioInRange(abcRatio, 0.382, 0.886, RATIO_TOLERANCE)) {
      const direction: Direction = A.type === 1 ? "long" : "short";
      const abLen = Math.abs(A.price - B.price);
      const projD_ABCD = direction === "long"
        ? C.price - abLen
        : C.price + abLen;

      // Use fib deviation of AC ratio from midpoint of 0.382-0.886
      const abcdFibDev = Math.abs(abcRatio - 0.634);

      // Record BC_FORMING for ABCD
      if (
        PHASE_DEPTH.BC_FORMING > PHASE_DEPTH[deepest.phase] ||
        (PHASE_DEPTH.BC_FORMING === PHASE_DEPTH[deepest.phase] && abcdFibDev < bestFibDeviation)
      ) {
        deepest = {
          phase: "BC_FORMING",
          bestPattern: "ABCD",
          bestDirection: direction,
          pivotCount: pivots.length,
          xPrice: X.price,
          aPrice: A.price,
          bPrice: B.price,
          cPrice: C.price,
          projectedD: null,
          distanceToDPct: null,
        };
        bestFibDeviation = abcdFibDev;
      }

      if (Number.isFinite(projD_ABCD) && projD_ABCD > 0) {
        const dAlreadyHit = direction === "long"
          ? lastClose <= projD_ABCD
          : lastClose >= projD_ABCD;

        if (!dAlreadyHit) {
          const distPct = Math.abs(lastClose - projD_ABCD) / lastClose * 100;
          const candidatePhase: PatternPhase = distPct <= 5 ? "D_APPROACHING" : "CD_PROJECTED";

          if (
            PHASE_DEPTH[candidatePhase] > PHASE_DEPTH[deepest.phase] ||
            (PHASE_DEPTH[candidatePhase] === PHASE_DEPTH[deepest.phase] && abcdFibDev < bestFibDeviation)
          ) {
            deepest = {
              phase: candidatePhase,
              bestPattern: "ABCD",
              bestDirection: direction,
              pivotCount: pivots.length,
              xPrice: X.price,
              aPrice: A.price,
              bPrice: B.price,
              cPrice: C.price,
              projectedD: projD_ABCD,
              distanceToDPct: Math.round(distPct * 100) / 100,
            };
            bestFibDeviation = abcdFibDev;
          }
        }
      }
    }
  }

  return deepest;
}
