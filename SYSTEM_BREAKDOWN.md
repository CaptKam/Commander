# Pattern Bot v2 — Complete System Breakdown

## Table of Contents
1. [What This System Does](#what-this-system-does)
2. [Architecture Overview](#architecture-overview)
3. [The Scan Workflow (Step by Step)](#the-scan-workflow-step-by-step)
4. [What Are Harmonic Patterns?](#what-are-harmonic-patterns)
5. [Pattern Definitions & Fibonacci Ratios](#pattern-definitions--fibonacci-ratios)
6. [The 7-Rule Quality Filter](#the-7-rule-quality-filter)
7. [Order Execution Flow](#order-execution-flow)
8. [Exit Management Lifecycle](#exit-management-lifecycle)
9. [Data Storage (Database Schema)](#data-storage-database-schema)
10. [Market Data Pipeline](#market-data-pipeline)
11. [WebSocket Price Streaming](#websocket-price-streaming)
12. [Position Sizing & Risk Controls](#position-sizing--risk-controls)
13. [The Dashboard UI — Every Page & Button](#the-dashboard-ui--every-page--button)
14. [File Map](#file-map)
15. [System Rules (CLAUDE.md)](#system-rules-claudemd)
16. [Known Limitations](#known-limitations)

---

## What This System Does

Pattern Bot is a fully automated trading system that:

1. **Scans** 35 symbols (23 crypto + 12 equities) every 30 seconds
2. **Detects** XABCD harmonic patterns on 1-Day and 4-Hour timeframes
3. **Filters** candidates through 7 quality rules to eliminate low-probability setups
4. **Places** live limit orders on Alpaca's paper trading API when price approaches the D-point
5. **Manages** exits automatically with split TP1/TP2 targets and software stop-loss monitoring
6. **Displays** everything in a real-time "Commander" dashboard

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (Port 5000)                  │
│         React + Vite + Tailwind ("Commander v2")        │
│    Polls /api/* endpoints every few seconds for data    │
└──────────────────────┬──────────────────────────────────┘
                       │ Vite proxy /api → localhost:3000
┌──────────────────────▼──────────────────────────────────┐
│                    BACKEND (Port 3000)                   │
│                  Express + TypeScript                    │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Orchestrator │→ │   Patterns   │→ │   Screener    │  │
│  │  (30s loop)  │  │  (Harmonics) │  │ (Phase C)     │  │
│  └──────┬──────┘  └──────────────┘  └───────────────┘  │
│         │                                               │
│  ┌──────▼──────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   Quality   │→ │    Alpaca    │→ │ Exit Manager  │  │
│  │  Filters    │  │  (Execution) │  │ (TP/SL)       │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  WebSocket  │  │   Crypto     │  │   API Router  │  │
│  │  Streams    │  │   Monitor    │  │  (Dashboard)  │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │    PostgreSQL (Neon)    │
          │  live_signals table    │
          │  watchlist table       │
          │  system_settings table │
          └────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │     Alpaca APIs         │
          │  Paper Trading API     │
          │  Market Data API       │
          │  WebSocket Streams     │
          └────────────────────────┘
```

---

## The Scan Workflow (Step by Step)

Every 30 seconds, the orchestrator runs a complete scan cycle. Here is exactly what happens:

### Step 0: Load Settings
- Reads `system_settings` table from PostgreSQL
- Gets: `trading_enabled`, `equity_allocation` (default 5%), `crypto_allocation` (default 7%), `enabled_patterns` list

### Step 1: Determine What to Scan
- Loads all 35 symbols from the `watchlist` table
- Checks if US stock market is open (Mon-Fri 9:00 AM – 4:30 PM Eastern)
- **Market open**: Scans all 35 symbols (23 crypto + 12 equity)
- **Market closed**: Scans only 23 crypto symbols (crypto trades 24/7)
- **Post-close window (4:30-5:00 PM)**: One final daily candle scan for stocks, then stops until next open

### Step 2: Fetch Candle Data
- For each symbol, fetches historical OHLCV candles from Alpaca's Market Data API
- **1-Day timeframe**: 365 days of daily candles (1 year lookback)
- **4-Hour timeframe**: 90 days of 4-hour candles (3 month lookback)
- Data is cached in memory: 1D candles cached for 2 hours, 4H candles cached for 5 minutes
- Alpaca paginates results; the system follows up to 15 pages per request
- Rate limiter enforces 200 requests/minute (Alpaca free tier limit)

### Step 3: Detect Harmonic Patterns
For each symbol + timeframe combination, two detection modes run:

**Mode 1 — Forming Patterns (Phase C)**
- Find swing high/low pivots using 5-bar left + 5-bar right confirmation
- Take the most recent 40 pivots
- Try every consecutive group of 4 pivots (X, A, B, C) that alternate high/low
- For each group, test all 5 pattern definitions (Gartley, Bat, Alt Bat, Butterfly, ABCD)
- If XAB and ABC ratios match a pattern (within ±5% tolerance), project where D should complete
- Calculate entry price (projected D), TP1, TP2, and stop-loss
- Only include if D hasn't been reached yet (pattern still forming)

**Mode 2 — Completed Patterns**
- Same pivot detection, but looks for patterns where all 5 points (X, A, B, C, D) are confirmed pivots
- These generate market orders instead of limit orders

### Step 4: Quality Filtering (7 Rules)
Every candidate must pass all 7 rules (details below). Typically 70-85% of candidates pass.

### Step 5: Phase C Screening
- Blocks Crab and Deep Crab patterns (globally disabled due to low win rates)
- Checks against the `enabled_patterns` list from system settings

### Step 6: Deduplication (2 Layers)
- **Layer 1 — In-memory cache**: Key = `symbol:timeframe:pattern:direction`, TTL = 4 hours. Prevents re-processing the same forming pattern every 30s scan.
- **Layer 2 — Database check**: Queries `live_signals` table for any existing signal with same symbol + timeframe + pattern + direction created within the age window (14 days for 1D, 7 days for 4H). Survives restarts.

### Step 7: Save & Execute
For each truly new signal:
1. Validate through Zod schema (enforces positive numbers, valid patterns)
2. Send Telegram/Discord notification
3. Insert into `live_signals` table in PostgreSQL
4. If `trading_enabled` is true AND we have account equity data:
   - Calculate position size (% of equity)
   - Place a limit order on Alpaca at the projected D price
   - Save the Alpaca order ID back to the database
5. Skip crypto SHORT signals (Alpaca doesn't support crypto shorting)

### Step 8: Exit Cycle (runs in `finally` block)
- Checks all pending/filled signals for entry fills
- Places TP1 + TP2 exit orders when entries fill
- Monitors stop-loss levels via software price checks

### Step 9: Position Monitor
- Checks all open positions against their TP/SL levels using WebSocket stream prices
- Fires market exit orders if stop-loss is breached

### Mutex Lock
A boolean lock (`isScanning`) prevents overlapping scans. If a scan takes longer than 30s and the next interval fires, it skips gracefully instead of stacking API requests.

---

## What Are Harmonic Patterns?

Harmonic patterns are geometric price structures based on Fibonacci ratios. They identify potential reversal zones where price is likely to change direction.

### The XABCD Structure
Every harmonic pattern consists of 5 price points forming 4 "legs":

```
Bullish (Long) Example:          Bearish (Short) Example:

    X                                 A
   / \                               / \
  /   \                             /   \
 /     B                           /     B
A       \                         X       \
         \   D (Buy here)                  \   D (Sell here)
          \ /                               \ /
           C                                 C
```

- **X → A**: The initial impulse move
- **A → B**: First retracement (B retraces part of XA)
- **B → C**: Second impulse (C retraces part of AB)
- **C → D**: Final leg — D is where the pattern completes and a trade is placed

The system projects where D *should* land based on the Fibonacci ratio rules of each pattern, then places a limit order at that price.

---

## Pattern Definitions & Fibonacci Ratios

Each pattern has specific ratio requirements for how far B retraces XA, how far C retraces AB, and where D completes relative to XA:

### Gartley
| Ratio | Range |
|-------|-------|
| XAB (B retraces XA) | 0.618 (±5% tolerance) |
| ABC (C retraces AB) | 0.382 – 0.886 |
| XAD (D retraces XA) | 0.786 |

**Character**: The most conservative pattern. D completes inside the XA range (retracement). Stop-loss placed beyond X.

### Bat
| Ratio | Range |
|-------|-------|
| XAB | 0.382 – 0.500 |
| ABC | 0.382 – 0.886 |
| XAD | 0.886 |

**Character**: Deeper D completion than Gartley. B retraces less of XA (shallower initial pullback). Stop-loss placed beyond X.

### Alt Bat (Alternate Bat)
| Ratio | Range |
|-------|-------|
| XAB | 0.382 |
| ABC | 0.382 – 0.886 |
| XAD | 1.130 |

**Character**: Extension pattern — D goes slightly beyond X (113% of XA). More aggressive entry. Stop-loss placed beyond D.

### Butterfly
| Ratio | Range |
|-------|-------|
| XAB | 0.786 |
| ABC | 0.382 – 0.886 |
| XAD | 1.272 – 1.618 |

**Character**: Major extension pattern — D extends well beyond X. Targets deep reversals. Stop-loss placed beyond D.

### ABCD
| Ratio | Range |
|-------|-------|
| XAB | 0.618 – 0.786 |
| ABC | 0.618 – 0.786 |
| XAD | 1.272 – 1.618 |

**Character**: Simplest harmonic structure. Equal measured moves. Extension pattern with stop-loss beyond D.

### Tolerance
All ratios are checked with ±5% tolerance. For example, XAB = 0.618 accepts values from 0.568 to 0.668.

### Disabled Patterns
**Crab** and **Deep Crab** are globally disabled in code (screener.ts + Zod schema) due to low historical win rates. They cannot be re-enabled from the dashboard.

---

## The 7-Rule Quality Filter

Every candidate from the pattern detector must pass ALL 7 rules. If any single rule fails, the candidate is rejected with a logged reason.

### Rule 1: XB Ratio Bounds (0.2 – 1.0)
B must retrace between 20% and 100% of XA. Values outside this mean B didn't really retrace (too small) or extended past A (invalid structure).

### Rule 2: XD Within Pattern-Specific Bounds
D must land within the expected range for its pattern type:
| Pattern | XD Min | XD Max |
|---------|--------|--------|
| Gartley | 0.60 | 0.90 |
| Bat | 0.75 | 1.00 |
| Alt Bat | 1.00 | 1.25 |
| Butterfly | 1.15 | 1.75 |
| ABCD | 0.60 | 1.80 |

### Rule 3: AC Ratio Bounds (0.2 – 1.0)
C must retrace between 20% and 100% of AB. Same structural logic as Rule 1 but for the BC leg.

### Rule 4: Reward-to-Risk ≥ 1.0
The distance from D to TP1 (reward) must be at least equal to the distance from D to stop-loss (risk). No trades where you risk more than you can gain.

### Rule 5: Minimum Profit Target ≥ 2.0%
The TP1 target must be at least 2% away from entry. This filters out thin signals that would be eaten by trading fees and slippage.

### Rule 6: Fibonacci Proximity ≤ 15%
The actual XB and XD ratios must be within 15% of the pattern's ideal Fibonacci values. This ensures the pattern is a clean, textbook-quality harmonic — not a forced fit.

| Pattern | Ideal XB | Ideal XD |
|---------|----------|----------|
| Gartley | 0.618 | 0.786 |
| Bat | 0.441 | 0.886 |
| Alt Bat | 0.382 | 1.130 |
| Butterfly | 0.786 | 1.445 |
| ABCD | 0.618 | 1.000 |

For ABCD, only XB proximity is checked (XD is meaningless for this pattern).

### Rule 7: Pattern Age Window
If the D-point has a timestamp, it must have formed recently:
- **1D patterns**: Within the last 14 days
- **4H patterns**: Within the last 7 days

Stale patterns from months ago are rejected.

---

## Order Execution Flow

```
Signal Detected
      │
      ▼
  Is trading enabled? ──No──→ Save signal to DB, skip order
      │Yes
      ▼
  Is it crypto SHORT? ──Yes──→ Save signal, skip (Alpaca doesn't support crypto shorting)
      │No
      ▼
  Calculate position size
  (equity × allocation %)
      │
      ▼
  Cap to available buying power
  (leave 2% buffer for fees)
      │
      ▼
  Format qty & price through
  Anti-422 sanitizers
      │
      ▼
  POST /v2/orders to Alpaca
  (limit order at projected D)
      │
      ▼
  Save Alpaca order ID to DB
```

### Position Sizing
- **Stocks**: 5% of total account equity per trade (configurable)
- **Crypto**: 7% of total account equity per trade (configurable)
- Capped to 98% of available buying power to avoid overdraft
- Quantity = allocated_funds ÷ limit_price

### Anti-422 Formatting (CLAUDE.md Rule #1)
Alpaca rejects orders with too many decimal places. All values pass through formatters:
- **Crypto qty**: Truncated (floor, not rounded) to 9 decimal places
- **Crypto price**: Dynamic decimals based on price tier (2 for BTC-range, 4 for mid-caps, 6-8 for altcoins)
- **Stock qty**: Whole shares only (fractional disabled)
- **Stock price**: 2 decimal places

### Hard-to-Borrow Retry
If Alpaca rejects a GTC order with a "hard-to-borrow" error (some stocks), the system automatically retries as a DAY order.

---

## Exit Management Lifecycle

Each signal progresses through these states:

```
pending → filled → partial_exit → closed
                                    ↑
                       exit_failed ─┘ (after 3 retries)
                       cancelled (entry expired)
```

### State: `pending`
- Entry limit order is live on Alpaca, waiting for price to reach D
- Every scan cycle, the exit manager checks if the order has filled

### State: `filled`
- Entry order filled — the bot now holds a position
- Immediately places TWO exit limit orders:
  - **TP1**: 50% of position at 0.382 Fibonacci retracement of AD (closer target)
  - **TP2**: 50% of position at 0.618 Fibonacci retracement of AD (further target)
- Quantity math: TP1 = floor(qty × 0.5), TP2 = qty - TP1 (guarantees no overflow)

### State: `partial_exit`
- TP1 has been hit and filled
- Remaining 50% is protected by TP2 (still live) + software stop-loss

### State: `closed`
- All exits complete (both TPs hit, or SL triggered, or manual close)

### State: `exit_failed`
- Exit order placement failed 3 times — needs manual intervention

### State: `cancelled`
- Entry order was cancelled or expired on Alpaca before filling

### Stop-Loss Architecture
Alpaca crypto does NOT support standalone stop orders. Since TP1 (50%) + TP2 (50%) = 100% of the position, there's no room for a separate SL order. Instead:
- The **crypto monitor** checks the current price against the SL level every scan cycle (~30s)
- If price breaches SL, it cancels all open exit orders and fires a market close on the entire position
- Price is read from WebSocket stream (real-time) with REST API fallback

### Stop-Loss Placement
- **Retracement patterns** (Gartley, Bat): SL placed beyond X with 5% of XA range as buffer
- **Extension patterns** (Butterfly, ABCD, Alt Bat): SL placed beyond D with same buffer
- Validated: SL must be above entry for shorts, below entry for longs. Invalid patterns are skipped with a `[CRITICAL]` log.

---

## Data Storage (Database Schema)

Three tables in PostgreSQL (Drizzle ORM):

### `live_signals` — The Core Trade Table
| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | Auto-incrementing signal ID |
| `symbol` | text, NOT NULL | Ticker (e.g., "BTC/USD", "AAPL") |
| `pattern_type` | text, NOT NULL | "Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD" |
| `timeframe` | text, NOT NULL | "1D" or "4H" |
| `direction` | text, NOT NULL | "long" or "short" |
| `entry_price` | numeric(20,10), NOT NULL | Projected D price (limit order price) |
| `stop_loss_price` | numeric(20,10), NOT NULL | Stop-loss level |
| `tp1_price` | numeric(20,10), NOT NULL | Take-profit 1 (0.382 AD retracement) |
| `tp2_price` | numeric(20,10), NOT NULL | Take-profit 2 (0.618 AD retracement) |
| `x_price` | numeric(20,10) | X pivot price |
| `a_price` | numeric(20,10) | A pivot price |
| `b_price` | numeric(20,10) | B pivot price |
| `c_price` | numeric(20,10) | C pivot price |
| `status` | text, default "pending" | Lifecycle state (see Exit Management) |
| `entry_order_id` | text | Alpaca order ID for entry |
| `tp1_order_id` | text | Alpaca order ID for TP1 exit |
| `tp2_order_id` | text | Alpaca order ID for TP2 exit |
| `sl_order_id` | text | Alpaca order ID for SL exit |
| `filled_qty` | numeric(20,10) | Quantity actually filled by Alpaca |
| `filled_avg_price` | numeric(20,10) | Average fill price |
| `exit_retries` | integer, default 0 | Counter for failed exit attempts (max 3) |
| `created_at` | timestamp | When the signal was first detected |
| `executed_at` | timestamp | When the entry order was filled |

**Zod Validation Layer**: Before any insert, values are validated:
- `tp1Price`, `tp2Price`, `entryPrice`, `stopLossPrice` must be positive numbers
- `patternType` cannot be "Crab" or "Deep Crab"
- `direction` must be "long" or "short"
- `timeframe` must be "1D" or "4H"

### `watchlist` — Symbol List
| Column | Type | Description |
|--------|------|-------------|
| `symbol` | varchar(20), PK | Ticker symbol |
| `asset_class` | varchar(20), default "equity" | "equity" or "crypto" |

Contains 35 symbols: BTC/USD, ETH/USD, TSLA, NVDA, ADA/USD, SOL/USD, XRP/USD, DOGE/USD, AVAX/USD, LINK/USD, LTC/USD, AMZN, META, MSFT, AMD, GOOGL, INTC, SPY, QQQ, IWM, PEPE/USD, SHIB/USD, TRUMP/USD, DOT/USD, UNI/USD, AAVE/USD, BCH/USD, GRT/USD, BAT/USD, CRV/USD, SUSHI/USD, XTZ/USD, BNB/USD, SUI/USD, AAPL

### `system_settings` — Bot Configuration (Singleton Row)
| Column | Type | Description |
|--------|------|-------------|
| `id` | integer, PK, default 1 | Always 1 (single row) |
| `trading_enabled` | boolean, default true | Master on/off switch for order placement |
| `equity_allocation` | numeric(5,4), default 0.05 | % of equity per stock trade (5%) |
| `crypto_allocation` | numeric(5,4), default 0.07 | % of equity per crypto trade (7%) |
| `enabled_patterns` | jsonb | Array of enabled pattern names |

### In-Memory Caches (Ephemeral, Not Trade State)
- **Candle cache**: `Map<"symbol:timeframe", { candles, expiresAt }>` — 1D: 2hr TTL, 4H: 5min TTL
- **Signal dedup cache**: `Map<"symbol:timeframe:pattern:direction", expiryTimestamp>` — 4hr TTL
- **WebSocket price cache**: `Map<symbol, { price, timestamp }>` — latest trade prices from streams
- **Rate limiter**: Sliding window counter for Alpaca API calls (200/min)

---

## Market Data Pipeline

### Data Source
All market data comes from Alpaca's Market Data API (single provider, no fallbacks):
- **Stocks**: `GET https://data.alpaca.markets/v2/stocks/bars`
- **Crypto**: `GET https://data.alpaca.markets/v1beta3/crypto/us/bars`

### Lookback Windows
- **1-Day candles**: 365 days (1 year) — provides deep pivot history
- **4-Hour candles**: 90 days (3 months) — shorter window but more granular

### Pagination
Alpaca returns max ~1000 bars per page. The system follows `next_page_token` up to 15 pages. If the 15-page limit is hit, a warning is logged and some data may be truncated.

### Caching Strategy
Purpose: Stay under the 200 req/min rate limit.
- 1D candles don't change intraday → cached 2 hours
- 4H candles update every 4 hours → cached 5 minutes
- Cache key: `"BTC/USD:1D"` → `{ candles: [...], expiresAt: ... }`

### Rate Limiter
- Sliding window: counts requests in the last 60 seconds
- Warning at 80% utilization (160 req/min)
- Hard stop at 100% (200 req/min) — throws error to prevent 429s

---

## WebSocket Price Streaming

Two persistent WebSocket connections for real-time prices:

### Crypto Stream
- URL: `wss://stream.data.alpaca.markets/v1beta3/crypto/us`
- Subscribes to trade updates for all 23 crypto symbols
- Runs 24/7
- Used for real-time SL monitoring (more responsive than 30s polling)

### Stock/SIP Stream
- URL: `wss://stream.data.alpaca.markets/v2/sip`
- Subscribes to trade updates for all 12 equity symbols
- Only connects during market hours (Mon-Fri 4AM-8PM ET)

### Reconnection Logic
- Auto-reconnects with exponential backoff: 5s → 10s → 30s → 60s → 120s
- After 5 consecutive failures, reconnection is suspended:
  - Crypto: retries after 300s cooldown
  - Stocks: retries at next market open

### Known Issue
Alpaca free tier has a connection limit (code 406). The WebSocket streams frequently hit this limit and get disconnected. The system compensates by falling back to REST API polling in the scan loop — signal detection is unaffected.

---

## Position Sizing & Risk Controls

### Per-Trade Allocation
- **Stocks**: 5% of total equity (configurable via dashboard)
- **Crypto**: 7% of total equity (configurable via dashboard)
- Example: $100,000 equity → $5,000 per stock trade, $7,000 per crypto trade

### Buying Power Cap
Before placing an order, allocated funds are capped to 98% of available buying power. This prevents "insufficient balance" rejections from Alpaca.

### No Crypto Shorting
Alpaca doesn't support short-selling crypto. When the system detects a SHORT signal for a crypto symbol, it saves the signal to the database for tracking but does NOT place an order.

### Stop-Loss as % of XA Range
Stop-loss is placed 5% of the XA range beyond the reference point (X for retracement patterns, D for extension patterns). This gives the trade breathing room without excessive risk.

### Exit Splitting
Positions are split 50/50 between TP1 and TP2. TP1 is the conservative target (locks in partial profit), TP2 is the aggressive target (lets the remaining half run further).

---

## The Dashboard UI — Every Page & Button

The frontend is a single-page React app styled as "Commander: Pattern Bot (v2)". It has a dark military/terminal aesthetic.

### Global Layout
- **Top bar**: Title "COMMANDER: PATTERN BOT (v2)", online status, uptime indicator
- **Top navigation**: 4 tabs — TERMINAL, ANALYTICS, RISK ENGINE, LOGS
- **Left sidebar**: Market Pulse, Account info, 4 sidebar panels, System Status
- **Bottom bar**: Gateway (ALPACA-API), uptime, API status indicator, UTC timestamp

---

### Top Navigation Tabs

#### TERMINAL (Default View)
The main operational view showing all active signals.

**Center Panel — "Tactical Depth of Market"**
- Shows all active signals sorted by distance to D-point (closest first)
- Each row: Symbol, Pattern type, Timeframe, Current price (USD), Distance bar (visual % from current price to projected D), Direction badge (green for entries approaching from above, red for below)
- Top section: "Imminent" signals (within ~5% of D-point) — these are closest to triggering
- Bottom section: Further-out signals still being tracked
- Header badges: "LIVE FEED" indicator, total signal count

**Right Panel — "Execution Engine"**
- **Win Rate box**: Shows overall win rate percentage (wins ÷ total closed trades)
- **Profit Factor box**: Shows profit factor (gross profit ÷ gross loss), or "—" if no losing trades yet
- **Auto-Trade toggle**: Green toggle to enable/disable live order placement. When OFF, signals are still detected and saved but no orders are sent to Alpaca
- **Position Sizing sliders**: Two sliders to adjust stock (default 5%) and crypto (default 7%) allocation percentages
- **REFRESH ALL button**: Manually triggers an immediate scan cycle (same as waiting for the 30s auto-scan)
- **KILL SWITCH button**: Emergency button — cancels ALL open orders on Alpaca and disables auto-trade. Use in case of market crash or system malfunction

**Right Panel — "Live Execution Log"**
- Real-time scrolling feed of system events:
  - Order placements: "LONG SPY Butterfly @ $659.25"
  - Signal detections: "SHORT NVDA Butterfly @ $200.03"
  - System messages: "System initialized. Connected to Alpaca API"
- Shows timestamp for each entry
- "LIVE" indicator in the corner

#### ANALYTICS
Performance analysis and pattern statistics.

**Top Stats Row (5 cards)**
- **Total Signals**: Count of all signals ever detected
- **Win Rate**: Percentage of winning trades
- **Profit Factor**: Gross profit ÷ gross loss (or "—" if incalculable)
- **Total Trades**: Count of filled trades in history
- **Watchlist**: Number of symbols being scanned

**Pattern Distribution Chart**
- Bar chart showing how many signals each pattern type has generated
- Grouped by: Gartley, Bat, Alt Bat, Butterfly, ABCD

**Direction Breakdown**
- Long vs Short signal count comparison

**Timeframe Breakdown**
- 1D vs 4H signal count comparison

**Top Symbols**
- Ranked list of symbols by number of signals generated

**Full Trade History Table**
- Every filled trade with columns: Symbol, Pattern, Direction, Target Entry, Fill Price, Quantity, Stop-Loss, TP1, Fill Date
- Shows null guards ("—") for unmatched fills that have no associated signal

#### RISK ENGINE
Capital exposure and risk parameter monitoring.

**Top Stats Row**
- **Account Equity**: Current total account value
- **Buying Power**: Available cash for new trades
- **Exposure %**: Percentage of equity currently deployed in open positions
- **Open Positions**: Count of active positions

**Capital Allocation Bars**
- Visual bar chart showing how much capital is allocated to each open position
- Color-coded by risk level (green < 30%, amber 30-70%, red > 70%)

**Risk Parameters Panel**
- Position sizing settings (stock %, crypto %)
- Maximum concurrent positions
- Stop-loss methodology explanation

**Position R:R Analysis**
- For each open position: current risk % of equity, reward-to-risk ratio
- Color-coded: green for R:R ≥ 2.0, amber for R:R < 2.0

**Upcoming Entry Risk Assessment**
- Shows imminent signals (close to D-point) with their potential risk impact
- Distance to entry, estimated position size, risk % if filled

#### LOGS
Unified event timeline combining all system events.

**Event Types**
- **SIGNAL** (amber): New pattern detected and saved to DB
- **SCAN** (blue): Scan cycle completion with candidate counts
- **FILL** (green): Order filled on Alpaca

**Controls**
- Filter by event type (SIGNAL / SCAN / FILL)
- Refresh button to pull latest events
- All events sorted by timestamp (newest first)
- Each entry shows: timestamp, event type badge, detailed message

---

### Left Sidebar Panels

#### EXECUTE (DOM View — Default)
Shows the Tactical Depth of Market (same as Terminal center panel). This is selected by default when the Terminal tab is active.

#### PORTFOLIO
Detailed position and trade information.

**Open Positions Table**
- Columns: Symbol, Side (long/short), Quantity, Entry Price, Current Price, Stop-Loss, TP1, P/L Bar, P/L %
- P/L bar: visual green/red bar proportional to unrealized P/L percentage
- Empty state: "No open positions" message

**Trade History**
- Recent filled trades: Symbol, Pattern, Direction, Target Entry, Fill Price, Quantity, Time ago
- Shows all 9 historical fills

#### SLIPPAGE HUB
Fill quality analysis measuring how well actual fills matched target prices.

**Top Stats**
- **Total Fills**: Number of completed trades
- **Avg Slippage**: Average deviation between target entry and actual fill price (as %)
- **Best Fill**: Most favorable slippage (negative = filled better than target)
- **Worst Slippage**: Largest unfavorable slippage

**Fill Detail Table**
- Each fill: Symbol, Pattern, Side, Target Price, Filled Price, Slippage %, visual indicator
- Positive slippage (bad) shown in red, negative slippage (good) shown in green
- Only shows trades that have both a target entry price and a fill price (skips unmatched fills)

#### RISK GUARD
Real-time risk monitoring with limit enforcement.

**Risk Limit Bars**
- **Max Position Size**: Bar showing current vs allowed position sizing
- **Max Concurrent Positions**: Bar showing current vs max allowed
- **Daily Loss Limit**: Bar showing today's losses vs maximum allowed
- Color shifts from green → amber → red as limits are approached

**Approaching Trade Risk Preview**
- Lists imminent signals (within ~5% of D-point) with their projected risk impact
- For each: Symbol, Direction, Distance %, projected risk as % of equity
- Helps assess what happens if the next signal triggers

---

### Sidebar Info Sections (Always Visible)

#### MARKET PULSE
- If positions exist: Shows the top position's symbol, current price, P/L %, and total position count
- If no positions: Shows "No Positions" with count of signals being watched (e.g., "53 watching")
- Green dot indicates live data connection

#### ACCOUNT
- **Equity**: Total account value (e.g., $100,348.43)
- **Buying Power**: Available cash for new orders
- **Day P&L**: Today's profit/loss in dollars (green if positive, red if negative)

#### SYSTEM STATUS
- Imminent signal count and total tracking count
- Win rate summary (e.g., "Win rate: 100% (1W / 0L)")

---

### Top-Right Icons

#### Notification Bell (with badge count)
Shows count of pending alerts/notifications

#### Settings Gear
Access to system configuration

#### User Avatar
Account/profile access

---

## File Map

```
server/
├── index.ts                 # Express server entry point (port 3000)
├── orchestrator.ts          # The brain — 30s scan loop, coordinates everything
├── patterns.ts              # Harmonic pattern detection engine (pivots → XABCD)
├── harmonics.ts             # Pure math: Fibonacci ratios, retracement calculations
├── screener.ts              # Phase C filter: blocks Crab/Deep Crab, validates patterns
├── quality-filters.ts       # 7-rule quality gate (R:R, Fib proximity, age, etc.)
├── alpaca.ts                # Order execution: position sizing, limit order placement
├── alpaca-data.ts           # Market data ingestion: candle fetching, caching, rate limiting
├── exit-manager.ts          # Exit lifecycle: TP1/TP2 placement, fill tracking, SL monitoring
├── crypto-monitor.ts        # Real-time position monitor: WebSocket price → SL/TP checks
├── websocket-stream.ts      # Persistent WebSocket connections for live price streaming
├── api.ts                   # Express router: /api/* endpoints for dashboard
├── db.ts                    # Drizzle ORM connection + table initialization
├── check-inverted-tp.ts     # Diagnostic utility for checking bad TP/SL values
└── utils/
    ├── alpacaFormatters.ts  # Anti-422: qty/price decimal formatting for Alpaca API
    └── notifier.ts          # Telegram/Discord alert delivery

shared/
└── schema.ts               # Drizzle table definitions + Zod validation schemas

client/
└── src/
    ├── App.tsx              # Entire Commander v2 UI (~1600 lines)
    ├── main.tsx             # React entry point
    └── index.css            # Global styles + CSS custom properties

CLAUDE.md                    # System rules (4 critical rules for AI to follow)
```

---

## System Rules (CLAUDE.md)

### Rule 1: Alpaca API Decimal Precision (Anti-422)
All qty/price values must pass through `formatAlpacaQty()` / `formatAlpacaPrice()` before hitting Alpaca. Crypto qty max 9 decimals. No scientific notation. No NaN/zero/negative values.

### Rule 2: State Management (Anti-NULL)
Zero in-memory trade state. All configs, signals, and positions must be saved to PostgreSQL. TP1 and TP2 prices can NEVER be NULL when a trade executes. Three layers enforce this: Drizzle `.notNull()`, Zod `.refine()`, and pattern detection validation.

### Rule 3: Pattern Exclusions
Crab and Deep Crab are globally disabled and blocked at multiple levels (screener.ts, Zod schema, quality filters). They cannot be re-enabled from the UI.

### Rule 4: Development Workflow
Decoupled architecture — Alpaca data failures don't crash the pattern engine, and pattern engine failures don't crash order execution. Each component handles its own errors. Rate limiter at 200 req/min for Alpaca free tier.

---

## Known Limitations

| Issue | Impact | Detail |
|-------|--------|--------|
| 4H pagination cap | Some crypto symbols missing 4H data on some scans | Alpaca returns too many bars across 23 symbols; 15-page limit truncates the response |
| WebSocket 406 | No real-time price streaming | Alpaca free tier connection limit; system falls back to REST polling |
| BNB/USD, SUI/USD | No data, wasted API calls | Alpaca doesn't carry these symbols |
| No crypto shorting | Short signals saved but not traded | Alpaca paper trading doesn't support crypto short-selling |
| Alt Bat SL inversion | 5 patterns skipped per scan | Some Alt Bat patterns produce stop-losses on the wrong side of entry; correctly caught and skipped |
| Profit factor null | Shows "—" on dashboard | Cannot compute profit factor with 0 losing trades (division by zero) |
| Single-file frontend | Maintenance difficulty | All 1600 lines of UI in one App.tsx file |
