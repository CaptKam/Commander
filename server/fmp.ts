/**
 * Market Data Ingestion & Caching Layer — FMP (Financial Modeling Prep)
 *
 * Fetches historical candle data from FMP API endpoints:
 *   - Daily:    GET https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=...
 *   - 4-Hour:   GET https://financialmodelingprep.com/stable/historical-chart/4hour?symbol=...
 *
 * FMP uses BTCUSD format for crypto (no slash). Our internal format is
 * BTC/USD, so we convert at the boundary.
 *
 * Cache TTLs:
 *   - "1D" candles: 1 hour
 *   - "4H" candles: 1 minute
 *
 * Lookback windows:
 *   - "1D": 90 days
 *   - "4H": 15 days
 *
 * NOTE: This in-memory cache is strictly for API rate-limiting. It does
 * NOT store trade state, so it complies with CLAUDE.md Rule #2.
 */

// ============================================================
// Environment
// ============================================================
function getFmpApiKey(): string {
  const key = process.env.FMP_API_KEY;
  if (!key) {
    throw new Error("[MarketData] FMP_API_KEY must be set in .env");
  }
  return key;
}

// ============================================================
// Types
// ============================================================
export interface Candle {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============================================================
// Cache configuration
// ============================================================
const CACHE_TTL_MS: Record<string, number> = {
  "1D": 60 * 60 * 1000,  // 1 hour
  "4H": 60 * 1000,        // 1 minute
};

interface CacheEntry {
  candles: Candle[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCacheKey(symbol: string, timeframe: string): string {
  return `${symbol}:${timeframe}`;
}

// ============================================================
// FMP API base
// ============================================================
const FMP_BASE = "https://financialmodelingprep.com";

/**
 * Converts our internal symbol format to FMP format.
 * "BTC/USD" → "BTCUSD", "AAPL" → "AAPL"
 */
function toFmpSymbol(symbol: string): string {
  return symbol.replace("/", "");
}

function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes("/");
}

/**
 * Returns from/to date strings for the lookback window.
 */
function getDateRange(timeframe: "1D" | "4H"): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  if (timeframe === "1D") {
    from.setDate(from.getDate() - 90);
  } else {
    from.setDate(from.getDate() - 15);
  }
  return {
    from: from.toISOString().split("T")[0],
    to: to.toISOString().split("T")[0],
  };
}

// ============================================================
// FMP response normalization
// ============================================================

/**
 * Parses FMP daily (EOD) response.
 * Response format: { historical: [{ date, open, high, low, close, volume, ... }] }
 */
function parseDailyResponse(json: any): Candle[] {
  const bars = json?.historical;
  if (!Array.isArray(bars)) return [];

  return bars
    .map((bar: any) => ({
      timestamp: new Date(bar.date).getTime(),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume),
    }))
    .filter((c: Candle) => c.open > 0 && c.high > 0)
    .sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);
}

/**
 * Parses FMP intraday (4hour) response.
 * Response format: [{ date, open, high, low, close, volume }]
 */
function parseIntradayResponse(json: any): Candle[] {
  if (!Array.isArray(json)) return [];

  return json
    .map((bar: any) => ({
      timestamp: new Date(bar.date).getTime(),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume),
    }))
    .filter((c: Candle) => c.open > 0 && c.high > 0)
    .sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);
}

// ============================================================
// Single-symbol fetcher
// ============================================================

/**
 * Fetches candles for a single symbol from FMP.
 */
async function fetchFromFmp(
  symbol: string,
  timeframe: "1D" | "4H",
  apiKey: string,
): Promise<Candle[]> {
  const fmpSymbol = toFmpSymbol(symbol);
  const { from, to } = getDateRange(timeframe);

  let url: string;
  if (timeframe === "1D") {
    url =
      `${FMP_BASE}/stable/historical-price-eod/full` +
      `?symbol=${encodeURIComponent(fmpSymbol)}` +
      `&from=${from}&to=${to}&apikey=${apiKey}`;
  } else {
    url =
      `${FMP_BASE}/stable/historical-chart/4hour` +
      `?symbol=${encodeURIComponent(fmpSymbol)}` +
      `&from=${from}&to=${to}&apikey=${apiKey}`;
  }

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[MarketData] FMP API error for ${symbol} (${timeframe}): ${res.status} — ${body}`,
    );
  }

  const json = await res.json();

  if (timeframe === "1D") {
    return parseDailyResponse(json);
  } else {
    return parseIntradayResponse(json);
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Fetches candles for an entire watchlist on a given timeframe.
 * Fetches per-symbol (FMP doesn't have a multi-symbol batch endpoint
 * for historical charts), but caches aggressively to minimize calls.
 */
export async function fetchWatchlist(
  symbols: string[],
  timeframe: "1D" | "4H",
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  const now = Date.now();
  const ttl = CACHE_TTL_MS[timeframe] ?? CACHE_TTL_MS["4H"];

  // Separate cached vs uncached
  const uncached: string[] = [];
  for (const symbol of symbols) {
    const key = getCacheKey(symbol, timeframe);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      results.set(symbol, cached.candles);
    } else {
      uncached.push(symbol);
    }
  }

  if (uncached.length === 0) return results;

  const apiKey = getFmpApiKey();

  // Fetch uncached symbols sequentially to respect FMP rate limits
  for (const symbol of uncached) {
    try {
      const candles = await fetchFromFmp(symbol, timeframe, apiKey);

      if (candles.length === 0) {
        console.warn(`[MarketData] No FMP data for ${symbol} ${timeframe}`);
        continue;
      }

      results.set(symbol, candles);
      cache.set(getCacheKey(symbol, timeframe), {
        candles,
        expiresAt: Date.now() + ttl,
      });

      console.log(
        `[MarketData] FMP: ${symbol} ${timeframe} → ${candles.length} candles`,
      );
    } catch (err) {
      console.error(
        `[MarketData] FMP fetch failed for ${symbol} (${timeframe}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return results;
}

/**
 * Fetches candles for a single symbol.
 */
export async function fetchCandles(
  symbol: string,
  timeframe: "1D" | "4H",
): Promise<Candle[]> {
  const result = await fetchWatchlist([symbol], timeframe);
  return result.get(symbol) ?? [];
}

/**
 * Returns current cache stats for monitoring/debugging.
 */
export function getCacheStats(): { entries: number; symbols: string[] } {
  const symbols = Array.from(cache.keys());
  return { entries: symbols.length, symbols };
}
