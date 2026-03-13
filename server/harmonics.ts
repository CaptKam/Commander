/**
 * Harmonic Math Utilities — Phase 8
 * Pure math functions for Fibonacci retracement/extension calculations.
 * No side effects, no I/O — just numbers in, numbers out.
 */

// ============================================================
// Standard Fibonacci ratios used in harmonic pattern detection
// ============================================================
export const FIB = {
  _0236: 0.236,
  _0382: 0.382,
  _0500: 0.5,
  _0618: 0.618,
  _0707: 0.707,
  _0786: 0.786,
  _0886: 0.886,
  _1000: 1.0,
  _1130: 1.13,
  _1272: 1.272,
  _1414: 1.414,
  _1618: 1.618,
  _2000: 2.0,
  _2240: 2.24,
  _2618: 2.618,
  _3618: 3.618,
} as const;

/**
 * Calculates the retracement ratio of retPrice between fromPrice and toPrice.
 *
 * Example: If X=100, A=80, B=87.86 → calcRetrace(100, 80, 87.86) = 0.393
 * This means B retraced ~39.3% of the XA leg.
 *
 * Returns the absolute ratio (always positive).
 */
export function calcRetrace(
  fromPrice: number,
  toPrice: number,
  retPrice: number,
): number {
  const leg = toPrice - fromPrice;
  if (leg === 0) return 0;
  return Math.abs((retPrice - toPrice) / leg);
}

/**
 * Calculates the extension ratio of extPrice beyond the fromPrice→toPrice leg,
 * measured from the retrace point.
 *
 * Example: For BC extension, fromPrice=A, toPrice=B, extPrice=C
 */
export function calcExtension(
  fromPrice: number,
  toPrice: number,
  extPrice: number,
): number {
  const leg = Math.abs(toPrice - fromPrice);
  if (leg === 0) return 0;
  return Math.abs(extPrice - toPrice) / leg;
}

/**
 * Checks if an actual ratio falls within [min, max] ± tolerance.
 *
 * Example: ratioInRange(0.63, 0.618, 0.618, 0.05) → true (0.63 is within 0.568–0.668)
 */
export function ratioInRange(
  actual: number,
  min: number,
  max: number,
  tolerance: number = 0.05,
): boolean {
  return actual >= min - tolerance && actual <= max + tolerance;
}
