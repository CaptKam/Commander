import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Zap,
  Target,
  BarChart3,
  Plus,
  Minus,
  Eye,
  Settings,
  Power,
  Shield,
  Bell,
  User,
  Globe,
  Clock,
  AlertTriangle,
  XCircle,
  FileBarChart,
  Trash2,
  RefreshCw,
  Skull,
  X,
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

interface ApproachingSignal {
  id: number;
  symbol: string;
  pattern: string;
  direction: string;
  timeframe: string;
  projectedD: number;
  currentPrice: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number | null;
  x: number | null;
  a: number | null;
  b: number | null;
  c: number | null;
  distancePct: number;
  createdAt: string;
}

interface WatchlistEntry {
  symbol: string;
  assetClass: string;
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

interface BotSettings {
  trading_enabled: boolean;
  equity_allocation: number;
  crypto_allocation: number;
  enabled_patterns: string[];
}

const ALL_PATTERNS = ["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"] as const;
const POLL_INTERVAL = 10_000;
const MONO_FONT =
  "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// ============================================================
// Helpers
// ============================================================
function formatUsd(n: number): string {
  const abs = Math.abs(n);
  const decimals =
    abs === 0 ? 2 : abs < 0.001 ? 8 : abs < 0.1 ? 6 : abs < 1 ? 4 : 2;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
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

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function nowUtc(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// ============================================================
// Tab / Sidebar types
// ============================================================
type TabId = "terminal" | "analytics" | "risk" | "logs";

const TAB_TO_SIDEBAR: Record<TabId, string> = {
  terminal: "EXECUTE",
  analytics: "PORTFOLIO",
  risk: "RISK GUARD",
  logs: "SIGNAL LOG",
};

const SIDEBAR_TO_TAB: Record<string, TabId> = {
  EXECUTE: "terminal",
  PORTFOLIO: "analytics",
  "RISK GUARD": "risk",
  "SIGNAL LOG": "logs",
};

// ============================================================
// App
// ============================================================
export default function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [approaching, setApproaching] = useState<ApproachingSignal[]>([]);
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistEntry[]>([]);
  const [history, setHistory] = useState<ClosedTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("terminal");
  const [newSymbol, setNewSymbol] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [acctRes, posRes, sigRes, statRes, metRes, appRes, setRes, wlRes, histRes] =
        await Promise.allSettled([
          fetch("/api/account").then((r) => r.json()),
          fetch("/api/positions").then((r) => r.json()),
          fetch("/api/signals").then((r) => r.json()),
          fetch("/api/status").then((r) => r.json()),
          fetch("/api/metrics").then((r) => r.json()),
          fetch("/api/approaching").then((r) => r.json()),
          fetch("/api/settings").then((r) => r.json()),
          fetch("/api/watchlist").then((r) => r.json()),
          fetch("/api/history").then((r) => r.json()),
        ]);
      if (acctRes.status === "fulfilled") setAccount(acctRes.value);
      if (posRes.status === "fulfilled" && Array.isArray(posRes.value))
        setPositions(posRes.value);
      if (sigRes.status === "fulfilled" && Array.isArray(sigRes.value))
        setSignals(sigRes.value);
      if (statRes.status === "fulfilled") setStatus(statRes.value);
      if (metRes.status === "fulfilled") setMetrics(metRes.value);
      if (appRes.status === "fulfilled" && Array.isArray(appRes.value))
        setApproaching(appRes.value);
      if (setRes.status === "fulfilled" && setRes.value && !setRes.value.error)
        setBotSettings(setRes.value);
      if (wlRes.status === "fulfilled" && Array.isArray(wlRes.value))
        setWatchlistItems(wlRes.value);
      if (histRes.status === "fulfilled" && Array.isArray(histRes.value))
        setHistory(histRes.value);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  const updateSettings = useCallback(async (patch: Partial<BotSettings>) => {
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setBotSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    } catch {
      // silent
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

  const removeSymbol = useCallback(
    async (sym: string) => {
      try {
        await fetch(`/api/watchlist/${encodeURIComponent(sym)}`, {
          method: "DELETE",
        });
        fetchAll();
      } catch {
        // silent
      }
    },
    [fetchAll],
  );

  const clearSignals = useCallback(async () => {
    if (!confirm("Clear all signals from the feed?")) return;
    try {
      const res = await fetch("/api/signals/clear", { method: "POST" });
      if (res.ok) setSignals([]);
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

  // Derive a "primary" symbol from positions or approaching signals
  const primarySymbol =
    positions.length > 0
      ? positions[0].symbol
      : approaching.length > 0
        ? approaching[0].symbol
        : "BTC/USD";
  const primaryPrice =
    positions.length > 0
      ? positions[0].current_price
      : approaching.length > 0
        ? approaching[0].currentPrice
        : 0;
  const primaryPl =
    positions.length > 0
      ? positions[0].unrealized_pl_pct
      : account?.daily_pl_pct ?? 0;

  // Build log entries from signals
  const logEntries = signals.slice(0, 20).map((s) => ({
    time: new Date(s.createdAt).toLocaleTimeString("en-US", { hour12: false }),
    text: `${s.direction.toUpperCase()} ${s.symbol} ${s.patternType} @ ${formatUsd(Number(s.entryPrice))}`,
    type:
      s.status === "filled" ? "success" : s.status === "pending" ? "info" : "warn",
  }));

  // Imminent count for bell badge
  const imminentCount = approaching.filter((s) => s.distancePct < 5).length;

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--bg-main)" }}
      >
        <div className="text-center">
          <Zap
            className="w-10 h-10 mx-auto mb-3 animate-pulse"
            style={{ color: "var(--accent-green)" }}
          />
          <p style={{ color: "var(--text-muted)" }} className="text-sm">
            Loading Commander Terminal...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen h-screen flex flex-col overflow-hidden text-xs sm:text-sm">
      {/* ==================== HEADER ==================== */}
      <header
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: "var(--border-color)", background: "var(--bg-main)" }}
      >
        <div className="flex items-center space-x-4">
          <div
            className="w-8 h-8 rounded flex items-center justify-center border"
            style={{
              background: "var(--accent-green-dim)",
              borderColor: "#15803d",
              color: "var(--accent-green)",
            }}
          >
            <FileBarChart className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white tracking-wide">
              COMMANDER: PATTERN BOT (v2)
            </h1>
            <p
              className="text-[10px] uppercase tracking-wider"
              style={{ color: "var(--accent-green)" }}
            >
              {isOnline
                ? `Online · ${formatUptime(status?.uptime ?? 0)}`
                : "Connecting..."}
            </p>
          </div>
        </div>

        {/* Header Tabs */}
        <nav className="flex space-x-6">
          {(
            [
              ["terminal", "Terminal"],
              ["analytics", "Analytics"],
              ["risk", "Risk Engine"],
              ["logs", "Logs"],
            ] as [TabId, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`pb-1 uppercase font-semibold tracking-wider text-xs transition-colors ${
                activeTab === id ? "border-b-2" : "hover:text-white"
              }`}
              style={
                activeTab === id
                  ? {
                      color: "var(--accent-green)",
                      borderColor: "var(--accent-green)",
                    }
                  : { color: "var(--text-muted)" }
              }
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Header Buttons */}
        <div className="flex items-center space-x-3">
          {/* Bell — jumps to terminal tab + shows imminent count */}
          <button
            className="w-8 h-8 rounded flex items-center justify-center border transition-colors relative"
            style={{
              background: "var(--bg-panel)",
              borderColor: "var(--border-color)",
              color: imminentCount > 0 ? "var(--accent-amber)" : "var(--text-muted)",
            }}
            onClick={() => setActiveTab("terminal")}
            title={`${imminentCount} imminent signals`}
          >
            <Bell className="w-4 h-4" />
            {imminentCount > 0 && (
              <span
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[8px] font-bold flex items-center justify-center text-white"
                style={{ background: "var(--accent-red)" }}
              >
                {imminentCount}
              </span>
            )}
          </button>

          {/* Settings gear — toggles settings overlay */}
          <button
            className="w-8 h-8 rounded flex items-center justify-center border transition-colors"
            style={{
              background: showSettingsPanel ? "var(--accent-green-dim)" : "var(--bg-panel)",
              borderColor: showSettingsPanel ? "#166534" : "var(--border-color)",
              color: showSettingsPanel ? "var(--accent-green)" : "var(--text-muted)",
            }}
            onClick={() => setShowSettingsPanel(!showSettingsPanel)}
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>

          {/* User avatar — shows account info */}
          <button
            className="w-8 h-8 rounded flex items-center justify-center text-black font-bold text-xs bg-[#ebd8c3]"
            onClick={() => setActiveTab("analytics")}
            title="Account & Portfolio"
          >
            <User className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* ==================== MAIN CONTENT ==================== */}
      <main className="flex-1 flex overflow-hidden">
        {/* ---- LEFT SIDEBAR ---- */}
        <aside
          className="w-64 flex flex-col border-r p-4 space-y-6 overflow-y-auto"
          style={{ borderColor: "var(--border-color)", background: "var(--bg-main)" }}
        >
          {/* Market Pulse */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <span
                className="text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Market Pulse
              </span>
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  background: isOnline ? "#22c55e" : "#ef4444",
                  boxShadow: isOnline
                    ? "0 0 6px rgba(34,197,94,0.6)"
                    : undefined,
                }}
              />
            </div>
            <div
              className="rounded-md p-4 border"
              style={{
                background: "var(--bg-panel)",
                borderColor: "var(--border-color)",
              }}
            >
              <div
                className="text-[10px]"
                style={{ color: "var(--text-muted)" }}
              >
                {primarySymbol}
              </div>
              <div className="text-2xl font-bold text-white mb-2">
                {primaryPrice > 0 ? formatUsd(primaryPrice) : "—"}
              </div>
              <div className="flex justify-between text-xs">
                <span
                  style={{
                    color:
                      primaryPl >= 0
                        ? "var(--accent-green)"
                        : "var(--accent-red)",
                  }}
                >
                  {primaryPl >= 0 ? "+" : ""}
                  {primaryPl.toFixed(2)}%
                </span>
                <span style={{ color: "var(--accent-amber)" }}>
                  {positions.length} pos
                </span>
              </div>
            </div>
          </div>

          {/* Account Stats */}
          {account && (
            <div className="space-y-2">
              <span
                className="text-[10px] uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Account
              </span>
              <div
                className="rounded-md p-3 border space-y-2"
                style={{
                  background: "var(--bg-panel)",
                  borderColor: "var(--border-color)",
                }}
              >
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--text-muted)" }}>Equity</span>
                  <span className="text-white font-mono">
                    {formatUsd(account.equity)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--text-muted)" }}>
                    Buying Power
                  </span>
                  <span className="text-white font-mono">
                    {formatUsd(account.buying_power)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--text-muted)" }}>Day P&L</span>
                  <span
                    className="font-mono font-semibold"
                    style={{
                      color:
                        account.daily_pl >= 0
                          ? "var(--accent-green)"
                          : "var(--accent-red)",
                    }}
                  >
                    {account.daily_pl >= 0 ? "+" : ""}
                    {formatUsd(account.daily_pl)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Sidebar Navigation — synced with header tabs */}
          <nav className="space-y-2 flex-1">
            {(
              [
                { icon: <BarChart3 className="w-4 h-4" />, label: "EXECUTE" },
                { icon: <Activity className="w-4 h-4" />, label: "PORTFOLIO" },
                { icon: <Shield className="w-4 h-4" />, label: "RISK GUARD" },
                { icon: <Zap className="w-4 h-4" />, label: "SIGNAL LOG" },
              ] as { icon: React.ReactNode; label: string }[]
            ).map((item) => {
              const tabId = SIDEBAR_TO_TAB[item.label];
              const isActive = activeTab === tabId;
              return (
                <button
                  key={item.label}
                  onClick={() => setActiveTab(tabId)}
                  className={`w-full flex items-center space-x-3 rounded-md px-4 py-3 text-sm transition-colors text-left ${
                    isActive ? "font-semibold border" : ""
                  }`}
                  style={
                    isActive
                      ? {
                          background: "var(--accent-green-dim)",
                          color: "var(--accent-green)",
                          borderColor: "#166534",
                        }
                      : { color: "var(--text-muted)" }
                  }
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* System Status */}
          <div
            className="rounded-md p-4 border mt-auto"
            style={{
              background: "var(--bg-panel)",
              borderColor: "var(--border-color)",
            }}
          >
            <div
              className="flex items-center space-x-2 mb-2 font-semibold"
              style={{ color: "var(--text-muted)" }}
            >
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs">SYSTEM STATUS</span>
            </div>
            <p
              className="text-[10px] leading-relaxed"
              style={{ color: "var(--text-muted)" }}
            >
              {approaching.length > 0
                ? `${imminentCount} imminent signals. ${approaching.length} total tracking.`
                : "No active signals. Scanner running normally."}
            </p>
            {metrics && (
              <p
                className="text-[10px] leading-relaxed mt-1"
                style={{ color: "var(--text-muted)" }}
              >
                Win rate: {metrics.win_rate}% ({metrics.wins}W /{" "}
                {metrics.losses}L)
              </p>
            )}
          </div>
        </aside>

        {/* ---- CENTER PANEL ---- */}
        <section
          className="flex-1 flex flex-col border-r"
          style={{
            borderColor: "var(--border-color)",
            background: "var(--bg-main)",
          }}
        >
          {/* Tab: Terminal */}
          {activeTab === "terminal" && (
            <TerminalTab
              approaching={approaching}
              positions={positions}
              signals={signals}
            />
          )}

          {/* Tab: Analytics */}
          {activeTab === "analytics" && (
            <AnalyticsTab
              account={account}
              metrics={metrics}
              positions={positions}
              history={history}
            />
          )}

          {/* Tab: Risk Engine */}
          {activeTab === "risk" && (
            <RiskTab
              botSettings={botSettings}
              updateSettings={updateSettings}
              watchlistItems={watchlistItems}
              newSymbol={newSymbol}
              setNewSymbol={setNewSymbol}
              addSymbol={addSymbol}
              removeSymbol={removeSymbol}
              positions={positions}
            />
          )}

          {/* Tab: Logs */}
          {activeTab === "logs" && (
            <LogsTab
              signals={signals}
              clearSignals={clearSignals}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await fetchAll();
                setRefreshing(false);
              }}
            />
          )}
        </section>

        {/* ---- RIGHT SIDEBAR (Execution Engine) ---- */}
        <aside
          className="w-80 flex flex-col p-4 overflow-y-auto"
          style={{ background: "var(--bg-main)" }}
        >
          {/* Settings Overlay Panel */}
          {showSettingsPanel && botSettings ? (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2
                  className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}
                >
                  System Settings
                </h2>
                <button
                  onClick={() => setShowSettingsPanel(false)}
                  className="p-1 rounded transition-colors"
                  style={{ color: "var(--text-muted)" }}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Auto-Trade Toggle */}
              <div
                className="rounded-md p-3 border mb-4 flex items-center justify-between"
                style={{
                  background: "var(--bg-panel)",
                  borderColor: "var(--border-color)",
                }}
              >
                <div className="flex items-center gap-2">
                  <Power
                    className="w-4 h-4"
                    style={{
                      color: botSettings.trading_enabled
                        ? "var(--accent-green)"
                        : "var(--accent-red)",
                    }}
                  />
                  <span className="text-xs font-medium text-white">
                    Auto-Trade
                  </span>
                </div>
                <button
                  onClick={() =>
                    updateSettings({
                      trading_enabled: !botSettings.trading_enabled,
                    })
                  }
                  className="relative w-11 h-6 rounded-full transition-colors"
                  style={{
                    background: botSettings.trading_enabled
                      ? "#22c55e"
                      : "#374151",
                  }}
                >
                  <span
                    className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform"
                    style={{
                      transform: botSettings.trading_enabled
                        ? "translateX(20px)"
                        : "translateX(0)",
                    }}
                  />
                </button>
              </div>

              {/* Position Sizing */}
              <div className="space-y-3 mb-4">
                <label
                  className="block text-[10px] uppercase mb-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  Position Sizing
                </label>
                <div className="flex items-center gap-2 text-xs">
                  <span
                    style={{ color: "var(--text-muted)" }}
                    className="w-14"
                  >
                    Stock
                  </span>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={Math.round(botSettings.equity_allocation * 100)}
                    onChange={(e) =>
                      updateSettings({
                        equity_allocation: Number(e.target.value) / 100,
                      })
                    }
                    className="flex-1 h-1.5"
                    style={{ accentColor: "var(--accent-green)" }}
                  />
                  <span className="text-sm font-medium text-white w-10 text-right font-mono">
                    {Math.round(botSettings.equity_allocation * 100)}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span
                    style={{ color: "var(--text-muted)" }}
                    className="w-14"
                  >
                    Crypto
                  </span>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={Math.round(botSettings.crypto_allocation * 100)}
                    onChange={(e) =>
                      updateSettings({
                        crypto_allocation: Number(e.target.value) / 100,
                      })
                    }
                    className="flex-1 h-1.5"
                    style={{ accentColor: "var(--accent-amber)" }}
                  />
                  <span className="text-sm font-medium text-white w-10 text-right font-mono">
                    {Math.round(botSettings.crypto_allocation * 100)}%
                  </span>
                </div>
              </div>

              {/* Pattern Toggles */}
              <div className="space-y-2 mb-4">
                <span
                  className="text-[10px] uppercase"
                  style={{ color: "var(--text-muted)" }}
                >
                  Enabled Patterns
                </span>
                <div className="flex flex-wrap gap-2">
                  {ALL_PATTERNS.map((p) => {
                    const isEnabled =
                      botSettings.enabled_patterns.includes(p);
                    return (
                      <button
                        key={p}
                        onClick={() => {
                          const next = isEnabled
                            ? botSettings.enabled_patterns.filter(
                                (x) => x !== p,
                              )
                            : [...botSettings.enabled_patterns, p];
                          if (next.length > 0)
                            updateSettings({ enabled_patterns: next });
                        }}
                        className="text-xs px-2.5 py-1 rounded-lg border transition-colors"
                        style={
                          isEnabled
                            ? {
                                background: "rgba(205,166,97,0.1)",
                                color: "var(--accent-amber)",
                                borderColor: "rgba(205,166,97,0.3)",
                              }
                            : {
                                background: "var(--bg-panel)",
                                color: "var(--text-muted)",
                                borderColor: "var(--border-color)",
                              }
                        }
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            /* Default: Execution Engine */
            <div className="mb-6">
              <h2
                className="text-[10px] font-semibold uppercase tracking-wider mb-4"
                style={{ color: "var(--text-muted)" }}
              >
                Execution Engine
              </h2>

              {/* Stats Row */}
              <div className="grid grid-cols-2 gap-3 mb-6">
                <MetricBox
                  label="Win Rate"
                  value={metrics ? `${metrics.win_rate}%` : "—"}
                />
                <MetricBox
                  label="Profit Factor"
                  value={
                    metrics
                      ? metrics.profit_factor === Infinity
                        ? "INF"
                        : String(metrics.profit_factor)
                      : "—"
                  }
                />
              </div>

              {/* Trading Toggle */}
              {botSettings && (
                <div
                  className="rounded-md p-3 border mb-4 flex items-center justify-between"
                  style={{
                    background: "var(--bg-panel)",
                    borderColor: "var(--border-color)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Power
                      className="w-4 h-4"
                      style={{
                        color: botSettings.trading_enabled
                          ? "var(--accent-green)"
                          : "var(--accent-red)",
                      }}
                    />
                    <span className="text-xs font-medium text-white">
                      Auto-Trade
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      updateSettings({
                        trading_enabled: !botSettings.trading_enabled,
                      })
                    }
                    className="relative w-11 h-6 rounded-full transition-colors"
                    style={{
                      background: botSettings.trading_enabled
                        ? "#22c55e"
                        : "#374151",
                    }}
                  >
                    <span
                      className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform"
                      style={{
                        transform: botSettings.trading_enabled
                          ? "translateX(20px)"
                          : "translateX(0)",
                      }}
                    />
                  </button>
                </div>
              )}

              {/* Action Buttons */}
              <div className="space-y-3">
                <button
                  className="w-full text-black font-bold text-sm uppercase tracking-wider py-4 rounded flex items-center justify-center space-x-2 transition-colors"
                  style={{
                    background: "#52b788",
                    boxShadow: "0 0 15px rgba(82,183,136,0.2)",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "#40916c")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "#52b788")
                  }
                  onClick={async () => {
                    setRefreshing(true);
                    await fetchAll();
                    setRefreshing(false);
                  }}
                >
                  <RefreshCw
                    className={`w-5 h-5 ${refreshing ? "animate-spin" : ""}`}
                  />
                  <span>Refresh All</span>
                </button>
                <button
                  className="w-full font-bold text-sm uppercase tracking-wider py-4 rounded flex items-center justify-center space-x-2 transition-colors border"
                  style={{
                    background: "rgba(58,34,35,0.8)",
                    color: "var(--accent-red)",
                    borderColor: "rgba(127,29,29,0.5)",
                  }}
                  onClick={async () => {
                    if (
                      botSettings?.trading_enabled &&
                      confirm("Disable auto-trading?")
                    ) {
                      await updateSettings({ trading_enabled: false });
                    }
                  }}
                >
                  <XCircle className="w-5 h-5" />
                  <span>Kill Switch</span>
                </button>
              </div>
            </div>
          )}

          {/* Live Execution Log */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex justify-between items-center mb-2">
              <h2
                className="text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Live Execution Log
              </h2>
              <span
                className="text-[9px] tracking-widest uppercase"
                style={{ color: "var(--accent-green)" }}
              >
                {isOnline ? "Live" : "Offline"}
              </span>
            </div>
            <div
              className="flex-1 rounded-md p-3 overflow-y-auto border text-[10px] leading-tight space-y-2"
              style={{
                background: "var(--bg-panel)",
                borderColor: "var(--border-color)",
                fontFamily: MONO_FONT,
              }}
            >
              <div
                className="flex space-x-2"
                style={{ color: "var(--text-muted)" }}
              >
                <span className="opacity-50">[sys]</span>
                <span style={{ color: "#5eb387" }}>
                  System initialized. Connected to Alpaca API.
                </span>
              </div>

              {logEntries.length === 0 ? (
                <div
                  className="flex space-x-2"
                  style={{ color: "var(--text-muted)" }}
                >
                  <span className="opacity-50">[--:--]</span>
                  <span>Awaiting signals...</span>
                </div>
              ) : (
                logEntries.map((entry, i) => (
                  <div
                    key={i}
                    className="flex space-x-2"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <span className="opacity-50">[{entry.time}]</span>
                    <span
                      style={{
                        color:
                          entry.type === "success"
                            ? "#5eb387"
                            : entry.type === "warn"
                              ? "var(--accent-amber)"
                              : "var(--text-main)",
                      }}
                    >
                      {entry.text}
                    </span>
                  </div>
                ))
              )}

              <div
                className="flex space-x-2"
                style={{ color: "var(--text-muted)" }}
              >
                <span className="opacity-50">
                  [
                  {new Date().toLocaleTimeString("en-US", { hour12: false })}]
                </span>
                <span className="animate-pulse">_</span>
              </div>
            </div>
          </div>
        </aside>
      </main>

      {/* ==================== BOTTOM STATUS BAR ==================== */}
      <footer
        className="flex justify-between items-center px-4 py-2 border-t text-[9px] uppercase tracking-widest"
        style={{
          borderColor: "var(--border-color)",
          background: "var(--bg-main)",
          color: "var(--text-muted)",
          fontFamily: MONO_FONT,
        }}
      >
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2">
            <Globe className="w-3 h-3" />
            <span>Gateway: Alpaca-API</span>
          </div>
          <div className="flex items-center space-x-2">
            <Clock className="w-3 h-3" />
            <span>Uptime: {status ? formatUptime(status.uptime) : "—"}</span>
          </div>
        </div>
        <div className="flex items-center space-x-4">
          <div
            className="flex items-center space-x-2"
            style={{ color: "var(--accent-green)" }}
          >
            <span>API: {isOnline ? "Active" : "Down"}</span>
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: isOnline ? "#22c55e" : "#ef4444",
                boxShadow: isOnline
                  ? "0 0 5px rgba(82,183,136,0.8)"
                  : undefined,
              }}
            />
          </div>
          <span>{nowUtc()}</span>
        </div>
      </footer>
    </div>
  );
}

// ============================================================
// TAB: Terminal (Depth of Market + Positions)
// ============================================================
function TerminalTab({
  approaching,
  positions,
  signals,
}: {
  approaching: ApproachingSignal[];
  positions: Position[];
  signals: Signal[];
}) {
  return (
    <>
      <div
        className="p-4 border-b flex justify-between items-center"
        style={{ borderColor: "var(--border-color)" }}
      >
        <h2
          className="text-sm font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          Tactical Depth of Market
        </h2>
        <div className="flex space-x-2">
          <span
            className="px-2 py-1 rounded border text-[10px]"
            style={{
              background: "var(--bg-panel)",
              color: "var(--accent-green)",
              borderColor: "#166534",
            }}
          >
            LIVE FEED
          </span>
          <span
            className="px-2 py-1 rounded border text-[10px]"
            style={{
              background: "var(--bg-panel)",
              color: "var(--accent-amber)",
              borderColor: "rgba(205,166,97,0.3)",
            }}
          >
            {signals.length} SIGNALS
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {/* DOM Header */}
        <div
          className="grid grid-cols-4 gap-4 px-4 py-2 border-b text-[10px] uppercase tracking-wider"
          style={{
            borderColor: "var(--border-color)",
            color: "var(--text-muted)",
          }}
        >
          <div>Symbol</div>
          <div className="text-right">Price (USD)</div>
          <div>Distance</div>
          <div className="text-right">Direction</div>
        </div>

        {/* Asks — short signals */}
        {approaching
          .filter((s) => s.direction === "short")
          .slice(0, 6)
          .map((s) => (
            <DomRow
              key={s.id}
              symbol={s.symbol}
              pattern={s.pattern}
              price={s.projectedD}
              side="ask"
              distancePct={s.distancePct}
              timeframe={s.timeframe}
            />
          ))}

        {approaching.filter((s) => s.direction === "short").length === 0 && (
          <div
            className="px-4 py-6 text-center text-[10px]"
            style={{ color: "var(--text-muted)" }}
          >
            No short signals
          </div>
        )}

        {/* Spread divider */}
        <div
          className="px-4 py-2 flex justify-center items-center border-y"
          style={{
            borderColor: "var(--border-color)",
            background: "rgba(21,26,29,0.5)",
          }}
        >
          <span
            className="text-[10px] uppercase tracking-widest"
            style={{ color: "var(--text-muted)" }}
          >
            {approaching.length > 0
              ? `${approaching.length} Active Signals · ${approaching.filter((s) => s.distancePct < 5).length} Imminent`
              : "No Active Signals"}
          </span>
        </div>

        {/* Bids — long signals */}
        {approaching
          .filter((s) => s.direction === "long")
          .slice(0, 6)
          .map((s) => (
            <DomRow
              key={s.id}
              symbol={s.symbol}
              pattern={s.pattern}
              price={s.projectedD}
              side="bid"
              distancePct={s.distancePct}
              timeframe={s.timeframe}
            />
          ))}

        {approaching.filter((s) => s.direction === "long").length === 0 && (
          <div
            className="px-4 py-6 text-center text-[10px]"
            style={{ color: "var(--text-muted)" }}
          >
            No long signals
          </div>
        )}

        {/* Active Positions */}
        {positions.length > 0 && (
          <div className="mt-4">
            <div
              className="px-4 py-2 border-t border-b text-[10px] uppercase tracking-wider font-semibold"
              style={{
                borderColor: "var(--border-color)",
                color: "var(--text-muted)",
              }}
            >
              Open Positions ({positions.length})
            </div>
            {positions.map((p) => (
              <div
                key={p.symbol}
                className="grid grid-cols-4 gap-4 px-4 py-3 border-b items-center transition-colors"
                style={{ borderColor: "var(--border-color)" }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background =
                    "var(--bg-panel-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <div>
                  <span className="font-mono text-sm text-white">
                    {p.symbol}
                  </span>
                  {p.pattern && (
                    <span
                      className="text-[10px] ml-1.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {p.pattern}
                    </span>
                  )}
                </div>
                <div
                  className="font-mono text-sm text-right"
                  style={{ color: "var(--text-main)" }}
                >
                  {formatUsd(p.current_price)}
                </div>
                <div className="flex items-center h-full">
                  <div
                    className="h-1 rounded"
                    style={{
                      width: `${Math.min(Math.abs(p.unrealized_pl_pct) * 10, 100)}%`,
                      background:
                        p.unrealized_pl >= 0
                          ? "rgba(34,197,94,0.5)"
                          : "rgba(239,68,68,0.5)",
                    }}
                  />
                </div>
                <div className="text-right">
                  <span
                    className="font-mono text-sm font-semibold"
                    style={{
                      color:
                        p.unrealized_pl >= 0
                          ? "var(--accent-green)"
                          : "var(--accent-red)",
                    }}
                  >
                    {p.unrealized_pl >= 0 ? "+" : ""}
                    {p.unrealized_pl_pct.toFixed(2)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================
// TAB: Analytics (Account + Metrics + Trade History)
// ============================================================
function AnalyticsTab({
  account,
  metrics,
  positions,
  history,
}: {
  account: Account | null;
  metrics: Metrics | null;
  positions: Position[];
  history: ClosedTrade[];
}) {
  return (
    <>
      <div
        className="p-4 border-b flex justify-between items-center"
        style={{ borderColor: "var(--border-color)" }}
      >
        <h2
          className="text-sm font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          Analytics & Portfolio
        </h2>
        <span
          className="px-2 py-1 rounded border text-[10px]"
          style={{
            background: "var(--bg-panel)",
            color: "var(--accent-amber)",
            borderColor: "rgba(205,166,97,0.3)",
          }}
        >
          {history.length} CLOSED TRADES
        </span>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Metrics Cards */}
        <div className="grid grid-cols-4 gap-3">
          <MetricBox
            label="Win Rate"
            value={metrics ? `${metrics.win_rate}%` : "—"}
          />
          <MetricBox
            label="Profit Factor"
            value={
              metrics
                ? metrics.profit_factor === Infinity
                  ? "INF"
                  : String(metrics.profit_factor)
                : "—"
            }
          />
          <MetricBox
            label="Total Trades"
            value={metrics ? String(metrics.total_trades) : "—"}
          />
          <MetricBox
            label="Open Positions"
            value={String(positions.length)}
          />
        </div>

        {/* Account Summary */}
        {account && (
          <div
            className="rounded-md border p-4"
            style={{
              background: "var(--bg-panel)",
              borderColor: "var(--border-color)",
            }}
          >
            <h3
              className="text-[10px] font-semibold uppercase tracking-wider mb-3"
              style={{ color: "var(--text-muted)" }}
            >
              Account Summary
            </h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div
                  className="text-[10px] mb-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  Equity
                </div>
                <div className="text-lg font-bold text-white font-mono">
                  {formatUsd(account.equity)}
                </div>
              </div>
              <div>
                <div
                  className="text-[10px] mb-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  Buying Power
                </div>
                <div className="text-lg font-bold text-white font-mono">
                  {formatUsd(account.buying_power)}
                </div>
              </div>
              <div>
                <div
                  className="text-[10px] mb-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  Day P&L
                </div>
                <div
                  className="text-lg font-bold font-mono"
                  style={{
                    color:
                      account.daily_pl >= 0
                        ? "var(--accent-green)"
                        : "var(--accent-red)",
                  }}
                >
                  {account.daily_pl >= 0 ? "+" : ""}
                  {formatUsd(account.daily_pl)}{" "}
                  <span className="text-xs">
                    ({account.daily_pl_pct >= 0 ? "+" : ""}
                    {account.daily_pl_pct.toFixed(2)}%)
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Trade History Table */}
        <div
          className="rounded-md border overflow-hidden"
          style={{
            background: "var(--bg-panel)",
            borderColor: "var(--border-color)",
          }}
        >
          <div
            className="px-4 py-3 border-b flex items-center gap-2"
            style={{ borderColor: "var(--border-color)" }}
          >
            <Skull className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
            <h3
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              Trade History
            </h3>
          </div>
          {history.length === 0 ? (
            <div
              className="p-8 text-center text-sm"
              style={{ color: "var(--text-muted)" }}
            >
              No closed trades yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-xs border-b"
                    style={{
                      borderColor: "var(--border-color)",
                      color: "var(--text-muted)",
                    }}
                  >
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
                      className="border-b transition-colors"
                      style={{ borderColor: "rgba(39,49,54,0.5)" }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background =
                          "var(--bg-panel-hover)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                    >
                      <td className="px-4 py-2.5 font-medium text-white">
                        {t.symbol}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className="text-xs font-medium px-1.5 py-0.5 rounded"
                          style={{
                            background:
                              t.side === "buy"
                                ? "rgba(103,194,152,0.1)"
                                : "rgba(222,107,107,0.1)",
                            color:
                              t.side === "buy"
                                ? "var(--accent-green)"
                                : "var(--accent-red)",
                          }}
                        >
                          {t.side.toUpperCase()}
                        </span>
                      </td>
                      <td
                        className="px-4 py-2.5 text-right"
                        style={{ color: "var(--text-main)" }}
                      >
                        {t.qty}
                      </td>
                      <td
                        className="px-4 py-2.5 text-right"
                        style={{ color: "var(--text-main)" }}
                      >
                        {formatUsd(t.filled_price)}
                      </td>
                      <td
                        className="px-4 py-2.5 text-right text-xs"
                        style={{ color: "var(--accent-red)", opacity: 0.8 }}
                      >
                        {t.stop_loss ? formatUsd(t.stop_loss) : "—"}
                      </td>
                      <td
                        className="px-4 py-2.5 text-right text-xs"
                        style={{ color: "var(--accent-green)", opacity: 0.8 }}
                      >
                        {t.tp1 ? formatUsd(t.tp1) : "—"}
                      </td>
                      <td
                        className="px-4 py-2.5 text-xs"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {t.pattern ?? "—"}
                      </td>
                      <td
                        className="px-4 py-2.5 text-right text-xs whitespace-nowrap"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {t.filled_at ? timeAgo(t.filled_at) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ============================================================
// TAB: Risk Engine (Watchlist + Pattern Config + Risk Overview)
// ============================================================
function RiskTab({
  botSettings,
  updateSettings,
  watchlistItems,
  newSymbol,
  setNewSymbol,
  addSymbol,
  removeSymbol,
  positions,
}: {
  botSettings: BotSettings | null;
  updateSettings: (patch: Partial<BotSettings>) => Promise<void>;
  watchlistItems: WatchlistEntry[];
  newSymbol: string;
  setNewSymbol: (v: string) => void;
  addSymbol: () => Promise<void>;
  removeSymbol: (sym: string) => Promise<void>;
  positions: Position[];
}) {
  return (
    <>
      <div
        className="p-4 border-b flex justify-between items-center"
        style={{ borderColor: "var(--border-color)" }}
      >
        <h2
          className="text-sm font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          Risk Engine
        </h2>
        <span
          className="px-2 py-1 rounded border text-[10px]"
          style={{
            background: "var(--bg-panel)",
            color: "var(--accent-green)",
            borderColor: "#166534",
          }}
        >
          {watchlistItems.length} SYMBOLS
        </span>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Bot Settings */}
        {botSettings && (
          <div
            className="rounded-md border p-4"
            style={{
              background: "var(--bg-panel)",
              borderColor: "var(--border-color)",
            }}
          >
            <h3
              className="text-[10px] font-semibold uppercase tracking-wider mb-3"
              style={{ color: "var(--text-muted)" }}
            >
              Trading Configuration
            </h3>

            {/* Kill Switch */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Power
                  className="w-4 h-4"
                  style={{
                    color: botSettings.trading_enabled
                      ? "var(--accent-green)"
                      : "var(--accent-red)",
                  }}
                />
                <span className="text-sm font-medium text-white">
                  Live Auto-Trading
                </span>
              </div>
              <button
                onClick={() =>
                  updateSettings({
                    trading_enabled: !botSettings.trading_enabled,
                  })
                }
                className="relative w-11 h-6 rounded-full transition-colors"
                style={{
                  background: botSettings.trading_enabled
                    ? "#22c55e"
                    : "#374151",
                }}
              >
                <span
                  className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform"
                  style={{
                    transform: botSettings.trading_enabled
                      ? "translateX(20px)"
                      : "translateX(0)",
                  }}
                />
              </button>
            </div>

            {/* Position Sizing */}
            <div className="space-y-3 mb-4">
              <div className="flex items-center gap-2 mb-1">
                <Shield
                  className="w-3.5 h-3.5"
                  style={{ color: "var(--accent-green)" }}
                />
                <span
                  className="text-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  Position Sizing
                </span>
              </div>
              <div className="flex items-center gap-3">
                <label
                  className="text-xs w-20"
                  style={{ color: "var(--text-muted)" }}
                >
                  Stock %
                </label>
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={Math.round(botSettings.equity_allocation * 100)}
                  onChange={(e) =>
                    updateSettings({
                      equity_allocation: Number(e.target.value) / 100,
                    })
                  }
                  className="flex-1 h-1.5"
                  style={{ accentColor: "var(--accent-green)" }}
                />
                <span className="text-sm font-medium text-white w-10 text-right font-mono">
                  {Math.round(botSettings.equity_allocation * 100)}%
                </span>
              </div>
              <div className="flex items-center gap-3">
                <label
                  className="text-xs w-20"
                  style={{ color: "var(--text-muted)" }}
                >
                  Crypto %
                </label>
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={Math.round(botSettings.crypto_allocation * 100)}
                  onChange={(e) =>
                    updateSettings({
                      crypto_allocation: Number(e.target.value) / 100,
                    })
                  }
                  className="flex-1 h-1.5"
                  style={{ accentColor: "var(--accent-amber)" }}
                />
                <span className="text-sm font-medium text-white w-10 text-right font-mono">
                  {Math.round(botSettings.crypto_allocation * 100)}%
                </span>
              </div>
            </div>

            {/* Pattern Toggles */}
            <div className="space-y-2">
              <span
                className="text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Enabled Patterns
              </span>
              <div className="flex flex-wrap gap-2">
                {ALL_PATTERNS.map((p) => {
                  const isEnabled =
                    botSettings.enabled_patterns.includes(p);
                  return (
                    <button
                      key={p}
                      onClick={() => {
                        const next = isEnabled
                          ? botSettings.enabled_patterns.filter(
                              (x) => x !== p,
                            )
                          : [...botSettings.enabled_patterns, p];
                        if (next.length > 0)
                          updateSettings({ enabled_patterns: next });
                      }}
                      className="text-xs px-2.5 py-1 rounded-lg border transition-colors"
                      style={
                        isEnabled
                          ? {
                              background: "rgba(205,166,97,0.1)",
                              color: "var(--accent-amber)",
                              borderColor: "rgba(205,166,97,0.3)",
                            }
                          : {
                              background: "var(--bg-panel)",
                              color: "var(--text-muted)",
                              borderColor: "var(--border-color)",
                            }
                      }
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Watchlist Manager */}
        <div
          className="rounded-md border p-4"
          style={{
            background: "var(--bg-panel)",
            borderColor: "var(--border-color)",
          }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Eye
              className="w-4 h-4"
              style={{ color: "var(--accent-amber)" }}
            />
            <h3
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              Watchlist Manager
            </h3>
            <span
              className="text-xs ml-auto"
              style={{ color: "var(--text-muted)" }}
            >
              {watchlistItems.length} symbols
            </span>
          </div>

          {/* Add symbol input */}
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addSymbol()}
              placeholder="Add symbol (e.g. NVDA, SOL/USD)"
              className="flex-1 rounded-lg px-3 py-2 text-sm focus:outline-none"
              style={{
                background: "var(--bg-main)",
                border: "1px solid var(--border-color)",
                color: "var(--text-main)",
              }}
            />
            <button
              onClick={addSymbol}
              className="rounded-lg px-3 py-2 text-sm font-medium flex items-center gap-1.5 transition-colors"
              style={{
                background: "rgba(205,166,97,0.1)",
                color: "var(--accent-amber)",
                border: "1px solid rgba(205,166,97,0.2)",
              }}
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>

          {/* Symbol chips */}
          {watchlistItems.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No symbols in watchlist
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {watchlistItems.map((w) => (
                <div
                  key={w.symbol}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm border"
                  style={{
                    background: "var(--bg-main)",
                    borderColor: "var(--border-color)",
                  }}
                >
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
                    style={{
                      background:
                        w.assetClass === "crypto"
                          ? "var(--accent-amber)"
                          : "var(--accent-green)",
                    }}
                  />
                  <span className="font-medium text-white">{w.symbol}</span>
                  <span
                    className="text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {w.assetClass}
                  </span>
                  <button
                    onClick={() => removeSymbol(w.symbol)}
                    className="ml-1 transition-colors"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.color = "var(--accent-red)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.color = "var(--text-muted)")
                    }
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Position Risk Overview */}
        {positions.length > 0 && (
          <div
            className="rounded-md border p-4"
            style={{
              background: "var(--bg-panel)",
              borderColor: "var(--border-color)",
            }}
          >
            <h3
              className="text-[10px] font-semibold uppercase tracking-wider mb-3"
              style={{ color: "var(--text-muted)" }}
            >
              Position Risk Overview
            </h3>
            <div className="space-y-2">
              {positions.map((p) => (
                <div
                  key={p.symbol}
                  className="flex items-center gap-3 text-xs"
                >
                  <span className="text-white font-medium w-24 font-mono">
                    {p.symbol}
                  </span>
                  <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "var(--bg-main)" }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min(Math.abs(p.unrealized_pl_pct) * 10, 100)}%`,
                        background:
                          p.unrealized_pl >= 0
                            ? "var(--accent-green)"
                            : "var(--accent-red)",
                      }}
                    />
                  </div>
                  <span
                    className="font-mono w-16 text-right"
                    style={{
                      color:
                        p.unrealized_pl >= 0
                          ? "var(--accent-green)"
                          : "var(--accent-red)",
                    }}
                  >
                    {p.unrealized_pl >= 0 ? "+" : ""}
                    {p.unrealized_pl_pct.toFixed(2)}%
                  </span>
                  <span style={{ color: "var(--text-muted)" }} className="w-20 text-right">
                    SL: {p.stop_loss ? formatUsd(p.stop_loss) : "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================
// TAB: Logs (Full Signal Feed)
// ============================================================
function LogsTab({
  signals,
  clearSignals,
  refreshing,
  onRefresh,
}: {
  signals: Signal[];
  clearSignals: () => Promise<void>;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  return (
    <>
      <div
        className="p-4 border-b flex justify-between items-center"
        style={{ borderColor: "var(--border-color)" }}
      >
        <h2
          className="text-sm font-semibold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          Signal Log
        </h2>
        <div className="flex items-center space-x-2">
          <span
            className="text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            {signals.length} signals
          </span>
          <button
            onClick={onRefresh}
            className="p-1.5 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            title="Refresh"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
          </button>
          <button
            onClick={clearSignals}
            className="p-1.5 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "var(--accent-red)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "var(--text-muted)")
            }
            title="Clear all signals"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {signals.length === 0 ? (
          <div
            className="p-8 text-center text-sm"
            style={{ color: "var(--text-muted)" }}
          >
            No signals detected yet
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "rgba(39,49,54,0.5)" }}>
            {signals.map((s) => (
              <div
                key={s.id}
                className="px-4 py-3 flex items-center gap-3 transition-colors"
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background =
                    "var(--bg-panel-hover)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{
                    background:
                      s.direction === "long"
                        ? "var(--accent-green)"
                        : "var(--accent-red)",
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{s.symbol}</span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--bg-panel)",
                        color: "var(--text-muted)",
                      }}
                    >
                      {s.timeframe}
                    </span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--bg-panel)",
                        color: "var(--text-muted)",
                      }}
                    >
                      {s.patternType}
                    </span>
                    <span
                      className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
                      style={{
                        background:
                          s.direction === "long"
                            ? "rgba(103,194,152,0.1)"
                            : "rgba(222,107,107,0.1)",
                        color:
                          s.direction === "long"
                            ? "var(--accent-green)"
                            : "var(--accent-red)",
                      }}
                    >
                      {s.direction}
                    </span>
                  </div>
                  <div
                    className="text-xs mt-0.5"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Entry {formatUsd(Number(s.entryPrice))} · SL{" "}
                    {formatUsd(Number(s.stopLossPrice))} · TP1{" "}
                    {formatUsd(Number(s.tp1Price))} · TP2{" "}
                    {formatUsd(Number(s.tp2Price))}
                  </div>
                  {s.xPrice && (
                    <div
                      className="text-xs mt-0.5 font-mono"
                      style={{ color: "var(--text-muted)", opacity: 0.6 }}
                    >
                      X={formatUsd(Number(s.xPrice))} A=
                      {formatUsd(Number(s.aPrice))} B=
                      {formatUsd(Number(s.bPrice))} C=
                      {formatUsd(Number(s.cPrice))}
                    </div>
                  )}
                </div>
                <span
                  className="text-xs whitespace-nowrap"
                  style={{ color: "var(--text-muted)" }}
                >
                  {timeAgo(s.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ============================================================
// Sub-Components
// ============================================================

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-md p-3 border"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border-color)",
      }}
    >
      <div
        className="text-[10px] uppercase mb-1"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div
        className="text-lg font-bold text-white"
        style={{ fontFamily: MONO_FONT }}
      >
        {value}
      </div>
    </div>
  );
}

function DomRow({
  symbol,
  pattern,
  price,
  side,
  distancePct,
  timeframe,
}: {
  symbol: string;
  pattern: string;
  price: number;
  side: "bid" | "ask";
  distancePct: number;
  timeframe: string;
}) {
  const isAsk = side === "ask";
  const color = isAsk ? "var(--accent-red)" : "var(--accent-green)";
  const barBg = isAsk ? "rgba(239,68,68,0.5)" : "rgba(34,197,94,0.5)";
  const btnBg = isAsk ? "var(--accent-red-dim)" : "var(--accent-green-dim)";
  const btnBorder = isAsk ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)";

  return (
    <div
      className="grid grid-cols-4 gap-4 px-4 py-3 border-b items-center transition-colors cursor-default"
      style={{ borderColor: "var(--border-color)" }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "var(--bg-panel-hover)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "transparent")
      }
    >
      <div>
        <span
          className="text-sm"
          style={{ color: "var(--text-main)", fontFamily: MONO_FONT }}
        >
          {symbol}
        </span>
        <span
          className="text-[9px] ml-1.5"
          style={{ color: "var(--text-muted)" }}
        >
          {pattern} · {timeframe}
        </span>
      </div>
      <div
        className="text-sm text-right"
        style={{ color, fontFamily: MONO_FONT }}
      >
        {price.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </div>
      <div className="flex items-center h-full">
        <div
          className="h-1 rounded"
          style={{
            width: `${Math.min(100 - distancePct * 5, 100)}%`,
            background: barBg,
          }}
        />
      </div>
      <div className="text-right">
        <span
          className="px-3 py-1 text-[10px] rounded border uppercase"
          style={{
            borderColor: btnBorder,
            color,
            background: `${btnBg}50`,
          }}
        >
          {distancePct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}
