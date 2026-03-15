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
  ChevronUp,
  FileBarChart,
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

interface BotSettings {
  trading_enabled: boolean;
  equity_allocation: number;
  crypto_allocation: number;
  enabled_patterns: string[];
}

const POLL_INTERVAL = 10_000;

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

function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
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
// Tabs
// ============================================================
type TabId = "terminal" | "analytics" | "risk" | "logs";

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
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("terminal");
  const [orderSize, setOrderSize] = useState("0.5000");

  const fetchAll = useCallback(async () => {
    try {
      const [acctRes, posRes, sigRes, statRes, metRes, appRes, setRes] =
        await Promise.allSettled([
          fetch("/api/account").then((r) => r.json()),
          fetch("/api/positions").then((r) => r.json()),
          fetch("/api/signals").then((r) => r.json()),
          fetch("/api/status").then((r) => r.json()),
          fetch("/api/metrics").then((r) => r.json()),
          fetch("/api/approaching").then((r) => r.json()),
          fetch("/api/settings").then((r) => r.json()),
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
    positions.length > 0 ? positions[0].unrealized_pl_pct : account?.daily_pl_pct ?? 0;

  // Build log entries from signals
  const logEntries = signals.slice(0, 20).map((s) => ({
    time: new Date(s.createdAt).toLocaleTimeString("en-US", { hour12: false }),
    text: `${s.direction.toUpperCase()} ${s.symbol} ${s.patternType} @ ${formatUsd(Number(s.entryPrice))}`,
    type: s.status === "filled" ? "success" : s.status === "pending" ? "info" : "warn",
  }));

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-main)" }}>
        <div className="text-center">
          <Zap className="w-10 h-10 mx-auto mb-3 animate-pulse" style={{ color: "var(--accent-green)" }} />
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
              {isOnline ? `Online · ${formatUptime(status?.uptime ?? 0)}` : "Connecting..."}
            </p>
          </div>
        </div>

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
                activeTab === id
                  ? "border-b-2"
                  : "hover:text-white"
              }`}
              style={
                activeTab === id
                  ? { color: "var(--accent-green)", borderColor: "var(--accent-green)" }
                  : { color: "var(--text-muted)" }
              }
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex items-center space-x-3">
          <IconButton>
            <Bell className="w-4 h-4" />
          </IconButton>
          <IconButton>
            <Settings className="w-4 h-4" />
          </IconButton>
          <button className="w-8 h-8 rounded flex items-center justify-center text-black font-bold text-xs bg-[#ebd8c3]">
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
                  boxShadow: isOnline ? "0 0 6px rgba(34,197,94,0.6)" : undefined,
                }}
              />
            </div>
            <div
              className="rounded-md p-4 border"
              style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
            >
              <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                {primarySymbol}
              </div>
              <div className="text-2xl font-bold text-white mb-2">
                {primaryPrice > 0 ? formatUsd(primaryPrice) : "—"}
              </div>
              <div className="flex justify-between text-xs">
                <span style={{ color: primaryPl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
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
                style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
              >
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--text-muted)" }}>Equity</span>
                  <span className="text-white font-mono">{formatUsd(account.equity)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span style={{ color: "var(--text-muted)" }}>Buying Power</span>
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

          {/* Navigation Menu */}
          <nav className="space-y-2 flex-1">
            {[
              { icon: <BarChart3 className="w-4 h-4" />, label: "EXECUTE", active: true },
              { icon: <Activity className="w-4 h-4" />, label: "PORTFOLIO", active: false },
              { icon: <TrendingUp className="w-4 h-4" />, label: "SLIPPAGE HUB", active: false },
              { icon: <Shield className="w-4 h-4" />, label: "RISK GUARD", active: false },
            ].map((item) => (
              <a
                key={item.label}
                href="#"
                className={`flex items-center space-x-3 rounded-md px-4 py-3 text-sm transition-colors ${
                  item.active ? "font-semibold border" : ""
                }`}
                style={
                  item.active
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
              </a>
            ))}
          </nav>

          {/* System Status */}
          <div
            className="rounded-md p-4 border mt-auto"
            style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
          >
            <div className="flex items-center space-x-2 mb-2 font-semibold" style={{ color: "var(--text-muted)" }}>
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs">SYSTEM STATUS</span>
            </div>
            <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              {approaching.length > 0
                ? `${approaching.filter((s) => s.distancePct < 5).length} imminent signals detected. ${approaching.length} total tracking.`
                : "No active signals. Scanner running normally."}
            </p>
            {metrics && (
              <p className="text-[10px] leading-relaxed mt-1" style={{ color: "var(--text-muted)" }}>
                Win rate: {metrics.win_rate}% ({metrics.wins}W / {metrics.losses}L)
              </p>
            )}
          </div>
        </aside>

        {/* ---- CENTER PANEL (Tactical Depth) ---- */}
        <section
          className="flex-1 flex flex-col border-r"
          style={{ borderColor: "var(--border-color)", background: "var(--bg-main)" }}
        >
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
              style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}
            >
              <div>Symbol</div>
              <div className="text-right">Price (USD)</div>
              <div>Distance</div>
              <div className="text-right">Direction</div>
            </div>

            {/* Asks — approaching signals with direction "short" or far signals */}
            {approaching
              .filter((s) => s.direction === "short")
              .slice(0, 6)
              .map((s) => (
                <DomRow
                  key={s.id}
                  symbol={s.symbol}
                  pattern={s.pattern}
                  price={s.projectedD}
                  depth={Math.min(s.distancePct * 10, 100)}
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

            {/* Bids — approaching signals with direction "long" */}
            {approaching
              .filter((s) => s.direction === "long")
              .slice(0, 6)
              .map((s) => (
                <DomRow
                  key={s.id}
                  symbol={s.symbol}
                  pattern={s.pattern}
                  price={s.projectedD}
                  depth={Math.min(s.distancePct * 10, 100)}
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

            {/* Active Positions Table */}
            {positions.length > 0 && (
              <div className="mt-4">
                <div
                  className="px-4 py-2 border-t border-b text-[10px] uppercase tracking-wider font-semibold"
                  style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}
                >
                  Open Positions ({positions.length})
                </div>
                {positions.map((p) => (
                  <div
                    key={p.symbol}
                    className="grid grid-cols-4 gap-4 px-4 py-3 border-b items-center transition-colors"
                    style={{ borderColor: "var(--border-color)" }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = "var(--bg-panel-hover)")
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <div>
                      <span className="font-mono text-sm text-white">{p.symbol}</span>
                      {p.pattern && (
                        <span className="text-[10px] ml-1.5" style={{ color: "var(--text-muted)" }}>
                          {p.pattern}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-sm text-right" style={{ color: "var(--text-main)" }}>
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
        </section>

        {/* ---- RIGHT SIDEBAR (Execution Engine) ---- */}
        <aside
          className="w-80 flex flex-col p-4 overflow-y-auto"
          style={{ background: "var(--bg-main)" }}
        >
          <div className="mb-6">
            <h2
              className="text-[10px] font-semibold uppercase tracking-wider mb-4"
              style={{ color: "var(--text-muted)" }}
            >
              Execution Engine
            </h2>

            {/* Stats Row */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              <MetricBox label="Win Rate" value={metrics ? `${metrics.win_rate}%` : "—"} />
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
                style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
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
                  <span className="text-xs font-medium text-white">Auto-Trade</span>
                </div>
                <button
                  onClick={() =>
                    updateSettings({ trading_enabled: !botSettings.trading_enabled })
                  }
                  className="relative w-11 h-6 rounded-full transition-colors"
                  style={{
                    background: botSettings.trading_enabled ? "#22c55e" : "#374151",
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

            {/* Position Size Allocations */}
            {botSettings && (
              <div className="space-y-3 mb-6">
                <label
                  className="block text-[10px] uppercase mb-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  Position Sizing
                </label>
                <div className="flex items-center gap-2 text-xs">
                  <span style={{ color: "var(--text-muted)" }} className="w-14">
                    Stock
                  </span>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={Math.round(botSettings.equity_allocation * 100)}
                    onChange={(e) =>
                      updateSettings({ equity_allocation: Number(e.target.value) / 100 })
                    }
                    className="flex-1 h-1.5"
                    style={{ accentColor: "var(--accent-green)" }}
                  />
                  <span className="text-sm font-medium text-white w-10 text-right font-mono">
                    {Math.round(botSettings.equity_allocation * 100)}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span style={{ color: "var(--text-muted)" }} className="w-14">
                    Crypto
                  </span>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={Math.round(botSettings.crypto_allocation * 100)}
                    onChange={(e) =>
                      updateSettings({ crypto_allocation: Number(e.target.value) / 100 })
                    }
                    className="flex-1 h-1.5"
                    style={{ accentColor: "var(--accent-amber)" }}
                  />
                  <span className="text-sm font-medium text-white w-10 text-right font-mono">
                    {Math.round(botSettings.crypto_allocation * 100)}%
                  </span>
                </div>
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
                onMouseEnter={(e) => (e.currentTarget.style.background = "#40916c")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#52b788")}
                onClick={() => fetchAll()}
              >
                <Zap className="w-5 h-5" />
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
                fontFamily:
                  "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }}
            >
              {/* System init message */}
              <div className="flex space-x-2" style={{ color: "var(--text-muted)" }}>
                <span className="opacity-50">[sys]</span>
                <span style={{ color: "#5eb387" }}>
                  System initialized. Connected to Alpaca API.
                </span>
              </div>

              {/* Real signal log entries */}
              {logEntries.length === 0 ? (
                <div className="flex space-x-2" style={{ color: "var(--text-muted)" }}>
                  <span className="opacity-50">[--:--]</span>
                  <span>Awaiting signals...</span>
                </div>
              ) : (
                logEntries.map((entry, i) => (
                  <div key={i} className="flex space-x-2" style={{ color: "var(--text-muted)" }}>
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

              {/* Blinking cursor */}
              <div className="flex space-x-2" style={{ color: "var(--text-muted)" }}>
                <span className="opacity-50">[{new Date().toLocaleTimeString("en-US", { hour12: false })}]</span>
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
          fontFamily:
            "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
          <div className="flex items-center space-x-2" style={{ color: "var(--accent-green)" }}>
            <span>API: {isOnline ? "Active" : "Down"}</span>
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: isOnline ? "#22c55e" : "#ef4444",
                boxShadow: isOnline ? "0 0 5px rgba(82,183,136,0.8)" : undefined,
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
// Sub-Components
// ============================================================

function IconButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      className="w-8 h-8 rounded flex items-center justify-center border transition-colors"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border-color)",
        color: "var(--text-muted)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
    >
      {children}
    </button>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-md p-3 border"
      style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
    >
      <div className="text-[10px] uppercase mb-1" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div
        className="text-lg font-bold text-white"
        style={{
          fontFamily:
            "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        }}
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
  depth,
  side,
  distancePct,
  timeframe,
}: {
  symbol: string;
  pattern: string;
  price: number;
  depth: number;
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
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-panel-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <div>
        <span
          className="text-sm"
          style={{
            color: "var(--text-main)",
            fontFamily:
              "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          {symbol}
        </span>
        <span className="text-[9px] ml-1.5" style={{ color: "var(--text-muted)" }}>
          {pattern} · {timeframe}
        </span>
      </div>
      <div
        className="text-sm text-right"
        style={{
          color,
          fontFamily:
            "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        }}
      >
        {price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div className="flex items-center h-full">
        <div
          className="h-1 rounded"
          style={{ width: `${Math.min(100 - distancePct * 5, 100)}%`, background: barBg }}
        />
      </div>
      <div className="text-right">
        <span
          className="px-3 py-1 text-[10px] rounded border uppercase"
          style={{ borderColor: btnBorder, color, background: `${btnBg}50` }}
        >
          {distancePct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}
