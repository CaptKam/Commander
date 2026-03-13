/**
 * Anti-422 Utility Module — Alpaca Order Formatting
 * See CLAUDE.md Rule #1: Alpaca API Decimal Precision
 *
 * Alpaca rejects orders (422) if:
 *   - Decimal places exceed limits
 *   - Scientific notation (e.g. 1e-7) leaks into the payload
 *   - Values are NaN, zero, or negative
 *
 * Every qty and price value MUST pass through these formatters
 * before being sent to the Alpaca API.
 */

/**
 * Safely truncates a number to a fixed number of decimal places
 * WITHOUT rounding up (to avoid exceeding available balance).
 * Returns a plain decimal string — never scientific notation.
 */
function truncateToFixed(value: number, decimals: number): number {
  // Multiply, floor, divide — avoids toFixed() rounding-up behavior
  const factor = Math.pow(10, decimals);
  const truncated = Math.floor(value * factor) / factor;

  // Convert through toFixed to kill any scientific notation (e.g. 1e-7)
  // then back to Number so Alpaca receives a clean numeric type.
  return Number(truncated.toFixed(decimals));
}

/**
 * Validates that the formatted result is a finite, positive number.
 * Throws a descriptive error to catch bad math before it hits Alpaca.
 */
function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `[Alpaca Anti-422] ${label} resolved to ${value} — must be a finite number > 0. ` +
        `Aborting order to prevent 422 rejection.`,
    );
  }
}

// -------------------------------------------------------------------
// Crypto price thresholds for decimal precision selection.
// High-value coins (BTC, ETH) need fewer decimals on price;
// low-value altcoins need more to represent meaningful amounts.
// -------------------------------------------------------------------
const CRYPTO_PRICE_TIERS = [
  { threshold: 1000, decimals: 2 }, // BTC-range: $67,000.12
  { threshold: 1, decimals: 4 }, // Mid-caps:  $142.5678
  { threshold: 0.01, decimals: 6 }, // Low-caps:  $0.004567
] as const;

const CRYPTO_PRICE_DEFAULT_DECIMALS = 8; // Sub-penny altcoins

/**
 * formatAlpacaQty — Format order quantity for Alpaca
 *
 * @param qty           Raw calculated quantity
 * @param isCrypto      true for crypto assets, false for equities
 * @param fractional    (stocks only) true if fractional share trading is enabled
 * @returns             Cleaned number safe for Alpaca's qty field
 * @throws              If result is NaN, zero, or negative
 */
export function formatAlpacaQty(
  qty: number,
  isCrypto: boolean,
  fractional: boolean = false,
): number {
  let formatted: number;

  if (isCrypto) {
    // CLAUDE.md Rule #1: crypto qty — max 9 decimal places
    formatted = truncateToFixed(qty, 9);
  } else {
    // Stocks: whole shares by default, 4 decimals if fractional
    formatted = fractional ? truncateToFixed(qty, 4) : Math.floor(qty);
  }

  assertPositive(formatted, `qty (${isCrypto ? "crypto" : "stock"})`);
  return formatted;
}

/**
 * formatAlpacaPrice — Format limit/stop price for Alpaca
 *
 * @param price         Raw calculated price
 * @param isCrypto      true for crypto assets, false for equities
 * @returns             Cleaned number safe for Alpaca's limit_price / stop_price fields
 * @throws              If result is NaN, zero, or negative
 */
export function formatAlpacaPrice(
  price: number,
  isCrypto: boolean,
): number {
  let formatted: number;

  if (isCrypto) {
    // Pick decimal precision based on price magnitude
    let decimals = CRYPTO_PRICE_DEFAULT_DECIMALS;
    for (const tier of CRYPTO_PRICE_TIERS) {
      if (price >= tier.threshold) {
        decimals = tier.decimals;
        break;
      }
    }
    formatted = truncateToFixed(price, decimals);
  } else {
    // Equities: always 2 decimal places (cents)
    formatted = truncateToFixed(price, 2);
  }

  assertPositive(formatted, `price (${isCrypto ? "crypto" : "stock"})`);
  return formatted;
}
