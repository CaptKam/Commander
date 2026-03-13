/**
 * Market Data Ingestion & Caching Layer — Phase 10 (Batched Alpaca)
 *
 * Uses Alpaca's multi-symbol batch endpoints to fetch candles for the
 * entire watchlist in 1-2 API calls instead of N sequential ones.
 *
 * Batch endpoints:
 *   - Stocks:  GET https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL,TSLA,...
 *   - Crypto:  GET https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=BTC/USD,...
 *
 * Cache TTLs (tightened for faster reaction):
 *   - "1D" candles: 1 hour  (daily bars are stable but refresh hourly)
 *   - "4H" candles: 1 minute (need near-real-time data for forming patterns)
 *
 * Payload reduction:
 *   - "1D" lookback: 90 days (was 365)
 *   - "4H" lookback: 15 days (was 60)
 *
 * NOTE: This in-memory cache is strictly for API rate-limiting. It does
 * NOT store trade state, so it complies with CLAUDE.md Rule #2.
 */

// ============================================================
// Environment
// ============================================================
let ALPACA_API_KEY = process.env.ALPACA_API_KEY;
let ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;

function assertMarketDataKeys(): void {
  ALPACA_API_KEY = process.env.ALPACA_API_KEY;
  ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;
  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    throw new Error(
      "[MarketData] ALPACA_API_KEY and ALPACA_API_SECRET must be set in .env",
    );
  }
}

function marketDataHeaders(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": ALPACA_API_KEY!,
    "APCA-API-SECRET-KEY": ALPACA_API_SECRET!,
  };
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
// Alpaca Market Data endpoints
// ============================================================
const STOCK_DATA_BASE = "https://data.alpaca.markets/v2";
const CRYPTO_DATA_BASE = "https://data.alpaca.markets/v1beta3/crypto/us";

/** Max symbols per batch request to stay under URL length limits. */
const BATCH_CHUNK_SIZE = 40;

function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes("/");
}

function alpacaTimeframe(timeframe: "1D" | "4H"): string {
  return timeframe === "1D" ? "1Day" : "4Hour";
}

/**
 * Returns a start date with reduced lookback for smaller payloads.
 *   1D → 90 days  (~90 bars, plenty for pivot detection)
 *   4H → 15 days  (~6 bars/day × 15 = 90 bars)
 */
function getStartDate(timeframe: "1D" | "4H"): string {
  const now = new Date();
  if (timeframe === "1D") {
    now.setDate(now.getDate() - 90);
  } else {
    now.setDate(now.getDate() - 15);
  }
  return now.toISOString().split(".")[0] + "Z";
}

// ============================================================
// Bar normalization — handles both batch and single responses
// ============================================================
function parseRawBars(rawBars: any[]): Candle[] {
  return rawBars
    .map((bar: any) => ({
      timestamp: new Date(bar.t).getTime(),
      open: Number(bar.o),
      high: Number(bar.h),
      low: Number(bar.l),
      close: Number(bar.c),
      volume: Number(bar.v),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ============================================================
// Batch fetcher — fetches multiple symbols in a single request
// ============================================================

/**
 * Fetches bars for multiple stock symbols in one Alpaca request.
 * Handles pagination automatically.
 */
async function fetchStockBatch(
  symbols: string[],
  timeframe: "1D" | "4H",
  headers: Record<string, string>,
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  const tf = alpacaTimeframe(timeframe);
  const start = getStartDate(timeframe);

  const baseUrl =
    `${STOCK_DATA_BASE}/stocks/bars` +
    `?symbols=${symbols.join(",")}` +
    `&timeframe=${tf}&start=${start}&limit=1000&feed=iex`;

  let nextUrl: string | null = baseUrl;

  while (nextUrl) {
    const res = await fetch(nextUrl, { headers });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[MarketData] Stock batch error: ${res.status} — ${body}`);
      break;
    }

    const json = await res.json();

    // Batch response: { "bars": { "AAPL": [...], "TSLA": [...] }, "next_page_token": ... }
    if (json.bars && typeof json.bars === "object") {
      for (const [sym, bars] of Object.entries(json.bars)) {
        if (!Array.isArray(bars)) continue;
        const existing = results.get(sym) ?? [];
        existing.push(...parseRawBars(bars));
        results.set(sym, existing);
      }
    }

    if (json.next_page_token) {
      nextUrl = `${baseUrl}&page_token=${json.next_page_token}`;
    } else {
      nextUrl = null;
    }
  }

  return results;
}

/**
 * Fetches bars for multiple crypto symbols in one Alpaca request.
 * Handles pagination automatically.
 */
async function fetchCryptoBatch(
  symbols: string[],
  timeframe: "1D" | "4H",
  headers: Record<string, string>,
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  const tf = alpacaTimeframe(timeframe);
  const start = getStartDate(timeframe);

  const encodedSymbols = symbols.map((s) => encodeURIComponent(s)).join(",");
  const baseUrl =
    `${CRYPTO_DATA_BASE}/bars` +
    `?symbols=${encodedSymbols}` +
    `&timeframe=${tf}&start=${start}&limit=1000`;

  let nextUrl: string | null = baseUrl;

  while (nextUrl) {
    const res = await fetch(nextUrl, { headers });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[MarketData] Crypto batch error: ${res.status} — ${body}`);
      break;
    }

    const json = await res.json();

    // Batch response: { "bars": { "BTC/USD": [...], "ETH/USD": [...] }, "next_page_token": ... }
    if (json.bars && typeof json.bars === "object") {
      for (const [sym, bars] of Object.entries(json.bars)) {
        if (!Array.isArray(bars)) continue;
        const existing = results.get(sym) ?? [];
        existing.push(...parseRawBars(bars));
        results.set(sym, existing);
      }
    }

    if (json.next_page_token) {
      nextUrl = `${baseUrl}&page_token=${json.next_page_token}`;
    } else {
      nextUrl = null;
    }
  }

  return results;
}

/**
 * Splits an array into chunks of the given size.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ============================================================
// Public API
// ============================================================

/**
 * Fetches candles for an entire watchlist on a given timeframe.
 * Uses batch endpoints — typically 1-2 API calls for the whole list.
 */
export async function fetchWatchlist(
  symbols: string[],
  timeframe: "1D" | "4H",
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  const now = Date.now();

  // ---- Separate cached vs uncached symbols ----
  const missingStocks: string[] = [];
  const missingCrypto: string[] = [];

  for (const symbol of symbols) {
    const key = getCacheKey(symbol, timeframe);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      results.set(symbol, cached.candles);
    } else if (isCryptoSymbol(symbol)) {
      missingCrypto.push(symbol);
    } else {
      missingStocks.push(symbol);
    }
  }

  if (missingStocks.length === 0 && missingCrypto.length === 0) {
    return results;
  }

  // ---- Fetch uncached symbols in batches ----
  assertMarketDataKeys();
  const headers = marketDataHeaders();
  const ttl = CACHE_TTL_MS[timeframe] ?? CACHE_TTL_MS["4H"];

  // Stock batches
  for (const stockChunk of chunk(missingStocks, BATCH_CHUNK_SIZE)) {
    try {
      const batchResult = await fetchStockBatch(stockChunk, timeframe, headers);
      for (const [sym, candles] of batchResult) {
        candles.sort((a, b) => a.timestamp - b.timestamp);
        results.set(sym, candles);
        cache.set(getCacheKey(sym, timeframe), {
          candles,
          expiresAt: Date.now() + ttl,
        });
      }
      // Log symbols that returned no data
      for (const sym of stockChunk) {
        if (!batchResult.has(sym)) {
          console.warn(`[MarketData] No data for ${sym} ${timeframe}`);
        }
      }
    } catch (err) {
      console.error(
        `[MarketData] Stock batch failed for [${stockChunk.join(",")}]:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Crypto batches
  for (const cryptoChunk of chunk(missingCrypto, BATCH_CHUNK_SIZE)) {
    try {
      const batchResult = await fetchCryptoBatch(cryptoChunk, timeframe, headers);
      for (const [sym, candles] of batchResult) {
        candles.sort((a, b) => a.timestamp - b.timestamp);
        results.set(sym, candles);
        cache.set(getCacheKey(sym, timeframe), {
          candles,
          expiresAt: Date.now() + ttl,
        });
      }
      for (const sym of cryptoChunk) {
        if (!batchResult.has(sym)) {
          console.warn(`[MarketData] No data for ${sym} ${timeframe}`);
        }
      }
    } catch (err) {
      console.error(
        `[MarketData] Crypto batch failed for [${cryptoChunk.join(",")}]:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return results;
}

/**
 * Fetches candles for a single symbol (uses cache, falls through to batch of 1).
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
