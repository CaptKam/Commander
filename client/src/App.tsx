import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Settings,
  Power,
  XCircle,
  Plus,
  Zap,
  LayoutDashboard,
  Activity,
  Radar,
  Stethoscope,
  Radio,
  BarChart3,
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
  cash?: number;
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

interface Order {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  limit_price: number;
  reserved_usd: number;
  time_in_force: string;
  created_at: string;
  age_hours: number;
  pattern: string | null;
  direction: string | null;
  signal_id: number | null;
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
  hasOrder?: boolean;
  blocked?: string | null;
  paperOnly?: boolean;
  rr?: number | null;
}

interface BotSettings {
  trading_enabled: boolean;
  equity_allocation: number;
  crypto_allocation: number;
  enabled_patterns: string[];
}

interface SignalPipelineEntry {
  id: number;
  symbol: string;
  pattern: string;
  timeframe: string;
  direction: string;
  status: string;
  stage: string;
  stageDetail: string;
  stageColor: string;
  entryPrice: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  score: number | null;
  entryOrderId: string | null;
  hasOrder: boolean;
  detectedAt: string;
  filledAt: string | null;
  blockedReason: string | null;
}

interface SignalPipelineData {
  signals: SignalPipelineEntry[];
  summary: {
    total: number;
    byStage: Record<string, number>;
  };
}

interface PipelineData {
  lastUpdatedAgo: number | null;
  symbolsScanned: number;
  cryptoCount: number;
  equityCount: number;
  marketOpen: boolean;
  rawCandidates: number;
  qualityPassed: number;
  qualityRejected: number;
  screenerPassed: number;
  dedupSkipped: number;
  newSignalsSaved: number;
  ordersPlaced: number;
  ordersSkipped: number;
  paperOnlyCount: number;
  exitCycleRan: boolean;
  pendingFills: number;
  filledPositions: number;
  partialExits: number;
  closedTrades: number;
  websocket: { crypto: string; stock: string; priceCount: number };
}

interface ScanStateData {
  total: number;
  byPhase: Record<string, number>;
  dueNow: number;
  nextDue: string | null;
  totalUniverse?: number;
  favoriteSymbols?: string[];
  hotSymbols: Array<{
    symbol: string;
    timeframe: string;
    phase: string;
    bestPattern: string | null;
    bestDirection: string | null;
    projectedD: string | null;
    distanceToDPct: string | null;
    nextScanDue: string;
    tier: "IMMINENT" | "APPROACHING";
  }>;
}

interface TradeHistory {
  symbol: string;
  side: string;
  qty: number;
  filled_price: number;
  submitted_at: string;
  filled_at: string;
  pattern: string;
  direction: string;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
}

interface WatchlistItem {
  symbol: string;
  assetClass: string;
}

// ============================================================
// Constants & helpers
// ============================================================
const POLL_FAST = 15_000;    // 15s — account, positions (real-time during trading)
const POLL_MEDIUM = 30_000;  // 30s — signals, approaching, pipeline
const POLL_SLOW = 120_000;   // 2min — settings, watchlist, history, metrics, scan-state
const MONO = "'JetBrains Mono', 'Fira Code', 'SF Mono', ui-monospace, monospace";
const DISPLAY = "'Inter', 'SF Pro Display', system-ui, sans-serif";

function fmt(n: number): string {
  const abs = Math.abs(n);
  const d = abs === 0 ? 2 : abs < 0.001 ? 8 : abs < 0.1 ? 6 : abs < 1 ? 4 : 2;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d });
}

function ts(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function dateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Unified event feed
interface FeedEvent {
  time: string;
  tag: "FILL" | "NEAR" | "SIGNAL" | "REJECT" | "CLOSED";
  color: string;
  text: string;
}

// ============================================================
// App
// ============================================================
export default function App() {
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [approaching, setApproaching] = useState<ApproachingSignal[]>([]);
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);
  const [history, setHistory] = useState<TradeHistory[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [pipeline, setPipeline] = useState<PipelineData | null>(null);
  const [scanState, setScanState] = useState<ScanStateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blotterSort, setBlotterSort] = useState<"pnl" | "symbol" | "pct">("pnl");
  const [activePage, setActivePage] = useState<"dashboard" | "pipeline" | "scanner" | "diagnostics" | "feed" | "signals" | "trade">("dashboard");
  const [signalPipeline, setSignalPipeline] = useState<SignalPipelineData | null>(null);
  const [bottomTab, setBottomTab] = useState<"feed" | "signals" | "pipeline" | "scanner">("feed");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);
  const [chartTimeframe, setChartTimeframe] = useState<"4H" | "1D">("4H");
  const [tickerData, setTickerData] = useState<Array<{symbol: string; price: number}>>([]);
  const [marketClock, setMarketClock] = useState({ isOpen: false, label: "CLOSED", countdown: "" });

  // Cancel an open order on Alpaca
  const cancelOrder = useCallback(async (orderId: string) => {
    try {
      const res = await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
      if (res.ok) setOrders((prev) => prev.filter((o) => o.id !== orderId));
    } catch {}
  }, []);

  // Helper: open trade page for a symbol
  const openChart = useCallback((symbol: string, signalId?: number | null, timeframe?: "4H" | "1D") => {
    setSelectedSymbol(symbol);
    setSelectedSignalId(signalId ?? null);
    if (timeframe) setChartTimeframe(timeframe);
    setActivePage("trade");
  }, []);

  // Fast tier: account + positions (need real-time during trading)
  const fetchFast = useCallback(async () => {
    try {
      const [acctRes, posRes, ordRes] = await Promise.allSettled([
        fetch("/api/account").then((r) => r.json()),
        fetch("/api/positions").then((r) => r.json()),
        fetch("/api/orders").then((r) => r.json()),
      ]);
      if (acctRes.status === "fulfilled") setAccount(acctRes.value);
      if (posRes.status === "fulfilled" && Array.isArray(posRes.value)) setPositions(posRes.value);
      if (ordRes.status === "fulfilled" && Array.isArray(ordRes.value)) setOrders(ordRes.value);
    } catch {}
  }, []);

  // Medium tier: signals, approaching, pipeline, status
  const fetchMedium = useCallback(async () => {
    try {
      const [sigRes, appRes, pipeRes, statRes, spRes] = await Promise.allSettled([
        fetch("/api/signals").then((r) => r.json()),
        fetch("/api/approaching").then((r) => r.json()),
        fetch("/api/pipeline").then((r) => r.json()),
        fetch("/api/status").then((r) => r.json()),
        fetch("/api/signals/pipeline").then((r) => r.json()),
      ]);
      if (sigRes.status === "fulfilled" && Array.isArray(sigRes.value)) setSignals(sigRes.value);
      if (appRes.status === "fulfilled" && Array.isArray(appRes.value)) setApproaching(appRes.value);
      if (pipeRes.status === "fulfilled") setPipeline(pipeRes.value);
      if (statRes.status === "fulfilled") setStatus(statRes.value);
      if (spRes.status === "fulfilled") setSignalPipeline(spRes.value);
    } catch {}
  }, []);

  // Slow tier: settings, watchlist, history, metrics, scan-state
  const fetchSlow = useCallback(async () => {
    try {
      const [metRes, setRes, histRes, wlRes, ssRes] = await Promise.allSettled([
        fetch("/api/metrics").then((r) => r.json()),
        fetch("/api/settings").then((r) => r.json()),
        fetch("/api/history").then((r) => r.json()),
        fetch("/api/watchlist").then((r) => r.json()),
        fetch("/api/scan-state").then((r) => r.json()),
      ]);
      if (metRes.status === "fulfilled") setMetrics(metRes.value);
      if (setRes.status === "fulfilled" && setRes.value && !setRes.value.error) setBotSettings(setRes.value);
      if (histRes.status === "fulfilled" && Array.isArray(histRes.value)) setHistory(histRes.value);
      if (wlRes.status === "fulfilled" && Array.isArray(wlRes.value)) setWatchlist(wlRes.value);
      if (ssRes.status === "fulfilled") setScanState(ssRes.value);
    } catch {}
  }, []);

  // Combined fetch for initial load
  const fetchAll = useCallback(async () => {
    try {
      await Promise.all([fetchFast(), fetchMedium(), fetchSlow()]);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [fetchFast, fetchMedium, fetchSlow]);

  const updateSettings = useCallback(async (patch: Partial<BotSettings>) => {
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setBotSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll(); // Initial load — everything at once
    const fastId = setInterval(fetchFast, POLL_FAST);
    const mediumId = setInterval(fetchMedium, POLL_MEDIUM);
    const slowId = setInterval(fetchSlow, POLL_SLOW);
    return () => {
      clearInterval(fastId);
      clearInterval(mediumId);
      clearInterval(slowId);
    };
  }, [fetchAll, fetchFast, fetchMedium, fetchSlow]);

  // Ticker tape polling — 5s
  useEffect(() => {
    const poll = () => fetch("/api/ticker").then(r => r.json()).then(setTickerData).catch(() => {});
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // Market clock — 10s
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const hours = et.getHours();
      const minutes = et.getMinutes();
      const day = et.getDay();
      const timeMinutes = hours * 60 + minutes;
      const isWeekday = day >= 1 && day <= 5;
      const preMarket = timeMinutes >= 240 && timeMinutes < 570;
      const regularHours = timeMinutes >= 570 && timeMinutes < 960;
      const afterHours = timeMinutes >= 960 && timeMinutes < 1200;
      let label = "CLOSED";
      let isOpen = false;
      let countdown = "";
      if (!isWeekday) {
        label = "WEEKEND";
        countdown = "Opens Monday 9:30 AM ET";
      } else if (regularHours) {
        isOpen = true;
        label = "MARKET OPEN";
        const closeMin = 960 - timeMinutes;
        countdown = `Closes in ${Math.floor(closeMin / 60)}h ${closeMin % 60}m`;
      } else if (preMarket) {
        label = "PRE-MARKET";
        const openMin = 570 - timeMinutes;
        countdown = `Opens in ${Math.floor(openMin / 60)}h ${openMin % 60}m`;
      } else if (afterHours) {
        label = "AFTER-HOURS";
        const closeMin = 1200 - timeMinutes;
        countdown = `AH closes in ${Math.floor(closeMin / 60)}h ${closeMin % 60}m`;
      } else {
        label = "CLOSED";
        if (timeMinutes < 240) {
          const openMin = 570 - timeMinutes;
          countdown = `Opens in ${Math.floor(openMin / 60)}h ${openMin % 60}m`;
        } else {
          countdown = "Opens tomorrow 9:30 AM ET";
        }
      }
      setMarketClock({ isOpen, label, countdown });
    };
    update();
    const id = setInterval(update, 10000);
    return () => clearInterval(id);
  }, []);

  // ---- Derived ----
  const equity = account?.equity ?? 0;
  const bp = account?.buying_power ?? 0;
  const lockedPct = equity > 0 ? ((equity - bp) / equity) * 100 : 0;
  const totalPl = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const totalPlPct = equity > 0 ? (totalPl / equity) * 100 : 0;
  const bpPct = account ? Math.round((1 - account.buying_power / account.equity) * 100) : 0;

  // Sorted blotter
  const sortedPositions = useMemo(() => {
    const copy = [...positions];
    if (blotterSort === "pnl") copy.sort((a, b) => b.unrealized_pl - a.unrealized_pl);
    else if (blotterSort === "pct") copy.sort((a, b) => b.unrealized_pl_pct - a.unrealized_pl_pct);
    else copy.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return copy;
  }, [positions, blotterSort]);

  // Live feed: merge signals, approaching, history into one timeline
  const feed = useMemo<FeedEvent[]>(() => {
    const events: FeedEvent[] = [];

    history.slice(0, 50).forEach((t) => {
      events.push({
        time: t.filled_at,
        tag: "FILL",
        color: "var(--positive)",
        text: `${(t.direction ?? "").toUpperCase()} ${t.symbol} ${t.pattern ?? "?"} ${(t.qty ?? 0).toFixed(2)} @ ${fmt(t.filled_price)}`,
      });
    });

    approaching.forEach((s) => {
      const dist = s.distancePct ?? 0;
      const label = `${(s.direction ?? "").toUpperCase()} ${s.symbol} ${s.pattern} ${s.timeframe} — ${dist.toFixed(1)}% from D @ ${fmt(s.projectedD)}`;
      const suffix = s.paperOnly ? " (paper)" : "";
      events.push({
        time: s.createdAt,
        tag: "NEAR",
        color: dist < 2 ? "var(--warning)" : "var(--text-primary)",
        text: label + suffix,
      });
    });

    signals.slice(0, 60).forEach((s) => {
      if (s.status === "closed" || s.status === "cancelled") {
        events.push({
          time: s.createdAt,
          tag: "CLOSED",
          color: "var(--text-muted)",
          text: `${(s.direction ?? "").toUpperCase()} ${s.symbol} ${s.patternType} ${s.timeframe} — ${s.status}`,
        });
      } else {
        events.push({
          time: s.createdAt,
          tag: "SIGNAL",
          color: "var(--warning)",
          text: `${(s.direction ?? "").toUpperCase()} ${s.symbol} ${s.patternType} ${s.timeframe} @ ${fmt(Number(s.entryPrice))} — ${s.status}`,
        });
      }
    });

    events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return events.slice(0, 100);
  }, [history, approaching, signals]);

  // Alerts
  const alerts = useMemo(() => {
    const a: { level: "red" | "amber" | "green"; text: string }[] = [];
    if (lockedPct > 80) a.push({ level: "red", text: `GTC locked ${lockedPct.toFixed(0)}% of equity` });
    if (!botSettings?.trading_enabled) a.push({ level: "amber", text: "Auto-trade OFF" });
    if (positions.length >= 8) a.push({ level: "amber", text: `${positions.length} positions open` });
    if (a.length === 0) a.push({ level: "green", text: "All systems OK" });
    return a;
  }, [lockedPct, botSettings, positions]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-primary)" }}>
        <div className="flex flex-col items-center gap-3">
          <Zap className="w-8 h-8 animate-pulse" style={{ color: "var(--sys-light)" }} />
          <span style={{ fontFamily: DISPLAY, fontSize: "12px", fontWeight: 500, letterSpacing: "2px", textTransform: "uppercase" as const, color: "var(--sys-light)" }}>
            COMMANDER
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden terminal-bg" style={{ background: "var(--bg-primary)", fontFamily: MONO, fontSize: "13px" }}>
      {/* NYSE-STYLE TICKER TAPE */}
      <style>{`@keyframes ticker-scroll { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }`}</style>
      {tickerData.length > 0 && (
        <div style={{
          height: 28,
          background: "var(--bg-main)",
          borderBottom: "0.5px solid var(--border-color)",
          overflow: "hidden",
          position: "relative",
          display: "flex",
          alignItems: "center",
        }}>
          <div style={{
            display: "flex",
            gap: 32,
            animation: "ticker-scroll 30s linear infinite",
            whiteSpace: "nowrap",
            paddingLeft: "100%",
          }}>
            {tickerData.concat(tickerData).map((t, i) => (
              <span key={i} style={{
                fontSize: 11,
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "0.5px",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}>
                <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{t.symbol}</span>
                <span style={{ color: "var(--text-main)" }}>${t.price < 1 ? t.price.toFixed(4) : t.price < 100 ? t.price.toFixed(2) : t.price.toLocaleString(undefined, {maximumFractionDigits: 2})}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* HEADER BAR — Hedge fund terminal aesthetic                        */}
      {/* ================================================================ */}
      <header className="shrink-0 flex items-center justify-between px-5 h-12 border-b" style={{ borderColor: "var(--border-default)", background: "var(--bg-secondary)" }}>
        <div className="flex items-center gap-3">
          <span style={{ fontFamily: DISPLAY, fontSize: "13px", fontWeight: 600, letterSpacing: "2px", textTransform: "uppercase" as const, color: "var(--sys-light)" }}>
            FTM
          </span>
          <span style={{ fontFamily: DISPLAY, fontSize: "11px", fontWeight: 500, letterSpacing: "1.5px", textTransform: "uppercase" as const, color: "var(--sys-dark)" }}>
            COMMANDER
          </span>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{
              background: status?.status === "online" ? "var(--sys-primary)" : "var(--negative)",
              boxShadow: status?.status === "online" ? "0 0 6px var(--sys-primary)" : "0 0 6px var(--negative)",
            }} />
            <span className="text-[12px] uppercase tracking-wider" style={{ color: status?.status === "online" ? "var(--sys-light)" : "var(--negative)", fontFamily: DISPLAY }}>
              {status?.status === "online" ? "online" : "offline"}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-dim)", fontFamily: DISPLAY }}>P&L</span>
            <span className="font-semibold" style={{ fontSize: "16px", color: totalPl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
              {totalPl >= 0 ? "+" : ""}{fmt(totalPl)}
            </span>
            <span className="text-[12px]" style={{ color: totalPl >= 0 ? "var(--accent-green)" : "var(--accent-red)", opacity: 0.7 }}>
              ({totalPlPct >= 0 ? "+" : ""}{totalPlPct.toFixed(2)}%)
            </span>
          </div>
          <div style={{ width: 1, height: 16, background: "var(--border-default)" }} />
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-dim)", fontFamily: DISPLAY }}>Day</span>
            <span style={{ color: (account?.daily_pl ?? 0) >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
              {(account?.daily_pl ?? 0) >= 0 ? "+" : ""}{fmt(account?.daily_pl ?? 0)}
            </span>
          </div>
          <div style={{ width: 1, height: 16, background: "var(--border-default)" }} />
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-dim)", fontFamily: DISPLAY }}>Equity</span>
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{fmt(equity)}</span>
          </div>
          <div style={{ width: 1, height: 16, background: "var(--border-default)" }} />
          <div className="flex flex-col items-center">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-dim)", fontFamily: DISPLAY }}>W/L</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              <span style={{ color: "var(--accent-green)" }}>{positions.filter(p => p.unrealized_pl >= 0).length}</span>
              <span style={{ color: "var(--text-dim)" }}>/</span>
              <span style={{ color: "var(--accent-red)" }}>{positions.filter(p => p.unrealized_pl < 0).length}</span>
            </span>
          </div>
          <div style={{ width: 1, height: 16, background: "var(--border-default)" }} />
          <div className="flex flex-col items-center">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-dim)", fontFamily: DISPLAY }}>BP Used</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: bpPct > 80 ? "var(--accent-red)" : bpPct > 50 ? "var(--accent-amber)" : "var(--accent-green)" }}>
              {bpPct.toFixed(0)}%
            </span>
          </div>
          <div style={{ width: 1, height: 16, background: "var(--border-default)" }} />
          <div className="flex items-center gap-2">
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: marketClock.isOpen ? "var(--accent-green)" : "var(--accent-red)",
              boxShadow: marketClock.isOpen ? "0 0 6px var(--accent-green)" : "none",
            }} />
            <div className="flex flex-col">
              <span className="text-[11px] uppercase tracking-wider" style={{
                color: marketClock.isOpen ? "var(--accent-green)" : "var(--accent-red)",
                fontFamily: DISPLAY
              }}>
                {marketClock.label}
              </span>
              <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                {marketClock.countdown}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {botSettings && (
            <button
              onClick={() => updateSettings({ trading_enabled: !botSettings.trading_enabled })}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all"
              style={botSettings.trading_enabled
                ? { background: "var(--sys-bg)", color: "var(--sys-light)", border: "0.5px solid var(--sys-border)" }
                : { background: "var(--accent-red-dim)", color: "var(--accent-red)", border: "0.5px solid rgba(239, 68, 68, 0.20)" }}
            >
              <Power className="w-3 h-3" />
              {botSettings.trading_enabled ? "LIVE" : "OFF"}
            </button>
          )}
          <button
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all"
            style={{ background: "var(--accent-red-dim)", color: "var(--accent-red)", border: "0.5px solid rgba(239, 68, 68, 0.20)" }}
            onClick={async () => {
              if (botSettings?.trading_enabled && confirm("Disable auto-trading?")) {
                await updateSettings({ trading_enabled: false });
              }
            }}
          >
            <XCircle className="w-3 h-3" />
            Kill
          </button>
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            className="w-7 h-7 rounded-md flex items-center justify-center transition-all"
            style={{
              background: settingsOpen ? "var(--sys-bg)" : "transparent",
              border: settingsOpen ? "0.5px solid var(--sys-border)" : "0.5px solid var(--border-default)",
              color: settingsOpen ? "var(--sys-light)" : "var(--text-muted)",
            }}
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Settings drawer */}
      {settingsOpen && (
        <SettingsDrawer
          botSettings={botSettings}
          updateSettings={updateSettings}
          watchlist={watchlist}
          fetchAll={fetchAll}
        />
      )}

      {/* ================================================================ */}
      {/* MAIN BODY — left nav sidebar + page content                       */}
      {/* ================================================================ */}
      <div className="flex-1 flex overflow-hidden">
        <nav className="shrink-0 flex flex-col items-center py-3 gap-1.5 border-r" style={{ width: 64, borderColor: "var(--border-default)", background: "var(--bg-secondary)" }}>
          <div className="accent-bar mb-2" style={{ width: 28 }} />
          {([
            { key: "dashboard" as const, icon: LayoutDashboard, label: "Dashboard" },
            { key: "trade" as const, icon: BarChart3, label: "Trade" },
            { key: "feed" as const, icon: Radio, label: "Feed" },
            { key: "signals" as const, icon: Zap, label: "Sigs" },
            { key: "pipeline" as const, icon: Activity, label: "Pipe" },
            { key: "scanner" as const, icon: Radar, label: "Scan" },
            { key: "diagnostics" as const, icon: Stethoscope, label: "Diag" },
          ] as const).map((item) => {
            const active = activePage === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setActivePage(item.key)}
                className="w-11 h-11 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all"
                style={{
                  background: active ? "var(--sys-bg)" : "transparent",
                  color: active ? "var(--sys-light)" : "var(--text-muted)",
                  border: active ? "0.5px solid var(--sys-border)" : "0.5px solid transparent",
                  boxShadow: active ? "var(--sys-glow)" : "none",
                }}
                title={item.label}
              >
                <item.icon className="w-4 h-4" />
                <span className="text-[11px] uppercase tracking-wider font-semibold leading-none" style={{ fontFamily: DISPLAY }}>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* PAGE CONTENT */}
        <div className="flex-1 flex overflow-hidden">
          {/* ============ DASHBOARD PAGE ============ */}
          {activePage === "dashboard" && (
            <>
              <div className="flex-1 flex flex-col overflow-hidden border-r" style={{ borderColor: "var(--border-color)" }}>
                {/* BLOTTER + ACTIVITY SPLIT */}
                <div className="shrink-0 flex items-center justify-between px-4 h-9 border-b" style={{ borderColor: "var(--border-default)", background: "var(--bg-card)" }}>
                  <span className="text-[11px] uppercase tracking-widest font-medium" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>
                    Positions ({positions.length})
                  </span>
                  <div className="flex gap-2">
                    {(["pnl", "pct", "symbol"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setBlotterSort(s)}
                        className="text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={blotterSort === s
                          ? { color: "var(--sys-light)", background: "var(--sys-bg)", border: "0.5px solid var(--sys-border)" }
                          : { color: "var(--text-muted)", border: "0.5px solid transparent" }}
                      >
                        {s === "pnl" ? "P&L" : s === "pct" ? "%" : "A-Z"}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="shrink-0 grid grid-cols-[1fr_55px_70px_75px_75px_75px_75px_75px_80px] gap-1 px-4 py-1.5 text-[11px] uppercase tracking-wider border-b"
                  style={{ borderColor: "var(--border-color)", color: "var(--text-muted)", background: "var(--bg-main)" }}>
                  <div>Symbol</div>
                  <div>Side</div>
                  <div className="text-right">Qty</div>
                  <div className="text-right">Entry</div>
                  <div className="text-right">Last</div>
                  <div className="text-right">SL</div>
                  <div className="text-right">TP1</div>
                  <div className="text-right">TP2</div>
                  <div className="text-right">P&L</div>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {sortedPositions.length === 0 ? (
                    <div className="px-3 py-6 text-center" style={{ color: "var(--text-muted)" }}>
                      No open positions
                    </div>
                  ) : (
                    sortedPositions.map((p) => (
                      <div
                        key={p.symbol}
                        className="grid grid-cols-[1fr_55px_70px_75px_75px_75px_75px_75px_80px] gap-1 px-4 py-2 border-b items-center"
                        style={{ borderColor: "rgba(255,255,255,0.03)" }}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-white font-semibold truncate cursor-pointer hover:underline" style={{ color: "var(--accent-green)" }} onClick={() => openChart(p.symbol)}>{p.symbol}</span>
                          {p.pattern && <span className="text-[9px] truncate" style={{ color: "var(--accent-amber)" }}>{p.pattern}</span>}
                        </div>
                        <div>
                          <span
                            className="text-[11px] px-1 py-px rounded uppercase font-semibold"
                            style={{
                              background: p.side === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                              color: p.side === "long" ? "var(--accent-green)" : "var(--accent-red)",
                            }}
                          >
                            {p.side}
                          </span>
                        </div>
                        <div className="text-right" style={{ color: "var(--text-main)" }}>{p.qty < 1 ? p.qty.toFixed(6) : p.qty.toFixed(2)}</div>
                        <div className="text-right" style={{ color: "var(--text-muted)" }}>{fmt(p.entry_price)}</div>
                        <div className="text-right text-white">{fmt(p.current_price)}</div>
                        <div className="text-right" style={{ color: "var(--accent-red)" }}>{p.stop_loss ? fmt(p.stop_loss) : "—"}</div>
                        <div className="text-right" style={{ color: "var(--accent-green)" }}>{p.tp1 ? fmt(p.tp1) : "—"}</div>
                        <div className="text-right" style={{ color: "var(--accent-green)" }}>{p.tp2 ? fmt(p.tp2) : "—"}</div>
                        <div className="text-right font-semibold" style={{ color: p.unrealized_pl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                          {p.unrealized_pl >= 0 ? "+" : ""}{fmt(p.unrealized_pl)}
                        </div>
                      </div>
                    ))
                  )}

                  {positions.length > 0 && (
                    <div
                      className="grid grid-cols-[1fr_55px_70px_75px_75px_75px_75px_75px_80px] gap-1 px-4 py-2 border-t"
                      style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
                    >
                      <div className="text-[11px] uppercase font-semibold" style={{ color: "var(--text-muted)" }}>Total</div>
                      <div /><div /><div /><div /><div /><div /><div />
                      <div className="text-right font-bold" style={{ color: totalPl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                        {totalPl >= 0 ? "+" : ""}{fmt(totalPl)}
                      </div>
                    </div>
                  )}
                </div>

                {/* OPEN ORDERS SECTION */}
                <div className="shrink-0 flex flex-col" style={{ maxHeight: "30%" }}>
                  <div className="shrink-0 flex items-center justify-between px-4 h-9 border-b" style={{ borderColor: "var(--border-default)", background: "var(--bg-card)" }}>
                    <span className="text-[11px] uppercase tracking-widest font-medium" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>
                      Open Orders ({orders.length})
                    </span>
                  </div>

                  {orders.length === 0 ? (
                    <div className="flex items-center justify-center py-4 text-[11px]" style={{ color: "var(--text-muted)" }}>
                      No open orders
                    </div>
                  ) : (
                    <>
                      <div className="shrink-0 grid grid-cols-[1fr_50px_65px_75px_75px_90px_50px_40px] gap-1 px-4 py-1.5 text-[11px] uppercase tracking-wider border-b"
                        style={{ borderColor: "var(--border-color)", color: "var(--text-muted)", background: "var(--bg-main)" }}>
                        <div>Symbol</div>
                        <div>Side</div>
                        <div className="text-right">Qty</div>
                        <div className="text-right">Limit</div>
                        <div className="text-right">Reserved</div>
                        <div>Pattern</div>
                        <div className="text-right">Age</div>
                        <div />
                      </div>

                      <div className="overflow-y-auto">
                        {orders.map((o) => (
                          <div
                            key={o.id}
                            className="grid grid-cols-[1fr_50px_65px_75px_75px_90px_50px_40px] gap-1 px-4 py-2 border-b items-center"
                            style={{ borderColor: "rgba(255,255,255,0.03)" }}
                          >
                            <div className="min-w-0">
                              <span className="font-semibold truncate cursor-pointer hover:underline" style={{ color: "var(--accent-green)" }} onClick={() => openChart(o.symbol)}>
                                {o.symbol}
                              </span>
                            </div>
                            <div>
                              <span className="text-[11px] px-1 py-px rounded uppercase font-semibold"
                                style={{
                                  background: o.side === "buy" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                                  color: o.side === "buy" ? "var(--accent-green)" : "var(--accent-red)",
                                }}>
                                {o.side}
                              </span>
                            </div>
                            <div className="text-right" style={{ color: "var(--text-main)" }}>{o.qty < 1 ? o.qty.toFixed(6) : o.qty.toFixed(2)}</div>
                            <div className="text-right" style={{ color: "var(--text-muted)" }}>{fmt(o.limit_price)}</div>
                            <div className="text-right" style={{ color: "var(--text-main)" }}>{fmt(o.reserved_usd)}</div>
                            <div className="truncate">
                              {o.pattern ? (
                                <span className="text-[10px]" style={{ color: "var(--accent-amber)" }}>
                                  {o.pattern}{o.direction ? ` ${o.direction.toUpperCase()}` : ""}
                                </span>
                              ) : o.signal_id ? (
                                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{o.side === "buy" ? "ENTRY" : "TP"}</span>
                              ) : (
                                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>—</span>
                              )}
                            </div>
                            <div className="text-right text-[11px]" style={{ color: "var(--text-muted)" }}>
                              {o.age_hours < 1 ? "< 1h" : `${Math.floor(o.age_hours)}h`}
                            </div>
                            <div className="text-right">
                              <button
                                className="text-[9px] px-1.5 py-0.5 rounded font-semibold hover:opacity-80"
                                style={{ background: "var(--accent-red-dim)", color: "var(--accent-red)" }}
                                onClick={() => cancelOrder(o.id)}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>

                      {(() => {
                        const totalReserved = orders.reduce((s, o) => s + o.reserved_usd, 0);
                        return (
                          <div
                            className="shrink-0 grid grid-cols-[1fr_50px_65px_75px_75px_90px_50px_40px] gap-1 px-4 py-2 border-t"
                            style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
                          >
                            <div className="text-[11px] uppercase font-semibold" style={{ color: "var(--text-muted)" }}>Total Reserved</div>
                            <div /><div /><div />
                            <div className="text-right font-bold" style={{ color: "var(--text-main)" }}>{fmt(totalReserved)}</div>
                            <div /><div /><div />
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>

                {/* BOTTOM PANEL — tabbed: Feed | Signals | Pipeline | Scanner */}
                <div className="shrink-0 flex flex-col overflow-hidden" style={{ height: "40%" }}>
                  <div className="shrink-0 flex items-center gap-0 border-t border-b" style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}>
                    {([
                      { key: "feed" as const, label: "Live Feed", badge: feed.length > 0 ? String(feed.length) : undefined },
                      { key: "signals" as const, label: "Signals", badge: signalPipeline ? String(signalPipeline.summary.total) : undefined },
                      { key: "pipeline" as const, label: "Pipeline", badge: pipeline?.lastUpdatedAgo != null ? `${pipeline.lastUpdatedAgo}s` : undefined },
                      { key: "scanner" as const, label: "Scanner", badge: scanState && scanState.hotSymbols.length > 0 ? `${scanState.hotSymbols.length} hot` : undefined },
                    ]).map((tab) => (
                      <button
                        key={tab.key}
                        onClick={() => setBottomTab(tab.key)}
                        className="flex items-center gap-1.5 px-3 h-7 text-[9px] uppercase tracking-widest font-semibold border-b-2"
                        style={{
                          borderColor: bottomTab === tab.key ? "var(--accent-green)" : "transparent",
                          color: bottomTab === tab.key ? "var(--accent-green)" : "var(--text-muted)",
                          background: "transparent",
                        }}
                      >
                        {tab.label}
                        {tab.badge && (
                          <span className="text-[8px] px-1 py-px rounded" style={{
                            background: bottomTab === tab.key ? "var(--accent-green-dim)" : "rgba(255,255,255,0.05)",
                            color: bottomTab === tab.key ? "var(--accent-green)" : "var(--text-muted)",
                          }}>
                            {tab.badge}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {bottomTab === "feed" && (
                      <div className="px-3 py-2">
                        {feed.slice(0, 30).map((e, i) => (
                          <div key={i} className="flex items-start gap-2 py-0.5 leading-tight">
                            <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--text-muted)", opacity: 0.5 }}>{ts(e.time)}</span>
                            <span className="shrink-0 text-[8px] px-1 py-px rounded font-semibold uppercase" style={{
                              background: e.tag === "FILL" ? "var(--accent-green-dim)" : e.tag === "NEAR" ? "rgba(205,166,97,0.15)" : e.tag === "CLOSED" ? "rgba(122,136,145,0.15)" : "rgba(205,166,97,0.15)",
                              color: e.tag === "FILL" ? "var(--accent-green)" : e.tag === "NEAR" ? "var(--accent-amber)" : e.tag === "CLOSED" ? "var(--text-muted)" : "var(--accent-amber)",
                            }}>{e.tag}</span>
                            <span className="text-[10px]" style={{ color: e.color }}>{e.text}</span>
                          </div>
                        ))}
                        {feed.length === 0 && <div className="py-4 text-center" style={{ color: "var(--text-muted)" }}>Awaiting events...</div>}
                      </div>
                    )}
                    {bottomTab === "signals" && (
                      <SignalPipelineView data={signalPipeline} onSymbolClick={(sym, id, tf) => openChart(sym, id, tf as "4H" | "1D")} />
                    )}
                    {bottomTab === "pipeline" && (
                      <ScanPipeline data={pipeline} />
                    )}
                    {bottomTab === "scanner" && (
                      <ScanStateView data={scanState} onSymbolClick={(sym) => openChart(sym)} />
                    )}
                  </div>
                </div>
              </div>

              {/* RIGHT SIDEBAR — risk, stats, alerts, recent fills */}
              <aside className="w-64 shrink-0 flex flex-col overflow-y-auto" style={{ background: "var(--bg-panel)" }}>
                <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-color)" }}>
                  <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Risk</div>
                  <Row label="Equity" value={fmt(equity)} />
                  <Row label="Buying Power" value={fmt(bp)} />
                  <Row label="Cash" value={fmt(account?.cash ?? bp)} />
                  <div className="mt-2">
                    <div className="flex justify-between text-[12px] mb-0.5">
                      <span style={{ color: "var(--text-muted)" }}>GTC Locked</span>
                      <span style={{ color: lockedPct > 80 ? "var(--accent-red)" : lockedPct > 50 ? "var(--accent-amber)" : "var(--accent-green)" }}>{lockedPct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full" style={{ background: "var(--border-color)" }}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(lockedPct, 100)}%`, background: lockedPct > 80 ? "var(--accent-red)" : lockedPct > 50 ? "var(--accent-amber)" : "var(--accent-green)" }} />
                    </div>
                  </div>
                </div>
                <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-color)" }}>
                  <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Stats</div>
                  <Row label="Win Rate" value={metrics ? `${metrics.win_rate}%` : "—"} color="var(--accent-green)" />
                  <Row label="W / L" value={metrics ? `${metrics.wins} / ${metrics.losses}` : "—"} />
                  <Row label="Profit Factor" value={metrics ? (metrics.profit_factor == null ? "—" : metrics.profit_factor === Infinity ? "INF" : metrics.profit_factor.toFixed(2)) : "—"} />
                  <Row label="Trades" value={String(history.length)} />
                  <Row label="Signals" value={String(signals.length)} />
                  <Row label="Approaching" value={String(approaching.filter((s) => (s.distancePct ?? 0) <= 5).length)} color="var(--accent-amber)" />
                </div>
                <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-color)" }}>
                  <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Alerts</div>
                  {alerts.map((a, i) => (
                    <div key={i} className="flex items-center gap-2 py-0.5">
                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: a.level === "red" ? "var(--accent-red)" : a.level === "amber" ? "var(--accent-amber)" : "var(--accent-green)" }} />
                      <span style={{ color: a.level === "red" ? "var(--accent-red)" : a.level === "amber" ? "var(--accent-amber)" : "var(--accent-green)" }}>{a.text}</span>
                    </div>
                  ))}
                </div>
                <div className="px-3 py-3 flex-1">
                  <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Recent Fills ({history.length})</div>
                  {history.slice(0, 10).map((t, i) => (
                    <div key={i} className="flex items-center justify-between py-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[9px] px-1 py-px rounded uppercase font-semibold shrink-0" style={{ background: t.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)", color: t.direction === "long" ? "var(--accent-green)" : "var(--accent-red)" }}>{t.direction === "long" ? "L" : "S"}</span>
                        <span className="text-white truncate cursor-pointer hover:underline" style={{ color: "var(--accent-green)" }} onClick={() => openChart(t.symbol)}>{t.symbol}</span>
                        <span className="text-[9px] shrink-0" style={{ color: "var(--text-muted)" }}>{t.pattern}</span>
                      </div>
                      <span className="text-[9px] shrink-0" style={{ color: "var(--text-muted)" }}>{dateShort(t.filled_at)}</span>
                    </div>
                  ))}
                  {history.length === 0 && <div style={{ color: "var(--text-muted)" }}>No fills yet</div>}
                </div>
              </aside>
            </>
          )}

          {/* ============ FEED PAGE ============ */}
          {activePage === "feed" && (
            <div className="flex-1 overflow-y-auto">
              <div className="px-4 py-3">
                <div className="text-[11px] uppercase tracking-widest font-medium mb-3" style={{ color: "var(--sys-light)", fontFamily: DISPLAY }}>
                  Live Event Feed ({feed.length})
                </div>
                {feed.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 py-1 leading-tight">
                    <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--text-muted)", opacity: 0.5 }}>
                      {ts(e.time)}
                    </span>
                    <span
                      className="shrink-0 text-[11px] px-1 py-px rounded font-semibold uppercase"
                      style={{
                        background: e.tag === "FILL" ? "var(--sys-bg)"
                          : e.tag === "REJECT" ? "var(--accent-red-dim)"
                          : e.tag === "NEAR" ? "var(--oracle-bg)"
                          : e.tag === "CLOSED" ? "rgba(255,255,255,0.04)"
                          : "var(--oracle-bg)",
                        color: e.tag === "FILL" ? "var(--sys-light)"
                          : e.tag === "REJECT" ? "var(--negative)"
                          : e.tag === "NEAR" ? "var(--oracle-light)"
                          : e.tag === "CLOSED" ? "var(--text-muted)"
                          : "var(--oracle-light)",
                      }}
                    >
                      {e.tag}
                    </span>
                    <span style={{ color: e.color }}>{e.text}</span>
                  </div>
                ))}
                {feed.length === 0 && (
                  <div className="py-4 text-center" style={{ color: "var(--text-muted)" }}>Awaiting events...</div>
                )}
              </div>
            </div>
          )}

          {/* ============ SIGNALS WATCHBOARD ============ */}
          {activePage === "signals" && (
            <div className="flex-1 overflow-y-auto">
              <SignalPipelineView data={signalPipeline} onSymbolClick={(sym, id, tf) => openChart(sym, id, tf as "4H" | "1D")} />
            </div>
          )}

          {/* ============ PIPELINE PAGE ============ */}
          {activePage === "pipeline" && (
            <div className="flex-1 overflow-y-auto">
              <ScanPipeline data={pipeline} />
            </div>
          )}

          {/* ============ SCANNER PAGE ============ */}
          {activePage === "scanner" && (
            <div className="flex-1 overflow-y-auto">
              <ScanStateView data={scanState} onSymbolClick={(sym) => openChart(sym)} />
            </div>
          )}

          {/* ============ TRADE PAGE ============ */}
          {activePage === "trade" && (
            <TradePage
              symbol={selectedSymbol}
              signalId={selectedSignalId}
              timeframe={chartTimeframe}
              setTimeframe={setChartTimeframe}
              signals={signals}
              approaching={approaching}
              openChart={openChart}
            />
          )}

          {/* ============ DIAGNOSTICS PAGE ============ */}
          {activePage === "diagnostics" && (
            <div className="flex-1 overflow-y-auto">
              <DiagnosticsView />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Symbol Watchboard — shows every tracked symbol with phase
// ============================================================
const PHASE_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  "approaching": { label: "Phase C → D", color: "#fbbf24", bg: "rgba(245,158,11,0.10)", icon: "◎" },
  "imminent":    { label: "Imminent",     color: "#f97316", bg: "rgba(249,115,22,0.12)", icon: "⚡" },
  "order":       { label: "Order Live",   color: "#60a5fa", bg: "rgba(59,130,246,0.10)", icon: "●" },
  "filled":      { label: "In Trade",     color: "#34d399", bg: "rgba(16,185,129,0.10)", icon: "▲" },
  "exiting":     { label: "Exiting",      color: "#a78bfa", bg: "rgba(139,92,246,0.10)", icon: "◆" },
  "closed":      { label: "Closed",       color: "var(--text-muted)", bg: "rgba(255,255,255,0.03)", icon: "✓" },
  "paper":       { label: "Paper Only",   color: "#fbbf24", bg: "rgba(245,158,11,0.06)", icon: "○" },
};

function getPhaseFromSignal(
  ap: ApproachingSignal | undefined,
  sp: SignalPipelineEntry | undefined,
  hasPosition: boolean
): { phase: string; description: string; phaseKey: string } {
  if (hasPosition && sp?.stage === "Exiting") {
    return { phase: "Exiting", description: "TP/SL exits placed, monitoring", phaseKey: "exiting" };
  }
  if (hasPosition || sp?.stage === "Filled") {
    return { phase: "In Trade", description: "Position filled, managing exits", phaseKey: "filled" };
  }
  if (sp?.stage === "Closed") {
    return { phase: "Closed", description: sp.stageDetail || "Trade completed", phaseKey: "closed" };
  }
  if (sp?.stage === "Order Placed") {
    const dist = ap?.distancePct;
    const distStr = dist != null ? ` — ${dist.toFixed(1)}% away` : "";
    return { phase: "Order Live", description: `GTC limit @ ${sp.entryPrice != null ? fmt(sp.entryPrice) : "?"}${distStr}`, phaseKey: "order" };
  }
  if (sp?.stage === "Paper Only" || ap?.paperOnly) {
    const dist = ap?.distancePct;
    const distStr = dist != null ? `${dist.toFixed(1)}% from D` : "";
    return { phase: "Paper Only", description: `Tracking ${distStr} — no live order`, phaseKey: "paper" };
  }
  if (sp?.stage === "Market Closed") {
    const dist = ap?.distancePct;
    const distStr = dist != null ? ` — ${dist.toFixed(1)}% away` : "";
    return { phase: "Market Closed", description: `Equity order deferred${distStr}`, phaseKey: "approaching" };
  }
  if (ap) {
    const dist = ap.distancePct ?? 999;
    if (dist <= 2) {
      return {
        phase: "Imminent",
        description: `${dist.toFixed(1)}% from Phase D entry @ ${fmt(ap.projectedD)}`,
        phaseKey: "imminent",
      };
    }
    if (ap.hasOrder) {
      return {
        phase: "Order Live",
        description: `GTC limit @ ${fmt(ap.projectedD)} — ${dist.toFixed(1)}% away`,
        phaseKey: "order",
      };
    }
    return {
      phase: "Phase C → D",
      description: `Waiting on D @ ${fmt(ap.projectedD)} — ${dist.toFixed(1)}% away`,
      phaseKey: "approaching",
    };
  }
  if (sp) {
    return { phase: sp.stage, description: sp.stageDetail || "", phaseKey: "approaching" };
  }
  return { phase: "Unknown", description: "", phaseKey: "approaching" };
}

interface WatchboardSymbol {
  symbol: string;
  pattern: string;
  direction: string;
  timeframe: string;
  phaseKey: string;
  phase: string;
  description: string;
  distancePct: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  sl: number | null;
  tp1: number | null;
  rr: number | null;
  score: number | null;
  hasOrder: boolean;
  blocked: string | null;
  createdAt: string;
}

function SymbolWatchboard({
  approaching,
  signalPipeline,
  positions,
}: {
  approaching: ApproachingSignal[];
  signalPipeline: SignalPipelineData | null;
  positions: Position[];
}) {
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<"distance" | "time" | "symbol">("distance");

  const { items, phaseCounts } = useMemo(() => {
    const positionSymbols = new Set(positions.map((p) => p.symbol));
    const spMap = new Map<string, SignalPipelineEntry>();
    if (signalPipeline) {
      for (const s of signalPipeline.signals) {
        const key = `${s.symbol}:${s.timeframe}:${s.pattern}`;
        const existing = spMap.get(key);
        if (!existing || (s.stage !== "Closed" && s.stage !== "Expired")) {
          spMap.set(key, s);
        }
      }
    }

    const result: WatchboardSymbol[] = [];
    const bestBySymbol = new Map<string, WatchboardSymbol>();

    for (const ap of approaching) {
      const compKey = `${ap.symbol}:${ap.timeframe}:${ap.pattern}`;
      const sp = spMap.get(compKey);
      const hasPos = positionSymbols.has(ap.symbol);
      const { phase, description, phaseKey } = getPhaseFromSignal(ap, sp, hasPos);
      const item: WatchboardSymbol = {
        symbol: ap.symbol,
        pattern: ap.pattern,
        direction: ap.direction,
        timeframe: ap.timeframe,
        phaseKey,
        phase,
        description,
        distancePct: ap.distancePct,
        entryPrice: ap.projectedD,
        currentPrice: ap.currentPrice,
        sl: ap.sl,
        tp1: ap.tp1,
        rr: ap.rr ?? null,
        score: sp?.score ?? null,
        hasOrder: ap.hasOrder ?? false,
        blocked: ap.blocked ?? null,
        createdAt: ap.createdAt,
      };
      const existing = bestBySymbol.get(ap.symbol);
      if (!existing || (item.hasOrder && !existing.hasOrder) || (item.distancePct ?? 999) < (existing.distancePct ?? 999)) {
        bestBySymbol.set(ap.symbol, item);
      }
    }

    if (signalPipeline) {
      for (const sp of signalPipeline.signals) {
        if (bestBySymbol.has(sp.symbol)) continue;
        if (sp.stage === "Expired" || sp.stage === "Dismissed" || sp.stage === "Outranked") continue;
        if (bestBySymbol.has(sp.symbol)) continue;
        const hasPos = positionSymbols.has(sp.symbol);
        const { phase, description, phaseKey } = getPhaseFromSignal(undefined, sp, hasPos);
        bestBySymbol.set(sp.symbol, {
          symbol: sp.symbol,
          pattern: sp.pattern,
          direction: sp.direction,
          timeframe: sp.timeframe,
          phaseKey,
          phase,
          description,
          distancePct: null,
          entryPrice: sp.entryPrice,
          currentPrice: null,
          sl: sp.stopLoss,
          tp1: sp.tp1,
          rr: null,
          score: sp.score,
          hasOrder: sp.hasOrder,
          blocked: sp.blockedReason ?? null,
          createdAt: sp.detectedAt,
        });
      }
    }

    for (const item of bestBySymbol.values()) result.push(item);

    const counts: Record<string, number> = {};
    for (const it of result) counts[it.phaseKey] = (counts[it.phaseKey] ?? 0) + 1;
    return { items: result, phaseCounts: counts };
  }, [approaching, signalPipeline, positions]);

  const sorted = useMemo(() => {
    const filtered = phaseFilter ? items.filter((i) => i.phaseKey === phaseFilter) : items;
    return [...filtered].sort((a, b) => {
      if (sortMode === "distance") {
        return (a.distancePct ?? 999) - (b.distancePct ?? 999);
      }
      if (sortMode === "symbol") return a.symbol.localeCompare(b.symbol);
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [items, phaseFilter, sortMode]);

  return (
    <div style={{ background: "var(--bg-card)" }} className="h-full">
      <div className="flex items-center gap-1 px-4 py-2.5 flex-wrap border-b" style={{ borderColor: "var(--border-default)" }}>
        <span className="text-[11px] uppercase tracking-widest font-medium mr-2" style={{ color: "var(--sys-light)", fontFamily: DISPLAY }}>
          Watchboard
        </span>
        <button
          onClick={() => setPhaseFilter(null)}
          className="text-[12px] px-2 py-0.5 rounded font-semibold uppercase"
          style={{
            background: !phaseFilter ? "var(--sys-bg)" : "rgba(255,255,255,0.04)",
            color: !phaseFilter ? "var(--sys-light)" : "var(--text-muted)",
            border: !phaseFilter ? "0.5px solid var(--sys-border)" : "0.5px solid transparent",
            cursor: "pointer",
          }}
        >
          All {items.length}
        </button>
        {Object.entries(PHASE_CONFIG).map(([key, cfg]) => {
          const count = phaseCounts[key] ?? 0;
          if (count === 0) return null;
          return (
            <button
              key={key}
              onClick={() => setPhaseFilter(phaseFilter === key ? null : key)}
              className="text-[12px] px-2 py-0.5 rounded font-semibold"
              style={{
                background: phaseFilter === key ? cfg.bg : "rgba(255,255,255,0.03)",
                color: cfg.color,
                border: phaseFilter === key ? `1px solid ${cfg.color}40` : "1px solid transparent",
                cursor: "pointer",
              }}
            >
              {cfg.icon} {cfg.label} {count}
            </button>
          );
        })}
        <div className="flex-1" />
        <div className="flex gap-1">
          {(["distance", "time", "symbol"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSortMode(s)}
              className="text-[12px] px-1.5 py-0.5 rounded"
              style={{
                background: sortMode === s ? "rgba(255,255,255,0.1)" : "transparent",
                color: sortMode === s ? "white" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {s === "distance" ? "Closest" : s === "time" ? "Recent" : "A-Z"}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 110px)" }}>
        {sorted.length === 0 ? (
          <div className="p-6 text-center" style={{ color: "var(--text-muted)" }}>
            No active signals. Scanner is looking for harmonic patterns...
          </div>
        ) : (
          <div className="grid gap-0" style={{ fontFamily: MONO }}>
            {sorted.map((item) => {
              const cfg = PHASE_CONFIG[item.phaseKey] ?? PHASE_CONFIG["approaching"];
              const isHot = item.distancePct !== null && item.distancePct <= 2;
              return (
                <div
                  key={`${item.symbol}-${item.timeframe}-${item.pattern}-${item.createdAt}`}
                  className="flex items-center gap-3 px-4 py-2.5 border-b transition-colors"
                  style={{
                    borderColor: "var(--border-color)",
                    background: isHot ? "rgba(249,115,22,0.04)" : "transparent",
                  }}
                >
                  <div className="flex items-center gap-2" style={{ minWidth: 120 }}>
                    <span className="text-[13px]" style={{ color: cfg.color, opacity: 0.7 }}>{cfg.icon}</span>
                    <span className="text-[14px] font-bold text-white">{item.symbol}</span>
                  </div>

                  <div className="flex items-center gap-1.5" style={{ minWidth: 130 }}>
                    <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>{item.pattern}</span>
                    <span className="text-[11px] px-1 py-px rounded uppercase font-semibold"
                      style={{
                        background: item.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                        color: item.direction === "long" ? "var(--accent-green)" : "var(--accent-red)",
                      }}
                    >
                      {item.direction}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>{item.timeframe}</span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[11px] px-1.5 py-0.5 rounded font-semibold shrink-0"
                        style={{ background: cfg.bg, color: cfg.color }}
                      >
                        {item.phase}
                      </span>
                      <span className="text-[12px] truncate" style={{ color: "var(--text-muted)" }}>
                        {item.description}
                      </span>
                    </div>
                  </div>

                  {item.distancePct !== null && (
                    <div className="text-right shrink-0" style={{ minWidth: 55 }}>
                      <span
                        className="text-[13px] font-semibold tabular-nums"
                        style={{
                          color: item.distancePct <= 1 ? "var(--accent-red)" : item.distancePct <= 2 ? "#f97316" : item.distancePct <= 5 ? "#fbbf24" : "var(--text-muted)",
                        }}
                      >
                        {item.distancePct.toFixed(1)}%
                      </span>
                    </div>
                  )}

                  {item.entryPrice !== null && (
                    <div className="text-right shrink-0" style={{ minWidth: 80 }}>
                      <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>Entry</div>
                      <div className="text-[12px] tabular-nums" style={{ color: "var(--text-muted)" }}>{fmt(item.entryPrice)}</div>
                    </div>
                  )}

                  {item.currentPrice !== null && (
                    <div className="text-right shrink-0" style={{ minWidth: 80 }}>
                      <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>Now</div>
                      <div className="text-[12px] tabular-nums text-white">{fmt(item.currentPrice)}</div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 shrink-0" style={{ minWidth: 65 }}>
                    {item.score !== null && (
                      <span className="text-[11px] tabular-nums" style={{
                        color: item.score >= 75 ? "var(--accent-green)" : item.score >= 50 ? "#fbbf24" : "var(--text-muted)",
                      }}>
                        Q{item.score.toFixed(0)}
                      </span>
                    )}
                    {item.rr !== null && item.rr > 0 && (
                      <span className="text-[11px] tabular-nums" style={{ color: "var(--text-dim)" }}>
                        {item.rr.toFixed(1)}R
                      </span>
                    )}
                    {item.hasOrder && (
                      <span className="text-[11px]" style={{ color: "var(--accent-green)" }}>●</span>
                    )}
                  </div>

                  <div className="text-right shrink-0" style={{ minWidth: 40 }}>
                    <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                      {relativeTime(item.createdAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Scan Pipeline
// ============================================================
// ============================================================
// Signal Pipeline View — lifecycle stage for every signal
// ============================================================
const STAGE_COLORS: Record<string, { bg: string; fg: string }> = {
  "Detected":      { bg: "rgba(139, 92, 246, 0.10)", fg: "#a78bfa" },
  "Outranked":     { bg: "rgba(255,255,255,0.04)", fg: "var(--text-muted)" },
  "Paper Only":    { bg: "rgba(245, 158, 11, 0.10)",  fg: "#fbbf24" },
  "Market Closed": { bg: "rgba(245, 158, 11, 0.10)",  fg: "#fbbf24" },
  "Order Placed":  { bg: "rgba(249,115,22,0.10)",  fg: "#fb923c" },
  "Filled":        { bg: "rgba(59,130,246,0.10)",  fg: "#60a5fa" },
  "Exiting":       { bg: "rgba(59,130,246,0.10)",  fg: "#60a5fa" },
  "Closed":        { bg: "rgba(16, 185, 129, 0.10)", fg: "var(--sys-light)" },
  "Expired":       { bg: "rgba(255,255,255,0.04)", fg: "var(--text-muted)" },
  "Dismissed":     { bg: "rgba(255,255,255,0.04)", fg: "var(--text-muted)" },
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

function SignalPipelineView({ data, onSymbolClick }: { data: SignalPipelineData | null; onSymbolClick?: (symbol: string, signalId: number, timeframe: string) => void }) {
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"time" | "score" | "symbol">("time");

  if (!data) {
    return (
      <div className="p-6 text-center">
        <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          Waiting for signal data...
        </span>
      </div>
    );
  }

  const stages = [
    "Detected", "Order Placed", "Filled", "Exiting", "Closed",
    "Outranked", "Paper Only", "Market Closed", "Expired",
  ];

  const filtered = stageFilter
    ? data.signals.filter((s) => s.stage === stageFilter)
    : data.signals;

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "score") return (b.score ?? 0) - (a.score ?? 0);
    if (sortBy === "symbol") return a.symbol.localeCompare(b.symbol);
    return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
  });

  return (
    <div style={{ background: "var(--bg-card)" }}>
      <div className="flex items-center gap-1 px-3 py-2 flex-wrap border-b" style={{ borderColor: "var(--border-default)" }}>
        <button
          onClick={() => setStageFilter(null)}
          className="text-[12px] px-1.5 py-0.5 rounded font-semibold uppercase"
          style={{
            background: !stageFilter ? "var(--sys-bg)" : "rgba(255,255,255,0.04)",
            color: !stageFilter ? "var(--sys-light)" : "var(--text-muted)",
            border: !stageFilter ? "0.5px solid var(--sys-border)" : "0.5px solid transparent",
            cursor: "pointer",
          }}
        >
          All {data.summary.total}
        </button>
        {stages.map((stage) => {
          const count = data.summary.byStage[stage] ?? 0;
          if (count === 0) return null;
          const colors = STAGE_COLORS[stage] ?? { bg: "rgba(255,255,255,0.05)", fg: "var(--text-muted)" };
          return (
            <button
              key={stage}
              onClick={() => setStageFilter(stageFilter === stage ? null : stage)}
              className="text-[12px] px-1.5 py-0.5 rounded font-semibold"
              style={{
                background: stageFilter === stage ? colors.fg + "33" : colors.bg,
                color: colors.fg,
                border: stageFilter === stage ? `1px solid ${colors.fg}` : "1px solid transparent",
                cursor: "pointer",
              }}
            >
              {stage} {count}
            </button>
          );
        })}
        <div className="flex-1" />
        <div className="flex gap-1">
          {(["time", "score", "symbol"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className="text-[12px] px-1 py-0.5 rounded"
              style={{
                background: sortBy === s ? "rgba(255,255,255,0.1)" : "transparent",
                color: sortBy === s ? "white" : "var(--text-muted)",
                border: "none", cursor: "pointer",
              }}
            >
              {s === "time" ? "Recent" : s === "score" ? "Score" : "A-Z"}
            </button>
          ))}
        </div>
      </div>

      {/* Signal table */}
      <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 120px)" }}>
        <table className="w-full text-[12px]" style={{ fontFamily: MONO }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border-color)" }}>
              <th className="text-left px-2 py-1.5 font-semibold">Symbol</th>
              <th className="text-left px-2 py-1.5 font-semibold">Pattern</th>
              <th className="text-left px-2 py-1.5 font-semibold">Dir</th>
              <th className="text-right px-2 py-1.5 font-semibold">Score</th>
              <th className="text-right px-2 py-1.5 font-semibold">Entry</th>
              <th className="text-left px-2 py-1.5 font-semibold">Stage</th>
              <th className="text-left px-2 py-1.5 font-semibold">Detail</th>
              <th className="text-right px-2 py-1.5 font-semibold">When</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const colors = STAGE_COLORS[s.stage] ?? { bg: "rgba(255,255,255,0.05)", fg: "var(--text-muted)" };
              return (
                <tr
                  key={s.id}
                  className="border-b"
                  style={{ borderColor: "var(--border-color)" }}
                >
                  <td className="px-2 py-1.5 font-semibold cursor-pointer hover:underline" style={{ color: "var(--accent-green)" }} onClick={() => onSymbolClick?.(s.symbol, s.id, s.timeframe)}>{s.symbol}</td>
                  <td className="px-2 py-1.5" style={{ color: "var(--text-muted)" }}>
                    {s.pattern} {s.timeframe}
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className="text-[12px] px-1 py-px rounded uppercase font-semibold"
                      style={{
                        background: s.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                        color: s.direction === "long" ? "var(--accent-green)" : "var(--accent-red)",
                      }}
                    >
                      {s.direction}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right" style={{ color: s.score != null && s.score >= 75 ? "var(--accent-green)" : s.score != null && s.score >= 50 ? "var(--accent-amber)" : "var(--text-muted)" }}>
                    {s.score != null ? s.score.toFixed(1) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right" style={{ color: "var(--text-muted)" }}>
                    {s.entryPrice != null ? fmt(s.entryPrice) : "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className="text-[12px] px-1.5 py-0.5 rounded font-semibold"
                      style={{ background: colors.bg, color: colors.fg }}
                    >
                      {s.stage}
                    </span>
                  </td>
                  <td className="px-2 py-1.5" style={{ color: "var(--text-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.stageDetail}
                  </td>
                  <td className="px-2 py-1.5 text-right" style={{ color: "var(--text-muted)" }}>
                    {relativeTime(s.detectedAt)}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center" style={{ color: "var(--text-muted)" }}>
                  {stageFilter ? `No ${stageFilter} signals` : "No signals in the last 7 days"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// Scan Pipeline
// ============================================================
function ScanPipeline({ data }: { data: PipelineData | null }) {
  const [openSteps, setOpenSteps] = useState<Set<number>>(new Set([1]));

  if (!data) {
    return (
      <div className="p-6 text-center">
        <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          Waiting for first scan cycle...
        </span>
      </div>
    );
  }
  const toggle = (step: number) => {
    setOpenSteps(prev => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
  };
  const isOpen = (step: number) => openSteps.has(step);
  const steps = [
    {
      num: 1,
      name: "Determine what to scan",
      tag: data.lastUpdatedAgo !== null ? `${data.lastUpdatedAgo}s ago` : "waiting",
      active: true,
      content: (
        <div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <PipeMetric label="Symbols" value={String(data.symbolsScanned)} sub={`${data.cryptoCount} crypto · ${data.equityCount} equity`} />
            <PipeMetric label="Market" value={data.marketOpen ? "Open" : "Closed"} color={data.marketOpen ? "var(--accent-green)" : "var(--text-muted)"} />
            <PipeMetric label="Timeframes" value="1D + 4H" sub="Both scanned each cycle" />
          </div>
          <PipeBullet text={`All ${data.symbolsScanned} symbols scanned 24/7 (${data.cryptoCount} crypto · ${data.equityCount} equity)${!data.marketOpen ? " · Equity orders deferred" : ""}`} />
        </div>
      ),
    },
    {
      num: 2,
      name: "Fetch candle data",
      tag: "alpaca-data.ts",
      active: true,
      content: (
        <div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <PipeMetric label="1-Day candles" value="365 days" sub="Cached 2 hours" />
            <PipeMetric label="4-Hour candles" value="90 days" sub="Cached 5 minutes" />
          </div>
          <PipeBullet text="Crypto and stocks batched into separate API calls" />
          <PipeBullet text="Rate limiter: 1000 req/min (Algo Trader Plus) · 100ms throttle" />
          <PipeBullet text="Paginated up to 15 pages per request" />
        </div>
      ),
    },
    {
      num: 3,
      name: "Detect harmonic patterns",
      tag: "patterns.ts",
      active: data.rawCandidates > 0,
      content: (
        <div>
          <PipeMetric label="Raw candidates this cycle" value={String(data.rawCandidates)} />
          <div className="mt-3 rounded-md border p-3" style={{ background: "var(--bg-main)", borderColor: "var(--border-color)" }}>
            <div className="text-[12px] font-semibold mb-2" style={{ color: "var(--text-muted)" }}>MODE 1 — FORMING (PHASE C)</div>
            <div className="text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              5-bar pivot detection → 40 recent pivots → test X-A-B-C groups against 5 patterns (Gartley, Bat, Alt Bat, Butterfly, ABCD) → project D → limit order at projected price
            </div>
          </div>
          <div className="mt-2 rounded-md border p-3" style={{ background: "var(--bg-main)", borderColor: "var(--border-color)" }}>
            <div className="text-[12px] font-semibold mb-2" style={{ color: "var(--text-muted)" }}>MODE 2 — COMPLETED</div>
            <div className="text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
              All 5 pivots confirmed (X,A,B,C,D) → validates XAD ratio → 3% slippage check → market order if current price near D
            </div>
          </div>
        </div>
      ),
    },
    {
      num: 4,
      name: "Quality filtering (7 rules)",
      tag: "quality-filters.ts",
      active: data.rawCandidates > 0,
      content: (
        <div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <PipeMetric label="Passed" value={String(data.qualityPassed)} color="var(--accent-green)" />
            <PipeMetric label="Rejected" value={String(data.qualityRejected)} color="var(--accent-red)" />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
            <span>R1 · XB ratio 0.2 – 1.0</span>
            <span>R5 · Profit target ≥ 2.0%</span>
            <span>R2 · XD within pattern bounds</span>
            <span>R6 · Fib proximity ≤ 15%</span>
            <span>R3 · AC ratio 0.2 – 1.0</span>
            <span>R7 · Pattern age in window</span>
            <span>R4 · R:R ≥ 1.0</span>
          </div>
          {data.rawCandidates > 0 && (
            <div className="mt-3 flex items-center gap-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
              <span>{data.rawCandidates} candidates</span>
              <span style={{ color: "var(--accent-green)" }}>→</span>
              <span style={{ color: "var(--accent-green)" }}>{data.qualityPassed} passed</span>
              <span>·</span>
              <span style={{ color: "var(--accent-red)" }}>{data.qualityRejected} rejected</span>
              <span>·</span>
              <span>{data.rawCandidates > 0 ? Math.round((data.qualityPassed / data.rawCandidates) * 100) : 0}% pass rate</span>
            </div>
          )}
        </div>
      ),
    },
    {
      num: 5,
      name: "Phase C screening",
      tag: "screener.ts",
      active: data.qualityPassed > 0,
      content: (
        <div>
          <PipeMetric label="Passed screener" value={String(data.screenerPassed)} />
          <PipeBullet text="Blocks Crab and Deep Crab (globally disabled — low win rates)" />
          <PipeBullet text="Checks against your enabled_patterns from settings" />
        </div>
      ),
    },
    {
      num: 6,
      name: "Deduplication (2 layers)",
      tag: "orchestrator.ts",
      active: data.dedupSkipped > 0 || data.screenerPassed > 0,
      content: (
        <div>
          {data.dedupSkipped > 0 && (
            <PipeMetric label="Skipped as duplicates" value={String(data.dedupSkipped)} color="var(--accent-amber)" />
          )}
          <div className="mt-2 rounded-md border p-3" style={{ background: "var(--bg-main)", borderColor: "var(--border-color)" }}>
            <div className="text-[12px] font-semibold mb-1" style={{ color: "var(--text-muted)" }}>LAYER 1 — IN-MEMORY CACHE</div>
            <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>Key: symbol:timeframe:pattern:direction · TTL: 4 hours</div>
          </div>
          <div className="mt-2 rounded-md border p-3" style={{ background: "var(--bg-main)", borderColor: "var(--border-color)" }}>
            <div className="text-[12px] font-semibold mb-1" style={{ color: "var(--text-muted)" }}>LAYER 2 — DATABASE CHECK</div>
            <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>Window: 14 days for 1D, 7 days for 4H · Survives restarts</div>
          </div>
        </div>
      ),
    },
    {
      num: 7,
      name: "Save and execute",
      tag: "orchestrator.ts → alpaca.ts",
      active: data.newSignalsSaved > 0,
      content: (
        <div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            <PipeMetric label="Saved" value={String(data.newSignalsSaved)} color="var(--accent-green)" />
            <PipeMetric label="Orders placed" value={String(data.ordersPlaced)} color="var(--accent-green)" />
            <PipeMetric label="Orders skipped" value={String(data.ordersSkipped)} color="var(--accent-amber)" />
            <PipeMetric label="Paper only" value={String(data.paperOnlyCount)} />
          </div>
          <PipeBullet text="Zod validates all fields → Telegram alert → DB insert → Alpaca order" />
          <PipeBullet text="Position sizing: 5% equity for stocks, 7% for crypto" />
          <PipeBullet text="Skips if notional exceeds available buying power" />
          {data.paperOnlyCount > 0 && (
            <PipeBullet text={`${data.paperOnlyCount} crypto SHORT signal(s) tracked as paper_only — no Alpaca order`} />
          )}
        </div>
      ),
    },
    {
      num: 8,
      name: "Exit cycle",
      tag: "exit-manager.ts · crypto-monitor.ts",
      active: data.exitCycleRan,
      content: (
        <div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            <PipeMetric label="Pending fills" value={String(data.pendingFills)} />
            <PipeMetric label="In trade" value={String(data.filledPositions)} color="var(--accent-green)" />
            <PipeMetric label="Partial exit" value={String(data.partialExits)} color="var(--accent-amber)" />
            <PipeMetric label="Closed" value={String(data.closedTrades)} />
          </div>
          <div className="flex items-center gap-2 text-[12px] mb-3" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
            <span>pending</span>
            <span style={{ color: "var(--accent-green)" }}>→</span>
            <span style={{ color: "var(--accent-green)" }}>filled</span>
            <span style={{ color: "var(--accent-green)" }}>→</span>
            <span style={{ color: "var(--accent-amber)" }}>partial_exit</span>
            <span style={{ color: "var(--accent-green)" }}>→</span>
            <span style={{ color: "var(--accent-green)" }}>closed</span>
          </div>
          <PipeBullet text="Phase A: Poll Alpaca for entry fills → place TP1 + TP2 exits" />
          <PipeBullet text="Phase B: Monitor TP1/TP2 order fills → partial_exit → closed" />
          <PipeBullet text="Phase C: Software SL via WebSocket prices → market exit if breached" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <PipeMetric label="WebSocket crypto" value={data.websocket?.crypto ?? "—"} color={data.websocket?.crypto === "connected" ? "var(--accent-green)" : "var(--accent-amber)"} />
            <PipeMetric label="WebSocket stocks" value={data.websocket?.stock ?? "—"} color={data.websocket?.stock === "connected" ? "var(--accent-green)" : "var(--accent-amber)"} />
          </div>
        </div>
      ),
    },
  ];
  return (
    <div style={{ background: "var(--bg-card)" }}>
      <div className="p-4">
        {steps.map((step, i) => (
          <div key={step.num} className="flex gap-3" style={{ paddingBottom: i < steps.length - 1 ? 4 : 0 }}>
            <div className="flex flex-col items-center" style={{ width: 28 }}>
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-semibold shrink-0 cursor-pointer transition-all"
                style={{
                  background: step.active ? "var(--sys-bg)" : "var(--bg-card)",
                  border: step.active ? "0.5px solid var(--sys-border)" : "0.5px solid var(--border-default)",
                  color: step.active ? "var(--sys-light)" : "var(--text-muted)",
                  boxShadow: step.active ? "var(--sys-glow)" : "none",
                }}
                onClick={() => toggle(step.num)}
              >
                {step.num}
              </div>
              {i < steps.length - 1 && (
                <div className="flex-1" style={{ width: 1, background: "var(--border-color)", minHeight: 16 }} />
              )}
            </div>
            {/* Content */}
            <div className="flex-1" style={{ paddingBottom: i < steps.length - 1 ? 12 : 0 }}>
              <div
                className="flex items-center gap-2 cursor-pointer"
                onClick={() => toggle(step.num)}
                style={{ marginTop: 3 }}
              >
                <span className="text-xs font-semibold" style={{ color: isOpen(step.num) ? "var(--sys-light)" : "var(--text-primary)", fontFamily: DISPLAY }}>
                  {step.name}
                </span>
                <span className="text-[11px] px-1.5 py-0.5 rounded" style={{
                  background: "var(--bg-main)",
                  color: "var(--text-muted)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {step.tag}
                </span>
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {isOpen(step.num) ? "▾" : "▸"}
                </span>
              </div>
              {isOpen(step.num) && (
                <div className="mt-3 mb-2">
                  {step.content}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PipeMetric({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg p-2" style={{ background: "var(--bg-primary)", border: "0.5px solid var(--border-default)" }}>
      <div className="text-[12px] uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)", fontFamily: DISPLAY }}>{label}</div>
      <div className="text-sm font-semibold" style={{ color: color || "var(--text-primary)" }}>{value}</div>
      {sub && <div className="text-[12px] mt-0.5" style={{ color: "var(--text-dim)" }}>{sub}</div>}
    </div>
  );
}

function PipeBullet({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <div className="w-1 h-1 rounded-full mt-1.5 shrink-0" style={{ background: "var(--text-muted)" }} />
      <span className="text-[12px] leading-relaxed" style={{ color: "var(--text-muted)" }}>{text}</span>
    </div>
  );
}

// ============================================================
// Scan State View — tiered scanner phase distribution + hot symbols
// ============================================================
const PHASE_COLORS: Record<string, string> = {
  NO_PATTERN: "var(--text-muted)",
  XA_FORMING: "var(--text-muted)",
  AB_FORMING: "var(--text-muted)",
  BC_FORMING: "var(--accent-amber)",
  CD_PROJECTED: "var(--accent-green)",
  D_APPROACHING: "var(--accent-red)",
};

const PHASE_ORDER = ["NO_PATTERN", "XA_FORMING", "AB_FORMING", "BC_FORMING", "CD_PROJECTED", "D_APPROACHING"];

function ScanStateView({ data, onSymbolClick }: { data: ScanStateData | null; onSymbolClick?: (symbol: string) => void }) {
  const [refreshing, setRefreshing] = useState(false);
  if (!data || data.total === 0) return null;

  const phases = PHASE_ORDER.filter(p => (data.byPhase[p] ?? 0) > 0);
  const favoriteSet = new Set(data.favoriteSymbols ?? []);
  const cryptoCount = Math.floor(data.total / 2); // rough estimate: each symbol has 2 timeframes
  const equityCount = Math.floor(data.total / 2) - cryptoCount;
  const hotCount = (data.byPhase["CD_PROJECTED"] ?? 0) + (data.byPhase["D_APPROACHING"] ?? 0);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/universe/refresh", { method: "POST" });
    } catch {}
    setRefreshing(false);
  };

  return (
    <div style={{ background: "var(--bg-card)" }}>
      <div className="px-4 py-3">
        {/* Universe summary row */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[12px] font-semibold" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
            Scanning {(data.total / 2).toLocaleString(undefined, { maximumFractionDigits: 0 })} symbols
            {data.totalUniverse ? ` of ${data.totalUniverse.toLocaleString()} universe` : ""}
          </span>
          {hotCount > 0 && (
            <span className="text-[11px] px-1 py-px rounded font-bold" style={{ background: "var(--accent-green-dim)", color: "var(--accent-green)" }}>
              {hotCount} hot
            </span>
          )}
          {(data.byPhase["D_APPROACHING"] ?? 0) > 0 && (
            <span className="text-[11px] px-1 py-px rounded font-bold" style={{ background: "rgba(239,68,68,0.15)", color: "var(--accent-red)" }}>
              {data.byPhase["D_APPROACHING"]} approaching D
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="ml-auto text-[12px] uppercase tracking-wider px-2 py-0.5 rounded border"
            style={{
              borderColor: "var(--border-color)",
              color: refreshing ? "var(--text-muted)" : "var(--accent-green)",
              background: "transparent",
              cursor: refreshing ? "default" : "pointer",
              opacity: refreshing ? 0.5 : 1,
            }}
          >
            {refreshing ? "Refreshing..." : "Refresh universe"}
          </button>
        </div>

        {/* Phase distribution bar */}
        <div className="flex rounded overflow-hidden h-3 mb-2" style={{ background: "var(--bg-main)" }}>
          {phases.map(phase => {
            const count = data.byPhase[phase] ?? 0;
            const pct = data.total > 0 ? (count / data.total) * 100 : 0;
            if (pct === 0) return null;
            return (
              <div
                key={phase}
                title={`${phase}: ${count}`}
                style={{
                  width: `${pct}%`,
                  background: PHASE_COLORS[phase] ?? "var(--text-muted)",
                  opacity: phase === "NO_PATTERN" || phase === "XA_FORMING" || phase === "AB_FORMING" ? 0.3 : 0.7,
                  minWidth: count > 0 ? 4 : 0,
                }}
              />
            );
          })}
        </div>

        {/* Phase legend */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3">
          {phases.map(phase => (
            <div key={phase} className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-sm" style={{ background: PHASE_COLORS[phase] ?? "var(--text-muted)" }} />
              <span className="text-[11px]" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                {phase.replace("_", " ")}: {data.byPhase[phase] ?? 0}
              </span>
            </div>
          ))}
        </div>

        {/* Hot symbols */}
        {data.hotSymbols.length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wider font-medium mb-2" style={{ color: "var(--sys-light)", fontFamily: DISPLAY }}>
              Hot symbols
            </div>
            <div className="space-y-1">
              {data.hotSymbols.map((s, i) => (
                <div
                  key={`${s.symbol}-${s.timeframe}-${i}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                  style={{
                    background: "var(--bg-main)",
                    border: "0.5px solid var(--border-color)",
                    animation: s.phase === "D_APPROACHING" ? "pulse 2s ease-in-out infinite" : undefined,
                  }}
                >
                  {favoriteSet.has(s.symbol) && (
                    <span className="text-[12px] px-1 py-px rounded font-bold" style={{
                      background: "rgba(205,166,97,0.15)",
                      color: "var(--accent-amber)",
                    }}>
                      FAV
                    </span>
                  )}
                  <span className="text-[10px] font-bold cursor-pointer hover:underline" style={{
                    color: s.phase === "D_APPROACHING" ? "var(--accent-red)" : "var(--accent-green)",
                    fontFamily: "'JetBrains Mono', monospace",
                    minWidth: 70,
                  }} onClick={() => onSymbolClick?.(s.symbol)}>
                    {s.symbol}
                  </span>
                  <span className="text-[11px] px-1 py-px rounded" style={{
                    background: s.phase === "D_APPROACHING" ? "rgba(239,68,68,0.15)" : "var(--accent-green-dim)",
                    color: s.phase === "D_APPROACHING" ? "var(--accent-red)" : "var(--accent-green)",
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {s.timeframe}
                  </span>
                  {s.bestPattern && (
                    <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{s.bestPattern}</span>
                  )}
                  {s.bestDirection && (
                    <span className="text-[11px] font-semibold" style={{
                      color: s.bestDirection === "long" ? "var(--accent-green)" : "var(--accent-red)",
                    }}>
                      {s.bestDirection.toUpperCase()}
                    </span>
                  )}
                  {s.projectedD && (
                    <span className="text-[11px]" style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                      D=${Number(s.projectedD).toFixed(2)}
                    </span>
                  )}
                  {s.distanceToDPct && (
                    <span className="text-[11px] font-bold" style={{
                      color: Number(s.distanceToDPct) <= 2 ? "var(--accent-red)" : "var(--accent-amber)",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}>
                      {Number(s.distanceToDPct).toFixed(1)}% away
                    </span>
                  )}
                  <span className="text-[11px] ml-auto" style={{ color: "var(--text-muted)", opacity: 0.5 }}>
                    {s.tier}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Diagnostics View — comprehensive system health dashboard
// ============================================================
function DiagnosticsView() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchDiag = useCallback(async () => {
    try {
      const res = await fetch("/api/diagnostics/full");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to fetch diagnostics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDiag();
    if (!autoRefresh) return;
    const id = setInterval(fetchDiag, 15_000);
    return () => clearInterval(id);
  }, [fetchDiag, autoRefresh]);

  if (loading && !data) {
    return (
      <div className="p-6 text-center">
        <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>Loading diagnostics...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-6 text-center">
        <span className="text-[12px]" style={{ color: "var(--accent-red)" }}>Error: {error}</span>
      </div>
    );
  }

  if (!data) return null;

  const sys = data.system ?? {};
  const ws = data.websocket ?? {};
  const pipe = data.pipeline ?? {};
  const scanner = data.scanner ?? {};
  const orders = data.orders ?? {};
  const acct = data.account;
  const sigs = data.signals ?? {};
  const cache = data.cache ?? {};

  const scanAge = sys.lastScanAgeSeconds ?? null;
  const scanHealthy = scanAge != null && scanAge < 120;

  const signalSummary = (sigs.summary ?? []) as any[];
  const staleSignals = (sigs.stale ?? []) as any[];

  const totalSignalsByStatus: Record<string, number> = {};
  for (const row of signalSummary) {
    const status = row.status ?? "unknown";
    totalSignalsByStatus[status] = (totalSignalsByStatus[status] ?? 0) + Number(row.count ?? 0);
  }

  return (
    <div style={{ background: "var(--bg-card)" }}>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] uppercase tracking-widest font-medium" style={{ color: "var(--sys-light)", fontFamily: DISPLAY }}>
            System Diagnostics
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(p => !p)}
              className="text-[12px] uppercase tracking-wider px-2 py-0.5 rounded-md"
              style={{
                border: autoRefresh ? "0.5px solid var(--sys-border)" : "0.5px solid var(--border-default)",
                color: autoRefresh ? "var(--sys-light)" : "var(--text-muted)",
                background: autoRefresh ? "var(--sys-bg)" : "transparent",
              }}
            >
              {autoRefresh ? "Auto 15s" : "Paused"}
            </button>
            <button
              onClick={fetchDiag}
              className="text-[12px] uppercase tracking-wider px-2 py-0.5 rounded-md"
              style={{ border: "0.5px solid var(--sys-border)", color: "var(--sys-light)", background: "transparent" }}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Row 1: System Health + WebSocket + Cache */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <DiagSection title="System Health">
            <DiagRow label="Uptime" value={sys.uptimeFormatted ?? "—"} />
            <DiagRow label="Scan cycles" value={String(sys.scanCount ?? 0)} />
            <DiagRow
              label="Last scan"
              value={scanAge !== null ? `${scanAge}s ago` : "never"}
              color={scanHealthy ? "var(--accent-green)" : "var(--accent-red)"}
            />
            <DiagRow label="Market" value={sys.marketOpen ? "OPEN" : "CLOSED"} color={sys.marketOpen ? "var(--accent-green)" : "var(--text-muted)"} />
            <DiagRow label="Pass rate" value={`${sys.filterPassRate ?? 0}%`} sub={`${sys.lastScanPassedFilter ?? 0} / ${sys.lastScanCandidates ?? 0}`} />
          </DiagSection>

          <DiagSection title="WebSocket Streams">
            <DiagRow
              label="Crypto"
              value={(ws.crypto ?? "—").toUpperCase()}
              color={ws.crypto === "connected" ? "var(--accent-green)" : ws.crypto === "suspended" ? "var(--accent-amber)" : "var(--accent-red)"}
            />
            <DiagRow
              label="Stocks"
              value={(ws.stock ?? "—").toUpperCase()}
              color={ws.stock === "connected" ? "var(--accent-green)" : ws.stock === "suspended" ? "var(--accent-amber)" : "var(--accent-red)"}
            />
            <DiagRow label="Price count" value={String(ws.priceCount ?? 0)} />
            {ws.crypto === "suspended" && (
              <div className="text-[12px] mt-1 px-1 py-0.5 rounded" style={{ background: "rgba(205,166,97,0.1)", color: "var(--accent-amber)" }}>
                WS suspended — using REST fallback
              </div>
            )}
          </DiagSection>

          <DiagSection title="Data Cache">
            <DiagRow label="Entries" value={String(cache.totalEntries ?? 0)} />
            <DiagRow label="Hit rate" value={cache.hitRate != null ? `${cache.hitRate}%` : "—"} />
            <DiagRow label="Stale" value={String(cache.staleEntries ?? 0)} color={Number(cache.staleEntries ?? 0) > 10 ? "var(--accent-amber)" : undefined} />
          </DiagSection>
        </div>

        {/* Row 2: Pipeline Summary + Scanner + Orders */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <DiagSection title="Pipeline (Last Cycle)">
            <DiagRow label="Symbols scanned" value={String(pipe.symbolsScanned ?? 0)} sub={`${pipe.cryptoCount ?? 0}C / ${pipe.equityCount ?? 0}E`} />
            <DiagRow label="Raw candidates" value={String(pipe.rawCandidates ?? 0)} />
            <DiagRow label="Quality passed" value={String(pipe.qualityPassed ?? 0)} color="var(--accent-green)" />
            <DiagRow label="Quality rejected" value={String(pipe.qualityRejected ?? 0)} color={(pipe.qualityRejected ?? 0) > 0 ? "var(--accent-red)" : undefined} />
            <DiagRow label="Dedup skipped" value={String(pipe.dedupSkipped ?? 0)} />
            <DiagRow label="New signals" value={String(pipe.newSignalsSaved ?? 0)} color="var(--accent-green)" />
            <DiagRow label="Orders placed" value={String(pipe.ordersPlaced ?? 0)} color="var(--accent-green)" />
            <DiagRow label="Paper only" value={String(pipe.paperOnlyCount ?? 0)} />
            <DiagRow label="Last updated" value={pipe.lastUpdatedAgo != null ? `${pipe.lastUpdatedAgo}s ago` : "—"} />
          </DiagSection>

          <DiagSection title={`Scanner (${scanner.totalSlots ?? 0} slots)`}>
            <DiagRow label="Due now" value={String(scanner.dueNow ?? 0)} color={(scanner.dueNow ?? 0) > 0 ? "var(--accent-amber)" : undefined} />
            {Object.entries(scanner.phaseDistribution ?? {}).map(([phase, count]) => (
              <DiagRow
                key={phase}
                label={phase.replace(/_/g, " ")}
                value={String(count)}
                color={
                  phase === "D_APPROACHING" ? "var(--accent-red)"
                    : phase === "CD_PROJECTED" ? "var(--accent-green)"
                    : phase === "BC_FORMING" ? "var(--accent-amber)"
                    : undefined
                }
              />
            ))}
            {(scanner.overdueScanners ?? []).length > 0 && (
              <div className="mt-1">
                <div className="text-[12px] font-semibold mb-1" style={{ color: "var(--accent-red)" }}>
                  OVERDUE ({scanner.overdueScanners.length})
                </div>
                {(scanner.overdueScanners as any[]).slice(0, 5).map((s: any, i: number) => (
                  <div key={i} className="text-[12px]" style={{ color: "var(--accent-red)" }}>
                    {s.symbol} {s.timeframe} — {s.overdueMinutes}m late
                  </div>
                ))}
              </div>
            )}
          </DiagSection>

          <DiagSection title={`Open Orders (${orders.total ?? 0})`}>
            <DiagRow label="Buy orders" value={String(orders.buy ?? 0)} color="var(--accent-green)" />
            <DiagRow label="Sell orders" value={String(orders.sell ?? 0)} color="var(--accent-red)" />
            <DiagRow label="Total notional" value={`$${(orders.totalNotional ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
            {acct && (
              <>
                <div className="mt-1 pt-1" style={{ borderTop: "0.5px solid var(--border-color)" }}>
                  <DiagRow label="Equity" value={`$${acct.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                  <DiagRow label="Buying power" value={`$${acct.buyingPower.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                  <DiagRow label="Cash" value={`$${acct.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                </div>
              </>
            )}
          </DiagSection>
        </div>

        {/* Row 3: Signal Breakdown + Stale Signals + Orders Table */}
        <div className="grid grid-cols-3 gap-2">
          <DiagSection title="Signal Summary">
            {Object.entries(totalSignalsByStatus).map(([status, count]) => (
              <DiagRow
                key={status}
                label={status}
                value={String(count)}
                color={
                  status === "filled" ? "var(--accent-green)"
                    : status === "closed" ? "var(--text-muted)"
                    : status === "pending" ? "var(--accent-amber)"
                    : status === "paper_only" ? "var(--accent-amber)"
                    : undefined
                }
              />
            ))}
            <div className="mt-1 pt-1" style={{ borderTop: "0.5px solid var(--border-color)" }}>
              <div className="text-[12px] font-semibold mb-1" style={{ color: "var(--text-muted)" }}>BY ASSET CLASS</div>
              {signalSummary.map((row: any, i: number) => (
                <div key={i} className="flex justify-between text-[11px] py-px">
                  <span style={{ color: "var(--text-muted)" }}>
                    {row.asset_class} {(row.direction ?? "").toUpperCase()} {row.status}
                  </span>
                  <span style={{ color: "white" }}>{row.count}</span>
                </div>
              ))}
            </div>
          </DiagSection>

          <DiagSection title={`Stale Signals (${staleSignals.length})`}>
            {staleSignals.length === 0 ? (
              <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>No stale signals (48h+)</div>
            ) : (
              staleSignals.map((s: any, i: number) => (
                <div key={i} className="flex justify-between text-[11px] py-px">
                  <span style={{ color: "var(--accent-amber)" }}>{s.symbol}</span>
                  <span style={{ color: "var(--text-muted)" }}>{s.status}</span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {s.created_at ? dateShort(s.created_at) : "—"}
                  </span>
                </div>
              ))
            )}
          </DiagSection>

          <DiagSection title="Recent Orders">
            {(orders.orders ?? []).length === 0 ? (
              <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>No open orders</div>
            ) : (
              <div className="space-y-0.5">
                {(orders.orders as any[]).slice(0, 10).map((o: any, i: number) => (
                  <div key={i} className="flex items-center gap-1 text-[11px]">
                    <span
                      className="px-1 py-px rounded text-[12px] font-bold uppercase"
                      style={{
                        background: o.side === "buy" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                        color: o.side === "buy" ? "var(--accent-green)" : "var(--accent-red)",
                      }}
                    >
                      {o.side}
                    </span>
                    <span style={{ color: "white" }}>{o.symbol}</span>
                    <span style={{ color: "var(--text-muted)" }}>{o.qty}</span>
                    <span style={{ color: "var(--text-muted)" }}>@ {o.limitPrice ?? "mkt"}</span>
                    {o.ageMinutes != null && (
                      <span className="ml-auto" style={{ color: o.ageMinutes > 1440 ? "var(--accent-amber)" : "var(--text-muted)" }}>
                        {o.ageMinutes > 1440 ? `${Math.floor(o.ageMinutes / 1440)}d` : o.ageMinutes > 60 ? `${Math.floor(o.ageMinutes / 60)}h` : `${o.ageMinutes}m`}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </DiagSection>
        </div>
      </div>
    </div>
  );
}

function DiagSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-2.5 card-glow transition-all" style={{ background: "var(--bg-primary)", border: "0.5px solid var(--border-default)" }}>
      <div className="text-[12px] uppercase tracking-wider font-medium mb-1.5" style={{ color: "var(--text-secondary)", fontFamily: "'Inter', sans-serif" }}>{title}</div>
      {children}
    </div>
  );
}

function DiagRow({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="flex justify-between items-baseline py-px">
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{label}</span>
      <div className="flex items-baseline gap-1">
        {sub && <span className="text-[12px]" style={{ color: "var(--text-dim)", opacity: 0.6 }}>{sub}</span>}
        <span className="text-[11px] font-semibold" style={{ color: color ?? "var(--text-primary)" }}>{value}</span>
      </div>
    </div>
  );
}

// ============================================================
// Sidebar row helper
// ============================================================
function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="font-semibold" style={{ color: color || "var(--text-primary)" }}>{value}</span>
    </div>
  );
}

// ============================================================
// Trade Page — full chart + trade panel
// ============================================================
function TradePage({
  symbol,
  signalId,
  timeframe,
  setTimeframe,
  signals,
  approaching,
  openChart,
}: {
  symbol: string | null;
  signalId: number | null;
  timeframe: "4H" | "1D";
  setTimeframe: (tf: "4H" | "1D") => void;
  signals: Signal[];
  approaching: ApproachingSignal[];
  openChart: (symbol: string, signalId?: number | null, timeframe?: "4H" | "1D") => void;
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<any>(null);

  const [candles, setCandles] = useState<any[]>([]);
  const [signal, setSignal] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [orderResult, setOrderResult] = useState<string | null>(null);
  const [patternPhase, setPatternPhase] = useState<{
    matched: number; total: number; currentPrice: number;
    dPrice: number; dFound: boolean; distToDPct: number;
    leg: string; status: string;
  } | null>(null);

  // Fetch candle data when symbol or timeframe changes
  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    setOrderResult(null);

    fetch(`/api/candles/${encodeURIComponent(symbol)}?timeframe=${timeframe}`)
      .then((r) => r.json())
      .then((data) => {
        setCandles(data.candles || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [symbol, timeframe]);

  // Fetch signal details
  useEffect(() => {
    if (!signalId) {
      setSignal(null);
      setPatternPhase(null);
      return;
    }
    fetch(`/api/signal/${signalId}`)
      .then((r) => r.json())
      .then(setSignal)
      .catch(() => setSignal(null));
  }, [signalId]);

  // Also try to find signal from approaching data if no signalId
  useEffect(() => {
    if (signalId || !symbol) return;
    const match = approaching.find((a) => a.symbol === symbol);
    if (match) {
      setSignal({
        entryPrice: String(match.projectedD),
        stopLossPrice: String(match.sl),
        tp1Price: String(match.tp1),
        tp2Price: String(match.tp2),
        xPrice: match.x != null ? String(match.x) : null,
        aPrice: match.a != null ? String(match.a) : null,
        bPrice: match.b != null ? String(match.b) : null,
        cPrice: match.c != null ? String(match.c) : null,
        patternType: match.pattern,
        direction: match.direction,
        timeframe: match.timeframe,
        status: "approaching",
        score: null,
      });
    }
  }, [signalId, symbol, approaching]);

  // Render chart
  useEffect(() => {
    if (!chartContainerRef.current || candles.length === 0) return;
    let disposed = false;

    // Dynamic import
    import("lightweight-charts").then(({ createChart, ColorType, LineStyle }) => {
      if (disposed || !chartContainerRef.current) return;

      if (chartInstanceRef.current) {
        try { chartInstanceRef.current.remove(); } catch {}
        chartInstanceRef.current = null;
      }

      const container = chartContainerRef.current;
      const chart = createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
          background: { type: ColorType.Solid, color: "#0a0e0a" },
          textColor: "#7a8891",
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
        },
        grid: {
          vertLines: { color: "#1a2e1a" },
          horzLines: { color: "#1a2e1a" },
        },
        crosshair: {
          mode: 0,
        },
        rightPriceScale: {
          borderColor: "#273136",
          scaleMargins: { top: 0.1, bottom: 0.1 },
        },
        timeScale: {
          borderColor: "#273136",
          timeVisible: true,
          secondsVisible: false,
        },
      });

      chartInstanceRef.current = chart;

      const candleSeries = chart.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderDownColor: "#ef4444",
        borderUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        wickUpColor: "#22c55e",
      });

      candleSeries.setData(candles);

      // Add overlay lines and XABCD pattern shape if we have signal data
      if (signal) {
        const entryPrice = Number(signal.entryPrice);
        const slPrice = Number(signal.stopLossPrice);
        const tp1Price = Number(signal.tp1Price);
        const tp2Price = Number(signal.tp2Price);

        // Draw SL/TP/Entry horizontal price lines
        if (entryPrice > 0) {
          candleSeries.createPriceLine({
            price: entryPrice,
            color: "#eab308",
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "Entry (D)",
          });
        }
        if (slPrice > 0) {
          candleSeries.createPriceLine({
            price: slPrice,
            color: "#ef4444",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "SL",
          });
        }
        if (tp1Price > 0) {
          candleSeries.createPriceLine({
            price: tp1Price,
            color: "#22c55e",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "TP1",
          });
        }
        if (tp2Price > 0) {
          candleSeries.createPriceLine({
            price: tp2Price,
            color: "#4ade80",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "TP2",
          });
        }

        // ── XABCD Pattern Shape Overlay ──
        // Match XABCD pivot prices to actual candle timestamps
        const xP = Number(signal.xPrice);
        const aP = Number(signal.aPrice);
        const bP = Number(signal.bPrice);
        const cP = Number(signal.cPrice);
        const dP = entryPrice;
        const dir = signal.direction; // "long" or "short"

        // For long: X=low, A=high, B=low, C=high, D=low
        // For short: X=high, A=low, B=high, C=low, D=high
        const pivotSide = dir === "long"
          ? ["low", "high", "low", "high", "low"] as const
          : ["high", "low", "high", "low", "high"] as const;
        const pivotPrices = [xP, aP, bP, cP, dP];
        const pivotLabels = ["X", "A", "B", "C", "D"];

        // Find candle index for each pivot price
        // Scan RIGHT-TO-LEFT to find the MOST RECENT pattern, not old historical ones
        function findPivotIndex(price: number, side: "high" | "low", beforeIdx: number, afterIdx: number = 0): number {
          if (price <= 0 || isNaN(price)) return -1;
          let bestIdx = -1;
          let bestDiff = Infinity;
          for (let i = Math.min(beforeIdx, candles.length - 1); i >= afterIdx; i--) {
            const cp = side === "high" ? candles[i].high : candles[i].low;
            const diff = Math.abs(cp - price);
            const pctDiff = diff / price;
            if (pctDiff < 0.008 && diff < bestDiff) { // within 0.8%
              bestDiff = diff;
              bestIdx = i;
            }
          }
          return bestIdx;
        }

        // Strategy: find C first (most recent), then walk backwards for B, A, X
        // Then find D after C
        const lastIdx = candles.length - 1;
        const cIdx = findPivotIndex(cP, pivotSide[3], lastIdx);
        const bIdx = cIdx >= 0 ? findPivotIndex(bP, pivotSide[2], cIdx - 1) : -1;
        const aIdx = bIdx >= 0 ? findPivotIndex(aP, pivotSide[1], bIdx - 1) : -1;
        const xIdx = aIdx >= 0 ? findPivotIndex(xP, pivotSide[0], aIdx - 1) : -1;

        // D might be projected (not yet on chart) or completed — search after C
        const dIdx = cIdx >= 0 ? findPivotIndex(dP, pivotSide[4], lastIdx, cIdx + 1) : -1;

        const pivotIndices = [xIdx, aIdx, bIdx, cIdx, dIdx];

        // Build the pattern line data points
        const patternLineData: { time: any; value: number }[] = [];
        const markers: any[] = [];
        const markerColors = ["#c084fc", "#c084fc", "#c084fc", "#c084fc", "#eab308"]; // purple for XABC, yellow for D
        const markerShapes = dir === "long"
          ? ["arrowUp", "arrowDown", "arrowUp", "arrowDown", "arrowUp"] // low=up, high=down
          : ["arrowDown", "arrowUp", "arrowDown", "arrowUp", "arrowDown"];

        for (let i = 0; i < 5; i++) {
          const idx = pivotIndices[i];
          const price = pivotPrices[i];
          if (idx >= 0 && price > 0) {
            patternLineData.push({ time: candles[idx].time, value: price });
            markers.push({
              time: candles[idx].time,
              position: pivotSide[i] === "high" ? "aboveBar" : "belowBar",
              color: markerColors[i],
              shape: markerShapes[i],
              text: pivotLabels[i] + " " + price.toFixed(price > 100 ? 2 : price > 1 ? 4 : 6),
            });
          } else if (i === 4 && price > 0 && candles.length > 0) {
            // D is projected — extend to the last candle's time
            const lastTime = candles[candles.length - 1].time;
            patternLineData.push({ time: lastTime, value: price });
            markers.push({
              time: lastTime,
              position: pivotSide[i] === "high" ? "aboveBar" : "belowBar",
              color: "#eab308",
              shape: "circle",
              text: "D (proj) " + price.toFixed(price > 100 ? 2 : price > 1 ? 4 : 6),
            });
          }
        }

        // Draw the XABCD line series if we found at least 3 points
        if (patternLineData.length >= 3) {
          const patternSeries = chart.addLineSeries({
            color: "#a78bfa",
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            priceLineVisible: false,
          });
          patternSeries.setData(patternLineData);
        }

        // Add markers for XABCD pivot points
        if (markers.length > 0) {
          markers.sort((a: any, b: any) => a.time - b.time);
          candleSeries.setMarkers(markers);
        }

        // ── "Where are we" indicator — draw a vertical region or highlight ──
        // Find the current leg based on which points we matched
        const matched = pivotIndices.filter((idx) => idx >= 0).length;
        const lastCandlePrice = candles.length > 0 ? candles[candles.length - 1].close : 0;

        // Store phase info for the pattern progress bar UI
        setPatternPhase({
          matched,
          total: 5,
          currentPrice: lastCandlePrice,
          dPrice: dP,
          dFound: pivotIndices[4] >= 0,
          distToDPct: dP > 0 ? Math.abs((lastCandlePrice - dP) / dP * 100) : 0,
          leg: matched <= 2 ? "XA→AB" : matched <= 3 ? "AB→BC" : matched <= 4 ? "BC→CD" : "D Complete",
          status: signal.status,
        });
      }

      chart.timeScale().fitContent();

      // Resize observer
      const observer = new ResizeObserver(() => {
        if (disposed || !chartInstanceRef.current) return;
        try {
          chart.applyOptions({
            width: container.clientWidth,
            height: container.clientHeight,
          });
        } catch {}
      });
      observer.observe(container);

      return () => {
        observer.disconnect();
      };
    });

    return () => {
      disposed = true;
      if (chartInstanceRef.current) {
        try { chartInstanceRef.current.remove(); } catch {}
        chartInstanceRef.current = null;
      }
    };
  }, [candles, signal]);

  if (!symbol) {
    // No symbol selected — show a symbol picker from recent signals
    return (
      <div className="flex-1 flex flex-col items-center justify-center" style={{ color: "var(--text-muted)" }}>
        <BarChart3 className="w-16 h-16 mb-4 opacity-20" />
        <p className="text-sm mb-1" style={{ color: "var(--text-main)" }}>No symbol selected</p>
        <p className="text-xs mb-6 opacity-60">Click any symbol in Signals, Feed, or the table below</p>
        {signals.length > 0 && (
          <div className="w-80">
            <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>
              Recent Signals
            </div>
            {signals.slice(0, 8).map((s) => (
              <button
                key={s.id}
                onClick={() => openChart(s.symbol, s.id, s.timeframe as "4H" | "1D")}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded mb-1 text-left hover:opacity-80"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--border-color)" }}
              >
                <span className="font-semibold" style={{ color: "var(--accent-green)" }}>{s.symbol}</span>
                <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>{s.patternType}</span>
                <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>{s.timeframe}</span>
                <span
                  className="text-[8px] px-1 py-px rounded uppercase font-semibold ml-auto"
                  style={{
                    background: s.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                    color: s.direction === "long" ? "var(--accent-green)" : "var(--accent-red)",
                  }}
                >
                  {s.direction}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* CHART AREA */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Chart header */}
        <div
          className="shrink-0 flex items-center justify-between px-4 h-10 border-b"
          style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-bold text-white">{symbol}</span>
            {signal && (
              <>
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded uppercase font-semibold"
                  style={{
                    background: signal.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                    color: signal.direction === "long" ? "var(--accent-green)" : "var(--accent-red)",
                  }}
                >
                  {signal.direction}
                </span>
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {signal.patternType} {signal.timeframe}
                </span>
                {signal.score != null && (
                  <span
                    className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{ background: "var(--accent-green-dim)", color: "var(--accent-green)" }}
                  >
                    Score {Number(signal.score).toFixed(1)}
                  </span>
                )}
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded"
                  style={{ background: "rgba(234,179,8,0.15)", color: "#eab308" }}
                >
                  {signal.status}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {(["4H", "1D"] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className="px-3 py-1 text-[10px] rounded font-semibold"
                style={{
                  background: timeframe === tf ? "var(--accent-green-dim)" : "transparent",
                  color: timeframe === tf ? "var(--accent-green)" : "var(--text-muted)",
                  border: `1px solid ${timeframe === tf ? "#166534" : "var(--border-color)"}`,
                }}
              >
                {tf}
              </button>
            ))}
            <a
              href={`https://www.tradingview.com/chart/?symbol=${symbol.replace("/", "")}&interval=${timeframe === "1D" ? "D" : "240"}`}
              target="_blank"
              rel="noopener"
              className="px-2 py-1 text-[10px] rounded"
              style={{ border: "1px solid var(--border-color)", color: "var(--text-muted)" }}
            >
              TradingView
            </a>
          </div>
        </div>

        {/* Chart container */}
        <div ref={chartContainerRef} className="flex-1 relative" style={{ minHeight: 300 }}>
          {loading && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: "rgba(10,14,10,0.8)", color: "var(--text-muted)", zIndex: 10 }}
            >
              Loading chart data...
            </div>
          )}
          {!loading && candles.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center" style={{ color: "var(--text-muted)" }}>
              No candle data available for {symbol}
            </div>
          )}
        </div>

        {/* Pattern Phase Indicator Bar */}
        {patternPhase && signal && (
          <div
            className="shrink-0 flex items-center gap-3 px-4 h-9 border-t"
            style={{ borderColor: "var(--border-color)", background: "#0d120d" }}
          >
            {/* Step tracker: X → A → B → C → D */}
            <div className="flex items-center gap-0.5">
              {["X", "A", "B", "C", "D"].map((label, i) => {
                const isMatched = i < patternPhase.matched;
                const isCurrent = i === patternPhase.matched - 1 || (i === patternPhase.matched && i < 5);
                const isD = label === "D";
                return (
                  <div key={label} className="flex items-center">
                    {i > 0 && (
                      <div
                        className="w-5 h-0.5 mx-0.5"
                        style={{
                          background: isMatched ? "#a78bfa" : "#1a2e1a",
                        }}
                      />
                    )}
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold"
                      style={{
                        background: isMatched
                          ? isD ? "rgba(234,179,8,0.3)" : "rgba(167,139,250,0.25)"
                          : isCurrent ? "rgba(167,139,250,0.1)" : "#111",
                        color: isMatched
                          ? isD ? "#eab308" : "#c084fc"
                          : isCurrent ? "#8b5cf6" : "#333",
                        border: `1.5px solid ${isMatched ? (isD ? "#eab308" : "#8b5cf6") : isCurrent ? "#6d28d9" : "#222"}`,
                        boxShadow: isCurrent && !isMatched ? "0 0 6px rgba(139,92,246,0.3)" : "none",
                      }}
                    >
                      {label}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Current leg label */}
            <div className="text-[10px] font-semibold" style={{ color: "#a78bfa" }}>
              {patternPhase.leg}
            </div>

            {/* Distance to D */}
            {!patternPhase.dFound && patternPhase.dPrice > 0 && (
              <div className="flex items-center gap-1.5 ml-auto">
                <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                  Price → D:
                </span>
                <span
                  className="text-[10px] font-bold"
                  style={{
                    color: patternPhase.distToDPct < 2 ? "#ef4444"
                      : patternPhase.distToDPct < 5 ? "#eab308"
                      : "#a78bfa",
                  }}
                >
                  {patternPhase.distToDPct.toFixed(2)}%
                </span>
                <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                  (${patternPhase.currentPrice > 100
                    ? patternPhase.currentPrice.toFixed(2)
                    : patternPhase.currentPrice.toFixed(4)} → ${patternPhase.dPrice > 100
                    ? patternPhase.dPrice.toFixed(2)
                    : patternPhase.dPrice.toFixed(4)})
                </span>
              </div>
            )}
            {patternPhase.dFound && (
              <div className="flex items-center gap-1.5 ml-auto">
                <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                  style={{ background: "rgba(234,179,8,0.15)", color: "#eab308" }}>
                  D Reached
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* TRADE PANEL — 320px right side */}
      <div
        className="shrink-0 flex flex-col overflow-y-auto border-l"
        style={{ width: 320, borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
      >
        {/* Signal Details */}
        {signal && (
          <div className="p-4 border-b" style={{ borderColor: "var(--border-color)" }}>
            <div className="text-[9px] uppercase tracking-widest font-semibold mb-3" style={{ color: "var(--text-muted)" }}>
              Signal Details
            </div>
            <div className="space-y-1.5 text-[10px]">
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>Pattern</span>
                <span className="text-white font-semibold">{signal.patternType}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>Direction</span>
                <span style={{ color: signal.direction === "long" ? "var(--accent-green)" : "var(--accent-red)" }}>
                  {(signal.direction ?? "").toUpperCase()}
                </span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>Status</span>
                <span style={{ color: "#eab308" }}>{signal.status}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>Entry (D)</span>
                <span style={{ color: "#eab308" }}>{fmt(Number(signal.entryPrice))}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>Stop Loss</span>
                <span style={{ color: "var(--accent-red)" }}>{fmt(Number(signal.stopLossPrice))}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>TP1</span>
                <span style={{ color: "var(--accent-green)" }}>{fmt(Number(signal.tp1Price))}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: "var(--text-muted)" }}>TP2</span>
                <span style={{ color: "#4ade80" }}>{fmt(Number(signal.tp2Price))}</span>
              </div>
              {signal.score != null && (
                <div className="flex justify-between">
                  <span style={{ color: "var(--text-muted)" }}>Score</span>
                  <span style={{ color: "var(--accent-green)" }}>{Number(signal.score).toFixed(1)} / 100</span>
                </div>
              )}
            </div>

            {/* XABCD Points */}
            {signal.xPrice && Number(signal.xPrice) > 0 && (
              <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--border-color)" }}>
                <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>
                  Pattern Points
                </div>
                <div className="grid grid-cols-5 gap-1 text-center text-[9px]">
                  {(["X", "A", "B", "C", "D"] as const).map((point) => {
                    const priceMap: Record<string, string> = {
                      X: signal.xPrice,
                      A: signal.aPrice,
                      B: signal.bPrice,
                      C: signal.cPrice,
                      D: signal.entryPrice,
                    };
                    const p = Number(priceMap[point]);
                    return (
                      <div key={point}>
                        <div style={{ color: "#8b5cf6" }} className="font-bold">
                          {point}
                        </div>
                        <div className="text-white">{p > 0 ? fmt(p) : "—"}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Order Actions */}
        <div className="p-4 border-b" style={{ borderColor: "var(--border-color)" }}>
          <div className="text-[9px] uppercase tracking-widest font-semibold mb-3" style={{ color: "var(--text-muted)" }}>
            Actions
          </div>
          <div className="space-y-2">
            {/* Cancel order button */}
            {signal?.entryOrderId && signal?.status === "pending" && (
              <button
                onClick={async () => {
                  if (!confirm(`Cancel order for ${symbol}?`)) return;
                  try {
                    const res = await fetch(`/api/orders/cancel/${signal.entryOrderId}`, { method: "POST" });
                    const data = await res.json();
                    if (data.success) {
                      setOrderResult("Order cancelled");
                      if (signalId) fetch(`/api/signal/${signalId}`).then((r) => r.json()).then(setSignal);
                    } else {
                      setOrderResult(`Error: ${data.error}`);
                    }
                  } catch (err: any) {
                    setOrderResult(`Error: ${err.message}`);
                  }
                }}
                className="w-full py-2 rounded text-[10px] font-semibold uppercase tracking-wider"
                style={{ background: "var(--accent-red-dim)", color: "var(--accent-red)", border: "1px solid rgba(127,29,29,0.5)" }}
              >
                Cancel Order
              </button>
            )}

            {/* Buy / Sell buttons */}
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const qty = prompt(`Buy quantity for ${symbol}:`);
                  const price = prompt("Limit price:", signal ? Number(signal.entryPrice).toFixed(4) : "");
                  if (!qty || !price) return;
                  try {
                    const res = await fetch("/api/orders/place", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ symbol, side: "buy", qty, limit_price: price }),
                    });
                    const data = await res.json();
                    setOrderResult(data.success ? `Buy placed: ${qty} @ $${price}` : `Error: ${JSON.stringify(data.error)}`);
                  } catch (err: any) {
                    setOrderResult(`Error: ${err.message}`);
                  }
                }}
                className="flex-1 py-2.5 rounded text-[11px] font-bold uppercase tracking-wider"
                style={{ background: "var(--accent-green-dim)", color: "var(--accent-green)", border: "1px solid #166534" }}
              >
                BUY
              </button>
              <button
                onClick={async () => {
                  const qty = prompt(`Sell quantity for ${symbol}:`);
                  const price = prompt("Limit price:");
                  if (!qty || !price) return;
                  try {
                    const res = await fetch("/api/orders/place", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ symbol, side: "sell", qty, limit_price: price }),
                    });
                    const data = await res.json();
                    setOrderResult(data.success ? `Sell placed: ${qty} @ $${price}` : `Error: ${JSON.stringify(data.error)}`);
                  } catch (err: any) {
                    setOrderResult(`Error: ${err.message}`);
                  }
                }}
                className="flex-1 py-2.5 rounded text-[11px] font-bold uppercase tracking-wider"
                style={{ background: "var(--accent-red-dim)", color: "var(--accent-red)", border: "1px solid rgba(127,29,29,0.5)" }}
              >
                SELL
              </button>
            </div>

            {/* Order result feedback */}
            {orderResult && (
              <div className="text-[10px] p-2 rounded" style={{ background: "var(--bg-main)", color: "var(--text-muted)" }}>
                {orderResult}
              </div>
            )}
          </div>
        </div>

        {/* Quick symbol list from approaching signals */}
        {approaching.length > 0 && (
          <div className="p-4">
            <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>
              Approaching D ({approaching.filter((s) => (s.distancePct ?? 0) <= 10).length})
            </div>
            {approaching
              .filter((s) => (s.distancePct ?? 0) <= 10)
              .slice(0, 8)
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => openChart(s.symbol, s.id, s.timeframe as "4H" | "1D")}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded mb-0.5 text-left hover:opacity-80"
                  style={{
                    background: s.symbol === symbol ? "var(--accent-green-dim)" : "transparent",
                    border: s.symbol === symbol ? "1px solid #166534" : "1px solid transparent",
                  }}
                >
                  <span className="text-[10px] font-semibold" style={{ color: "var(--accent-green)" }}>
                    {s.symbol}
                  </span>
                  <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                    {s.pattern} {s.timeframe}
                  </span>
                  <span
                    className="text-[9px] font-bold ml-auto"
                    style={{ color: (s.distancePct ?? 0) < 3 ? "var(--accent-red)" : "var(--accent-amber)" }}
                  >
                    {(s.distancePct ?? 0).toFixed(1)}%
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Settings Drawer
// ============================================================
function SettingsDrawer({
  botSettings,
  updateSettings,
  watchlist,
  fetchAll,
}: {
  botSettings: BotSettings | null;
  updateSettings: (patch: Partial<BotSettings>) => Promise<void>;
  watchlist: WatchlistItem[];
  fetchAll: () => Promise<void>;
}) {
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

  return (
    <div className="shrink-0 border-b px-4 py-3 flex gap-8 overflow-x-auto" style={{ borderColor: "var(--border-default)", background: "var(--bg-secondary)" }}>
      <div>
        <div className="text-[11px] uppercase tracking-widest font-medium mb-2" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>Patterns</div>
        <div className="flex gap-1.5">
          {(["Gartley", "Bat", "Alt Bat", "Butterfly", "ABCD"] as const).map((p) => {
            const on = botSettings?.enabled_patterns?.includes(p) ?? true;
            return (
              <button
                key={p}
                onClick={() => {
                  if (!botSettings) return;
                  const next = on ? botSettings.enabled_patterns.filter((x) => x !== p) : [...botSettings.enabled_patterns, p];
                  if (next.length > 0) updateSettings({ enabled_patterns: next });
                }}
                className="px-2 py-1 rounded border text-[12px] transition-colors"
                style={on
                  ? { background: "var(--sys-bg)", color: "var(--sys-light)", border: "0.5px solid var(--sys-border)" }
                  : { background: "var(--bg-primary)", color: "var(--text-muted)", border: "0.5px solid var(--border-default)" }}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      {/* Sizing */}
      {botSettings && (
        <div className="min-w-[200px]">
          <div className="text-[11px] uppercase tracking-widest font-medium mb-2" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>Sizing</div>
          <div className="flex items-center gap-2 text-[12px]">
            <span style={{ color: "var(--text-muted)" }}>STK</span>
            <input type="range" min="1" max="20" value={Math.round(botSettings.equity_allocation * 100)}
              onChange={(e) => updateSettings({ equity_allocation: Number(e.target.value) / 100 })}
              className="flex-1 h-1" style={{ accentColor: "var(--accent-green)" }} />
            <span className="text-white w-7 text-right">{Math.round(botSettings.equity_allocation * 100)}%</span>
          </div>
          <div className="flex items-center gap-2 text-[12px] mt-1">
            <span style={{ color: "var(--text-muted)" }}>CRY</span>
            <input type="range" min="1" max="20" value={Math.round(botSettings.crypto_allocation * 100)}
              onChange={(e) => updateSettings({ crypto_allocation: Number(e.target.value) / 100 })}
              className="flex-1 h-1" style={{ accentColor: "var(--accent-amber)" }} />
            <span className="text-white w-7 text-right">{Math.round(botSettings.crypto_allocation * 100)}%</span>
          </div>
        </div>
      )}

      {/* Watchlist */}
      <div className="min-w-[300px]">
        <div className="text-[11px] uppercase tracking-widest font-medium mb-2" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>
          Watchlist ({watchlist.length})
        </div>
        <div className="flex gap-1.5 mb-2">
          <input
            type="text"
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSymbol()}
            placeholder="Add symbol..."
            className="rounded px-2 py-1 text-[12px] focus:outline-none w-32"
            style={{ background: "var(--bg-main)", border: "1px solid var(--border-color)", color: "var(--text-main)", fontFamily: "inherit" }}
          />
          <button onClick={addSymbol} className="rounded px-2 py-1 text-[12px] flex items-center gap-1"
            style={{ background: "rgba(205,166,97,0.1)", color: "var(--accent-amber)", border: "1px solid rgba(205,166,97,0.2)" }}>
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {watchlist.map((w) => (
            <div key={w.symbol} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] border"
              style={{ background: "var(--bg-main)", borderColor: "var(--border-color)" }}>
              <span className="w-1 h-1 rounded-full" style={{ background: w.assetClass === "crypto" ? "var(--accent-amber)" : "var(--accent-green)" }} />
              <span className="text-white">{w.symbol}</span>
              <button onClick={() => removeSymbol(w.symbol)} style={{ color: "var(--text-muted)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent-red)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}>
                <XCircle className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
