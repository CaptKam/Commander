/**
 * Alpaca Execution Engine — Phase 5
 * Takes validated Phase C signals and places live limit orders.
 *
 * CLAUDE.md Rule #1: All qty/price values pass through Anti-422 formatters.
 * CLAUDE.md Rule #4: Alpaca failures trigger Telegram alerts, never silent.
 */

import { formatAlpacaQty, formatAlpacaPrice } from "./utils/alpacaFormatters";
import { sendError } from "./utils/notifier";
import type { PhaseCSignal } from "./screener";

// ============================================================
// Environment — validated at call time, NOT import time.
// A missing key logs an error but does NOT crash the process.
// ============================================================
let ALPACA_API_KEY = process.env.ALPACA_API_KEY;
let ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;
const rawAlpacaBase =
  process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
const ALPACA_BASE_URL = rawAlpacaBase.replace(/\/v2\/?$/, "");

// ============================================================
// Position sizing defaults (overridden by DB system_settings)
// ============================================================
const DEFAULT_CRYPTO_ALLOCATION = 0.07;
const DEFAULT_EQUITY_ALLOCATION = 0.05;

// ============================================================
// Alpaca API types
// ============================================================
interface AlpacaOrderPayload {
  symbol: string;
  qty: string;
  side: "buy" | "sell";
  type: "limit";
  time_in_force: "gtc";
  limit_price: string;
}

interface AlpacaOrderResponse {
  id: string;
  client_order_id: string;
  status: string;
  symbol: string;
  qty: string;
  filled_qty: string;
  side: string;
  type: string;
  limit_price: string;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Fetches current account equity from Alpaca.
 */
export async function getAccountEquity(): Promise<number> {
  assertKeysPresent();

  const res = await fetch(`${ALPACA_BASE_URL}/v2/account`, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_API_KEY!,
      "APCA-API-SECRET-KEY": ALPACA_API_SECRET!,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca account fetch failed: ${res.status} — ${body}`);
  }

  const account = (await res.json()) as { equity: string };
  const equity = Number(account.equity);

  if (!Number.isFinite(equity) || equity <= 0) {
    throw new Error(
      `Alpaca account equity is invalid: ${account.equity}`,
    );
  }

  return equity;
}

/**
 * Places a Phase C limit order on Alpaca.
 *
 * Flow:
 *   1. Calculate position size (7% crypto / 5% equity)
 *   2. Compute raw qty from allocated funds and limit price
 *   3. Format qty and price through Anti-422 sanitizers
 *   4. POST to Alpaca /v2/orders
 *   5. On failure: fire Discord alert, then re-throw
 */
export async function placePhaseCLimitOrder(
  signal: PhaseCSignal,
  accountEquity: number,
  isCrypto: boolean,
  allocationOverride?: { equity: number; crypto: number },
): Promise<AlpacaOrderResponse> {
  assertKeysPresent();

  // ---- Step 1: Position sizing (uses DB settings if provided) ----
  const equityAlloc = allocationOverride?.equity ?? DEFAULT_EQUITY_ALLOCATION;
  const cryptoAlloc = allocationOverride?.crypto ?? DEFAULT_CRYPTO_ALLOCATION;
  const allocation = isCrypto ? cryptoAlloc : equityAlloc;
  const allocatedFunds = accountEquity * allocation;

  // ---- Step 2: Raw quantity ----
  const rawQty = allocatedFunds / signal.limitPrice;

  // ---- Step 3: Anti-422 formatting (CLAUDE.md Rule #1) ----
  const safeQty = formatAlpacaQty(rawQty, isCrypto);
  const safePrice = formatAlpacaPrice(signal.limitPrice, isCrypto);

  // ---- Step 4: Build and send order ----
  const side: "buy" | "sell" = signal.direction === "long" ? "buy" : "sell";

  const payload: AlpacaOrderPayload = {
    symbol: signal.symbol,
    qty: String(safeQty),
    side,
    type: "limit",
    time_in_force: "gtc",
    limit_price: String(safePrice),
  };

  console.log(
    `[Alpaca] Placing ${side} limit order: ${signal.symbol} ` +
      `qty=${safeQty} price=${safePrice} ` +
      `(${(allocation * 100).toFixed(0)}% of $${accountEquity.toFixed(2)})`,
  );

  try {
    const res = await fetch(`${ALPACA_BASE_URL}/v2/orders`, {
      method: "POST",
      headers: {
        "APCA-API-KEY-ID": ALPACA_API_KEY!,
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      const err = new Error(
        `Alpaca order rejected: ${res.status} — ${body}`,
      );
      // Fire Telegram alert so your phone knows immediately
      await sendError(
        `Alpaca Limit Order Failed: ${signal.symbol} ${signal.pattern} ${side}`,
        err,
      );
      throw err;
    }

    const order = (await res.json()) as AlpacaOrderResponse;
    console.log(
      `[Alpaca] Order accepted: ${order.id} status=${order.status}`,
    );
    return order;
  } catch (err) {
    // Catch network errors (not just HTTP errors handled above)
    if (
      !(
        err instanceof Error &&
        err.message.startsWith("Alpaca order rejected")
      )
    ) {
      await sendError(
        `Alpaca Limit Order Failed (network): ${signal.symbol} ${signal.pattern} ${side}`,
        err,
      );
    }
    throw err;
  }
}

/**
 * Re-reads API keys from process.env and throws if missing.
 * Must be called at the start of every public function so keys
 * set after module load (e.g. late dotenv init) are picked up.
 */
function assertKeysPresent(): void {
  ALPACA_API_KEY = process.env.ALPACA_API_KEY;
  ALPACA_API_SECRET = process.env.ALPACA_API_SECRET;
  if (!ALPACA_API_KEY || !ALPACA_API_SECRET) {
    throw new Error(
      "[Alpaca] ALPACA_API_KEY and ALPACA_API_SECRET must be set in .env",
    );
  }
}
