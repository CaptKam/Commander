/**
 * FMP Data Ingestion & Caching Layer — Phase 8 (Stable API Migration)
 *
 * FIXES:
 * 1. Migrates from deprecated /api/v3/ endpoints to /stable/ endpoints.
 *    FMP deprecated all v3/v4 legacy routes as of August 31, 2025.
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
// FMP API endpoints — using /stable/ routes (v3 deprecated Aug 2025)
// Daily uses historical-price-eod/full, intraday uses historical-chart.
// Symbol is now a query parameter, not a path segment.
// ============================================================
const FMP_BASE = "https://financialmodelingprep.com/stable";

/**
 * Builds the correct /stable/ URL for FMP requests.
 * - 1D: /stable/historical-price-eod/full?symbol=AAPL&apikey=...
 * - 4H: /stable/historical-chart/4hour?symbol=AAPL&apikey=...
 */
function buildUrl(symbol: string, timeframe: "1D" | "4H"): string {
  const cleanSymbol = sanitizeSymbol(symbol);
  if (timeframe === "1D") {
    return `${FMP_BASE}/historical-price-eod/full?symbol=${cleanSymbol}&apikey=${FMP_API_KEY}`;
  }
  return `${FMP_BASE}/historical-chart/4hour?symbol=${cleanSymbol}&apikey=${FMP_API_KEY}`;
}

// ============================================================
// Response normalization — handles both stable response formats:
//   - historical-chart (4H): returns flat array of candle objects
//   - historical-price-eod/full (1D): returns { historical: [...] }
// ============================================================
function normalizeResponse(raw: unknown): Candle[] {
  let records: unknown[];

  if (Array.isArray(raw)) {
    records = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as any).historical)) {
    records = (raw as any).historical;
  } else {
    return [];
  }

  return records
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

  const candles = normalizeResponse(json);

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
