import { useState, useEffect, useCallback, useMemo } from "react";
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
const POLL_INTERVAL = 10_000;
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
  const [activePage, setActivePage] = useState<"dashboard" | "pipeline" | "scanner" | "diagnostics" | "feed" | "signals">("dashboard");
  const [signalPipeline, setSignalPipeline] = useState<SignalPipelineData | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [acctRes, posRes, sigRes, statRes, metRes, appRes, setRes, histRes, wlRes, pipeRes, ssRes, spRes] =
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
          fetch("/api/pipeline").then((r) => r.json()),
          fetch("/api/scan-state").then((r) => r.json()),
          fetch("/api/signals/pipeline").then((r) => r.json()),
        ]);
      if (acctRes.status === "fulfilled") setAccount(acctRes.value);
      if (posRes.status === "fulfilled" && Array.isArray(posRes.value)) setPositions(posRes.value);
      if (sigRes.status === "fulfilled" && Array.isArray(sigRes.value)) setSignals(sigRes.value);
      if (statRes.status === "fulfilled") setStatus(statRes.value);
      if (metRes.status === "fulfilled") setMetrics(metRes.value);
      if (appRes.status === "fulfilled" && Array.isArray(appRes.value)) setApproaching(appRes.value);
      if (setRes.status === "fulfilled" && setRes.value && !setRes.value.error) setBotSettings(setRes.value);
      if (histRes.status === "fulfilled" && Array.isArray(histRes.value)) setHistory(histRes.value);
      if (wlRes.status === "fulfilled" && Array.isArray(wlRes.value)) setWatchlist(wlRes.value);
      if (pipeRes.status === "fulfilled") setPipeline(pipeRes.value);
      if (ssRes.status === "fulfilled") setScanState(ssRes.value);
      if (spRes.status === "fulfilled") setSignalPipeline(spRes.value);
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
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAll]);

  // ---- Derived ----
  const equity = account?.equity ?? 0;
  const bp = account?.buying_power ?? 0;
  const lockedPct = equity > 0 ? ((equity - bp) / equity) * 100 : 0;
  const totalPl = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const totalPlPct = equity > 0 ? (totalPl / equity) * 100 : 0;

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
            { key: "dashboard" as const, icon: LayoutDashboard, label: "Dash" },
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
                          <span className="text-white font-semibold truncate">{p.symbol}</span>
                          {p.pattern && <span className="text-[11px] truncate" style={{ color: "var(--accent-amber)" }}>{p.pattern}</span>}
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

                {/* HOT SIGNALS STRIP */}
                <div className="shrink-0 border-t" style={{ borderColor: "var(--border-default)", background: "var(--bg-secondary)" }}>
                  <div className="flex items-center justify-between px-4 h-8">
                    <span className="text-[11px] uppercase tracking-widest font-medium" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>
                      Active Signals ({approaching.length})
                    </span>
                    <button
                      onClick={() => setActivePage("signals")}
                      className="text-[11px] uppercase tracking-wider font-medium"
                      style={{ color: "var(--sys-light)", cursor: "pointer", background: "none", border: "none" }}
                    >
                      View All →
                    </button>
                  </div>
                  <div className="overflow-y-auto" style={{ maxHeight: 180 }}>
                    {approaching.slice(0, 12).map((s, idx) => {
                      const dist = s.distancePct ?? 999;
                      const isHot = dist <= 2;
                      return (
                        <div
                          key={`${s.symbol}-${s.timeframe}-${s.id ?? idx}`}
                          className="flex items-center gap-2 px-4 py-1.5 border-t"
                          style={{ borderColor: "rgba(255,255,255,0.03)", background: isHot ? "rgba(249,115,22,0.04)" : "transparent" }}
                        >
                          <span className="text-[12px] font-semibold text-white" style={{ minWidth: 70 }}>{s.symbol}</span>
                          <span className="text-[11px]" style={{ color: "var(--text-dim)", minWidth: 65 }}>{s.pattern}</span>
                          <span className="text-[11px] px-1 py-px rounded uppercase font-semibold"
                            style={{
                              background: s.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                              color: s.direction === "long" ? "var(--accent-green)" : "var(--accent-red)",
                            }}
                          >{s.direction === "long" ? "L" : "S"}</span>
                          <span className="text-[11px] flex-1 truncate" style={{ color: isHot ? "#f97316" : "var(--text-muted)" }}>
                            Phase C → D @ {fmt(s.projectedD)}
                          </span>
                          <span className="text-[12px] font-semibold tabular-nums" style={{
                            color: dist <= 1 ? "var(--accent-red)" : dist <= 2 ? "#f97316" : dist <= 5 ? "#fbbf24" : "var(--text-muted)",
                            minWidth: 40,
                            textAlign: "right",
                          }}>
                            {dist.toFixed(1)}%
                          </span>
                          {s.hasOrder && <span className="text-[10px]" style={{ color: "var(--accent-green)" }}>●</span>}
                        </div>
                      );
                    })}
                    {approaching.length === 0 && (
                      <div className="px-4 py-3 text-center text-[12px]" style={{ color: "var(--text-muted)" }}>
                        Scanner searching for patterns...
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <aside className="w-72 shrink-0 flex flex-col overflow-y-auto" style={{ background: "var(--bg-card)" }}>
                <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-default)" }}>
                  <div className="text-[11px] uppercase tracking-widest font-medium mb-2" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>Risk</div>
                  <Row label="Equity" value={fmt(equity)} />
                  <Row label="Buying Power" value={fmt(bp)} />
                  <Row label="Cash" value={fmt(account?.cash ?? bp)} />
                  <div className="mt-2">
                    <div className="flex justify-between text-[12px] mb-0.5">
                      <span style={{ color: "var(--text-muted)" }}>GTC Locked</span>
                      <span style={{ color: lockedPct > 80 ? "var(--accent-red)" : lockedPct > 50 ? "var(--accent-amber)" : "var(--accent-green)" }}>
                        {lockedPct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full" style={{ background: "var(--border-color)" }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(lockedPct, 100)}%`,
                          background: lockedPct > 80 ? "var(--accent-red)" : lockedPct > 50 ? "var(--accent-amber)" : "var(--accent-green)",
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-default)" }}>
                  <div className="text-[11px] uppercase tracking-widest font-medium mb-2" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>Stats</div>
                  <Row label="Win Rate" value={metrics ? `${metrics.win_rate}%` : "—"} color="var(--accent-green)" />
                  <Row label="W / L" value={metrics ? `${metrics.wins} / ${metrics.losses}` : "—"} />
                  <Row label="Profit Factor" value={metrics ? (metrics.profit_factor == null ? "—" : metrics.profit_factor === Infinity ? "INF" : metrics.profit_factor.toFixed(2)) : "—"} />
                  <Row label="Trades" value={String(history.length)} />
                  <Row label="Signals" value={String(signals.length)} />
                  <Row label="Approaching" value={String(approaching.filter((s) => (s.distancePct ?? 0) <= 5).length)} color="var(--accent-amber)" />
                </div>

                <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-default)" }}>
                  <div className="text-[11px] uppercase tracking-widest font-medium mb-2" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>
                    Imminent ({approaching.filter((s) => (s.distancePct ?? 0) <= 2).length})
                  </div>
                  {approaching.filter((s) => (s.distancePct ?? 0) <= 2).length === 0 ? (
                    <div style={{ color: "var(--text-muted)" }}>None imminent</div>
                  ) : (
                    approaching.filter((s) => (s.distancePct ?? 0) <= 2).map((s, i) => (
                      <div key={i} className="flex items-center justify-between py-0.5">
                        <span className="text-white">{s.symbol}</span>
                        <span className="text-[11px]" style={{ color: "var(--accent-amber)" }}>{(s.distancePct ?? 0).toFixed(1)}%</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-default)" }}>
                  <div className="text-[11px] uppercase tracking-widest font-medium mb-2" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>Alerts</div>
                  {alerts.map((a, i) => (
                    <div key={i} className="flex items-center gap-2 py-0.5">
                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{
                        background: a.level === "red" ? "var(--accent-red)" : a.level === "amber" ? "var(--accent-amber)" : "var(--accent-green)",
                      }} />
                      <span style={{ color: a.level === "red" ? "var(--accent-red)" : a.level === "amber" ? "var(--accent-amber)" : "var(--accent-green)" }}>
                        {a.text}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="px-3 py-3 flex-1">
                  <div className="text-[11px] uppercase tracking-widest font-medium mb-2" style={{ color: "var(--text-secondary)", fontFamily: DISPLAY }}>
                    Recent Fills ({history.length})
                  </div>
                  {history.slice(0, 10).map((t, i) => (
                    <div key={i} className="flex items-center justify-between py-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="text-[11px] px-1 py-px rounded uppercase font-semibold shrink-0"
                          style={{
                            background: (t.direction ?? "") === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                            color: (t.direction ?? "") === "long" ? "var(--accent-green)" : "var(--accent-red)",
                          }}
                        >
                          {(t.direction ?? "") === "long" ? "L" : "S"}
                        </span>
                        <span className="text-white truncate">{t.symbol}</span>
                        <span className="text-[11px] shrink-0" style={{ color: "var(--text-muted)" }}>{t.pattern}</span>
                      </div>
                      <span className="text-[11px] shrink-0" style={{ color: "var(--text-muted)" }}>
                        {dateShort(t.filled_at)}
                      </span>
                    </div>
                  ))}
                  {history.length === 0 && (
                    <div style={{ color: "var(--text-muted)" }}>No fills yet</div>
                  )}
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
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                <SymbolWatchboard
                  approaching={approaching}
                  signalPipeline={signalPipeline}
                  positions={positions}
                />
              </div>
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
              <ScanStateView data={scanState} />
            </div>
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

function SignalPipelineView({ data }: { data: SignalPipelineData | null }) {
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
                  <td className="px-2 py-1.5 font-semibold" style={{ color: "white" }}>{s.symbol}</td>
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

function ScanStateView({ data }: { data: ScanStateData | null }) {
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
                  <span className="text-[12px] font-bold" style={{
                    color: s.phase === "D_APPROACHING" ? "var(--accent-red)" : "var(--accent-green)",
                    fontFamily: "'JetBrains Mono', monospace",
                    minWidth: 70,
                  }}>
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
                    {s.phase === "D_APPROACHING" ? "IMMINENT" : "PROJECTED"}
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
