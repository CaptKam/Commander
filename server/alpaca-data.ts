/**
 * Market Data Ingestion & Caching Layer — Alpaca
 *
 * Replaces FMP as the primary market data source.
 * Alpaca provides both stock and crypto bars through a single API:
 *   - Stocks: GET https://data.alpaca.markets/v2/stocks/bars?symbols=...
 *   - Crypto: GET https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=...
 *
 * Advantages over FMP free tier:
 *   - Full 1D data coverage for all symbols
 *   - No missing symbols (SOL/USD, LINK/USD all available)
 *   - Already authenticated (same keys used for trading)
 *
 * Cache TTLs:
 *   - "1D" candles: 1 hour
 *   - "4H" candles: 1 minute
 *
 * NOTE: This in-memory cache is strictly for API rate-limiting. It does
 * NOT store trade state, so it complies with CLAUDE.md Rule #2.
 */

// ============================================================
// Types (same interface as fmp.ts for drop-in compatibility)
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
// Cache configuration
// ============================================================
const CACHE_TTL_MS: Record<string, number> = {
  "1D": 60 * 60 * 1000, // 1 hour
  "4H": 60 * 1000, // 1 minute
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
    start.setDate(start.getDate() - 90);
  } else {
    start.setDate(start.getDate() - 15);
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
// Stock bars fetcher (batched — up to 200 symbols per request)
// ============================================================
async function fetchStockBars(
  symbols: string[],
  timeframe: "1D" | "4H",
  key: string,
  secret: string,
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  if (symbols.length === 0) return results;

  const { start, end } = getDateRange(timeframe);
  const alpacaTf = toAlpacaTimeframe(timeframe);

  const url =
    `${ALPACA_DATA_BASE}/v2/stocks/bars` +
    `?symbols=${symbols.map(encodeURIComponent).join(",")}` +
    `&timeframe=${alpacaTf}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}` +
    `&limit=10000` +
    `&adjustment=split` +
    `&feed=sip`;

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
    for (const [sym, bars] of Object.entries(json.bars)) {
      const candles = bars
        .map(barToCandle)
        .filter((c) => c.open > 0 && c.high > 0)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (candles.length > 0) {
        results.set(sym, candles);
      }
    }
  }

  return results;
}

// ============================================================
// Crypto bars fetcher (batched)
// ============================================================
async function fetchCryptoBars(
  symbols: string[],
  timeframe: "1D" | "4H",
  key: string,
  secret: string,
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();
  if (symbols.length === 0) return results;

  const { start, end } = getDateRange(timeframe);
  const alpacaTf = toAlpacaTimeframe(timeframe);

  // Alpaca crypto uses slash format natively (BTC/USD) — no conversion needed
  const url =
    `${ALPACA_DATA_BASE}/v1beta3/crypto/us/bars` +
    `?symbols=${symbols.map(encodeURIComponent).join(",")}` +
    `&timeframe=${alpacaTf}` +
    `&start=${encodeURIComponent(start)}` +
    `&end=${encodeURIComponent(end)}` +
    `&limit=10000`;

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
    for (const [sym, bars] of Object.entries(json.bars)) {
      const candles = bars
        .map(barToCandle)
        .filter((c) => c.open > 0 && c.high > 0)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (candles.length > 0) {
        results.set(sym, candles);
      }
    }
  }

  return results;
}

// ============================================================
// Public API (same signature as fmp.ts for drop-in swap)
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
 * Returns current cache stats for monitoring/debugging.
 */
export function getCacheStats(): { entries: number; symbols: string[] } {
  const symbols = Array.from(cache.keys());
  return { entries: symbols.length, symbols };
}
