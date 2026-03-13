/**
 * Market Data Ingestion & Caching Layer — Phase 9 (Alpaca Migration)
 *
 * Replaces FMP with Alpaca Market Data API for historical candles.
 * FMP deprecated all legacy endpoints (Aug 2025) and the user's plan
 * doesn't cover stable routes either. Alpaca keys are already configured.
 *
 * Endpoints:
 *   - Stocks:  GET https://data.alpaca.markets/v2/stocks/{symbol}/bars
 *   - Crypto:  GET https://data.alpaca.markets/v1beta3/crypto/us/bars
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
// Read at module level but validated at call time — a missing key must NOT
// crash the process at import, otherwise the bot enters a restart loop and
// the in-memory dedup map resets every cycle, causing Telegram spam.
let ALPACA_API_KEY = process.env.ALPACA_API_KEY;
let ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;

function assertMarketDataKeys(): void {
  // Re-read in case env was set after module load (e.g. dotenv late init)
  ALPACA_API_KEY = process.env.ALPACA_API_KEY;
  ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;
  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    throw new Error(
      "[MarketData] ALPACA_API_KEY and ALPACA_API_SECRET must be set in .env",
    );
  }
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
// Alpaca Market Data endpoints
//   Stocks: https://data.alpaca.markets/v2/stocks/{symbol}/bars
//   Crypto: https://data.alpaca.markets/v1beta3/crypto/us/bars
// ============================================================
const STOCK_DATA_BASE = "https://data.alpaca.markets/v2";
const CRYPTO_DATA_BASE = "https://data.alpaca.markets/v1beta3/crypto/us";

/**
 * Returns true if the symbol looks like a crypto pair (contains "/").
 */
function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes("/");
}

/**
 * Maps our internal timeframe codes to Alpaca's timeframe format.
 */
function alpacaTimeframe(timeframe: "1D" | "4H"): string {
  return timeframe === "1D" ? "1Day" : "4Hour";
}

/**
 * Calculates a start date far enough back to get sufficient bars
 * for harmonic pattern detection (~250 bars).
 */
function getStartDate(timeframe: "1D" | "4H"): string {
  const now = new Date();
  if (timeframe === "1D") {
    // 365 days back for daily bars
    now.setDate(now.getDate() - 365);
  } else {
    // ~60 days back for 4H bars (6 bars/day × 60 days = 360 bars)
    now.setDate(now.getDate() - 60);
  }
  return now.toISOString().split(".")[0] + "Z";
}

/**
 * Builds the Alpaca Market Data URL and returns { url, headers }.
 */
function buildRequest(
  symbol: string,
  timeframe: "1D" | "4H",
): { url: string; headers: Record<string, string> } {
  const tf = alpacaTimeframe(timeframe);
  const start = getStartDate(timeframe);
  const headers: Record<string, string> = {
    "APCA-API-KEY-ID": ALPACA_API_KEY!,
    "APCA-API-SECRET-KEY": ALPACA_API_SECRET!,
  };

  if (isCryptoSymbol(symbol)) {
    // Crypto: multi-symbol endpoint with symbol as query param
    const url =
      `${CRYPTO_DATA_BASE}/bars?symbols=${encodeURIComponent(symbol)}` +
      `&timeframe=${tf}&start=${start}&limit=1000`;
    return { url, headers };
  }

  // Stocks: single-symbol endpoint with symbol in path
  const url =
    `${STOCK_DATA_BASE}/stocks/${encodeURIComponent(symbol)}/bars` +
    `?timeframe=${tf}&start=${start}&limit=1000&feed=iex`;
  return { url, headers };
}

// ============================================================
// Response normalization
//   Stock single-symbol:  { "bars": [ { t, o, h, l, c, v, ... } ], ... }
//   Crypto multi-symbol:  { "bars": { "BTC/USD": [ { t, o, h, l, c, v } ] }, ... }
// ============================================================
function normalizeAlpacaBars(json: any, symbol: string): Candle[] {
  let rawBars: any[];

  if (Array.isArray(json.bars)) {
    // Stock single-symbol response
    rawBars = json.bars;
  } else if (json.bars && typeof json.bars === "object" && json.bars[symbol]) {
    // Crypto multi-symbol response keyed by symbol
    rawBars = json.bars[symbol];
  } else {
    return [];
  }

  return rawBars
    .map((bar: any) => ({
      timestamp: new Date(bar.t).getTime(),
      open: Number(bar.o),
      high: Number(bar.h),
      low: Number(bar.l),
      close: Number(bar.c),
      volume: Number(bar.v),
    }))
    .sort((a, b) => a.timestamp - b.timestamp); // oldest first
}

// ============================================================
// The Fetcher — cache-first, with pagination support
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

  // ---- Cache miss or expired — hit Alpaca ----
  assertMarketDataKeys();
  const { url, headers } = buildRequest(symbol, timeframe);
  const allCandles: Candle[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const res = await fetch(nextUrl, { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `[MarketData] Alpaca API Error for ${symbol}: ${res.status} — ${body}`,
      );
    }

    const json = await res.json();
    const candles = normalizeAlpacaBars(json, symbol);
    allCandles.push(...candles);

    // Handle pagination
    if (json.next_page_token) {
      const separator = url.includes("?") ? "&" : "?";
      nextUrl = `${url}${separator}page_token=${json.next_page_token}`;
    } else {
      nextUrl = null;
    }
  }

  if (allCandles.length === 0) {
    console.warn(
      `[MarketData] No data for ${symbol} ${timeframe}. Check if symbol is supported.`,
    );
  }

  // ---- Sort and store in cache ----
  allCandles.sort((a, b) => a.timestamp - b.timestamp);
  const ttl = CACHE_TTL_MS[timeframe] ?? CACHE_TTL_MS["4H"];
  cache.set(key, {
    candles: allCandles,
    expiresAt: now + ttl,
  });

  return allCandles;
}

/**
 * Fetches candles for an entire watchlist on a given timeframe.
 * Processes sequentially to avoid rate-limit issues.
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
        `[MarketData] Skipping ${symbol} (${timeframe}):`,
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
