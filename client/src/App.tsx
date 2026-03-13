import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Wallet,
  DollarSign,
  Zap,
  CircleDot,
  Target,
  BarChart3,
  Skull,
  Plus,
  Trash2,
  Eye,
  Settings,
  Power,
  Shield,
} from "lucide-react";

// ============================================================
// Types
// ============================================================
interface Account {
  equity: number;
  buying_power: number;
  portfolio_value: number;
  daily_pl: number;
  daily_pl_pct: number;
  error?: string;
}

interface Position {
  symbol: string;
  qty: number;
  side: string;
  entry_price: number;
  current_price: number;
  market_value: number;
  unrealized_pl: number;
  unrealized_pl_pct: number;
  stop_loss: number | null;
  tp1: number | null;
  tp2: number | null;
  pattern: string | null;
}

interface Signal {
  id: number;
  symbol: string;
  patternType: string;
  timeframe: string;
  direction: string;
  entryPrice: string;
  stopLossPrice: string;
  tp1Price: string;
  tp2Price: string;
  xPrice: string | null;
  aPrice: string | null;
  bPrice: string | null;
  cPrice: string | null;
  status: string;
  createdAt: string;
}

interface Status {
  status: string;
  uptime: number;
}

interface Metrics {
  win_rate: number;
  profit_factor: number;
  total_trades: number;
  wins: number;
  losses: number;
}

interface ClosedTrade {
  symbol: string;
  side: string;
  qty: number;
  filled_price: number;
  submitted_at: string;
  filled_at: string;
  pattern: string | null;
  direction: string | null;
  entry_price: number | null;
  stop_loss: number | null;
  tp1: number | null;
  tp2: number | null;
}

interface WatchlistEntry {
  symbol: string;
  assetClass: string;
}

interface BotSettings {
  trading_enabled: boolean;
  equity_allocation: number;
  crypto_allocation: number;
  enabled_patterns: string[];
}

const ALL_PATTERNS = ["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"] as const;
const POLL_INTERVAL = 10_000;

// ============================================================
// Helpers
// ============================================================
function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ============================================================
// App
// ============================================================
export default function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [history, setHistory] = useState<ClosedTrade[]>([]);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistEntry[]>([]);
  const [newSymbol, setNewSymbol] = useState("");
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [acctRes, posRes, sigRes, statRes, metRes, histRes, wlRes, setRes] =
        await Promise.allSettled([
          fetch("/api/account").then((r) => r.json()),
          fetch("/api/positions").then((r) => r.json()),
          fetch("/api/signals").then((r) => r.json()),
          fetch("/api/status").then((r) => r.json()),
          fetch("/api/metrics").then((r) => r.json()),
          fetch("/api/history").then((r) => r.json()),
          fetch("/api/watchlist").then((r) => r.json()),
          fetch("/api/settings").then((r) => r.json()),
        ]);
      if (acctRes.status === "fulfilled") setAccount(acctRes.value);
      if (posRes.status === "fulfilled" && Array.isArray(posRes.value))
        setPositions(posRes.value);
      if (sigRes.status === "fulfilled" && Array.isArray(sigRes.value))
        setSignals(sigRes.value);
      if (statRes.status === "fulfilled") setStatus(statRes.value);
      if (metRes.status === "fulfilled") setMetrics(metRes.value);
      if (histRes.status === "fulfilled" && Array.isArray(histRes.value))
        setHistory(histRes.value);
      if (wlRes.status === "fulfilled" && Array.isArray(wlRes.value))
        setWatchlistItems(wlRes.value);
      if (setRes.status === "fulfilled" && setRes.value && !setRes.value.error)
        setBotSettings(setRes.value);
    } catch {
      // silent — dashboard will show stale data
    } finally {
      setLoading(false);
    }
  }, []);

  const addSymbol = useCallback(async () => {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    try {
      await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym }),
      });
      setNewSymbol("");
      fetchAll();
    } catch {
      // silent
    }
  }, [newSymbol, fetchAll]);

  const removeSymbol = useCallback(async (sym: string) => {
    try {
      await fetch(`/api/watchlist/${encodeURIComponent(sym)}`, {
        method: "DELETE",
      });
      fetchAll();
    } catch {
      // silent
    }
  }, [fetchAll]);

  const updateSettings = useCallback(async (patch: Partial<BotSettings>) => {
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setBotSettings((prev) => prev ? { ...prev, ...patch } : prev);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAll]);

  const isOnline = status?.status === "online";
  const plColor =
    (account?.daily_pl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400";

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <Zap className="w-10 h-10 text-amber-400 mx-auto mb-3 animate-pulse" />
          <p className="text-gray-400 text-sm">Loading Pattern Bot Dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 md:p-6">
      {/* ==================== TOP BAR ==================== */}
      <header className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Zap className="w-6 h-6 text-amber-400" />
            Pattern Bot
          </h1>
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                isOnline
                  ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                  : "bg-red-400"
              }`}
            />
            <span className={isOnline ? "text-emerald-400" : "text-red-400"}>
              {isOnline ? "System Online" : "Offline"}
            </span>
            {status && (
              <span className="text-gray-500 ml-1">
                ({formatUptime(status.uptime)})
              </span>
            )}
          </div>
        </div>

        {/* Stat Cards — Row 1: Account */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <StatCard
            icon={<DollarSign className="w-4 h-4 text-amber-400" />}
            label="Account Value"
            value={account ? formatUsd(account.equity) : "—"}
          />
          <StatCard
            icon={<Wallet className="w-4 h-4 text-blue-400" />}
            label="Buying Power"
            value={account ? formatUsd(account.buying_power) : "—"}
          />
          <StatCard
            icon={
              (account?.daily_pl ?? 0) >= 0 ? (
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              ) : (
                <TrendingDown className="w-4 h-4 text-red-400" />
              )
            }
            label="Today's P&L"
            value={account ? formatUsd(account.daily_pl) : "—"}
            valueClass={plColor}
            sub={
              account
                ? `${account.daily_pl_pct >= 0 ? "+" : ""}${account.daily_pl_pct.toFixed(2)}%`
                : undefined
            }
          />
          <StatCard
            icon={<Activity className="w-4 h-4 text-purple-400" />}
            label="Open Positions"
            value={String(positions.length)}
          />
        </div>

        {/* Stat Cards — Row 2: Performance Matrix */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={<Target className="w-4 h-4 text-cyan-400" />}
            label="Win Rate"
            value={metrics ? `${metrics.win_rate}%` : "—"}
            valueClass={
              metrics && metrics.win_rate >= 50
                ? "text-emerald-400"
                : metrics && metrics.win_rate > 0
                  ? "text-amber-400"
                  : undefined
            }
            sub={metrics ? `${metrics.wins}W / ${metrics.losses}L` : undefined}
          />
          <StatCard
            icon={<BarChart3 className="w-4 h-4 text-orange-400" />}
            label="Profit Factor"
            value={
              metrics
                ? metrics.profit_factor === Infinity
                  ? "INF"
                  : String(metrics.profit_factor)
                : "—"
            }
            valueClass={
              metrics && metrics.profit_factor >= 1.5
                ? "text-emerald-400"
                : metrics && metrics.profit_factor >= 1
                  ? "text-amber-400"
                  : metrics && metrics.profit_factor > 0
                    ? "text-red-400"
                    : undefined
            }
            sub={metrics && metrics.profit_factor >= 1.5 ? "Strong" : metrics && metrics.profit_factor >= 1 ? "Breakeven" : undefined}
          />
          <StatCard
            icon={<Activity className="w-4 h-4 text-indigo-400" />}
            label="Total Trades"
            value={metrics ? String(metrics.total_trades) : "—"}
          />
          <StatCard
            icon={<Zap className="w-4 h-4 text-amber-400" />}
            label="Signals Detected"
            value={String(signals.length)}
          />
        </div>
      </header>

      {/* ==================== BODY ==================== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* LEFT: Active Positions (with SL/TP) */}
        <section className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <CircleDot className="w-4 h-4 text-blue-400" />
            <h2 className="font-semibold text-sm">Active Positions</h2>
          </div>
          {positions.length === 0 ? (
            <div className="p-8 text-center text-gray-500 text-sm">
              No open positions
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-gray-800">
                    <th className="text-left px-4 py-2">Symbol</th>
                    <th className="text-right px-4 py-2">Qty</th>
                    <th className="text-right px-4 py-2">Entry</th>
                    <th className="text-right px-4 py-2">Current</th>
                    <th className="text-right px-4 py-2">SL</th>
                    <th className="text-right px-4 py-2">TP1</th>
                    <th className="text-right px-4 py-2">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr
                      key={p.symbol}
                      className="border-b border-gray-800/50 hover:bg-gray-800/40"
                    >
                      <td className="px-4 py-2.5">
                        <span className="font-medium">{p.symbol}</span>
                        {p.pattern && (
                          <span className="text-xs text-gray-500 ml-1.5">
                            {p.pattern}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-300">
                        {p.qty}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-300">
                        {formatUsd(p.entry_price)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-300">
                        {formatUsd(p.current_price)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-red-400/80 text-xs">
                        {p.stop_loss ? formatUsd(p.stop_loss) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-emerald-400/80 text-xs">
                        {p.tp1 ? formatUsd(p.tp1) : "—"}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-medium ${
                          p.unrealized_pl >= 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {formatUsd(p.unrealized_pl)}
                        <span className="text-xs text-gray-500 ml-1">
                          ({p.unrealized_pl_pct >= 0 ? "+" : ""}
                          {p.unrealized_pl_pct.toFixed(1)}%)
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* RIGHT: Live Scanner Feed */}
        <section className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-sm">Live Scanner Feed</h2>
            <span className="text-xs text-gray-500 ml-auto">
              {signals.length} signals
            </span>
          </div>
          {signals.length === 0 ? (
            <div className="p-8 text-center text-gray-500 text-sm">
              No signals detected yet
            </div>
          ) : (
            <div className="max-h-[500px] overflow-y-auto divide-y divide-gray-800/50">
              {signals.map((s) => (
                <div
                  key={s.id}
                  className="px-4 py-3 hover:bg-gray-800/40 flex items-center gap-3"
                >
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${
                      s.direction === "long"
                        ? "bg-emerald-400"
                        : "bg-red-400"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.symbol}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                        {s.timeframe}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                        {s.patternType}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {s.direction.toUpperCase()} @ {formatUsd(Number(s.entryPrice))}
                      {" · "}SL {formatUsd(Number(s.stopLossPrice))}
                      {" · "}TP1 {formatUsd(Number(s.tp1Price))}
                      {" · "}TP2 {formatUsd(Number(s.tp2Price))}
                    </div>
                    {s.xPrice && (
                      <div className="text-xs text-gray-600 mt-0.5 font-mono">
                        X={formatUsd(Number(s.xPrice))} A={formatUsd(Number(s.aPrice))} B={formatUsd(Number(s.bPrice))} C={formatUsd(Number(s.cPrice))}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-gray-500 whitespace-nowrap">
                    {timeAgo(s.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ==================== CONTROL PANELS (side by side) ==================== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">

      {/* WATCHLIST MANAGER */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
          <Eye className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-sm">Watchlist Manager</h2>
          <span className="text-xs text-gray-500 ml-auto">
            {watchlistItems.length} symbols
          </span>
        </div>
        <div className="p-4">
          {/* Add symbol input */}
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addSymbol()}
              placeholder="Add symbol (e.g. NVDA, SOL/USD)"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-amber-400/50"
            />
            <button
              onClick={addSymbol}
              className="bg-amber-400/10 text-amber-400 border border-amber-400/20 rounded-lg px-3 py-2 text-sm font-medium hover:bg-amber-400/20 transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
          {/* Symbol chips */}
          {watchlistItems.length === 0 ? (
            <p className="text-gray-500 text-sm">No symbols in watchlist</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {watchlistItems.map((w) => (
                <div
                  key={w.symbol}
                  className="flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm group"
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      w.assetClass === "crypto"
                        ? "bg-orange-400"
                        : "bg-blue-400"
                    }`}
                  />
                  <span className="font-medium text-gray-200">{w.symbol}</span>
                  <span className="text-xs text-gray-500">{w.assetClass}</span>
                  <button
                    onClick={() => removeSymbol(w.symbol)}
                    className="ml-1 text-gray-600 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* SYSTEM SETTINGS */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
          <Settings className="w-4 h-4 text-gray-400" />
          <h2 className="font-semibold text-sm">System Settings</h2>
        </div>
        {botSettings ? (
          <div className="p-4 space-y-4">
            {/* Kill Switch */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Power className={`w-4 h-4 ${botSettings.trading_enabled ? "text-emerald-400" : "text-red-400"}`} />
                <span className="text-sm font-medium">Live Auto-Trading</span>
              </div>
              <button
                onClick={() => updateSettings({ trading_enabled: !botSettings.trading_enabled })}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  botSettings.trading_enabled ? "bg-emerald-500" : "bg-gray-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                    botSettings.trading_enabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Position Sizing */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-xs text-gray-400">Position Sizing</span>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-400 w-20">Stock %</label>
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={Math.round(botSettings.equity_allocation * 100)}
                  onChange={(e) =>
                    updateSettings({ equity_allocation: Number(e.target.value) / 100 })
                  }
                  className="flex-1 accent-blue-400 h-1.5"
                />
                <span className="text-sm font-medium w-10 text-right">
                  {Math.round(botSettings.equity_allocation * 100)}%
                </span>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-400 w-20">Crypto %</label>
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={Math.round(botSettings.crypto_allocation * 100)}
                  onChange={(e) =>
                    updateSettings({ crypto_allocation: Number(e.target.value) / 100 })
                  }
                  className="flex-1 accent-orange-400 h-1.5"
                />
                <span className="text-sm font-medium w-10 text-right">
                  {Math.round(botSettings.crypto_allocation * 100)}%
                </span>
              </div>
            </div>

            {/* Pattern Toggles */}
            <div className="space-y-2">
              <span className="text-xs text-gray-400">Enabled Patterns</span>
              <div className="flex flex-wrap gap-2">
                {ALL_PATTERNS.map((p) => {
                  const isEnabled = botSettings.enabled_patterns.includes(p);
                  return (
                    <button
                      key={p}
                      onClick={() => {
                        const next = isEnabled
                          ? botSettings.enabled_patterns.filter((x) => x !== p)
                          : [...botSettings.enabled_patterns, p];
                        if (next.length > 0) updateSettings({ enabled_patterns: next });
                      }}
                      className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                        isEnabled
                          ? "bg-amber-400/10 text-amber-400 border-amber-400/30"
                          : "bg-gray-800 text-gray-500 border-gray-700"
                      }`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-gray-500 text-sm">
            Loading settings...
          </div>
        )}
      </section>

      </div>

      {/* ==================== TRADE HISTORY (Graveyard) ==================== */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
          <Skull className="w-4 h-4 text-gray-400" />
          <h2 className="font-semibold text-sm">Trade History</h2>
          <span className="text-xs text-gray-500 ml-auto">
            {history.length} closed trades
          </span>
        </div>
        {history.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">
            No closed trades yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-xs border-b border-gray-800">
                  <th className="text-left px-4 py-2">Symbol</th>
                  <th className="text-left px-4 py-2">Side</th>
                  <th className="text-right px-4 py-2">Qty</th>
                  <th className="text-right px-4 py-2">Filled Price</th>
                  <th className="text-right px-4 py-2">SL</th>
                  <th className="text-right px-4 py-2">TP1</th>
                  <th className="text-left px-4 py-2">Pattern</th>
                  <th className="text-right px-4 py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {history.map((t, i) => (
                  <tr
                    key={`${t.symbol}-${t.filled_at}-${i}`}
                    className="border-b border-gray-800/50 hover:bg-gray-800/40"
                  >
                    <td className="px-4 py-2.5 font-medium">{t.symbol}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                          t.side === "buy"
                            ? "bg-emerald-400/10 text-emerald-400"
                            : "bg-red-400/10 text-red-400"
                        }`}
                      >
                        {t.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-300">
                      {t.qty}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-300">
                      {formatUsd(t.filled_price)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-red-400/80 text-xs">
                      {t.stop_loss ? formatUsd(t.stop_loss) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-emerald-400/80 text-xs">
                      {t.tp1 ? formatUsd(t.tp1) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs">
                      {t.pattern ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-500 text-xs whitespace-nowrap">
                      {t.filled_at ? timeAgo(t.filled_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ============================================================
// Stat Card Component
// ============================================================
function StatCard({
  icon,
  label,
  value,
  valueClass,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
  sub?: string;
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-lg font-bold ${valueClass ?? "text-gray-100"}`}>
        {value}
      </div>
      {sub && <div className={`text-xs ${valueClass ?? "text-gray-400"}`}>{sub}</div>}
    </div>
  );
}
