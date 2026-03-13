/**
 * FMP Data Ingestion & Caching Layer — Phase 7 (FIXED for New API Keys)
 *
 * FIXES:
 * 1. Switches from 'historical-price-full' (Legacy) to 'historical-chart' (Modern).
 * 2. Sanitizes symbols (removes "/" for Crypto compatibility).
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

/**
 * FMP requires symbols without slashes (BTCUSD, not BTC/USD).
 */
function sanitizeSymbol(symbol: string): string {
  return symbol.replace("/", "").toUpperCase();
}

function getCacheKey(symbol: string, timeframe: string): string {
  return `${symbol}:${timeframe}`;
}

// ============================================================
// FMP API endpoints — using /api/v3/historical-chart for ALL requests
// The 'historical-chart' endpoint works for both daily and intraday
// with newer API keys, avoiding 403 Legacy errors.
// ============================================================
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

/**
 * Uses the 'historical-chart' endpoint for ALL requests to avoid 403 Legacy errors.
 */
function buildUrl(symbol: string, timeframe: "1D" | "4H"): string {
  const cleanSymbol = sanitizeSymbol(symbol);
  const tfParam = timeframe === "1D" ? "1day" : "4hour";
  return `${FMP_BASE}/historical-chart/${tfParam}/${cleanSymbol}?apikey=${FMP_API_KEY}`;
}

// ============================================================
// Response normalization — unified for historical-chart endpoint
// ============================================================
function normalizeResponse(raw: unknown[]): Candle[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((c: any) => ({
      timestamp: new Date(c.date).getTime(),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
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
      `[FMP] API Error for ${symbol}: ${res.status} — ${body}`,
    );
  }

  const json = await res.json();

  // New FMP keys sometimes receive an error object instead of an array
  if (json && !Array.isArray(json) && (json as any)["Error Message"]) {
    throw new Error(`[FMP] ${(json as any)["Error Message"]}`);
  }

  const candles = normalizeResponse(json as unknown[]);

  if (candles.length === 0) {
    console.warn(
      `[FMP] No data for ${symbol} ${timeframe}. Check if symbol is supported on your plan.`,
    );
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
