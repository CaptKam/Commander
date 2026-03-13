/**
 * FMP Data Ingestion & Caching Layer — Phase 7
 * Fetches candle data from Financial Modeling Prep with an intelligent
 * in-memory cache to prevent rate-limit bans.
 *
 * Cache TTLs:
 *   - "1D" candles: 6 hours (daily bars don't change intraday)
 *   - "4H" candles: 5 minutes (need fresher data for forming patterns)
 *
 * NOTE: This in-memory cache is strictly for API rate-limiting. It does
 * NOT store trade state, so it complies with CLAUDE.md Rule #2.
 */

// ============================================================
// Environment
// ============================================================
const FMP_API_KEY = process.env.FMP_API_KEY;
if (!FMP_API_KEY) {
  throw new Error("[FMP] FMP_API_KEY must be set in .env");
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
  "1D": 6 * 60 * 60 * 1000, // 6 hours
  "4H": 5 * 60 * 1000, // 5 minutes
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
// Raw FMP response types (their API shape, not ours)
// ============================================================
interface FmpDailyCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface FmpDailyResponse {
  symbol: string;
  historical: FmpDailyCandle[];
}

interface FmpIntradayCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============================================================
// FMP API endpoints
// ============================================================
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

function buildUrl(symbol: string, timeframe: "1D" | "4H"): string {
  if (timeframe === "1D") {
    return `${FMP_BASE}/historical-price-full/${encodeURIComponent(symbol)}?apikey=${FMP_API_KEY}`;
  }
  return `${FMP_BASE}/historical-chart/4hour/${encodeURIComponent(symbol)}?apikey=${FMP_API_KEY}`;
}

// ============================================================
// Response normalization — maps FMP shape into our Candle[]
// ============================================================
function normalizeDailyResponse(raw: FmpDailyResponse): Candle[] {
  if (!raw.historical || !Array.isArray(raw.historical)) {
    return [];
  }

  return raw.historical
    .map((c) => ({
      timestamp: new Date(c.date).getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }))
    .sort((a, b) => a.timestamp - b.timestamp); // oldest first
}

function normalizeIntradayResponse(raw: FmpIntradayCandle[]): Candle[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((c) => ({
      timestamp: new Date(c.date).getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }))
    .sort((a, b) => a.timestamp - b.timestamp); // oldest first
}

// ============================================================
// The Fetcher — cache-first, rate-limit safe
// ============================================================
export async function fetchCandles(
  symbol: string,
  timeframe: "1D" | "4H",
): Promise<Candle[]> {
  const key = getCacheKey(symbol, timeframe);
  const now = Date.now();

  // ---- Check cache ----
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.candles;
  }

  // ---- Cache miss or expired — hit FMP ----
  const url = buildUrl(symbol, timeframe);

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[FMP] Failed to fetch ${timeframe} candles for ${symbol}: ${res.status} — ${body}`,
    );
  }

  const json = await res.json();

  // ---- Normalize based on endpoint shape ----
  const candles =
    timeframe === "1D"
      ? normalizeDailyResponse(json as FmpDailyResponse)
      : normalizeIntradayResponse(json as FmpIntradayCandle[]);

  if (candles.length === 0) {
    console.warn(`[FMP] No candle data returned for ${symbol} ${timeframe}`);
  }

  // ---- Store in cache ----
  const ttl = CACHE_TTL_MS[timeframe] ?? CACHE_TTL_MS["4H"];
  cache.set(key, {
    candles,
    expiresAt: now + ttl,
  });

  return candles;
}

/**
 * Fetches candles for an entire watchlist on a given timeframe.
 * Processes sequentially to respect FMP rate limits (~300/min).
 */
export async function fetchWatchlist(
  symbols: string[],
  timeframe: "1D" | "4H",
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();

  for (const symbol of symbols) {
    try {
      const candles = await fetchCandles(symbol, timeframe);
      results.set(symbol, candles);
    } catch (err) {
      // Log and skip — one bad symbol shouldn't kill the entire scan
      console.error(
        `[FMP] Skipping ${symbol} (${timeframe}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return results;
}

/**
 * Returns current cache stats for monitoring/debugging.
 */
export function getCacheStats(): { entries: number; symbols: string[] } {
  const symbols = Array.from(cache.keys());
  return { entries: symbols.length, symbols };
}
