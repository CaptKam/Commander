/**
 * Universe Manager — Discovers all tradeable assets on Alpaca
 *
 * Pulls the full asset list, filters for quality (active, tradeable,
 * major exchange, not OTC/penny), and returns symbols ready to seed
 * into the tiered scanner.
 *
 * Called periodically (once per day) to pick up new listings and
 * remove delisted symbols.
 */

import { checkTradingRateLimit } from "./utils/tradingRateLimiter";

// ============================================================
// Types
// ============================================================
export interface FilteredAsset {
  symbol: string;
  name: string;
  assetClass: "equity" | "crypto";
  exchange: string;
}

interface AlpacaAsset {
  symbol: string;
  name: string;
  exchange: string;
  status: string;
  tradable: boolean;
  class: string;
}

interface UniverseStats {
  totalEquities: number;
  totalCrypto: number;
  totalFiltered: number;
  exchanges: Record<string, number>;
  lastRefreshed: string | null;
}

// ============================================================
// Alpaca trading API base (NOT data API)
// ============================================================
function getAlpacaBase(): string {
  const raw = process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
  return raw.replace(/\/v2\/?$/, "");
}

function getAlpacaHeaders(): Record<string, string> | null {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) return null;
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

// ============================================================
// Module-level cache (metadata only — complies with CLAUDE.md Rule #2)
// ============================================================
let cachedAssets: FilteredAsset[] | null = null;
let cachedStats: UniverseStats | null = null;
let lastRefreshedAt: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ============================================================
// Function 1: fetchAlpacaAssets()
// ============================================================
async function fetchAlpacaAssets(): Promise<{ equities: AlpacaAsset[]; crypto: AlpacaAsset[] }> {
  const base = getAlpacaBase();
  const headers = getAlpacaHeaders();
  if (!headers) {
    console.warn("[Universe] Alpaca keys not configured — returning empty asset list");
    return { equities: [], crypto: [] };
  }

  let equities: AlpacaAsset[] = [];
  let crypto: AlpacaAsset[] = [];

  // Fetch equities
  try {
    checkTradingRateLimit();
    const res = await fetch(`${base}/v2/assets?status=active&asset_class=us_equity`, { headers });
    if (res.ok) {
      equities = (await res.json()) as AlpacaAsset[];
    } else {
      const body = await res.text();
      console.error(`[Universe] Failed to fetch equities: ${res.status} — ${body}`);
    }
  } catch (err) {
    console.error("[Universe] Error fetching equities:", err);
  }

  // Fetch crypto
  try {
    checkTradingRateLimit();
    const res = await fetch(`${base}/v2/assets?status=active&asset_class=crypto`, { headers });
    if (res.ok) {
      crypto = (await res.json()) as AlpacaAsset[];
    } else {
      const body = await res.text();
      console.error(`[Universe] Failed to fetch crypto: ${res.status} — ${body}`);
    }
  } catch (err) {
    console.error("[Universe] Error fetching crypto:", err);
  }

  console.log(`[Universe] Fetched ${equities.length} equities, ${crypto.length} crypto from Alpaca`);
  return { equities, crypto };
}

// ============================================================
// Function 2: filterAssets()
// ============================================================
const MAJOR_EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "ARCA", "BATS"]);

function filterAssets(raw: { equities: AlpacaAsset[]; crypto: AlpacaAsset[] }): FilteredAsset[] {
  const results: FilteredAsset[] = [];

  // Equity filters
  for (const asset of raw.equities) {
    if (!asset.tradable) continue;
    if (asset.status !== "active") continue;
    if (!MAJOR_EXCHANGES.has(asset.exchange)) continue;
    if (asset.symbol.includes(".") || asset.symbol.includes("/")) continue;
    if (asset.symbol.length > 5) continue;

    results.push({
      symbol: asset.symbol,
      name: asset.name,
      assetClass: "equity",
      exchange: asset.exchange,
    });
  }

  const equityCount = results.length;

  // Crypto filters
  for (const asset of raw.crypto) {
    if (!asset.tradable) continue;
    if (asset.status !== "active") continue;
    if (!asset.symbol.includes("/USD")) continue;

    results.push({
      symbol: asset.symbol,
      name: asset.name,
      assetClass: "crypto",
      exchange: asset.exchange,
    });
  }

  const cryptoCount = results.length - equityCount;
  console.log(`[Universe] After filtering: ${equityCount} equities (major exchange, no OTC), ${cryptoCount} crypto`);

  return results;
}

// ============================================================
// Function 3: getFullUniverse()
// ============================================================
export async function getFullUniverse(): Promise<FilteredAsset[]> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedAssets && now - lastRefreshedAt < CACHE_TTL_MS) {
    return cachedAssets;
  }

  const raw = await fetchAlpacaAssets();
  const filtered = filterAssets(raw);

  // Update cache
  cachedAssets = filtered;
  lastRefreshedAt = now;

  // Build stats
  const exchanges: Record<string, number> = {};
  let totalEquities = 0;
  let totalCrypto = 0;
  for (const asset of filtered) {
    if (asset.assetClass === "equity") {
      totalEquities++;
    } else {
      totalCrypto++;
    }
    exchanges[asset.exchange] = (exchanges[asset.exchange] ?? 0) + 1;
  }
  cachedStats = {
    totalEquities,
    totalCrypto,
    totalFiltered: filtered.length,
    exchanges,
    lastRefreshed: new Date(lastRefreshedAt).toISOString(),
  };

  return filtered;
}

// ============================================================
// Function 4: getUniverseStats()
// ============================================================
export async function getUniverseStats(): Promise<UniverseStats> {
  if (cachedStats && Date.now() - lastRefreshedAt < CACHE_TTL_MS) {
    return cachedStats;
  }

  // Trigger a fresh fetch to populate stats
  await getFullUniverse();

  return cachedStats ?? {
    totalEquities: 0,
    totalCrypto: 0,
    totalFiltered: 0,
    exchanges: {},
    lastRefreshed: null,
  };
}
