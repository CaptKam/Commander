/**
 * Real-Time Price Streaming — Alpaca WebSocket
 *
 * Opens persistent WebSocket connections for instant price updates:
 *   - Crypto: wss://stream.data.alpaca.markets/v1beta3/crypto/us
 *   - Stocks: wss://stream.data.alpaca.markets/v2/sip
 *
 * Replaces polling-based price checks with real-time streaming.
 * The crypto-monitor and exit-manager read from the shared price
 * cache instead of making REST calls every 30 seconds.
 *
 * Auto-reconnects with exponential backoff on disconnection.
 * Heartbeat ping every 30s to keep connections alive.
 *
 * NOTE: The price cache is ephemeral (in-memory). It does NOT store
 * trade state — complies with CLAUDE.md Rule #2.
 */

import WebSocket from "ws";

// ============================================================
// Shared price cache — latest trade price per symbol
// ============================================================
const latestPrices = new Map<string, { price: number; timestamp: number }>();

/**
 * Gets the latest streamed price for a symbol.
 * Returns null if no price has been received yet.
 */
export function getStreamPrice(symbol: string): number | null {
  // Try exact match first, then normalized (no slash)
  const entry = latestPrices.get(symbol)
    ?? latestPrices.get(symbol.replace(/\//g, ""));
  return entry?.price ?? null;
}

/**
 * Returns all currently tracked prices (for debugging/dashboard).
 */
export function getAllStreamPrices(): Map<string, { price: number; timestamp: number }> {
  return new Map(latestPrices);
}

// ============================================================
// Environment
// ============================================================
function getAlpacaKeys(): { key: string; secret: string } {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) {
    throw new Error("[WebSocket] ALPACA_API_KEY and ALPACA_API_SECRET must be set");
  }
  return { key, secret };
}

// ============================================================
// WebSocket URLs
// ============================================================
const CRYPTO_WS_URL = "wss://stream.data.alpaca.markets/v1beta3/crypto/us";
const STOCK_WS_URL = "wss://stream.data.alpaca.markets/v2/sip";

// ============================================================
// Reconnection config
// ============================================================
const INITIAL_RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

// ============================================================
// Connection state
// ============================================================
let cryptoWs: WebSocket | null = null;
let stockWs: WebSocket | null = null;
let cryptoReconnectMs = INITIAL_RECONNECT_MS;
let stockReconnectMs = INITIAL_RECONNECT_MS;
let cryptoHeartbeat: ReturnType<typeof setInterval> | null = null;
let stockHeartbeat: ReturnType<typeof setInterval> | null = null;
let cryptoSymbols: string[] = [];
let stockSymbols: string[] = [];

// ============================================================
// Alpaca WebSocket message types
// ============================================================
interface AlpacaTrade {
  T: "t";   // Trade
  S: string; // Symbol
  p: number; // Price
  s: number; // Size
  t: string; // Timestamp
}

interface AlpacaMessage {
  T: string;
  S?: string;
  p?: number;
  msg?: string;
  code?: number;
}

// ============================================================
// Generic WebSocket connection factory
// ============================================================
function createStream(
  url: string,
  label: string,
  symbols: string[],
  getReconnectMs: () => number,
  setReconnectMs: (ms: number) => void,
  setWs: (ws: WebSocket | null) => void,
  setHeartbeat: (id: ReturnType<typeof setInterval> | null) => void,
  getHeartbeat: () => ReturnType<typeof setInterval> | null,
): void {
  if (symbols.length === 0) {
    console.log(`[WebSocket] ${label}: no symbols to subscribe — skipping`);
    return;
  }

  const { key, secret } = getAlpacaKeys();

  console.log(`[WebSocket] ${label}: connecting to ${url}`);
  const ws = new WebSocket(url);
  setWs(ws);

  ws.on("open", () => {
    console.log(`[WebSocket] ${label}: connected`);
    setReconnectMs(INITIAL_RECONNECT_MS);

    // Authenticate
    ws.send(JSON.stringify({
      action: "auth",
      key,
      secret,
    }));
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const messages = JSON.parse(data.toString()) as AlpacaMessage[];

      for (const msg of messages) {
        // Auth success → subscribe to trades
        if (msg.T === "success" && msg.msg === "authenticated") {
          console.log(`[WebSocket] ${label}: authenticated — subscribing to ${symbols.length} symbols`);
          ws.send(JSON.stringify({
            action: "subscribe",
            trades: symbols,
          }));
          continue;
        }

        // Subscription confirmed
        if (msg.T === "subscription") {
          console.log(`[WebSocket] ${label}: subscribed`);
          continue;
        }

        // Trade update — update price cache
        if (msg.T === "t" && msg.S && msg.p) {
          latestPrices.set(msg.S, {
            price: msg.p,
            timestamp: Date.now(),
          });
        }

        // Auth error
        if (msg.T === "error") {
          console.error(`[WebSocket] ${label}: error — code=${msg.code} msg=${msg.msg}`);
        }
      }
    } catch (err) {
      console.error(`[WebSocket] ${label}: failed to parse message:`, err);
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    console.warn(
      `[WebSocket] ${label}: disconnected (code=${code} reason=${reason.toString()}) — ` +
      `reconnecting in ${getReconnectMs() / 1000}s`,
    );
    setWs(null);
    clearHeartbeat(getHeartbeat, setHeartbeat);

    // Reconnect with exponential backoff
    setTimeout(() => {
      const nextMs = Math.min(getReconnectMs() * 2, MAX_RECONNECT_MS);
      setReconnectMs(nextMs);
      createStream(url, label, symbols, getReconnectMs, setReconnectMs, setWs, setHeartbeat, getHeartbeat);
    }, getReconnectMs());
  });

  ws.on("error", (err: Error) => {
    console.error(`[WebSocket] ${label}: error —`, err.message);
    // The "close" handler will fire after this and handle reconnection
  });

  // Heartbeat ping to keep connection alive
  clearHeartbeat(getHeartbeat, setHeartbeat);
  const hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  setHeartbeat(hb);
}

function clearHeartbeat(
  getHeartbeat: () => ReturnType<typeof setInterval> | null,
  setHeartbeat: (id: ReturnType<typeof setInterval> | null) => void,
): void {
  const hb = getHeartbeat();
  if (hb) {
    clearInterval(hb);
    setHeartbeat(null);
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Starts both crypto and stock WebSocket streams.
 * Call once at boot after loading the watchlist from DB.
 *
 * @param watchlist  Array of symbols (e.g., ["BTC/USD", "AAPL"])
 */
export function startPriceStreams(watchlist: string[]): void {
  cryptoSymbols = watchlist.filter((s) => s.includes("/"));
  stockSymbols = watchlist.filter((s) => !s.includes("/"));

  console.log(
    `[WebSocket] Starting streams: ${cryptoSymbols.length} crypto, ${stockSymbols.length} stocks`,
  );

  // Crypto stream
  createStream(
    CRYPTO_WS_URL,
    "Crypto",
    cryptoSymbols,
    () => cryptoReconnectMs,
    (ms) => { cryptoReconnectMs = ms; },
    (ws) => { cryptoWs = ws; },
    (hb) => { cryptoHeartbeat = hb; },
    () => cryptoHeartbeat,
  );

  // Stock stream (SIP)
  createStream(
    STOCK_WS_URL,
    "Stock/SIP",
    stockSymbols,
    () => stockReconnectMs,
    (ms) => { stockReconnectMs = ms; },
    (ws) => { stockWs = ws; },
    (hb) => { stockHeartbeat = hb; },
    () => stockHeartbeat,
  );
}

/**
 * Gracefully closes both WebSocket connections.
 */
export function stopPriceStreams(): void {
  if (cryptoWs) {
    cryptoWs.close();
    cryptoWs = null;
  }
  if (stockWs) {
    stockWs.close();
    stockWs = null;
  }
  clearHeartbeat(() => cryptoHeartbeat, (hb) => { cryptoHeartbeat = hb; });
  clearHeartbeat(() => stockHeartbeat, (hb) => { stockHeartbeat = hb; });
  console.log("[WebSocket] All streams stopped");
}

/**
 * Returns connection status for monitoring.
 */
export function getStreamStatus(): { crypto: string; stock: string; priceCount: number } {
  const wsState = (ws: WebSocket | null): string => {
    if (!ws) return "disconnected";
    switch (ws.readyState) {
      case WebSocket.CONNECTING: return "connecting";
      case WebSocket.OPEN: return "connected";
      case WebSocket.CLOSING: return "closing";
      case WebSocket.CLOSED: return "closed";
      default: return "unknown";
    }
  };
  return {
    crypto: wsState(cryptoWs),
    stock: wsState(stockWs),
    priceCount: latestPrices.size,
  };
}
