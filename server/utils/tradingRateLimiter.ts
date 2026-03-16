/**
 * Trading API Rate Limiter — Shared across alpaca.ts, exit-manager.ts, crypto-monitor.ts
 *
 * Alpaca shares a single 200 req/min rate limit across BOTH data and trading APIs.
 * The data rate limiter in alpaca-data.ts only tracks data calls. This module
 * tracks trading calls to prevent 429 errors when the exit cycle makes many
 * concurrent API calls under heavy signal load.
 *
 * Uses a sliding window approach matching alpaca-data.ts.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const TRADING_BUDGET = 60; // Reserve 60 req/min for trading (data gets 140)

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
