/**
 * Market Data Ingestion & Caching Layer — Alpaca (sole data provider)
 *
 * Alpaca provides both stock and crypto bars through a single API:
 *   - Stocks: GET https://data.alpaca.markets/v2/stocks/bars?symbols=...
 *   - Crypto: GET https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=...
 *
 * SIP feed enabled for full market data coverage.
 *
 * Rate limits (monitored and enforced here):
 *   - 200 requests/minute (free tier)
 *   - Warns at 80% utilization, throws at 100%
 *
 * Lookback windows:
 *   - "1D": 365 days (1 year — deep pivot history for pattern detection)
 *   - "4H": 90 days (3 months of 4-hour candles)
 *
 * Cache TTLs:
 *   - "1D" candles: 2 hours (daily bars are static intraday)
 *   - "4H" candles: 5 minutes (balances freshness vs API budget)
 *
 * NOTE: This in-memory cache is strictly for API rate-limiting. It does
 * NOT store trade state, so it complies with CLAUDE.md Rule #2.
 */

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
// Environment
// ============================================================
function getAlpacaKeys(): { key: string; secret: string } {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      "[MarketData] ALPACA_API_KEY and ALPACA_API_SECRET must be set in .env",
    );
  }
  return { key, secret };
}

// ============================================================
// Alpaca data API base (same for paper and live)
// ============================================================
const ALPACA_DATA_BASE = "https://data.alpaca.markets";

// ============================================================
// Cache configuration — generous TTLs to conserve free tier budget
// ============================================================
const CACHE_TTL_MS: Record<string, number> = {
  "1D": 2 * 60 * 60 * 1000, // 2 hours (daily bars are static intraday)
  "4H": 5 * 60 * 1000,      // 5 minutes (balances freshness vs API cost)
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
// Rate Limiter — Alpaca Free Tier: 200 req/min
//
// Sliding window counter. Logs warnings at 80% utilization.
// Throws at 100% to prevent 429s from Alpaca.
// ============================================================
const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const RATE_LIMIT_MAX = 200;           // Alpaca free tier
const RATE_LIMIT_WARN_PCT = 0.8;      // Warn at 80% (160 calls)

const requestTimestamps: number[] = [];

function checkRateLimit(): void {
  const now = Date.now();
  // Evict timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= RATE_LIMIT_MAX) {
    const oldestAge = now - requestTimestamps[0];
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - oldestAge;
    throw new Error(
      `[MarketData] Rate limit reached (${RATE_LIMIT_MAX}/min). ` +
      `Retry after ${Math.ceil(retryAfterMs / 1000)}s. ` +
      `Upgrade to paid tier for 1000/min.`,
    );
  }

  if (requestTimestamps.length >= RATE_LIMIT_MAX * RATE_LIMIT_WARN_PCT) {
    console.warn(
      `[MarketData] Rate limit warning: ${requestTimestamps.length}/${RATE_LIMIT_MAX} calls in last 60s ` +
      `(${Math.round((requestTimestamps.length / RATE_LIMIT_MAX) * 100)}% utilized)`,
    );
  }

  requestTimestamps.push(now);
}

/**
 * Returns current API usage stats for monitoring.
 */
export function getRateLimitStats(): { used: number; limit: number; pct: number } {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }
  return {
    used: requestTimestamps.length,
    limit: RATE_LIMIT_MAX,
    pct: Math.round((requestTimestamps.length / RATE_LIMIT_MAX) * 100),
  };
}

// ============================================================
// Helpers
// ============================================================
function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes("/");
}

/**
 * Converts our timeframe format to Alpaca's.
 * "1D" → "1Day", "4H" → "4Hour"
 */
function toAlpacaTimeframe(tf: "1D" | "4H"): string {
  return tf === "1D" ? "1Day" : "4Hour";
}

/**
 * Returns ISO date strings for the lookback window.
 */
function getDateRange(timeframe: "1D" | "4H"): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  if (timeframe === "1D") {
    start.setDate(start.getDate() - 365); // 1 year — deep pivot history
  } else {
    start.setDate(start.getDate() - 60);  // 60 days of 4H candles (reduced from 90 to fit within page limit)
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

// ============================================================
// Alpaca bar response types
// ============================================================
interface AlpacaBar {
  t: string; // ISO timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function barToCandle(bar: AlpacaBar): Candle {
  return {
    timestamp: new Date(bar.t).getTime(),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  };
}

// ============================================================
// Shared pagination helper
// Alpaca's limit is shared across ALL symbols in a multi-symbol
// request. With 12 stocks × 540 4H candles = 6480 bars, the
// first page gets truncated. Must follow next_page_token.
// Max 15 pages to prevent runaway loops on free tier.
// ============================================================
const MAX_PAGES = 15;

function appendBars(
  results: Map<string, AlpacaBar[]>,
  bars: Record<string, AlpacaBar[]>,
): void {
  for (const [sym, newBars] of Object.entries(bars)) {
    const existing = results.get(sym);
    if (existing) {
      existing.push(...newBars);
    } else {
      results.set(sym, [...newBars]);
    }
  }
}

// ============================================================
// Batch chunking — split large symbol lists to avoid pagination
// truncation. 5 symbols × ~360 candles = ~1,800 bars per chunk,
// well within 1–2 pages of Alpaca's 10,000-bar page limit.
// ============================================================
const CHUNK_SIZE = 5;

function chunkArray(arr: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < arr.length; i += CHUNK_SIZE) {
    chunks.push(arr.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

// ============================================================
// Stock bars fetcher (batched + paginated)
// ============================================================
async function fetchStockBars(
  symbols: string[],
  timeframe: "1D" | "4H",
  key: string,
  secret: string,
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  if (symbols.length === 0) return results;

  const chunks = chunkArray(symbols);
  for (const chunk of chunks) {
    const chunkResult = await fetchStockBarsChunk(chunk, timeframe, key, secret);
    for (const [sym, candles] of chunkResult) {
      results.set(sym, candles);
    }
  }

  return results;
}

async function fetchStockBarsChunk(
  symbols: string[],
  timeframe: "1D" | "4H",
  key: string,
  secret: string,
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  if (symbols.length === 0) return results;

  const { start, end } = getDateRange(timeframe);
  const alpacaTf = toAlpacaTimeframe(timeframe);
  const allBars = new Map<string, AlpacaBar[]>();

  let pageToken: string | null = null;
  let page = 0;

  do {
    checkRateLimit(); // 200/min guard

    let url =
      `${ALPACA_DATA_BASE}/v2/stocks/bars` +
      `?symbols=${symbols.map(encodeURIComponent).join(",")}` +
      `&timeframe=${alpacaTf}` +
      `&start=${encodeURIComponent(start)}` +
      `&end=${encodeURIComponent(end)}` +
      `&limit=10000` +
      `&adjustment=split` +
      `&feed=sip`;
    if (pageToken) {
      url += `&page_token=${encodeURIComponent(pageToken)}`;
    }

    if (page === 0) {
      console.log(`[MarketData] Stock bars URL: ${url.split("?")[0]}?... (${symbols.length} symbols, ${alpacaTf})`);
    }

    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `[MarketData] Alpaca stock bars error: ${res.status} — ${body}`,
      );
    }

    const json = (await res.json()) as {
      bars: Record<string, AlpacaBar[]>;
      next_page_token: string | null;
    };

    if (json.bars) {
      appendBars(allBars, json.bars);
    }

    pageToken = json.next_page_token;
    page++;

    if (pageToken) {
      console.log(`[MarketData] Stock bars page ${page}: fetching next page...`);
    }
  } while (pageToken && page < MAX_PAGES);

  if (page >= MAX_PAGES && pageToken) {
    console.warn(`[MarketData] Stock bars: hit max ${MAX_PAGES} pages, some data may be truncated`);
  }

  // Convert raw bars to candles
  for (const [sym, bars] of allBars) {
    const candles = bars
      .map(barToCandle)
      .filter((c) => c.open > 0 && c.high > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (candles.length > 0) {
      results.set(sym, candles);
    }
  }

  return results;
}

// ============================================================
// Crypto bars fetcher (batched + paginated)
// ============================================================
async function fetchCryptoBars(
  symbols: string[],
  timeframe: "1D" | "4H",
  key: string,
  secret: string,
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  if (symbols.length === 0) return results;

  const chunks = chunkArray(symbols);
  for (const chunk of chunks) {
    const chunkResult = await fetchCryptoBarsChunk(chunk, timeframe, key, secret);
    for (const [sym, candles] of chunkResult) {
      results.set(sym, candles);
    }
  }

  return results;
}

async function fetchCryptoBarsChunk(
  symbols: string[],
  timeframe: "1D" | "4H",
  key: string,
  secret: string,
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  if (symbols.length === 0) return results;

  const { start, end } = getDateRange(timeframe);
  const alpacaTf = toAlpacaTimeframe(timeframe);
  const allBars = new Map<string, AlpacaBar[]>();

  let pageToken: string | null = null;
  let page = 0;

  do {
    checkRateLimit(); // 200/min guard

    // Alpaca crypto uses slash format natively (BTC/USD) — no conversion needed
    let url =
      `${ALPACA_DATA_BASE}/v1beta3/crypto/us/bars` +
      `?symbols=${symbols.map(encodeURIComponent).join(",")}` +
      `&timeframe=${alpacaTf}` +
      `&start=${encodeURIComponent(start)}` +
      `&end=${encodeURIComponent(end)}` +
      `&limit=10000`;
    if (pageToken) {
      url += `&page_token=${encodeURIComponent(pageToken)}`;
    }

    if (page === 0) {
      console.log(`[MarketData] Crypto bars URL: ${url.split("?")[0]}?... (${symbols.length} symbols, ${alpacaTf})`);
    }

    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `[MarketData] Alpaca crypto bars error: ${res.status} — ${body}`,
      );
    }

    const json = (await res.json()) as {
      bars: Record<string, AlpacaBar[]>;
      next_page_token: string | null;
    };

    if (json.bars) {
      appendBars(allBars, json.bars);
    }

    pageToken = json.next_page_token;
    page++;

    if (pageToken) {
      console.log(`[MarketData] Crypto bars page ${page}: fetching next page...`);
    }
  } while (pageToken && page < MAX_PAGES);

  if (page >= MAX_PAGES && pageToken) {
    console.warn(`[MarketData] Crypto bars: hit max ${MAX_PAGES} pages, some data may be truncated`);
  }

  // Convert raw bars to candles
  for (const [sym, bars] of allBars) {
    const candles = bars
      .map(barToCandle)
      .filter((c) => c.open > 0 && c.high > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (candles.length > 0) {
      results.set(sym, candles);
    }
  }

  return results;
}

// ============================================================
// Public API
// ============================================================

/**
 * Fetches candles for an entire watchlist on a given timeframe.
 * Batches stock and crypto symbols into separate Alpaca API calls.
 * Caches aggressively to minimize API usage.
 */
export async function fetchWatchlist(
  symbols: string[],
  timeframe: "1D" | "4H",
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  const now = Date.now();
  const ttl = CACHE_TTL_MS[timeframe] ?? CACHE_TTL_MS["4H"];

  // Separate cached vs uncached
  const uncachedStocks: string[] = [];
  const uncachedCrypto: string[] = [];

  for (const symbol of symbols) {
    const key = getCacheKey(symbol, timeframe);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      results.set(symbol, cached.candles);
    } else if (isCryptoSymbol(symbol)) {
      uncachedCrypto.push(symbol);
    } else {
      uncachedStocks.push(symbol);
    }
  }

  if (uncachedStocks.length === 0 && uncachedCrypto.length === 0) {
    return results;
  }

  const { key, secret } = getAlpacaKeys();

  // Fetch stocks and crypto in parallel (batched — one call per asset class)
  const [stockBars, cryptoBars] = await Promise.allSettled([
    uncachedStocks.length > 0
      ? fetchStockBars(uncachedStocks, timeframe, key, secret)
      : Promise.resolve(new Map<string, Candle[]>()),
    uncachedCrypto.length > 0
      ? fetchCryptoBars(uncachedCrypto, timeframe, key, secret)
      : Promise.resolve(new Map<string, Candle[]>()),
  ]);

  // Process stock results
  if (stockBars.status === "fulfilled") {
    for (const [sym, candles] of stockBars.value) {
      results.set(sym, candles);
      cache.set(getCacheKey(sym, timeframe), {
        candles,
        expiresAt: Date.now() + ttl,
      });
      console.log(
        `[MarketData] Alpaca: ${sym} ${timeframe} → ${candles.length} candles`,
      );
    }
    // Log symbols that returned no data
    for (const sym of uncachedStocks) {
      if (!stockBars.value.has(sym)) {
        console.warn(`[MarketData] No Alpaca data for ${sym} ${timeframe}`);
      }
    }
  } else {
    console.error(
      `[MarketData] Alpaca stock bars fetch failed:`,
      stockBars.reason,
    );
  }

  // Process crypto results
  if (cryptoBars.status === "fulfilled") {
    for (const [sym, candles] of cryptoBars.value) {
      results.set(sym, candles);
      cache.set(getCacheKey(sym, timeframe), {
        candles,
        expiresAt: Date.now() + ttl,
      });
      console.log(
        `[MarketData] Alpaca: ${sym} ${timeframe} → ${candles.length} candles`,
      );
    }
    for (const sym of uncachedCrypto) {
      if (!cryptoBars.value.has(sym)) {
        console.warn(`[MarketData] No Alpaca data for ${sym} ${timeframe}`);
      }
    }
  } else {
    console.error(
      `[MarketData] Alpaca crypto bars fetch failed:`,
      cryptoBars.reason,
    );
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
 * Returns the most recent close price for a symbol from the candle cache.
 * Checks 4H first (fresher, 5-min TTL), then falls back to 1D.
 * Returns null if no cached data exists.
 */
export function getLatestCachedPrice(symbol: string): number | null {
  const now = Date.now();

  // Prefer 4H data (5-min TTL, most recent)
  const key4h = getCacheKey(symbol, "4H");
  const cached4h = cache.get(key4h);
  if (cached4h && cached4h.expiresAt > now && cached4h.candles.length > 0) {
    return cached4h.candles[cached4h.candles.length - 1].close;
  }

  // Fall back to 1D data (2-hour TTL)
  const key1d = getCacheKey(symbol, "1D");
  const cached1d = cache.get(key1d);
  if (cached1d && cached1d.expiresAt > now && cached1d.candles.length > 0) {
    return cached1d.candles[cached1d.candles.length - 1].close;
  }

  return null;
}

/**
 * Returns current cache stats for monitoring/debugging.
 */
export function getCacheStats(): { entries: number; symbols: string[] } {
  const symbols = Array.from(cache.keys());
  return { entries: symbols.length, symbols };
}
