import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Zap,
  Target,
  BarChart3,
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
  DollarSign,
  Percent,
  ArrowUpRight,
  ArrowDownRight,
  List,
  Crosshair,
  Unlock,
  CheckCircle2,
  XOctagon,
  Layers,
  RefreshCw,
  Plus,
} from "lucide-react";

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
  profit_factor: number | null;
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

interface TradeHistory {
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

interface WatchlistItem {
  symbol: string;
  assetClass: string;
}

const POLL_INTERVAL = 10_000;

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

type TabId = "terminal" | "analytics" | "risk" | "logs";
type SidebarTab = "execute" | "portfolio" | "slippage" | "riskguard";

export default function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [approaching, setApproaching] = useState<ApproachingSignal[]>([]);
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);
  const [history, setHistory] = useState<TradeHistory[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("terminal");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("execute");

  const fetchAll = useCallback(async () => {
    try {
      const [acctRes, posRes, sigRes, statRes, metRes, appRes, setRes, histRes, wlRes] =
        await Promise.allSettled([
          fetch("/api/account").then((r) => r.json()),
          fetch("/api/positions").then((r) => r.json()),
          fetch("/api/signals").then((r) => r.json()),
          fetch("/api/status").then((r) => r.json()),
          fetch("/api/metrics").then((r) => r.json()),
          fetch("/api/approaching").then((r) => r.json()),
          fetch("/api/settings").then((r) => r.json()),
          fetch("/api/history").then((r) => r.json()),
          fetch("/api/watchlist").then((r) => r.json()),
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
      if (histRes.status === "fulfilled" && Array.isArray(histRes.value))
        setHistory(histRes.value);
      if (wlRes.status === "fulfilled" && Array.isArray(wlRes.value))
        setWatchlist(wlRes.value);
    } catch {
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
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAll]);

  const isOnline = status?.status === "online";

  const logEntries = signals.slice(0, 20).map((s) => ({
    time: new Date(s.createdAt).toLocaleTimeString("en-US", { hour12: false }),
    text: `${s.direction.toUpperCase()} ${s.symbol} ${s.patternType} @ ${formatUsd(Number(s.entryPrice))}`,
    type: s.status === "filled" ? "success" : s.status === "pending" ? "info" : "warn",
  }));

  const analyticsData = useMemo(() => {
    const patternCounts: Record<string, number> = {};
    const directionCounts: Record<string, number> = { long: 0, short: 0 };
    const timeframeCounts: Record<string, number> = { "4H": 0, "1D": 0 };
    const symbolCounts: Record<string, number> = {};

    signals.forEach((s) => {
      patternCounts[s.patternType] = (patternCounts[s.patternType] || 0) + 1;
      directionCounts[s.direction] = (directionCounts[s.direction] || 0) + 1;
      timeframeCounts[s.timeframe] = (timeframeCounts[s.timeframe] || 0) + 1;
      symbolCounts[s.symbol] = (symbolCounts[s.symbol] || 0) + 1;
    });

    approaching.forEach((s) => {
      patternCounts[s.pattern] = (patternCounts[s.pattern] || 0) + 1;
      directionCounts[s.direction] = (directionCounts[s.direction] || 0) + 1;
      timeframeCounts[s.timeframe] = (timeframeCounts[s.timeframe] || 0) + 1;
      symbolCounts[s.symbol] = (symbolCounts[s.symbol] || 0) + 1;
    });

    const topSymbols = Object.entries(symbolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    return { patternCounts, directionCounts, timeframeCounts, topSymbols };
  }, [signals, approaching]);

  const riskData = useMemo(() => {
    const totalExposure = positions.reduce((sum, p) => sum + Math.abs(p.market_value), 0);
    const equity = account?.equity || 1;
    const exposurePct = (totalExposure / equity) * 100;

    const positionRisks = positions.map((p) => {
      const riskPerShare = p.stop_loss
        ? Math.abs(p.entry_price - p.stop_loss)
        : p.entry_price * 0.02;
      const totalRisk = riskPerShare * Math.abs(p.qty);
      const riskPct = (totalRisk / equity) * 100;
      const rewardTP1 = p.tp1
        ? Math.abs(p.tp1 - p.entry_price) * Math.abs(p.qty)
        : 0;
      const rrRatio = totalRisk > 0 && rewardTP1 > 0 ? rewardTP1 / totalRisk : 0;
      return {
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        marketValue: p.market_value,
        risk: totalRisk,
        riskPct,
        rrRatio,
        unrealizedPl: p.unrealized_pl,
        stopLoss: p.stop_loss,
        tp1: p.tp1,
        tp2: p.tp2,
      };
    });

    const maxDrawdown = positions.reduce(
      (max, p) => Math.min(max, p.unrealized_pl),
      0
    );

    const cryptoExposure = positions
      .filter((p) => p.symbol.includes("/"))
      .reduce((sum, p) => sum + Math.abs(p.market_value), 0);
    const equityExposure = positions
      .filter((p) => !p.symbol.includes("/"))
      .reduce((sum, p) => sum + Math.abs(p.market_value), 0);

    return {
      totalExposure,
      exposurePct,
      positionRisks,
      maxDrawdown,
      cryptoExposure,
      equityExposure,
      buyingPower: account?.buying_power || 0,
    };
  }, [positions, account]);

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
                activeTab === id ? "border-b-2" : "hover:text-white"
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
          <IconButton
            onClick={() => setActiveTab("terminal")}
            title={`${approaching.filter((s) => s.distancePct < 5).length} imminent signals`}
            badge={approaching.filter((s) => s.distancePct < 5).length}
          >
            <Bell className="w-4 h-4" />
          </IconButton>
          <IconButton
            onClick={() => setActiveTab("risk")}
            title="Risk Engine & Settings"
            active={activeTab === "risk"}
          >
            <Settings className="w-4 h-4" />
          </IconButton>
          <button
            className="w-8 h-8 rounded flex items-center justify-center text-black font-bold text-xs bg-[#ebd8c3] transition-opacity hover:opacity-80"
            onClick={() => setActiveTab("analytics")}
            title="Account & Portfolio"
          >
            <User className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {activeTab === "terminal" && (
          <>
            <aside
              className="w-64 flex flex-col border-r p-4 space-y-6 overflow-y-auto"
              style={{ borderColor: "var(--border-color)", background: "var(--bg-main)" }}
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                    Market Pulse
                  </h2>
                  <div className="w-2 h-2 rounded-full" style={{ background: "#22c55e", boxShadow: "0 0 6px rgba(34,197,94,0.8)" }} />
                </div>
                {positions.length > 0 ? (
                  <div className="rounded-md p-3 border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
                    <div className="text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>{positions[0].symbol}</div>
                    <div className="text-2xl font-bold text-white font-mono">{formatUsd(positions[0].current_price)}</div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs font-mono" style={{ color: positions[0].unrealized_pl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                        {positions[0].unrealized_pl >= 0 ? "+" : ""}{(positions[0].unrealized_pl_pct ?? 0).toFixed(2)}%
                      </span>
                      <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{positions.length} pos</span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md p-3 border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
                    <div className="text-[10px] mb-1" style={{ color: "var(--text-muted)" }}>No Positions</div>
                    <div className="text-lg font-bold text-white font-mono">{approaching.length} watching</div>
                  </div>
                )}
              </div>

              {account && (
                <div>
                  <h2 className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>Account</h2>
                  <div className="rounded-md p-3 border space-y-2" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
                    <div className="flex justify-between text-xs">
                      <span style={{ color: "var(--text-muted)" }}>Equity</span>
                      <span className="font-mono font-semibold text-white">{formatUsd(account.equity)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span style={{ color: "var(--text-muted)" }}>Buying Power</span>
                      <span className="font-mono font-semibold text-white">{formatUsd(account.buying_power)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span style={{ color: "var(--text-muted)" }}>Day P&L</span>
                      <span className="font-mono font-semibold" style={{ color: account.daily_pl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                        {account.daily_pl >= 0 ? "+" : ""}{formatUsd(account.daily_pl)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <nav className="space-y-2 flex-1">
                {([
                  { icon: <BarChart3 className="w-4 h-4" />, label: "EXECUTE", id: "execute" as SidebarTab },
                  { icon: <Activity className="w-4 h-4" />, label: "PORTFOLIO", id: "portfolio" as SidebarTab },
                  { icon: <TrendingUp className="w-4 h-4" />, label: "SLIPPAGE HUB", id: "slippage" as SidebarTab },
                  { icon: <Shield className="w-4 h-4" />, label: "RISK GUARD", id: "riskguard" as SidebarTab },
                ]).map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSidebarTab(item.id)}
                    className={`w-full flex items-center space-x-3 rounded-md px-4 py-3 text-sm transition-colors text-left ${
                      sidebarTab === item.id ? "font-semibold border" : ""
                    }`}
                    style={
                      sidebarTab === item.id
                        ? { background: "var(--accent-green-dim)", color: "var(--accent-green)", borderColor: "#166534" }
                        : { color: "var(--text-muted)" }
                    }
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
              </nav>

              <div className="rounded-md p-4 border mt-auto" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
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

            <section className="flex-1 flex flex-col border-r" style={{ borderColor: "var(--border-color)", background: "var(--bg-main)" }}>
              {sidebarTab === "execute" && <ExecutePanel approaching={approaching} signals={signals} positions={positions} />}
              {sidebarTab === "portfolio" && <PortfolioPanel positions={positions} history={history} account={account} />}
              {sidebarTab === "slippage" && <SlippagePanel history={history} />}
              {sidebarTab === "riskguard" && <RiskGuardPanel positions={positions} approaching={approaching} account={account} botSettings={botSettings} updateSettings={updateSettings} watchlist={watchlist} fetchAll={fetchAll} />}
            </section>

            <aside className="w-80 flex flex-col p-4 overflow-y-auto" style={{ background: "var(--bg-main)" }}>
              <div className="mb-6">
                <h2 className="text-[10px] font-semibold uppercase tracking-wider mb-4" style={{ color: "var(--text-muted)" }}>
                  Execution Engine
                </h2>
                <div className="grid grid-cols-2 gap-3 mb-6">
                  <MetricBox label="Win Rate" value={metrics ? `${metrics.win_rate}%` : "—"} />
                  <MetricBox label="Profit Factor" value={metrics ? (metrics.profit_factor == null ? "—" : metrics.profit_factor === Infinity ? "INF" : String(metrics.profit_factor)) : "—"} />
                </div>

                {botSettings && (
                  <div className="rounded-md p-3 border mb-4 flex items-center justify-between" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
                    <div className="flex items-center gap-2">
                      <Power className="w-4 h-4" style={{ color: botSettings.trading_enabled ? "var(--accent-green)" : "var(--accent-red)" }} />
                      <span className="text-xs font-medium text-white">Auto-Trade</span>
                    </div>
                    <button
                      onClick={() => updateSettings({ trading_enabled: !botSettings.trading_enabled })}
                      className="relative w-11 h-6 rounded-full transition-colors"
                      style={{ background: botSettings.trading_enabled ? "#22c55e" : "#374151" }}
                    >
                      <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform" style={{ transform: botSettings.trading_enabled ? "translateX(20px)" : "translateX(0)" }} />
                    </button>
                  </div>
                )}

                {botSettings && (
                  <div className="space-y-3 mb-6">
                    <label className="block text-[10px] uppercase mb-1" style={{ color: "var(--text-muted)" }}>Position Sizing</label>
                    <div className="flex items-center gap-2 text-xs">
                      <span style={{ color: "var(--text-muted)" }} className="w-14">Stock</span>
                      <input type="range" min="1" max="20" value={Math.round(botSettings.equity_allocation * 100)} onChange={(e) => updateSettings({ equity_allocation: Number(e.target.value) / 100 })} className="flex-1 h-1.5" style={{ accentColor: "var(--accent-green)" }} />
                      <span className="text-sm font-medium text-white w-10 text-right font-mono">{Math.round(botSettings.equity_allocation * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span style={{ color: "var(--text-muted)" }} className="w-14">Crypto</span>
                      <input type="range" min="1" max="20" value={Math.round(botSettings.crypto_allocation * 100)} onChange={(e) => updateSettings({ crypto_allocation: Number(e.target.value) / 100 })} className="flex-1 h-1.5" style={{ accentColor: "var(--accent-amber)" }} />
                      <span className="text-sm font-medium text-white w-10 text-right font-mono">{Math.round(botSettings.crypto_allocation * 100)}%</span>
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  <button
                    className="w-full text-black font-bold text-sm uppercase tracking-wider py-4 rounded flex items-center justify-center space-x-2 transition-colors"
                    style={{ background: "#52b788", boxShadow: "0 0 15px rgba(82,183,136,0.2)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#40916c")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "#52b788")}
                    onClick={() => fetchAll()}
                  >
                    <Zap className="w-5 h-5" />
                    <span>Refresh All</span>
                  </button>
                  <button
                    className="w-full font-bold text-sm uppercase tracking-wider py-4 rounded flex items-center justify-center space-x-2 transition-colors border"
                    style={{ background: "rgba(58,34,35,0.8)", color: "var(--accent-red)", borderColor: "rgba(127,29,29,0.5)" }}
                    onClick={async () => {
                      if (botSettings?.trading_enabled && confirm("Disable auto-trading?")) {
                        await updateSettings({ trading_enabled: false });
                      }
                    }}
                  >
                    <XCircle className="w-5 h-5" />
                    <span>Kill Switch</span>
                  </button>
                </div>
              </div>

              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex justify-between items-center mb-2">
                  <h2 className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Live Execution Log</h2>
                  <span className="text-[9px] tracking-widest uppercase" style={{ color: "var(--accent-green)" }}>{isOnline ? "Live" : "Offline"}</span>
                </div>
                <div className="flex-1 rounded-md p-3 overflow-y-auto border text-[10px] leading-tight space-y-2" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)", fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  <div className="flex space-x-2" style={{ color: "var(--text-muted)" }}>
                    <span className="opacity-50">[sys]</span>
                    <span style={{ color: "#5eb387" }}>System initialized. Connected to Alpaca API.</span>
                  </div>
                  {logEntries.length === 0 ? (
                    <div className="flex space-x-2" style={{ color: "var(--text-muted)" }}>
                      <span className="opacity-50">[--:--]</span>
                      <span>Awaiting signals...</span>
                    </div>
                  ) : (
                    logEntries.map((entry, i) => (
                      <div key={i} className="flex space-x-2" style={{ color: "var(--text-muted)" }}>
                        <span className="opacity-50">[{entry.time}]</span>
                        <span style={{ color: entry.type === "success" ? "#5eb387" : entry.type === "warn" ? "var(--accent-amber)" : "var(--text-main)" }}>
                          {entry.text}
                        </span>
                      </div>
                    ))
                  )}
                  <div className="flex space-x-2" style={{ color: "var(--text-muted)" }}>
                    <span className="opacity-50">[{new Date().toLocaleTimeString("en-US", { hour12: false })}]</span>
                    <span className="animate-pulse">_</span>
                  </div>
                </div>
              </div>
            </aside>
          </>
        )}

        {activeTab === "analytics" && (
          <AnalyticsPage
            history={history}
            signals={signals}
            approaching={approaching}
            metrics={metrics}
            analyticsData={analyticsData}
            watchlist={watchlist}
          />
        )}

        {activeTab === "risk" && (
          <RiskEnginePage
            riskData={riskData}
            positions={positions}
            account={account}
            botSettings={botSettings}
            approaching={approaching}
            metrics={metrics}
          />
        )}

        {activeTab === "logs" && (
          <LogsPage
            signals={signals}
            approaching={approaching}
            history={history}
            status={status}
            isOnline={isOnline}
            onClearSignals={async () => {
              if (!confirm("Clear all signals from the feed?")) return;
              try {
                const res = await fetch("/api/signals/clear", { method: "POST" });
                if (res.ok) { setSignals([]); fetchAll(); }
              } catch {}
            }}
            onRefresh={fetchAll}
          />
        )}
      </main>

      <footer
        className="flex justify-between items-center px-4 py-2 border-t text-[9px] uppercase tracking-widest"
        style={{ borderColor: "var(--border-color)", background: "var(--bg-main)", color: "var(--text-muted)", fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
      >
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2"><Globe className="w-3 h-3" /><span>Gateway: Alpaca-API</span></div>
          <div className="flex items-center space-x-2"><Clock className="w-3 h-3" /><span>Uptime: {status ? formatUptime(status.uptime) : "—"}</span></div>
        </div>
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2" style={{ color: "var(--accent-green)" }}>
            <span>API: {isOnline ? "Active" : "Down"}</span>
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: isOnline ? "#22c55e" : "#ef4444", boxShadow: isOnline ? "0 0 5px rgba(82,183,136,0.8)" : undefined }} />
          </div>
          <span>{nowUtc()}</span>
        </div>
      </footer>
    </div>
  );
}

function ExecutePanel({ approaching, signals, positions }: { approaching: ApproachingSignal[]; signals: Signal[]; positions: Position[] }) {
  return (
    <>
      <div className="p-4 border-b flex justify-between items-center" style={{ borderColor: "var(--border-color)" }}>
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Tactical Depth of Market</h2>
        <div className="flex space-x-2">
          <span className="px-2 py-1 rounded border text-[10px]" style={{ background: "var(--bg-panel)", color: "var(--accent-green)", borderColor: "#166534" }}>LIVE FEED</span>
          <span className="px-2 py-1 rounded border text-[10px]" style={{ background: "var(--bg-panel)", color: "var(--accent-amber)", borderColor: "rgba(205,166,97,0.3)" }}>{signals.length} SIGNALS</span>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-4 gap-4 px-4 py-2 border-b text-[10px] uppercase tracking-wider" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
          <div>Symbol</div><div className="text-right">Price (USD)</div><div>Distance</div><div className="text-right">Direction</div>
        </div>
        {approaching.filter((s) => s.direction === "short").slice(0, 6).map((s) => (
          <DomRow key={s.id} symbol={s.symbol} pattern={s.pattern} price={s.projectedD} depth={Math.min(s.distancePct * 10, 100)} side="ask" distancePct={s.distancePct} timeframe={s.timeframe} />
        ))}
        {approaching.filter((s) => s.direction === "short").length === 0 && (
          <div className="px-4 py-6 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>No short signals</div>
        )}
        <div className="px-4 py-2 flex justify-center items-center border-y" style={{ borderColor: "var(--border-color)", background: "rgba(21,26,29,0.5)" }}>
          <span className="text-[10px] uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
            {approaching.length > 0 ? `${approaching.length} Active Signals · ${approaching.filter((s) => s.distancePct < 5).length} Imminent` : "No Active Signals"}
          </span>
        </div>
        {approaching.filter((s) => s.direction === "long").slice(0, 6).map((s) => (
          <DomRow key={s.id} symbol={s.symbol} pattern={s.pattern} price={s.projectedD} depth={Math.min(s.distancePct * 10, 100)} side="bid" distancePct={s.distancePct} timeframe={s.timeframe} />
        ))}
        {approaching.filter((s) => s.direction === "long").length === 0 && (
          <div className="px-4 py-6 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>No long signals</div>
        )}
        {positions.length > 0 && (
          <div className="mt-4">
            <div className="px-4 py-2 border-t border-b text-[10px] uppercase tracking-wider font-semibold" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
              Open Positions ({positions.length})
            </div>
            {positions.map((p) => (
              <div key={p.symbol} className="grid grid-cols-4 gap-4 px-4 py-3 border-b items-center transition-colors" style={{ borderColor: "var(--border-color)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div>
                  <span className="font-mono text-sm text-white">{p.symbol}</span>
                  {p.pattern && <span className="text-[10px] ml-1.5" style={{ color: "var(--text-muted)" }}>{p.pattern}</span>}
                </div>
                <div className="font-mono text-sm text-right" style={{ color: "var(--text-main)" }}>{formatUsd(p.current_price)}</div>
                <div className="flex items-center h-full">
                  <div className="h-1 rounded" style={{ width: `${Math.min(Math.abs(p.unrealized_pl_pct) * 10, 100)}%`, background: p.unrealized_pl >= 0 ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)" }} />
                </div>
                <div className="text-right">
                  <span className="font-mono text-sm font-semibold" style={{ color: p.unrealized_pl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                    {p.unrealized_pl >= 0 ? "+" : ""}{(p.unrealized_pl_pct ?? 0).toFixed(2)}%
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

function PortfolioPanel({ positions, history, account }: { positions: Position[]; history: TradeHistory[]; account: Account | null }) {
  const totalUnrealized = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const totalMarketValue = positions.reduce((s, p) => s + Math.abs(p.market_value), 0);

  return (
    <>
      <div className="p-4 border-b" style={{ borderColor: "var(--border-color)" }}>
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Portfolio Overview</h2>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Open Positions" value={String(positions.length)} icon={<Layers className="w-4 h-4" />} />
          <StatCard label="Total Exposure" value={formatUsd(totalMarketValue)} icon={<DollarSign className="w-4 h-4" />} />
          <StatCard label="Unrealized P&L" value={formatUsd(totalUnrealized)} icon={totalUnrealized >= 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />} color={totalUnrealized >= 0 ? "var(--accent-green)" : "var(--accent-red)"} />
          <StatCard label="Completed Trades" value={String(history.length)} icon={<CheckCircle2 className="w-4 h-4" />} />
        </div>

        {positions.length > 0 && (
          <div className="rounded-md border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
            <div className="px-4 py-3 border-b text-[10px] uppercase tracking-wider font-semibold" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
              Active Positions Detail
            </div>
            <div className="grid grid-cols-8 gap-2 px-4 py-2 text-[9px] uppercase tracking-wider border-b" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
              <div>Symbol</div><div>Side</div><div className="text-right">Qty</div><div className="text-right">Entry</div><div className="text-right">Current</div><div className="text-right">SL</div><div className="text-right">TP1</div><div className="text-right">P&L</div>
            </div>
            {positions.map((p) => (
              <div key={p.symbol} className="grid grid-cols-8 gap-2 px-4 py-2.5 border-b text-xs items-center" style={{ borderColor: "var(--border-color)" }}>
                <div className="font-mono text-white font-semibold">{p.symbol}</div>
                <div><span className="px-1.5 py-0.5 rounded text-[9px] uppercase" style={{ background: p.side === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)", color: p.side === "long" ? "var(--accent-green)" : "var(--accent-red)" }}>{p.side}</span></div>
                <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{(p.qty ?? 0).toFixed(2)}</div>
                <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{formatUsd(p.entry_price)}</div>
                <div className="text-right font-mono text-white">{formatUsd(p.current_price)}</div>
                <div className="text-right font-mono" style={{ color: "var(--accent-red)" }}>{p.stop_loss ? formatUsd(p.stop_loss) : "—"}</div>
                <div className="text-right font-mono" style={{ color: "var(--accent-green)" }}>{p.tp1 ? formatUsd(p.tp1) : "—"}</div>
                <div className="text-right font-mono font-semibold" style={{ color: p.unrealized_pl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                  {p.unrealized_pl >= 0 ? "+" : ""}{formatUsd(p.unrealized_pl)}
                </div>
              </div>
            ))}
          </div>
        )}

        {positions.length === 0 && (
          <div className="rounded-md border p-8 text-center" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
            <Target className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--text-muted)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>No open positions. Scanner is actively looking for patterns.</p>
          </div>
        )}

        <div className="rounded-md border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <div className="px-4 py-3 border-b text-[10px] uppercase tracking-wider font-semibold" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            Recent Trade History
          </div>
          <div className="grid grid-cols-7 gap-2 px-4 py-2 text-[9px] uppercase tracking-wider border-b" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            <div>Symbol</div><div>Pattern</div><div>Dir</div><div className="text-right">Entry</div><div className="text-right">Fill</div><div className="text-right">Qty</div><div className="text-right">Time</div>
          </div>
          {history.slice(0, 15).map((t, i) => (
            <div key={i} className="grid grid-cols-7 gap-2 px-4 py-2 border-b text-xs items-center" style={{ borderColor: "var(--border-color)" }}>
              <div className="font-mono text-white">{t.symbol}</div>
              <div style={{ color: "var(--accent-amber)" }}>{t.pattern || "—"}</div>
              <div><span className="px-1.5 py-0.5 rounded text-[9px] uppercase" style={{ background: t.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)", color: t.direction === "long" ? "var(--accent-green)" : "var(--accent-red)" }}>{t.direction || t.side}</span></div>
              <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{t.entry_price != null ? formatUsd(t.entry_price) : "—"}</div>
              <div className="text-right font-mono text-white">{formatUsd(t.filled_price)}</div>
              <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{(t.qty ?? 0).toFixed(2)}</div>
              <div className="text-right text-[10px]" style={{ color: "var(--text-muted)" }}>{timeAgo(t.filled_at)}</div>
            </div>
          ))}
          {history.length === 0 && (
            <div className="px-4 py-6 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>No trade history yet</div>
          )}
        </div>
      </div>
    </>
  );
}

function SlippagePanel({ history }: { history: TradeHistory[] }) {
  const slippageData = history.filter((t) => t.entry_price != null).map((t) => {
    const entryPrice = t.entry_price!;
    const slippage = t.filled_price - entryPrice;
    const slippagePct = (slippage / entryPrice) * 100;
    const dir = t.direction || t.side;
    const slippageDir = dir === "long" || dir === "buy" ? slippage : -slippage;
    return { ...t, slippage: slippageDir, slippagePct: dir === "long" || dir === "buy" ? slippagePct : -slippagePct };
  });

  const avgSlippage = slippageData.length > 0
    ? slippageData.reduce((s, d) => s + d.slippagePct, 0) / slippageData.length
    : 0;
  const favorableCount = slippageData.filter((d) => d.slippagePct <= 0).length;
  const adverseCount = slippageData.filter((d) => d.slippagePct > 0).length;
  const worstSlippage = slippageData.length > 0
    ? Math.max(...slippageData.map((d) => d.slippagePct))
    : 0;

  return (
    <>
      <div className="p-4 border-b" style={{ borderColor: "var(--border-color)" }}>
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Slippage Analysis Hub</h2>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Avg Slippage" value={`${avgSlippage.toFixed(3)}%`} icon={<Percent className="w-4 h-4" />} color={avgSlippage <= 0 ? "var(--accent-green)" : "var(--accent-red)"} />
          <StatCard label="Favorable Fills" value={String(favorableCount)} icon={<CheckCircle2 className="w-4 h-4" />} color="var(--accent-green)" />
          <StatCard label="Adverse Fills" value={String(adverseCount)} icon={<XOctagon className="w-4 h-4" />} color="var(--accent-red)" />
          <StatCard label="Worst Slippage" value={`${worstSlippage.toFixed(3)}%`} icon={<AlertTriangle className="w-4 h-4" />} color="var(--accent-amber)" />
        </div>

        <div className="rounded-md border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <div className="px-4 py-3 border-b text-[10px] uppercase tracking-wider font-semibold" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            Fill Quality Per Trade
          </div>
          <div className="grid grid-cols-7 gap-2 px-4 py-2 text-[9px] uppercase tracking-wider border-b" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            <div>Symbol</div><div>Pattern</div><div>Dir</div><div className="text-right">Expected</div><div className="text-right">Actual Fill</div><div className="text-right">Slippage</div><div className="text-right">Quality</div>
          </div>
          {slippageData.map((d, i) => (
            <div key={i} className="grid grid-cols-7 gap-2 px-4 py-2.5 border-b text-xs items-center" style={{ borderColor: "var(--border-color)" }}>
              <div className="font-mono text-white">{d.symbol}</div>
              <div style={{ color: "var(--accent-amber)" }}>{d.pattern || "—"}</div>
              <div><span className="px-1.5 py-0.5 rounded text-[9px] uppercase" style={{ background: (d.direction || d.side) === "long" || d.side === "buy" ? "var(--accent-green-dim)" : "var(--accent-red-dim)", color: (d.direction || d.side) === "long" || d.side === "buy" ? "var(--accent-green)" : "var(--accent-red)" }}>{d.direction || d.side}</span></div>
              <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{d.entry_price != null ? formatUsd(d.entry_price) : "—"}</div>
              <div className="text-right font-mono text-white">{formatUsd(d.filled_price)}</div>
              <div className="text-right font-mono" style={{ color: d.slippagePct <= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                {d.slippagePct > 0 ? "+" : ""}{d.slippagePct.toFixed(4)}%
              </div>
              <div className="text-right">
                <span className="px-2 py-0.5 rounded text-[9px]" style={{
                  background: Math.abs(d.slippagePct) < 0.1 ? "var(--accent-green-dim)" : Math.abs(d.slippagePct) < 1 ? "rgba(205,166,97,0.15)" : "var(--accent-red-dim)",
                  color: Math.abs(d.slippagePct) < 0.1 ? "var(--accent-green)" : Math.abs(d.slippagePct) < 1 ? "var(--accent-amber)" : "var(--accent-red)",
                }}>
                  {Math.abs(d.slippagePct) < 0.1 ? "EXCELLENT" : Math.abs(d.slippagePct) < 1 ? "FAIR" : "POOR"}
                </span>
              </div>
            </div>
          ))}
          {slippageData.length === 0 && (
            <div className="px-4 py-8 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>No fills to analyze yet. Execute some trades first.</div>
          )}
        </div>
      </div>
    </>
  );
}

function RiskGuardPanel({ positions, approaching, account, botSettings, updateSettings, watchlist, fetchAll }: { positions: Position[]; approaching: ApproachingSignal[]; account: Account | null; botSettings: BotSettings | null; updateSettings: (patch: Partial<BotSettings>) => Promise<void>; watchlist: WatchlistItem[]; fetchAll: () => Promise<void> }) {
  const [newSymbol, setNewSymbol] = useState("");
  const addSymbol = async () => {
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    try {
      await fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: sym }) });
      setNewSymbol("");
      fetchAll();
    } catch {}
  };
  const removeSymbol = async (sym: string) => {
    try {
      await fetch(`/api/watchlist/${encodeURIComponent(sym)}`, { method: "DELETE" });
      fetchAll();
    } catch {}
  };
  const equity = account?.equity || 1;
  const totalExposure = positions.reduce((s, p) => s + Math.abs(p.market_value), 0);
  const exposurePct = (totalExposure / equity) * 100;
  const maxRiskPerTrade = equity * (botSettings?.crypto_allocation || 0.07);

  return (
    <>
      <div className="p-4 border-b" style={{ borderColor: "var(--border-color)" }}>
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>Risk Guard Monitor</h2>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Exposure" value={`${exposurePct.toFixed(1)}%`} icon={<Shield className="w-4 h-4" />} color={exposurePct < 30 ? "var(--accent-green)" : exposurePct < 70 ? "var(--accent-amber)" : "var(--accent-red)"} />
          <StatCard label="Max Risk/Trade" value={formatUsd(maxRiskPerTrade)} icon={<Target className="w-4 h-4" />} />
          <StatCard label="Pending Entries" value={String(approaching.length)} icon={<Crosshair className="w-4 h-4" />} color="var(--accent-amber)" />
        </div>

        <div className="rounded-md border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <div className="px-4 py-3 border-b text-[10px] uppercase tracking-wider font-semibold" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            Risk Limits
          </div>
          <div className="p-4 space-y-4">
            <RiskBar label="Portfolio Exposure" value={exposurePct} max={100} color={exposurePct < 30 ? "#22c55e" : exposurePct < 70 ? "#eab308" : "#ef4444"} />
            <RiskBar label="Stock Allocation" value={(botSettings?.equity_allocation || 0) * 100} max={20} color="#3b82f6" />
            <RiskBar label="Crypto Allocation" value={(botSettings?.crypto_allocation || 0) * 100} max={20} color="#f59e0b" />
            <RiskBar label="Open Positions" value={positions.length} max={10} color={positions.length < 5 ? "#22c55e" : "#ef4444"} />
          </div>
        </div>

        <div className="rounded-md border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <div className="px-4 py-3 border-b text-[10px] uppercase tracking-wider font-semibold" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            Approaching Trade Risk Preview
          </div>
          {approaching.slice(0, 8).map((s) => {
            const riskAmt = Math.abs(s.projectedD - s.sl) * (maxRiskPerTrade / s.projectedD);
            const riskPctOfEquity = (riskAmt / equity) * 100;
            return (
              <div key={s.id} className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: "var(--border-color)" }}>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-white text-xs">{s.symbol}</span>
                  <span className="text-[9px]" style={{ color: "var(--accent-amber)" }}>{s.pattern}</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] uppercase" style={{ background: s.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)", color: s.direction === "long" ? "var(--accent-green)" : "var(--accent-red)" }}>{s.direction}</span>
                </div>
                <div className="flex items-center gap-4 text-[10px]">
                  <span style={{ color: "var(--text-muted)" }}>Risk: <span className="text-white">{riskPctOfEquity.toFixed(2)}%</span></span>
                  <span style={{ color: "var(--text-muted)" }}>Dist: <span style={{ color: s.distancePct < 3 ? "var(--accent-red)" : "var(--accent-green)" }}>{s.distancePct.toFixed(1)}%</span></span>
                </div>
              </div>
            );
          })}
          {approaching.length === 0 && (
            <div className="px-4 py-6 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>No approaching trades to evaluate</div>
          )}
        </div>

        <div className="rounded-md border p-4" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <div className="text-[10px] uppercase tracking-wider font-semibold mb-3" style={{ color: "var(--text-muted)" }}>Pattern Toggles</div>
          <div className="flex flex-wrap gap-2">
            {(["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"] as const).map((p) => {
              const isEnabled = botSettings?.enabled_patterns?.includes(p) ?? true;
              return (
                <button
                  key={p}
                  onClick={() => {
                    if (!botSettings) return;
                    const next = isEnabled
                      ? botSettings.enabled_patterns.filter((x) => x !== p)
                      : [...botSettings.enabled_patterns, p];
                    if (next.length > 0) updateSettings({ enabled_patterns: next });
                  }}
                  className="px-2.5 py-1 rounded border text-[10px] transition-colors cursor-pointer"
                  style={isEnabled
                    ? { background: "var(--accent-green-dim)", color: "var(--accent-green)", borderColor: "#166534" }
                    : { background: "var(--bg-panel)", color: "var(--text-muted)", borderColor: "var(--border-color)" }
                  }
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>

        {/* Watchlist Manager */}
        <div className="rounded-md border p-4" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <div className="flex items-center gap-2 mb-3">
            <Eye className="w-4 h-4" style={{ color: "var(--accent-amber)" }} />
            <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--text-muted)" }}>Watchlist Manager</span>
            <span className="text-[10px] ml-auto" style={{ color: "var(--text-muted)" }}>{watchlist.length} symbols</span>
          </div>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addSymbol()}
              placeholder="Add symbol (e.g. NVDA, SOL/USD)"
              className="flex-1 rounded-lg px-3 py-2 text-xs focus:outline-none"
              style={{ background: "var(--bg-main)", border: "1px solid var(--border-color)", color: "var(--text-main)" }}
            />
            <button
              onClick={addSymbol}
              className="rounded-lg px-3 py-2 text-xs font-medium flex items-center gap-1 transition-colors"
              style={{ background: "rgba(205,166,97,0.1)", color: "var(--accent-amber)", border: "1px solid rgba(205,166,97,0.2)" }}
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>
          {watchlist.length === 0 ? (
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>No symbols in watchlist</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {watchlist.map((w) => (
                <div key={w.symbol} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[10px] border" style={{ background: "var(--bg-main)", borderColor: "var(--border-color)" }}>
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: w.assetClass === "crypto" ? "var(--accent-amber)" : "var(--accent-green)" }} />
                  <span className="font-medium text-white">{w.symbol}</span>
                  <button
                    onClick={() => removeSymbol(w.symbol)}
                    className="ml-0.5 transition-colors"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-red)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                  >
                    <XCircle className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function AnalyticsPage({ history, signals, approaching, metrics, analyticsData, watchlist }: {
  history: TradeHistory[];
  signals: Signal[];
  approaching: ApproachingSignal[];
  metrics: Metrics | null;
  analyticsData: {
    patternCounts: Record<string, number>;
    directionCounts: Record<string, number>;
    timeframeCounts: Record<string, number>;
    topSymbols: [string, number][];
  };
  watchlist: WatchlistItem[];
}) {
  const totalSignals = signals.length + approaching.length;
  const cryptoSymbols = watchlist.filter((w) => w.assetClass === "crypto").length;
  const equitySymbols = watchlist.filter((w) => w.assetClass === "equity").length;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6" style={{ background: "var(--bg-main)" }}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white uppercase tracking-wider">Analytics Dashboard</h2>
        <span className="text-[10px] px-3 py-1 rounded border" style={{ background: "var(--bg-panel)", color: "var(--accent-green)", borderColor: "#166534" }}>
          {totalSignals} Active Signals
        </span>
      </div>

      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Total Signals" value={String(totalSignals)} icon={<Zap className="w-4 h-4" />} color="var(--accent-amber)" />
        <StatCard label="Win Rate" value={metrics ? `${metrics.win_rate}%` : "—"} icon={<Target className="w-4 h-4" />} color="var(--accent-green)" />
        <StatCard label="Profit Factor" value={metrics ? (metrics.profit_factor == null ? "—" : metrics.profit_factor === Infinity ? "INF" : metrics.profit_factor.toFixed(2)) : "—"} icon={<TrendingUp className="w-4 h-4" />} />
        <StatCard label="Total Trades" value={String(history.length)} icon={<BarChart3 className="w-4 h-4" />} />
        <StatCard label="Watchlist" value={`${watchlist.length}`} icon={<Eye className="w-4 h-4" />} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-md border p-4" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <h3 className="text-[10px] uppercase tracking-wider font-semibold mb-4" style={{ color: "var(--text-muted)" }}>Pattern Distribution</h3>
          {Object.entries(analyticsData.patternCounts).sort((a, b) => b[1] - a[1]).map(([pattern, count]) => (
            <div key={pattern} className="flex items-center justify-between mb-2">
              <span className="text-xs text-white">{pattern}</span>
              <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 rounded-full" style={{ background: "var(--border-color)" }}>
                  <div className="h-full rounded-full" style={{ width: `${(count / totalSignals) * 100}%`, background: "var(--accent-green)" }} />
                </div>
                <span className="text-[10px] font-mono w-6 text-right" style={{ color: "var(--accent-amber)" }}>{count}</span>
              </div>
            </div>
          ))}
          {Object.keys(analyticsData.patternCounts).length === 0 && (
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>No signals detected yet</p>
          )}
        </div>

        <div className="rounded-md border p-4" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <h3 className="text-[10px] uppercase tracking-wider font-semibold mb-4" style={{ color: "var(--text-muted)" }}>Direction Breakdown</h3>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span style={{ color: "var(--accent-green)" }}>Long</span>
                <span className="font-mono text-white">{analyticsData.directionCounts.long || 0}</span>
              </div>
              <div className="h-2 rounded-full" style={{ background: "var(--border-color)" }}>
                <div className="h-full rounded-full" style={{ width: `${totalSignals > 0 ? ((analyticsData.directionCounts.long || 0) / totalSignals) * 100 : 0}%`, background: "#22c55e" }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span style={{ color: "var(--accent-red)" }}>Short</span>
                <span className="font-mono text-white">{analyticsData.directionCounts.short || 0}</span>
              </div>
              <div className="h-2 rounded-full" style={{ background: "var(--border-color)" }}>
                <div className="h-full rounded-full" style={{ width: `${totalSignals > 0 ? ((analyticsData.directionCounts.short || 0) / totalSignals) * 100 : 0}%`, background: "#ef4444" }} />
              </div>
            </div>
          </div>
          <div className="mt-6">
            <h4 className="text-[10px] uppercase tracking-wider font-semibold mb-3" style={{ color: "var(--text-muted)" }}>Timeframe Split</h4>
            <div className="flex gap-3">
              {Object.entries(analyticsData.timeframeCounts).map(([tf, count]) => (
                <div key={tf} className="flex-1 rounded-md p-3 border text-center" style={{ background: "var(--bg-main)", borderColor: "var(--border-color)" }}>
                  <div className="text-lg font-bold text-white font-mono">{count}</div>
                  <div className="text-[9px] uppercase" style={{ color: "var(--text-muted)" }}>{tf}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-md border p-4" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <h3 className="text-[10px] uppercase tracking-wider font-semibold mb-4" style={{ color: "var(--text-muted)" }}>Top Active Symbols</h3>
          {analyticsData.topSymbols.map(([sym, count]) => (
            <div key={sym} className="flex items-center justify-between mb-2 py-1">
              <span className="text-xs font-mono text-white">{sym}</span>
              <div className="flex items-center gap-2">
                <div className="flex">
                  {Array.from({ length: count }).map((_, j) => (
                    <div key={j} className="w-2 h-2 rounded-full mr-0.5" style={{ background: "var(--accent-green)" }} />
                  ))}
                </div>
                <span className="text-[10px] font-mono" style={{ color: "var(--accent-amber)" }}>{count}</span>
              </div>
            </div>
          ))}
          {analyticsData.topSymbols.length === 0 && (
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>No symbol activity yet</p>
          )}
          <div className="mt-4 pt-3 border-t" style={{ borderColor: "var(--border-color)" }}>
            <div className="flex justify-between text-[10px]">
              <span style={{ color: "var(--text-muted)" }}>Crypto symbols</span>
              <span className="text-white">{cryptoSymbols}</span>
            </div>
            <div className="flex justify-between text-[10px] mt-1">
              <span style={{ color: "var(--text-muted)" }}>Equity symbols</span>
              <span className="text-white">{equitySymbols}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-md border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
        <div className="px-4 py-3 border-b flex justify-between items-center" style={{ borderColor: "var(--border-color)" }}>
          <h3 className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--text-muted)" }}>Complete Trade History</h3>
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{history.length} trades</span>
        </div>
        <div className="grid grid-cols-9 gap-2 px-4 py-2 text-[9px] uppercase tracking-wider border-b" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
          <div>Symbol</div><div>Pattern</div><div>Dir</div><div className="text-right">Target Entry</div><div className="text-right">Filled Price</div><div className="text-right">Qty</div><div className="text-right">SL</div><div className="text-right">TP1</div><div className="text-right">Time</div>
        </div>
        {history.map((t, i) => (
          <div key={i} className="grid grid-cols-9 gap-2 px-4 py-2 border-b text-xs items-center transition-colors"
            style={{ borderColor: "var(--border-color)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-panel-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <div className="font-mono text-white">{t.symbol}</div>
            <div style={{ color: "var(--accent-amber)" }}>{t.pattern || "—"}</div>
            <div><span className="px-1.5 py-0.5 rounded text-[9px] uppercase" style={{ background: t.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)", color: t.direction === "long" ? "var(--accent-green)" : "var(--accent-red)" }}>{t.direction || t.side}</span></div>
            <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{t.entry_price != null ? formatUsd(t.entry_price) : "—"}</div>
            <div className="text-right font-mono text-white">{formatUsd(t.filled_price)}</div>
            <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{(t.qty ?? 0).toFixed(2)}</div>
            <div className="text-right font-mono" style={{ color: "var(--accent-red)" }}>{t.stop_loss != null ? formatUsd(t.stop_loss) : "—"}</div>
            <div className="text-right font-mono" style={{ color: "var(--accent-green)" }}>{t.tp1 != null ? formatUsd(t.tp1) : "—"}</div>
            <div className="text-right text-[10px]" style={{ color: "var(--text-muted)" }}>
              {new Date(t.filled_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </div>
          </div>
        ))}
        {history.length === 0 && (
          <div className="px-4 py-8 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>No completed trades yet</div>
        )}
      </div>
    </div>
  );
}

function RiskEnginePage({ riskData, positions, account, botSettings, approaching, metrics }: {
  riskData: {
    totalExposure: number;
    exposurePct: number;
    positionRisks: {
      symbol: string; side: string; qty: number; marketValue: number; risk: number; riskPct: number; rrRatio: number; unrealizedPl: number; stopLoss: number | null; tp1: number | null; tp2: number | null;
    }[];
    maxDrawdown: number;
    cryptoExposure: number;
    equityExposure: number;
    buyingPower: number;
  };
  positions: Position[];
  account: Account | null;
  botSettings: BotSettings | null;
  approaching: ApproachingSignal[];
  metrics: Metrics | null;
}) {
  const equity = account?.equity || 1;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6" style={{ background: "var(--bg-main)" }}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white uppercase tracking-wider">Risk Engine</h2>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: riskData.exposurePct < 30 ? "#22c55e" : riskData.exposurePct < 70 ? "#eab308" : "#ef4444" }} />
          <span className="text-[10px] uppercase tracking-wider" style={{ color: riskData.exposurePct < 30 ? "var(--accent-green)" : "var(--accent-amber)" }}>
            {riskData.exposurePct < 30 ? "LOW RISK" : riskData.exposurePct < 70 ? "MODERATE RISK" : "HIGH RISK"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Total Exposure" value={formatUsd(riskData.totalExposure)} icon={<DollarSign className="w-4 h-4" />} />
        <StatCard label="Exposure %" value={`${riskData.exposurePct.toFixed(1)}%`} icon={<Percent className="w-4 h-4" />} color={riskData.exposurePct < 30 ? "var(--accent-green)" : "var(--accent-amber)"} />
        <StatCard label="Buying Power" value={formatUsd(riskData.buyingPower)} icon={<Unlock className="w-4 h-4" />} color="var(--accent-green)" />
        <StatCard label="Max Drawdown" value={formatUsd(riskData.maxDrawdown)} icon={<TrendingDown className="w-4 h-4" />} color="var(--accent-red)" />
        <StatCard label="Pending Entries" value={String(approaching.length)} icon={<Crosshair className="w-4 h-4" />} color="var(--accent-amber)" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-md border p-4" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <h3 className="text-[10px] uppercase tracking-wider font-semibold mb-4" style={{ color: "var(--text-muted)" }}>Capital Allocation</h3>
          <div className="space-y-4">
            <RiskBar label="Portfolio Utilization" value={riskData.exposurePct} max={100} color={riskData.exposurePct < 30 ? "#22c55e" : "#eab308"} />
            <RiskBar label="Crypto Exposure" value={(riskData.cryptoExposure / equity) * 100} max={100} color="#f59e0b" />
            <RiskBar label="Equity Exposure" value={(riskData.equityExposure / equity) * 100} max={100} color="#3b82f6" />
            <RiskBar label="Cash Reserve" value={((riskData.buyingPower) / equity) * 100} max={100} color="#22c55e" />
          </div>
          <div className="mt-4 pt-3 border-t space-y-2" style={{ borderColor: "var(--border-color)" }}>
            <div className="flex justify-between text-[10px]">
              <span style={{ color: "var(--text-muted)" }}>Crypto Exposure</span>
              <span className="font-mono text-white">{formatUsd(riskData.cryptoExposure)}</span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span style={{ color: "var(--text-muted)" }}>Equity Exposure</span>
              <span className="font-mono text-white">{formatUsd(riskData.equityExposure)}</span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span style={{ color: "var(--text-muted)" }}>Available Cash</span>
              <span className="font-mono" style={{ color: "var(--accent-green)" }}>{formatUsd(riskData.buyingPower)}</span>
            </div>
          </div>
        </div>

        <div className="rounded-md border p-4" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <h3 className="text-[10px] uppercase tracking-wider font-semibold mb-4" style={{ color: "var(--text-muted)" }}>Risk Parameters</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center py-2 border-b" style={{ borderColor: "var(--border-color)" }}>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>Stock Allocation</span>
              <span className="text-xs font-mono text-white">{Math.round((botSettings?.equity_allocation || 0) * 100)}%</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b" style={{ borderColor: "var(--border-color)" }}>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>Crypto Allocation</span>
              <span className="text-xs font-mono text-white">{Math.round((botSettings?.crypto_allocation || 0) * 100)}%</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b" style={{ borderColor: "var(--border-color)" }}>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>Max Risk Per Stock Trade</span>
              <span className="text-xs font-mono text-white">{formatUsd(equity * (botSettings?.equity_allocation || 0.05))}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b" style={{ borderColor: "var(--border-color)" }}>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>Max Risk Per Crypto Trade</span>
              <span className="text-xs font-mono text-white">{formatUsd(equity * (botSettings?.crypto_allocation || 0.07))}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b" style={{ borderColor: "var(--border-color)" }}>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>Auto-Trading</span>
              <span className="text-xs font-semibold" style={{ color: botSettings?.trading_enabled ? "var(--accent-green)" : "var(--accent-red)" }}>
                {botSettings?.trading_enabled ? "ENABLED" : "DISABLED"}
              </span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>Active Patterns</span>
              <span className="text-xs font-mono text-white">{(botSettings?.enabled_patterns || []).length}</span>
            </div>
          </div>
        </div>
      </div>

      {riskData.positionRisks.length > 0 && (
        <div className="rounded-md border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <div className="px-4 py-3 border-b text-[10px] uppercase tracking-wider font-semibold" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            Position Risk Breakdown
          </div>
          <div className="grid grid-cols-8 gap-2 px-4 py-2 text-[9px] uppercase tracking-wider border-b" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            <div>Symbol</div><div>Side</div><div className="text-right">Market Val</div><div className="text-right">Risk ($)</div><div className="text-right">Risk (%)</div><div className="text-right">R:R</div><div className="text-right">SL</div><div className="text-right">Unrl P&L</div>
          </div>
          {riskData.positionRisks.map((r) => (
            <div key={r.symbol} className="grid grid-cols-8 gap-2 px-4 py-2.5 border-b text-xs items-center" style={{ borderColor: "var(--border-color)" }}>
              <div className="font-mono text-white font-semibold">{r.symbol}</div>
              <div><span className="px-1.5 py-0.5 rounded text-[9px] uppercase" style={{ background: r.side === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)", color: r.side === "long" ? "var(--accent-green)" : "var(--accent-red)" }}>{r.side}</span></div>
              <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{formatUsd(r.marketValue)}</div>
              <div className="text-right font-mono" style={{ color: "var(--accent-red)" }}>{formatUsd(r.risk)}</div>
              <div className="text-right font-mono" style={{ color: r.riskPct < 2 ? "var(--accent-green)" : "var(--accent-amber)" }}>{r.riskPct.toFixed(2)}%</div>
              <div className="text-right font-mono" style={{ color: r.rrRatio >= 2 ? "var(--accent-green)" : "var(--accent-amber)" }}>{r.rrRatio > 0 ? `1:${r.rrRatio.toFixed(1)}` : "—"}</div>
              <div className="text-right font-mono" style={{ color: "var(--accent-red)" }}>{r.stopLoss ? formatUsd(r.stopLoss) : "—"}</div>
              <div className="text-right font-mono font-semibold" style={{ color: r.unrealizedPl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                {r.unrealizedPl >= 0 ? "+" : ""}{formatUsd(r.unrealizedPl)}
              </div>
            </div>
          ))}
        </div>
      )}

      {approaching.length > 0 && (
        <div className="rounded-md border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
          <div className="px-4 py-3 border-b text-[10px] uppercase tracking-wider font-semibold" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            Upcoming Entry Risk Assessment
          </div>
          <div className="grid grid-cols-7 gap-2 px-4 py-2 text-[9px] uppercase tracking-wider border-b" style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}>
            <div>Symbol</div><div>Pattern</div><div>Dir</div><div className="text-right">Entry</div><div className="text-right">SL</div><div className="text-right">Distance</div><div className="text-right">Risk/Trade</div>
          </div>
          {approaching.map((s) => {
            const riskPerUnit = Math.abs(s.projectedD - s.sl);
            const allocPct = s.symbol.includes("/") ? (botSettings?.crypto_allocation || 0.07) : (botSettings?.equity_allocation || 0.05);
            const positionSize = (equity * allocPct) / s.projectedD;
            const totalRisk = riskPerUnit * positionSize;
            return (
              <div key={s.id} className="grid grid-cols-7 gap-2 px-4 py-2.5 border-b text-xs items-center" style={{ borderColor: "var(--border-color)" }}>
                <div className="font-mono text-white">{s.symbol}</div>
                <div style={{ color: "var(--accent-amber)" }}>{s.pattern}</div>
                <div><span className="px-1.5 py-0.5 rounded text-[9px] uppercase" style={{ background: s.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)", color: s.direction === "long" ? "var(--accent-green)" : "var(--accent-red)" }}>{s.direction}</span></div>
                <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{formatUsd(s.projectedD)}</div>
                <div className="text-right font-mono" style={{ color: "var(--accent-red)" }}>{formatUsd(s.sl)}</div>
                <div className="text-right font-mono" style={{ color: s.distancePct < 3 ? "var(--accent-red)" : "var(--accent-green)" }}>{s.distancePct.toFixed(1)}%</div>
                <div className="text-right font-mono" style={{ color: "var(--text-main)" }}>{formatUsd(totalRisk)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LogsPage({ signals, approaching, history, status, isOnline, onClearSignals, onRefresh }: {
  signals: Signal[];
  approaching: ApproachingSignal[];
  history: TradeHistory[];
  status: Status | null;
  isOnline: boolean;
  onClearSignals: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const allEvents = useMemo(() => {
    const events: { time: string; type: string; message: string; level: "info" | "success" | "warn" | "error" }[] = [];

    signals.forEach((s) => {
      events.push({
        time: s.createdAt,
        type: "SIGNAL",
        message: `${s.direction.toUpperCase()} ${s.symbol} ${s.patternType} ${s.timeframe} | Entry: ${formatUsd(Number(s.entryPrice))} | SL: ${formatUsd(Number(s.stopLossPrice))} | TP1: ${formatUsd(Number(s.tp1Price))} | Status: ${s.status}`,
        level: s.status === "filled" ? "success" : s.status === "pending" ? "info" : "warn",
      });
    });

    approaching.forEach((s) => {
      events.push({
        time: s.createdAt,
        type: "SCAN",
        message: `${s.direction.toUpperCase()} ${s.symbol} ${s.pattern} ${s.timeframe} approaching D-point | Price: ${formatUsd(s.currentPrice)} | Target: ${formatUsd(s.projectedD)} | Distance: ${s.distancePct.toFixed(1)}%`,
        level: s.distancePct < 3 ? "warn" : "info",
      });
    });

    history.forEach((t) => {
      events.push({
        time: t.filled_at,
        type: "FILL",
        message: `${(t.direction || t.side).toUpperCase()} ${t.symbol} ${t.pattern || "—"} filled ${(t.qty ?? 0).toFixed(2)} @ ${formatUsd(t.filled_price)}${t.entry_price != null ? ` (target: ${formatUsd(t.entry_price)})` : ""}`,
        level: "success",
      });
    });

    return events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }, [signals, approaching, history]);

  const signalsByStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    signals.forEach((s) => {
      counts[s.status] = (counts[s.status] || 0) + 1;
    });
    return counts;
  }, [signals]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col p-6 space-y-4" style={{ background: "var(--bg-main)" }}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white uppercase tracking-wider">System Logs</h2>
        <div className="flex items-center gap-4">
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded border transition-colors"
            style={{ background: "var(--bg-panel)", color: "var(--text-muted)", borderColor: "var(--border-color)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-green)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
            title="Refresh"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
          <button
            onClick={onClearSignals}
            className="flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded border transition-colors"
            style={{ background: "var(--bg-panel)", color: "var(--text-muted)", borderColor: "var(--border-color)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-red)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
            title="Clear all signals"
          >
            <XCircle className="w-3 h-3" />
            Clear Signals
          </button>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ background: isOnline ? "#22c55e" : "#ef4444", boxShadow: isOnline ? "0 0 5px rgba(34,197,94,0.8)" : undefined }} />
            <span className="text-[10px] uppercase tracking-wider" style={{ color: isOnline ? "var(--accent-green)" : "var(--accent-red)" }}>
              {isOnline ? "System Online" : "System Offline"}
            </span>
          </div>
          <span className="text-[10px] px-2 py-1 rounded border" style={{ background: "var(--bg-panel)", color: "var(--text-muted)", borderColor: "var(--border-color)" }}>
            Uptime: {status ? formatUptime(status.uptime) : "—"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Total Events" value={String(allEvents.length)} icon={<List className="w-4 h-4" />} />
        <StatCard label="Active Signals" value={String(signals.length)} icon={<Zap className="w-4 h-4" />} color="var(--accent-amber)" />
        <StatCard label="Pending" value={String(signalsByStatus["pending"] || 0)} icon={<Clock className="w-4 h-4" />} />
        <StatCard label="Filled" value={String(signalsByStatus["filled"] || 0)} icon={<CheckCircle2 className="w-4 h-4" />} color="var(--accent-green)" />
        <StatCard label="Approaching" value={String(approaching.length)} icon={<Crosshair className="w-4 h-4" />} color="var(--accent-amber)" />
      </div>

      <div className="flex-1 overflow-hidden rounded-md border flex flex-col" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
        <div className="px-4 py-3 border-b flex justify-between items-center" style={{ borderColor: "var(--border-color)" }}>
          <h3 className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--text-muted)" }}>Event Timeline</h3>
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{allEvents.length} events</span>
        </div>
        <div className="flex-1 overflow-auto" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
          {allEvents.map((event, i) => {
            const d = new Date(event.time);
            const timeStr = d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
            const levelColor = event.level === "success" ? "#5eb387" : event.level === "warn" ? "var(--accent-amber)" : event.level === "error" ? "var(--accent-red)" : "var(--text-main)";
            const typeBg = event.type === "FILL" ? "var(--accent-green-dim)" : event.type === "SIGNAL" ? "rgba(205,166,97,0.15)" : "rgba(59,130,246,0.15)";
            const typeColor = event.type === "FILL" ? "var(--accent-green)" : event.type === "SIGNAL" ? "var(--accent-amber)" : "#60a5fa";

            return (
              <div key={i} className="px-4 py-2 border-b flex items-start gap-3 text-[10px] transition-colors"
                style={{ borderColor: "rgba(255,255,255,0.03)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-panel-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span className="shrink-0 opacity-50" style={{ color: "var(--text-muted)" }}>{timeStr}</span>
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px]" style={{ background: typeBg, color: typeColor }}>{event.type}</span>
                <span style={{ color: levelColor }}>{event.message}</span>
              </div>
            );
          })}
          {allEvents.length === 0 && (
            <div className="p-8 text-center text-[10px]" style={{ color: "var(--text-muted)" }}>
              No events recorded yet. The scanner is running and will log events here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IconButton({ children, onClick, title, badge, active }: { children: React.ReactNode; onClick?: () => void; title?: string; badge?: number; active?: boolean }) {
  return (
    <button
      className="w-8 h-8 rounded flex items-center justify-center border transition-colors relative"
      style={{
        background: active ? "var(--accent-green-dim)" : "var(--bg-panel)",
        borderColor: active ? "#166534" : "var(--border-color)",
        color: active ? "var(--accent-green)" : "var(--text-muted)",
      }}
      onClick={onClick}
      title={title}
      onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
      onMouseLeave={(e) => (e.currentTarget.style.color = active ? "var(--accent-green)" : "var(--text-muted)")}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[8px] font-bold flex items-center justify-center text-white" style={{ background: "var(--accent-red)" }}>
          {badge}
        </span>
      )}
    </button>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md p-3 border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
      <div className="text-[10px] uppercase mb-1" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="text-lg font-bold text-white" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{value}</div>
    </div>
  );
}

function StatCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color?: string }) {
  return (
    <div className="rounded-md p-3 border" style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}>
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: color || "var(--text-muted)" }}>{icon}</span>
        <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{label}</span>
      </div>
      <div className="text-base font-bold font-mono" style={{ color: color || "white" }}>{value}</div>
    </div>
  );
}

function RiskBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-1">
        <span style={{ color: "var(--text-muted)" }}>{label}</span>
        <span className="font-mono" style={{ color }}>{typeof value === "number" && value % 1 === 0 ? value : value.toFixed(1)}{max === 100 ? "%" : `/${max}`}</span>
      </div>
      <div className="h-1.5 rounded-full" style={{ background: "var(--border-color)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function DomRow({ symbol, pattern, price, depth, side, distancePct, timeframe }: {
  symbol: string; pattern: string; price: number; depth: number; side: "bid" | "ask"; distancePct: number; timeframe: string;
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
        <span className="text-sm" style={{ color: "var(--text-main)", fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{symbol}</span>
        <span className="text-[9px] ml-1.5" style={{ color: "var(--text-muted)" }}>{pattern} · {timeframe}</span>
      </div>
      <div className="text-sm text-right" style={{ color, fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
        {price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div className="flex items-center h-full">
        <div className="h-1 rounded" style={{ width: `${Math.min(100 - distancePct * 5, 100)}%`, background: barBg }} />
      </div>
      <div className="text-right">
        <span className="px-3 py-1 text-[10px] rounded border uppercase" style={{ borderColor: btnBorder, color, background: `${btnBg}50` }}>
          {distancePct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}
