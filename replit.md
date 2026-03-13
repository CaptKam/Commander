# Pattern Bot

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
  fmp.ts        FMP market data fetching
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

## Architecture Notes

- The Vite dev server (port 5000) proxies `/api/*` requests to the Express backend (port 3000)
- In production, Express serves the built frontend statically and handles all requests on port 3000
- Database is Replit's built-in PostgreSQL; `ensureTablesExist()` auto-creates schema at boot
- Trading engine runs as a mutex-locked scan loop to prevent overlapping API calls
- Crab and Deep Crab patterns are globally disabled (low win rates)
