/**
 * Trading API Rate Limiter — Shared across alpaca.ts, exit-manager.ts, crypto-monitor.ts
 *
 * Alpaca Algo Trader Plus: 1000 req/min shared across data and trading APIs.
 * Data rate limiter (alpaca-data.ts) handles data calls. This module tracks
 * trading API calls (orders, positions, account) to prevent 429 errors.
 *
 * Uses a sliding window approach matching alpaca-data.ts.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const TRADING_BUDGET = 300; // Algo Trader Plus: 1000/min total, reserve 300 for trading

const timestamps: number[] = [];

/**
 * Call before each Alpaca trading API request.
 * Throws if trading budget is exhausted — caller should catch and retry next cycle.
 */
export function checkTradingRateLimit(): void {
  const now = Date.now();
  while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= TRADING_BUDGET) {
    throw new Error(
      `[TradingRateLimit] Trading API budget exhausted (${TRADING_BUDGET}/min). ` +
      `Will retry next cycle.`,
    );
  }
  timestamps.push(now);
}

export function getTradingRateLimitStats(): { used: number; limit: number } {
  const now = Date.now();
  while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }
  return { used: timestamps.length, limit: TRADING_BUDGET };
}
