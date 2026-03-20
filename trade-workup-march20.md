# FTM COMMANDER — Complete Trade Workup
## March 20, 2026

---

## System Configuration

| Setting | Value |
|---------|-------|
| **Trading Enabled** | Yes |
| **Equity Allocation** | 5% of account equity per trade (~$4,942) |
| **Crypto Allocation** | 7% of account equity per trade |
| **Enabled Patterns** | Butterfly, Alt Bat, Gartley, Bat, ABCD |
| **Disabled Patterns** | Crab, Deep Crab (globally disabled) |
| **Proximity Threshold** | 5% (order placed when price is within 5% of projected D) |
| **Order Type** | Limit (GTC for crypto, DAY+extended for stocks) |
| **TP1 Split** | 50% of position |
| **TP2 Split** | Remaining 50% |
| **SL Method** | Software-monitored (checked every ~30s) |
| **Quality Filters** | 7 rules: XB ratio, XD ratio, AC ratio, R:R >= 1.0, Profit target >= 2%, Fib proximity <= 15%, Pattern age window |
| **Account Equity at Open** | ~$99,387 |

---

## CLOSED TRADES (Fully Exited)

---

### Trade 1: UAMY — ABCD 4H LONG

**Signal ID:** 8459
**Score:** 62.8 / 100

#### XABCD Pattern Points
| Pivot | Price |
|-------|-------|
| X | $8.60 |
| A | $10.72 |
| B | $9.31 |
| C | $10.35 |
| D (Entry) | $8.94 |

#### Trade Execution

| Field | Value |
|-------|-------|
| **Signal Detected** | March 19, 2026 at 5:53 PM ET |
| **Direction** | LONG (buy) |
| **Entry Order** | BUY 555 shares @ $8.94 limit |
| **Entry Fill Price** | $8.94 |
| **Entry Fill Time** | March 20, 10:13 AM ET |
| **Position Size** | $4,961.70 (5.0% of equity) |

#### Exit Levels

| Level | Price | Distance from Entry | Status |
|-------|-------|---------------------|--------|
| **Stop Loss** | $8.6644 | -3.08% | **HIT** |
| **TP1** | $9.4786 | +6.03% | Not reached |
| **TP2** | $9.8114 | +9.74% | Not reached |

#### Exit Execution

| Field | Value |
|-------|-------|
| **Exit Trigger** | Stop Loss breached (software SL monitor) |
| **Exit Type** | Market sell |
| **Exit Price** | $8.645 (avg) |
| **Exit Time** | March 20, 12:32 PM ET |
| **Hold Time** | ~2 hours 19 minutes |

#### P&L

| Metric | Value |
|--------|-------|
| **Realized P&L** | **-$163.73** |
| **Return** | **-3.30%** |
| **Result** | LOSS |
| **Risk Used** | 100% of planned SL distance |

#### Post-Mortem
- Entry filled right at market open. Price never moved toward TP1 ($9.48).
- SL was tight at $8.66, only 3.08% below entry. Price slipped through.
- The ABCD pattern had a moderate score (62.8) — below the Butterfly/Gartley sweet spot of 75+.
- R:R was approximately 2:1 (6% reward vs 3% risk on TP1), which is acceptable.

---

### Trade 2: PRSU — Butterfly 4H LONG

**Signal ID:** 8529
**Score:** 78.9 / 100

#### XABCD Pattern Points
| Pivot | Price |
|-------|-------|
| X | $35.54 |
| A | $37.73 |
| B | $36.04 |
| C | $37.36 |
| D (Entry) | $34.57 |

#### Trade Execution

| Field | Value |
|-------|-------|
| **Signal Detected** | March 19, 2026 at 5:57 PM ET |
| **Direction** | LONG (buy) |
| **Entry Order** | BUY 142 shares @ $34.57 limit |
| **Entry Fill Price** | $34.24 |
| **Entry Fill Time** | March 20, 1:53 PM ET |
| **Position Size** | $4,862.08 (4.9% of equity) |
| **Note** | Filled below limit at $34.24 (favorable slippage of $0.33) |

#### Exit Levels

| Level | Price | Distance from Entry | Status |
|-------|-------|---------------------|--------|
| **Stop Loss** | $34.2836 | -0.82% | **HIT** |
| **TP1** | $35.6343 | +3.09% | Not reached |
| **TP2** | $36.2933 | +4.99% | Not reached |

#### Exit Execution

| Field | Value |
|-------|-------|
| **Exit Trigger** | Stop Loss breached (software SL monitor) |
| **Exit Type** | Market sell |
| **Exit Price** | $33.84 (avg) |
| **Exit Time** | March 20, 2:36 PM ET |
| **Hold Time** | ~43 minutes |

#### P&L

| Metric | Value |
|--------|-------|
| **Realized P&L** | **-$53.96** |
| **Return** | **-1.11%** |
| **Result** | LOSS |
| **Risk Used** | Entry was at $34.24, SL at $34.28 — SL was actually ABOVE entry fill. See note. |

#### Post-Mortem
- This is a pattern accuracy issue. The limit order was set at $34.57 (projected D), but the fill came at $34.24 — well below the projected entry.
- The SL was computed relative to the projected D ($34.57), not the actual fill. So the SL at $34.28 was only $0.04 above the fill price of $34.24 — essentially no room.
- The SL triggered almost immediately because the fill price was already below the SL level.
- Score was high (78.9) but the tight SL relative to actual fill made this trade unmanageable.
- This highlights a potential improvement: recalculating SL based on actual fill price rather than projected D.

---

## CURRENTLY OPEN POSITIONS (Entered Today)

---

### Position 1: PHGE — ABCD 4H LONG

**Signal ID:** 9980
**Score:** 64.6 / 100

#### XABCD Pattern Points
| Pivot | Price |
|-------|-------|
| X | $4.06 |
| A | $8.10 |
| B | $5.41 |
| C | $6.84 |
| D (Entry) | $4.15 |

#### Trade Execution

| Field | Value |
|-------|-------|
| **Signal Detected** | March 20, 2026 at 2:45 PM ET |
| **Direction** | LONG (buy) |
| **Entry Fill Price** | $4.92 (Alpaca fill) |
| **Entry Fill Time** | March 20, 2:36 PM ET |
| **Shares** | 1,003 |
| **Position Size** | $4,934.76 |

#### Exit Levels

| Level | Price | Distance from Entry ($4.92) | Status |
|-------|-------|-----------------------------|--------|
| **Stop Loss** | $3.6248 | -26.3% | Active (monitoring) |
| **TP1** | $5.1776 | +5.2% | Pending |
| **TP2** | $5.8124 | +18.1% | Pending |

#### Current Status

| Metric | Value |
|--------|-------|
| **Current Price** | $4.89 |
| **Unrealized P&L** | **-$30.09 (-0.61%)** |
| **Status** | Open — TP/SL orders being monitored |

#### Notes
- Entry filled significantly above projected D ($4.15 vs $4.92 actual). This is a large slippage of +18.6%.
- Signal is in "projected" status in the DB, but Alpaca shows an active position. This may indicate the fill detection hasn't synced yet.
- SL at $3.62 provides very wide room (26% below fill). TP1 at $5.18 is 5.2% away.

---

### Position 2: CUBE — LONG (No Signal Link)

| Field | Value |
|-------|-------|
| **Entry Fill** | 134 shares @ $36.66 |
| **Fill Time** | March 20, 3:59 PM ET |
| **Current Price** | $36.69 |
| **Unrealized P&L** | **+$4.02 (+0.08%)** |
| **Position Size** | $4,916.46 |
| **Pattern/Signal** | Not linked to a Commander signal |
| **SL/TP** | None set |

---

### Position 3: INGR — LONG (No Signal Link)

| Field | Value |
|-------|-------|
| **Entry Fill** | 44 shares @ $109.29 |
| **Fill Time** | March 20, 3:59 PM ET |
| **Current Price** | $109.16 |
| **Unrealized P&L** | **-$5.66 (-0.12%)** |
| **Position Size** | $4,803.04 |
| **Pattern/Signal** | Not linked to a Commander signal |
| **SL/TP** | None set |

---

### Position 4: SCAP — LONG (No Signal Link)

| Field | Value |
|-------|-------|
| **Entry Fill** | 142 shares @ $34.09 |
| **Fill Time** | March 20, 3:59 PM ET |
| **Current Price** | $34.07 |
| **Unrealized P&L** | **-$2.23 (-0.05%)** |
| **Position Size** | $4,838.55 |
| **Pattern/Signal** | Not linked to a Commander signal |
| **SL/TP** | None set |

---

### Position 5: SGRY — LONG (No Signal Link)

| Field | Value |
|-------|-------|
| **Entry Fill** | 417 shares @ $11.80 |
| **Fill Time** | March 20, 3:59 PM ET |
| **Current Price** | $11.80 |
| **Unrealized P&L** | **$0.00 (0.00%)** |
| **Position Size** | $4,920.60 |
| **Pattern/Signal** | Not linked to a Commander signal |
| **SL/TP** | None set |

---

### Position 6: ZNTL — SHORT (No Signal Link)

| Field | Value |
|-------|-------|
| **Entry Fill** | 1,931 shares SHORT @ $2.60 |
| **Fill Time** | March 20, 3:59 PM ET |
| **Current Price** | $2.62 |
| **Unrealized P&L** | **-$38.62 (-0.77%)** |
| **Position Size** | $5,059.22 |
| **Pattern/Signal** | Not linked to a Commander signal |
| **SL/TP** | None set |

---

## PENDING ORDERS (Not Yet Filled)

### Active Limit Orders on Alpaca

| Symbol | Side | Qty | Limit Price | Pattern | Status |
|--------|------|-----|-------------|---------|--------|
| BBY | Buy | 80 | $61.61 | Gartley 4H LONG | Waiting for fill |
| HBCP | Sell | 81 | $60.36 | — | Waiting for fill |
| IIIV | Buy | 223 | $22.10 | — | Waiting for fill |
| RSPS | Buy | 169 | $29.05 | — | Waiting for fill |
| SPUC | Buy | 112 | $44.01 | — | Waiting for fill |

---

## DAY SUMMARY

### Closed P&L

| Trade | Pattern | Direction | Entry | Exit | Shares | P&L | Return |
|-------|---------|-----------|-------|------|--------|-----|--------|
| UAMY | ABCD 4H | LONG | $8.94 | $8.645 | 555 | -$163.73 | -3.30% |
| PRSU | Butterfly 4H | LONG | $34.24 | $33.84 | 142 | -$53.96 | -1.11% |
| **TOTAL** | | | | | | **-$217.69** | |

### Open Position P&L (Unrealized)

| Position | Direction | Shares | Entry | Current | Unrealized P&L |
|----------|-----------|--------|-------|---------|----------------|
| PHGE | LONG | 1,003 | $4.92 | $4.89 | -$30.09 |
| CUBE | LONG | 134 | $36.66 | $36.69 | +$4.02 |
| INGR | LONG | 44 | $109.29 | $109.16 | -$5.66 |
| SCAP | LONG | 142 | $34.09 | $34.07 | -$2.23 |
| SGRY | LONG | 417 | $11.80 | $11.80 | $0.00 |
| ZNTL | SHORT | 1,931 | $2.60 | $2.62 | -$38.62 |
| **TOTAL** | | | | | **-$72.58** |

### Account Impact

| Metric | Value |
|--------|-------|
| **Realized P&L (closed trades)** | -$217.69 |
| **Unrealized P&L (open positions)** | -$72.58 |
| **Total Day P&L (Alpaca reported)** | -$440.48 |
| **Account Equity** | $98,846.45 |
| **Win Rate Today** | 0/2 (0%) |

---

## ISSUES IDENTIFIED

### 1. Unlinked Positions (CUBE, INGR, SCAP, SGRY, ZNTL)
Five positions filled today have **no signal link** in Commander's database — no pattern, no SL, no TP. These orders were placed by the catch-up loop but the signal association was lost. The exit manager cannot monitor them for TP/SL because there's no signal row to reference. **These need manual exit management.**

### 2. PRSU Stop Loss Gap
The SL was calculated from projected D ($34.57) but the actual fill was at $34.24 — already below the SL level of $34.28. The trade was essentially dead on arrival. The system should consider recalculating SL relative to actual fill price.

### 3. PHGE Entry Slippage
Entry filled at $4.92 vs projected D of $4.15 — an 18.6% gap. The 5% proximity gate should have prevented this order. The signal status shows "projected" in the DB despite having a live position on Alpaca, suggesting a sync issue between the orchestrator and Alpaca's order fill detection.

### 4. Daily P&L Discrepancy
Realized trades account for -$217.69, open positions show -$72.58, but Alpaca reports -$440.48 for the day. The ~$150 gap likely comes from mark-to-market changes on positions that were opened and partially moved intraday, plus any carry-over effects from prior-day positions.
