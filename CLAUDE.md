# Pattern Bot: System Directives & Architecture

## Project Overview
Pattern Bot is an automated harmonic pattern detection and execution system. It scans crypto and equity markets across 1-day and 4-hour timeframes, detects XABCD harmonic structures (Gartley, Bat, Alt Bat, Butterfly, ABCD), and places live trades via the Alpaca API.

## Tech Stack
- **Backend:** Node.js, Express, TypeScript
- **Database:** PostgreSQL (via Neon/Supabase), Drizzle ORM
- **Frontend:** React, Vite, Tailwind CSS, shadcn/ui
- **Integrations:** Alpaca API (Trading + Market Data)

## CRITICAL SYSTEM RULES (NEVER VIOLATE)

### 1. Alpaca API Decimal Precision (Anti-422 Error Rule)
Alpaca will instantly reject orders with a 422 Unprocessable Entity if decimal limits are exceeded. You MUST strictly format all numeric payloads before sending to Alpaca:
- **Crypto Quantity (qty):** MAXIMUM of 9 decimal places (e.g., 0.000000001).
- **Crypto Limit Price (limit_price):** Round appropriately based on the asset (usually 2 to 4 decimal places max for high-value coins like BTC).
- **Rule:** Always use a utility formatter (e.g., `Number(val.toFixed(9))`) before injecting variables into the Alpaca order payload.

### 2. State Management & Exits (Anti-NULL Rule)
- **Zero In-Memory State:** Auto-trade configs, open positions, and pending signals must NEVER live in-memory. They must be saved to the PostgreSQL database via Drizzle ORM.
- **Strict TP/SL Variables:** The `tp1Price` and `tp2Price` split exit targets MUST be calculated, validated via Zod schemas, and permanently stamped to the `live_signals` database row. They can NEVER be NULL upon trade execution.

### 3. Phase C (Forming Pattern) Filtering
- **Pattern Exclusions:** The "Crab" and "Deep Crab" patterns are globally DISABLED due to low win rates.
- **Rule:** You must ensure that the `screener.ts` Phase C logic explicitly filters out Crab/Deep Crab patterns before calculating projected D limit orders.

### 4. Development Workflow
- **No Hallucinations:** Do not guess file paths or assume external package exports. If you are unsure, use your grep or ls tools to verify the codebase structure before writing code.
- **Database Migrations:** ONLY use Drizzle ORM for database queries. If you change a schema, explicitly remind the user to run the Drizzle migration command.
- **Decoupled Architecture:** Treat the Alpaca Data Scanner, the Harmonic Compute Engine, and the Alpaca Execution Engine as decoupled components. API latency in one must not crash the others.
- **Alpaca Rate Limit:** We are on the Algo Trader Plus tier (1000 req/min). The rate limiter in `alpaca-data.ts` enforces this with 100ms throttling between calls. Do NOT add unbounded API loops or remove the cache TTLs.

## Current Focus
We are migrating off a fragile prototype environment into a robust production environment. Focus on stability, strict TypeScript typing, and eliminating silent failures.
