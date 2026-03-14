# Position Sizing Guide — Pattern Bot

**What You Need to Know:** Position sizing determines **how much money (or how many shares/coins) you're risking on each trade.**

---

## The Simple Concept

When a pattern is detected, Pattern Bot doesn't just blindly trade. It calculates:

> **"What percentage of my total account should I risk on THIS trade?"**

Then it converts that percentage into an actual **quantity** (number of shares or coins).

---

## Current Defaults

Pattern Bot uses **conservative position sizing**:

| Asset Class | Allocation | Meaning |
|-------------|-----------|---------|
| **Crypto** | 7% | Risk 7% of your total account per crypto trade |
| **Equity/Stocks** | 5% | Risk 5% of your total account per equity trade |

**Example:**
- Your account balance: **$100,000**
- A BTC/USD pattern is detected
- Allocation: 7% of $100,000 = **$7,000**
- If BTC entry price is $66,000, you buy: 7000 ÷ 66000 ≈ **0.106 BTC**

---

## The Math Behind It

### Step-by-Step Calculation

**File:** `server/alpaca.ts` (lines 103–110)

```typescript
// Step 1: Determine allocation based on asset type
const allocation = isCrypto ? 0.07 : 0.05;
//                              ↑      ↑
//                         7% crypto, 5% stocks

// Step 2: Calculate allocated funds
const allocatedFunds = accountEquity * allocation;
//                     $100,000 × 0.07 = $7,000

// Step 3: Calculate quantity
const rawQty = allocatedFunds / limitPrice;
//              $7,000 / $66,000 = 0.106 BTC
```

### Real-World Examples

#### Example 1: LONG BTC/USD Pattern

```
Account Balance:    $100,000
Asset Type:         Crypto
Allocation:         7%
Allocated Funds:    $100,000 × 0.07 = $7,000
Entry Price (D):    $66,000
Quantity to Buy:    $7,000 ÷ $66,000 = 0.106 BTC
Take Profit 1:      $68,410
Take Profit 2:      $69,700
Stop Loss:          $65,521
Risk:               $7,000 (7% of account)
```

**If trade hits TP2:**
- Profit = ($69,700 - $66,000) × 0.106 BTC = $390.40 → Account grows to $100,390
- Next trade will use this new balance for calculations

**If trade hits SL:**
- Loss = ($65,521 - $66,000) × 0.106 BTC = -$50.66 → Account shrinks to $99,949
- Next trade uses updated balance

---

#### Example 2: SHORT AAPL (Equity) Pattern

```
Account Balance:    $100,000
Asset Type:         Equity
Allocation:         5%
Allocated Funds:    $100,000 × 0.05 = $5,000
Entry Price (D):    $226.79
Quantity to Sell:   $5,000 ÷ $226.79 = 22 shares (rounded down)
Take Profit 1:      $218.45
Take Profit 2:      $210.94
Stop Loss:          $231.93
Risk:               $5,000 (5% of account)
```

**If trade hits TP2:**
- Profit = ($226.79 - $210.94) × 22 shares = $348 → Account grows to $100,348

**If trade hits SL:**
- Loss = ($231.93 - $226.79) × 22 shares = $113 → Account shrinks to $99,887

---

## Why These Percentages?

### 7% for Crypto (vs 5% for Equity)
- Crypto is more volatile → bigger swings → need careful sizing
- Even at 7%, you're being conservative (typical traders use 10%+)
- Allows multiple losing trades before significant drawdown

### The Math:
If you have **10 consecutive losses** at 5% allocation:
```
$100,000 × (1 - 0.05)^10 = $59,874
Loss: ~$40,000 (40% of account)
```

If you have **10 consecutive losses** at 7% allocation:
```
$100,000 × (1 - 0.07)^10 = $47,872
Loss: ~$52,000 (52% of account)
```

**This is why we don't go too high** — you need to survive losing streaks.

---

## How Quantity is Formatted (Anti-422 Rule)

After calculating quantity, Pattern Bot formats it for Alpaca's strict requirements:

**File:** `server/utils/alpacaFormatters.ts`

```typescript
// Crypto: Maximum 9 decimal places
0.106248765 BTC → 0.106248765 (9 decimals OK)
0.1062487652 BTC → 0.106248765 (truncated to 9)

// Stocks: Whole shares by default
22.7 shares → 22 shares (rounded down to protect balance)
22 shares → 22 (no decimals)

// Prices: Depend on asset
Crypto $66,000.12 BTC → $66,000.12 (2 decimals)
Equity $226.79 AAPL → $226.79 (2 decimals)
```

**Why?** Alpaca API rejects orders (422 error) if decimals are wrong. Our formatter prevents this.

---

## How to Customize Position Sizing

### Option 1: Use Database Settings
To change allocations, you would add to `system_settings` table:
```typescript
{
  key: "position_sizing",
  value: { equity: 0.03, crypto: 0.05 }  // 3% stocks, 5% crypto
}
```

(Not currently implemented — would need DB schema update)

### Option 2: Edit Code Defaults
**File:** `server/alpaca.ts` (lines 26–27)

```typescript
// Current:
const DEFAULT_CRYPTO_ALLOCATION = 0.07;  // 7%
const DEFAULT_EQUITY_ALLOCATION = 0.05;  // 5%

// To change to 10% and 6%, edit to:
const DEFAULT_CRYPTO_ALLOCATION = 0.10;  // 10%
const DEFAULT_EQUITY_ALLOCATION = 0.06;  // 6%
```

Then restart the bot with `npm run dev:all`.

---

## Understanding the Flow

```
Pattern Detected (e.g., BTC Bat pattern)
        ↓
Signal Created with Entry Price = $66,000
        ↓
Position Sizing calculates:
  - Allocation = 7% (crypto)
  - Funds = $100,000 × 0.07 = $7,000
  - Qty = $7,000 ÷ $66,000 = 0.106 BTC
        ↓
Anti-422 Formatter cleans the quantity
  - 0.106248765 BTC → 0.106248765 (9 decimals max)
  - Price $66,000.12 → $66,000.12 (2 decimals)
        ↓
Alpaca Order Placed:
  - Buy 0.106 BTC at limit $66,000
  - Good-Till-Canceled (GTC)
        ↓
If Pattern Completes:
  - Order executes
  - Account balance updates
  - Next signal uses NEW balance for sizing
```

---

## Checking Your Current Quantities

When Pattern Bot places an order, it logs the quantity:

```
[Alpaca] Placing buy limit order: BTC/USD 
  qty=0.106248765 
  price=66000.12 
  (7% of $100,216.37)
```

This tells you:
- **qty=0.106248765** → You're buying 0.106 BTC
- **7% of $100,216.37** → You're risking $7,015 of your $100,216 account
- **price=66000.12** → At exactly this limit price

---

## Safety Rules

✅ **Always positive** — qty and price must be > 0  
✅ **Never NULL** — Zod schema enforces this  
✅ **Formatted for Alpaca** — Decimal precision locked down  
✅ **Conservative defaults** — 5–7% is safe for most traders  
✅ **Dynamic updates** — Uses current account balance, not fixed amount  

---

## FAQ

**Q: Why does my position size change between trades?**  
A: Your account balance changes as previous trades win/lose. Position sizing uses your *current* equity, so each trade adjusts accordingly.

**Q: Can I risk more than 7% per trade?**  
A: Yes! Edit the code constants or add database settings. But going above 10% per trade is risky — you could lose your account in 10 bad trades.

**Q: What if I only have $1,000 account?**  
A: 7% of $1,000 = $70 per crypto trade. You can still trade fractional coins, and Pattern Bot handles this automatically.

**Q: Why are stocks 5% and crypto 7%?**  
A: Crypto is more volatile, so 5% seems safer for stocks. But these are just defaults — you can change them!

---

## Summary

Position sizing is **automatic and conservative**:
- Crypto trades risk **7%** of your account per trade
- Equity trades risk **5%** of your account per trade
- Quantity is calculated as: `(Account × Allocation) ÷ Entry Price`
- The quantity is formatted to prevent Alpaca rejection
- Your balance updates after each trade, so next trade's size adjusts

**Bottom line:** You're never betting your whole account on one trade. You're betting a small, calculated slice, with a stop loss to limit damage if wrong.
