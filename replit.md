# Pattern Bot

> **Read `CLAUDE.md` first.** It contains the full architecture rules, critical system constraints, and pattern exclusions. Everything in `CLAUDE.md` applies here. The rules below are Replit-specific additions.

An automated harmonic pattern detection and execution system. Scans crypto and equity markets across 1-day and 4-hour timeframes, detects XABCD harmonic structures, and places live trades via the Alpaca API.

## Tech Stack

- **Frontend:** React 19, Vite 7, Tailwind CSS 4 (in `client/`)
- **Backend:** Node.js, Express 5, TypeScript (in `server/`)
- **Database:** PostgreSQL via Drizzle ORM (Replit built-in Postgres)
- **Trading API:** Alpaca (paper/live trading + market data)
- **Notifications:** Telegram bot (optional)

## Project Structure

```
client/         React frontend dashboard
server/         Express backend + trading engine
  index.ts      Entry point (boots Express + trading engine)
  api.ts        REST API routes (/api/*)
  db.ts         Drizzle ORM database connection
  orchestrator.ts  Main scanner loop (30s interval)
  patterns.ts   Harmonic pattern detection (XABCD)
  screener.ts   Phase C signal filtering
  alpaca.ts     Alpaca order execution
  alpaca-data.ts  Alpaca market data (candle bars) + rate limiter
  websocket-stream.ts  Real-time price streaming (crypto + stock WebSocket)
  exit-manager.ts  Automated TP/SL order lifecycle
  crypto-monitor.ts  Position monitor (TP/SL via streaming prices)
  quality-filters.ts  7-rule signal quality validation
shared/
  schema.ts     Drizzle schema + Zod validation
```

## Development

- `npm run dev:all` — starts both frontend (port 5000) and backend (port 3000) concurrently
- `npm run dev` — frontend only (Vite on port 5000)
- `npm run dev:server` — backend only (Express on port 3000)
- `npm run build` — builds frontend to `dist/`
- `npm start` — production mode (serves built frontend + runs trading engine)

## Environment Variables

Required for full functionality (see `.env.example`):
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit)
- `ALPACA_API_KEY` — Alpaca API key
- `ALPACA_API_SECRET` — Alpaca API secret
- `ALPACA_BASE_URL` — Alpaca endpoint (default: paper trading)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token (optional, for notifications)
- `TELEGRAM_CHAT_ID` — Telegram chat ID (optional)

## Deployment

Configured as a VM deployment (always-running) to support the 24/7 trading engine loop.
Build step: `npm run build` (compiles React frontend)
Run command: `npm start` (Express serves static frontend + runs trading engine on port 3000)

## Dashboard Pages (Commander v2)

The frontend (`client/src/App.tsx`) is a single-page app with top navigation tabs and left sidebar navigation:

**Bottom Tabs (Main View):**
- **LIVE FEED** — Unified event timeline: signals, approaching trades, fills, and closed trades
- **PIPELINE** — 8-step scan pipeline visualization with expand/collapse per step
- **SCANNER** — Phase distribution bar, hot symbols, universe stats
- **DIAGNOSTICS** — Comprehensive system health dashboard: system uptime, WebSocket stream status, data cache stats, pipeline summary, scanner phase distribution with overdue alerts, open Alpaca orders, account equity/buying power, signal breakdown by status/asset class/direction, and stale signal detection (48h+). Auto-refreshes every 15 seconds via `/api/diagnostics/full`.

**Right Sidebar:**
- Risk (equity, buying power, GTC locked %), Stats (win rate, W/L, profit factor), Imminent approaching trades, Alerts, Recent fills

All pages pull live data from the backend API endpoints and auto-refresh every 10 seconds.

## Architecture Notes

- The Vite dev server (port 5000) proxies `/api/*` requests to the Express backend (port 3000)
- In production, Express serves the built frontend statically and handles all requests on port 3000
- Database is Replit's built-in PostgreSQL; `ensureTablesExist()` auto-creates schema at boot
- Trading engine runs as a mutex-locked scan loop to prevent overlapping API calls
- Crab and Deep Crab patterns are globally disabled (low win rates)

## Replit Agent Rules

1. **Entry Point:** `node --import tsx server/index.ts` — do NOT change this to `npx ts-node` or add a separate dev server.
2. **Build Output:** Vite builds to `dist/` at the project root. The Express server serves static files from `process.cwd()/dist`. Do not change this path.
3. **Environment Variables:** All secrets are in Replit Secrets. NEVER hardcode API keys or connection strings.
4. **Paper Trading Only:** Always use `https://paper-api.alpaca.markets`. Never default to the live endpoint.
5. **No Mock Data:** Never hardcode fake prices, fake positions, or test JSON. Always pull from the real Alpaca paper account or the PostgreSQL database.
6. **Database:** PostgreSQL via Drizzle ORM only. Do not use raw SQL strings or add a second ORM.
7. **No New Frameworks:** Do not add Next.js, Prisma, Sequelize, or any framework not already in `package.json`.
