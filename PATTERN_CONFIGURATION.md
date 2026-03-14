# Pattern Bot — Pattern Configuration & Search Methodology

**Last Updated:** March 13, 2026  
**Status:** ✅ Active & Validated

---

## Overview

Pattern Bot is an automated harmonic pattern detection system that scans crypto and equity markets for XABCD harmonic structures. The system:

1. **Fetches candle data** from Alpaca/FMP APIs
2. **Detects pivot points** (swing highs/lows) in the price action
3. **Identifies forming patterns** by matching Fibonacci ratios
4. **Projects completion levels** (D point) and entry prices
5. **Places limit orders** when patterns are detected

---

## 🟢 Enabled Patterns

| Pattern | XAB Range | ABC Range | XAD Range | Use Case |
|---------|-----------|-----------|-----------|----------|
| **Gartley** | 0.618 | 0.382 → 0.886 | 0.786 | Reversal at 0.786 retracement of XA |
| **Bat** | 0.382 → 0.500 | 0.382 → 0.886 | 0.886 | Shallow pullback, deep D completion |
| **Alt Bat** | 0.382 | 0.382 → 0.886 | 1.130 | Alternative Bat with extension beyond X |
| **Butterfly** | 0.786 | 0.382 → 0.886 | 1.272 → 1.618 | Extended reversal pattern |
| **ABCD** | 0.618 → 0.786 | 0.618 → 0.786 | 1.272 → 1.618 | Four-point impulse/correction |

### Pattern Code Location
- **File:** `server/patterns.ts` (lines 96–127)
- **Definition Array:** `PATTERN_DEFS`

---

## 🔴 Disabled Patterns

| Pattern | Reason |
|---------|--------|
| **Crab** | Low win rate |
| **Deep Crab** | Low win rate |

**Enforcement Locations:**
1. `server/screener.ts` (lines 15, 69-71) — Blocks at Phase C screening
2. `shared/schema.ts` (lines 40, 58-60) — Blocks at database validation (Zod)
3. `CLAUDE.md` Rule #3 — System policy

---

## Fibonacci Ratios Reference

All patterns use Fibonacci retracement/extension levels:

```
Standard Fibonacci Levels:
├── 0.382  (38.2% retracement)
├── 0.500  (50% retracement)
├── 0.618  (61.8% retracement)
├── 0.786  (78.6% retracement)
├── 0.886  (88.6% retracement)
├── 1.130  (113% extension)
├── 1.272  (127.2% extension)
└── 1.618  (161.8% extension)
```

**File:** `server/harmonics.ts` — Defines `FIB` constants and ratio calculations

---

## Search Methodology

### Step 1: Pivot Detection

**Function:** `findPivots()` in `server/patterns.ts` (lines 27–82)

```typescript
Parameters:
  leftBars: 5    // Candles to the left of pivot
  rightBars: 5   // Candles to the right of pivot
  
Logic:
  - A Swing High: price higher than all 5 candles left AND right
  - A Swing Low: price lower than all 5 candles left AND right
  
Required Data: Minimum 20 candles (5 left + 1 + 5 right + buffer)
```

**Why 5 bars?** Standard TradingView pivot definition. Sensitive enough to catch patterns, stable enough to avoid false positives.

---

### Step 2: Pattern Matching

**Function:** `detectHarmonics()` in `server/patterns.ts` (lines 150–276)

```typescript
Input: Candles[] (OHLCV data, oldest first)
Process:
  1. Find all pivots from recent price action (last 20 pivots)
  2. Group pivots into X-A-B-C combinations (must alternate: high/low/high/low)
  3. Calculate two key ratios:
     - XAB Ratio = (B - A) / (X - A)   // First leg retracement
     - ABC Ratio = (C - B) / (A - B)   // Second leg retracement
  4. Test each ratio pair against pattern definitions
  5. If match found → project D and validate
Output: PhaseCSignal[] (forming patterns with entry/exit prices)
```

**Ratio Tolerance:** ±5% (RATIO_TOLERANCE = 0.05)  
**Why?** Real-world price action is never pixel-perfect. 5% tolerance catches natural patterns while rejecting noise.

---

### Step 3: D Projection

Once X-A-B-C points match a pattern, the D point is projected:

```typescript
XA Leg = X.price - A.price              // Signed distance
Mid XAD = (pattern.xad.min + pattern.xad.max) / 2
Projected D = A.price + (XA Leg × Mid XAD)
```

**Example (Long Pattern):**
```
If X = 100, A = 110, pattern.xad = 0.786:
  XA = 100 - 110 = -10
  D = 110 + (-10 × 0.786) = 110 - 7.86 = 102.14
  
Pattern is forming. D will be a LOW at 102.14 where we BUY.
```

---

### Step 4: Direction & Structure Validation

```typescript
// Alternating rule
if (X.type === A.type || A.type === B.type || B.type === C.type) {
  REJECT // Pattern doesn't alternate between highs/lows
}

// D hasn't been hit yet (still forming)
if (direction === "long" && lastCandle.low <= projectedD) {
  REJECT // D zone already reached
}
if (direction === "short" && lastCandle.high >= projectedD) {
  REJECT // D zone already reached
}

// D is reasonable
if (!Number.isFinite(projectedD) || projectedD <= 0) {
  REJECT // Math error
}
```

---

## Entry, Stop Loss & Take Profit Calculation

**File:** `server/patterns.ts` (lines 228–255)

```typescript
// Entry Price
entryPrice = projectedD  // Where pattern completes

// AD Leg (from A to D)
adRange = |A.price - projectedD|

// XA Leg (from X to A)
xaRange = |A.price - X.price|

// LONG Position
if (direction === "long") {
  tp1Price = projectedD + adRange × 0.382
  tp2Price = projectedD + adRange × 0.618
  stopLossPrice = projectedD - xaRange × 0.13
}

// SHORT Position
if (direction === "short") {
  tp1Price = projectedD - adRange × 0.382
  tp2Price = projectedD - adRange × 0.618
  stopLossPrice = projectedD + xaRange × 0.13
}
```

**Rationale:**
- **TP1 (38.2%):** Quick profit target at minor Fibonacci retracement
- **TP2 (61.8%):** Full profit target at major Fibonacci level
- **SL (13% of XA):** Beyond D to absorb market noise without excessive loss

**Validation:** All prices must be > 0 (Anti-NULL Rule)

---

## Scan Cycle

**File:** `server/orchestrator.ts`

```typescript
Configuration:
  SCAN_INTERVAL_MS = 30_000         // Scan every 30 seconds
  HEARTBEAT_EVERY_N_SCANS = 10      // Log heartbeat every 5 minutes
  TIMEFRAMES = ["1D", "4H"]         // Daily and 4-hour candles
  
Sequence:
  1. Load watchlist from database (or fallback to: BTC/USD, ETH/USD, AAPL, TSLA)
  2. For each symbol × each timeframe:
     a. Fetch 500+ candles from Alpaca
     b. detectHarmonics() → candidates
     c. processPhaseCSignals() → filter disabled patterns
  3. Validate each signal (Zod schema, TP/SL checks)
  4. Deduplicate (don't re-process same signal within 4H window)
  5. Save to database (live_signals table)
  6. Place Alpaca order if equity data available
  7. Sleep 30 seconds → repeat
```

**Safety Features:**
- **Mutex lock** — prevents overlapping scans if API is slow
- **Deduplication cache** — doesn't re-act on same signal within 4H
- **Decoupled errors** — API latency in one component doesn't crash others

---

## Database Schema

**File:** `shared/schema.ts`

```typescript
// live_signals table
{
  id: SERIAL PRIMARY KEY,
  symbol: TEXT NOT NULL,              // "AAPL", "BTC/USD"
  pattern_type: TEXT NOT NULL,        // "Gartley", "Bat", etc.
  timeframe: TEXT NOT NULL,           // "1D" or "4H"
  direction: TEXT NOT NULL,           // "long" or "short"
  entry_price: NUMERIC(20,10),        // Projected D
  stop_loss_price: NUMERIC(20,10),    // Stop loss
  tp1_price: NUMERIC(20,10) NOT NULL, // Take profit 1 (38.2%)
  tp2_price: NUMERIC(20,10) NOT NULL, // Take profit 2 (61.8%)
  status: TEXT DEFAULT 'pending',
  created_at: TIMESTAMP DEFAULT NOW(),
  executed_at: TIMESTAMP NULL,
}

// watchlist table
{
  symbol: VARCHAR(20) PRIMARY KEY,    // "AAPL", "BTC/USD"
  asset_class: VARCHAR(20),           // "equity" or "crypto"
}
```

**Validation (Zod):**
- `tp1Price` and `tp2Price` must be positive numbers (never NULL)
- `patternType` must be one of: Gartley, Bat, Alt Bat, Butterfly, ABCD
- `direction` must be: "long" or "short"
- `timeframe` must be: "1D" or "4H"

---

## Timeframes

| Timeframe | Candle Size | Typical Hold Time |
|-----------|-------------|-------------------|
| **1D** | 1 day | 5–20 days |
| **4H** | 4 hours | 1–3 days |

Both timeframes scanned **simultaneously** every 30 seconds.

---

## API Endpoints

### Signals Feed
```
GET /api/signals
Returns: Array of most recent signals (deduplicated by symbol:pattern:timeframe)
Limit: 50 unique patterns
```

### Watchlist Management
```
GET /api/watchlist                  // List all symbols
POST /api/watchlist                 // Add symbol
DELETE /api/watchlist/:symbol       // Remove symbol
```

### Account & Execution
```
GET /api/account                    // Live Alpaca equity/buying power
GET /api/positions                  // Current open positions
GET /api/metrics                    // Win rate, profit factor, trade count
```

---

## System Rules (CLAUDE.md)

### Rule #1: Alpaca API Decimal Precision
- Crypto quantity: max 9 decimal places
- Limit price: 2–4 decimals (asset-dependent)
- Formatter: `Number(val.toFixed(9))`

### Rule #2: State Management & Exits
- No in-memory state — everything saved to PostgreSQL
- tp1Price and tp2Price NEVER NULL at execution time
- Three-layer validation: Drizzle, Zod, Pattern filter

### Rule #3: Phase C Filtering
- Crab and Deep Crab patterns globally disabled
- Enforced in `screener.ts`, `schema.ts`

### Rule #4: Development Workflow
- Only Drizzle ORM for database queries
- Decoupled architecture (FMP, Harmonic engine, Alpaca)

---

## Validation Checklist

- ✅ Pattern definitions use correct Fibonacci ratios
- ✅ Pivot detection requires minimum 5-bar structure
- ✅ TP/SL calculations are always positive
- ✅ Disabled patterns (Crab/Deep Crab) blocked at 2 enforcement points
- ✅ Deduplication prevents same signal within 4H window
- ✅ Database schema enforces NOT NULL on TP1/TP2
- ✅ Watchlist dynamically loaded from database
- ✅ Scan interval is 30 seconds with mutex lock
- ✅ Ratio tolerance is ±5%
- ✅ X-A-B-C points alternate between highs and lows

---

## Quick Reference: Code Locations

| Component | File | Lines |
|-----------|------|-------|
| Pattern definitions | `server/patterns.ts` | 96–127 |
| Fibonacci ratios | `server/harmonics.ts` | (see FIB constants) |
| Pivot detection | `server/patterns.ts` | 27–82 |
| Harmonic detection | `server/patterns.ts` | 150–276 |
| Phase C filtering | `server/screener.ts` | 63–78 |
| Pattern validation (Zod) | `shared/schema.ts` | 53–64 |
| Scan orchestration | `server/orchestrator.ts` | 1–100 |
| Entry/Exit calculation | `server/patterns.ts` | 228–255 |
| System rules | `CLAUDE.md` | 12–34 |

---

## Testing Instructions

To verify the pattern configuration is correct:

1. **Check enabled patterns match expectations:**
   ```bash
   grep -A 30 "const PATTERN_DEFS" server/patterns.ts
   ```

2. **Verify disabled patterns are blocked:**
   ```bash
   grep -n "DISABLED_PATTERNS" server/screener.ts shared/schema.ts
   ```

3. **Confirm ratio tolerance:**
   ```bash
   grep "RATIO_TOLERANCE" server/patterns.ts
   ```

4. **Check scan interval:**
   ```bash
   grep "SCAN_INTERVAL_MS" server/orchestrator.ts
   ```

5. **View live signals (should show no duplicates):**
   ```bash
   curl http://localhost:3000/api/signals | jq '.[] | {symbol, pattern: .patternType, timeframe}'
   ```

---

## Summary

Pattern Bot detects 5 harmonic patterns (Gartley, Bat, Alt Bat, Butterfly, ABCD) across 1D and 4H timeframes by:

1. Finding pivots (swing highs/lows with 5-bar left/right structure)
2. Matching X-A-B-C ratios against Fibonacci rules (±5% tolerance)
3. Projecting D completion level and validating alternating structure
4. Calculating TP1, TP2, and SL using Fibonacci retracements
5. Saving to PostgreSQL and executing trades via Alpaca

All patterns are deduped, validated, and database-persisted before trading.
