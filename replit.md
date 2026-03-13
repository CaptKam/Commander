# Pattern Bot — Replit Agent Instructions

> **Read `CLAUDE.md` first.** It contains the full architecture rules, critical system constraints, and pattern exclusions. Everything in `CLAUDE.md` applies here. The rules below are Replit-specific additions.

## How to Run

```bash
# Install dependencies
npm ci --legacy-peer-deps

# Build the React dashboard
npm run build

# Start the hybrid server (Dashboard + Trading Engine)
node --import tsx server/index.ts
```

The app serves the dashboard on port 3000 and boots the trading engine in the same process.

## Project Structure

```
server/
  index.ts          # Express server + engine boot (entry point)
  orchestrator.ts   # 24/7 trading engine loop
  api.ts            # Dashboard REST API routes
  screener.ts       # Harmonic pattern scanner (Phase C)
  executor.ts       # Alpaca order execution
  db/
    schema.ts       # Drizzle ORM schema (PostgreSQL)
client/
  src/
    App.tsx         # React dashboard (single-page)
```

## Replit-Specific Rules

1. **Entry Point:** `node --import tsx server/index.ts` — do NOT change this to `npx ts-node` or add a separate dev server.
2. **Build Output:** Vite builds to `dist/` at the project root. The Express server serves static files from `process.cwd()/dist`. Do not change this path.
3. **Environment Variables:** All secrets (Alpaca keys, DB URL, FMP key) are in Replit Secrets. NEVER hardcode API keys or connection strings.
4. **Paper Trading Only:** Always use `https://paper-api.alpaca.markets`. Never default to the live endpoint.
5. **No Mock Data:** Never hardcode fake prices, fake positions, or test JSON. Always pull from the real Alpaca paper account or the PostgreSQL database.
6. **Database:** PostgreSQL via Drizzle ORM only. Do not use raw SQL strings or add a second ORM.
7. **No New Frameworks:** Do not add Next.js, Prisma, Sequelize, or any framework not already in `package.json`.
