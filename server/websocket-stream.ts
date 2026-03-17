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
 * SIP stream only connects during market hours (Mon-Fri 4AM-8PM ET).
 * Crypto stream runs 24/7.
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

// Shared backoff steps — longer waits to let Alpaca release phantom connections from restarts
const BACKOFF_STEPS = [15_000, 30_000, 60_000, 120_000, 300_000];
const MAX_CONSECUTIVE_FAILURES = 5;
// If a connection survives this long, reset the failure counter
const STABLE_CONNECTION_MS = 30_000;

// SIP market hours check interval (check every 5 minutes when suspended)
const SIP_MARKET_CHECK_INTERVAL_MS = 5 * 60 * 1000;

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

// SIP-specific state
let sipConsecutiveFailures = 0;
let sipSuspended = false;
let sipMarketCheckTimer: ReturnType<typeof setInterval> | null = null;
let sipReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sipConnectionOpenedAt = 0;

// Crypto-specific state
let cryptoConsecutiveFailures = 0;
let cryptoSuspended = false;
let cryptoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let cryptoConnectionOpenedAt = 0;
// Crypto resumes after suspension cooldown (5 min) instead of market hours
const CRYPTO_SUSPEND_COOLDOWN_MS = 5 * 60 * 1000;

// ============================================================
// SIP Market Hours — Mon-Fri 4:00 AM to 8:00 PM Eastern
// ============================================================
function isSipMarketHours(): boolean {
  const now = new Date();
  // Convert to Eastern Time
  const eastern = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = eastern.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;

  const hour = eastern.getHours();
  // 4:00 AM (hour=4) to 8:00 PM (hour=20, i.e. < 20)
  return hour >= 4 && hour < 20;
}

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
// Force-close a WebSocket — ensures no stale connections
// ============================================================
function forceCloseWs(ws: WebSocket | null): void {
  if (!ws) return;
  try {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws.terminate();
  } catch {
    // Swallow — we just want it dead
  }
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
  getWs: () => WebSocket | null,
  setHeartbeat: (id: ReturnType<typeof setInterval> | null) => void,
  getHeartbeat: () => ReturnType<typeof setInterval> | null,
): void {
  if (symbols.length === 0) {
    console.log(`[WebSocket] ${label}: no symbols to subscribe — skipping`);
    return;
  }

  const isSip = label === "Stock/SIP";
  const isCrypto = label === "Crypto";

  // --- SIP-specific guards ---
  if (isSip) {
    if (!isSipMarketHours()) {
      console.log(`[WebSocket] ${label}: market closed — skipping connection. Will retry at next market open.`);
      scheduleSipMarketCheck();
      return;
    }
    if (sipSuspended) {
      console.log(`[WebSocket] ${label}: reconnect suspended — waiting for next market open`);
      scheduleSipMarketCheck();
      return;
    }
    if (sipReconnectTimer) {
      clearTimeout(sipReconnectTimer);
      sipReconnectTimer = null;
    }
  }

  // --- Crypto-specific guards ---
  if (isCrypto) {
    if (cryptoSuspended) {
      console.log(`[WebSocket] ${label}: reconnect suspended — will retry in ${CRYPTO_SUSPEND_COOLDOWN_MS / 1000}s`);
      return;
    }
    if (cryptoReconnectTimer) {
      clearTimeout(cryptoReconnectTimer);
      cryptoReconnectTimer = null;
    }
  }

  // --- Cleanup existing connection before opening new one (both streams) ---
  const existingWs = getWs();
  if (existingWs) {
    console.log(`[WebSocket] ${label}: closing existing connection before reconnect`);
    forceCloseWs(existingWs);
    setWs(null);
  }

  const { key, secret } = getAlpacaKeys();

  console.log(`[WebSocket] ${label}: connecting to ${url}`);
  const ws = new WebSocket(url);
  setWs(ws);

  ws.on("open", () => {
    console.log(`[WebSocket] ${label}: connected`);
    setReconnectMs(INITIAL_RECONNECT_MS);

    if (isSip) {
      sipConnectionOpenedAt = Date.now();
    }
    if (isCrypto) {
      cryptoConnectionOpenedAt = Date.now();
    }

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

        // Auth/connection error
        if (msg.T === "error") {
          console.error(`[WebSocket] ${label}: error — code=${msg.code} msg=${msg.msg}`);
        }
      }
    } catch (err) {
      console.error(`[WebSocket] ${label}: failed to parse message:`, err);
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    setWs(null);
    clearHeartbeat(getHeartbeat, setHeartbeat);

    if (isSip) {
      // Check if this connection was stable (survived > 30s)
      const connectionDuration = Date.now() - sipConnectionOpenedAt;
      if (sipConnectionOpenedAt > 0 && connectionDuration > STABLE_CONNECTION_MS) {
        sipConsecutiveFailures = 0;
      } else {
        sipConsecutiveFailures++;
      }

      // If market is now closed, don't reconnect
      if (!isSipMarketHours()) {
        console.log(`[WebSocket] ${label}: disconnected (code=${code}) — market closed, not reconnecting`);
        scheduleSipMarketCheck();
        return;
      }

      // If too many consecutive failures, suspend
      if (sipConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        sipSuspended = true;
        console.error(
          `[WebSocket] SIP reconnect suspended — ${sipConsecutiveFailures} consecutive failures. ` +
          `Will retry at next market open.`,
        );
        scheduleSipMarketCheck();
        return;
      }

      // Exponential backoff: 2s, 5s, 10s, 30s, 60s
      const backoffIdx = Math.min(sipConsecutiveFailures, BACKOFF_STEPS.length - 1);
      const delayMs = BACKOFF_STEPS[backoffIdx];

      console.warn(
        `[WebSocket] ${label}: disconnected (code=${code} reason=${reason.toString()}) — ` +
        `reconnecting in ${delayMs / 1000}s (failure ${sipConsecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
      );

      sipReconnectTimer = setTimeout(() => {
        sipReconnectTimer = null;
        createStream(url, label, symbols, getReconnectMs, setReconnectMs, setWs, getWs, setHeartbeat, getHeartbeat);
      }, delayMs);
    } else if (isCrypto) {
      // Check if this connection was stable (survived > 30s)
      const connectionDuration = Date.now() - cryptoConnectionOpenedAt;
      if (cryptoConnectionOpenedAt > 0 && connectionDuration > STABLE_CONNECTION_MS) {
        cryptoConsecutiveFailures = 0;
      } else {
        cryptoConsecutiveFailures++;
      }

      // If too many consecutive failures, suspend and schedule cooldown
      if (cryptoConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        cryptoSuspended = true;
        console.error(
          `[WebSocket] Crypto reconnect suspended — ${cryptoConsecutiveFailures} consecutive failures. ` +
          `Will retry in ${CRYPTO_SUSPEND_COOLDOWN_MS / 1000}s.`,
        );
        setTimeout(() => {
          cryptoSuspended = false;
          cryptoConsecutiveFailures = 0;
          console.log("[WebSocket] Crypto: suspension cooldown expired — attempting connection");
          createStream(url, label, symbols, getReconnectMs, setReconnectMs, setWs, getWs, setHeartbeat, getHeartbeat);
        }, CRYPTO_SUSPEND_COOLDOWN_MS);
        return;
      }

      // Exponential backoff: 2s, 5s, 10s, 30s, 60s
      const backoffIdx = Math.min(cryptoConsecutiveFailures, BACKOFF_STEPS.length - 1);
      const delayMs = BACKOFF_STEPS[backoffIdx];

      console.warn(
        `[WebSocket] ${label}: disconnected (code=${code} reason=${reason.toString()}) — ` +
        `reconnecting in ${delayMs / 1000}s (failure ${cryptoConsecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
      );

      cryptoReconnectTimer = setTimeout(() => {
        cryptoReconnectTimer = null;
        createStream(url, label, symbols, getReconnectMs, setReconnectMs, setWs, getWs, setHeartbeat, getHeartbeat);
      }, delayMs);
    }
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
// SIP market hours poller — checks periodically and reconnects
// when market opens again
// ============================================================
function scheduleSipMarketCheck(): void {
  // Don't stack multiple timers
  if (sipMarketCheckTimer) return;

  sipMarketCheckTimer = setInterval(() => {
    if (isSipMarketHours() && stockSymbols.length > 0) {
      console.log("[WebSocket] Stock/SIP: market is open — attempting connection");
      // Clear the check timer
      if (sipMarketCheckTimer) {
        clearInterval(sipMarketCheckTimer);
        sipMarketCheckTimer = null;
      }
      // Reset suspension state for new market session
      sipSuspended = false;
      sipConsecutiveFailures = 0;
      // Attempt connection
      createStream(
        STOCK_WS_URL,
        "Stock/SIP",
        stockSymbols,
        () => stockReconnectMs,
        (ms) => { stockReconnectMs = ms; },
        (ws) => { stockWs = ws; },
        () => stockWs,
        (hb) => { stockHeartbeat = hb; },
        () => stockHeartbeat,
      );
    }
  }, SIP_MARKET_CHECK_INTERVAL_MS);
}

// ============================================================
// Public API
// ============================================================

/**
 * Starts both crypto and stock WebSocket streams.
 * Call once at boot after loading the watchlist from DB.
 *
 * Crypto streams run 24/7. Stock/SIP streams only connect
 * during market hours (Mon-Fri 4:00 AM - 8:00 PM ET).
 *
 * @param watchlist  Array of symbols (e.g., ["BTC/USD", "AAPL"])
 */
export function startPriceStreams(watchlist: string[]): void {
  cryptoSymbols = watchlist.filter((s) => s.includes("/"));
  stockSymbols = watchlist.filter((s) => !s.includes("/"));

  console.log(
    `[WebSocket] Starting streams: ${cryptoSymbols.length} crypto, ${stockSymbols.length} stocks`,
  );

  // Delay initial connections to let Alpaca release stale phantom connections
  // from previous process restarts (Replit doesn't cleanly terminate WebSockets)
  console.log("[WebSocket] Waiting 10s for stale connections to expire...");

  // Crypto stream — always on (delayed 10s)
  setTimeout(() => {
    createStream(
      CRYPTO_WS_URL,
      "Crypto",
      cryptoSymbols,
      () => cryptoReconnectMs,
      (ms) => { cryptoReconnectMs = ms; },
      (ws) => { cryptoWs = ws; },
      () => cryptoWs,
      (hb) => { cryptoHeartbeat = hb; },
      () => cryptoHeartbeat,
    );
  }, 10_000);

  // Stock stream (SIP) — market hours only (delayed 12s, staggered after crypto)
  setTimeout(() => {
    createStream(
      STOCK_WS_URL,
      "Stock/SIP",
      stockSymbols,
      () => stockReconnectMs,
      (ms) => { stockReconnectMs = ms; },
      (ws) => { stockWs = ws; },
      () => stockWs,
      (hb) => { stockHeartbeat = hb; },
      () => stockHeartbeat,
    );
  }, 12_000);
}

/**
 * Gracefully closes both WebSocket connections.
 */
export function stopPriceStreams(): void {
  // Clear all reconnect timers
  if (sipReconnectTimer) {
    clearTimeout(sipReconnectTimer);
    sipReconnectTimer = null;
  }
  if (sipMarketCheckTimer) {
    clearInterval(sipMarketCheckTimer);
    sipMarketCheckTimer = null;
  }
  if (cryptoReconnectTimer) {
    clearTimeout(cryptoReconnectTimer);
    cryptoReconnectTimer = null;
  }

  forceCloseWs(cryptoWs);
  cryptoWs = null;
  forceCloseWs(stockWs);
  stockWs = null;

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
    crypto: cryptoSuspended ? "suspended" : wsState(cryptoWs),
    stock: sipSuspended ? "suspended" : wsState(stockWs),
    priceCount: latestPrices.size,
  };
}
