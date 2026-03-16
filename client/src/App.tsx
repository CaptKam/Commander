import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Settings,
  Power,
  XCircle,
  Plus,
  Zap,
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
const MONO = "'JetBrains Mono', 'IBM Plex Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

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
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [blotterSort, setBlotterSort] = useState<"pnl" | "symbol" | "pct">("pnl");

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
      if (posRes.status === "fulfilled" && Array.isArray(posRes.value)) setPositions(posRes.value);
      if (sigRes.status === "fulfilled" && Array.isArray(sigRes.value)) setSignals(sigRes.value);
      if (statRes.status === "fulfilled") setStatus(statRes.value);
      if (metRes.status === "fulfilled") setMetrics(metRes.value);
      if (appRes.status === "fulfilled" && Array.isArray(appRes.value)) setApproaching(appRes.value);
      if (setRes.status === "fulfilled" && setRes.value && !setRes.value.error) setBotSettings(setRes.value);
      if (histRes.status === "fulfilled" && Array.isArray(histRes.value)) setHistory(histRes.value);
      if (wlRes.status === "fulfilled" && Array.isArray(wlRes.value)) setWatchlist(wlRes.value);
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

    history.slice(0, 20).forEach((t) => {
      events.push({
        time: t.filled_at,
        tag: "FILL",
        color: "var(--accent-green)",
        text: `${(t.direction ?? "").toUpperCase()} ${t.symbol} ${t.pattern ?? "?"} ${(t.qty ?? 0).toFixed(2)} @ ${fmt(t.filled_price)}`,
      });
    });

    approaching.forEach((s) => {
      const isCrypto = s.symbol.includes("/");
      const blocked = isCrypto && s.direction === "short";
      events.push({
        time: s.createdAt,
        tag: blocked ? "REJECT" : "NEAR",
        color: blocked ? "var(--accent-red)" : s.distancePct < 2 ? "var(--accent-amber)" : "var(--text-main)",
        text: blocked
          ? `${s.symbol} ${s.pattern} SHORT blocked — crypto shorts unsupported`
          : `${(s.direction ?? "").toUpperCase()} ${s.symbol} ${s.pattern} ${s.timeframe} — ${(s.distancePct ?? 0).toFixed(1)}% from D @ ${fmt(s.projectedD)}`,
      });
    });

    signals.slice(0, 30).forEach((s) => {
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
          color: "var(--accent-amber)",
          text: `${(s.direction ?? "").toUpperCase()} ${s.symbol} ${s.patternType} ${s.timeframe} @ ${fmt(Number(s.entryPrice))} — ${s.status}`,
        });
      }
    });

    events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return events.slice(0, 50);
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
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-main)" }}>
        <Zap className="w-8 h-8 animate-pulse" style={{ color: "var(--accent-green)" }} />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: "var(--bg-main)", fontFamily: MONO, fontSize: "11px" }}>
      {/* ================================================================ */}
      {/* HEADER BAR — P&L front and center                                */}
      {/* ================================================================ */}
      <header className="shrink-0 flex items-center justify-between px-4 h-10 border-b" style={{ borderColor: "var(--border-color)" }}>
        <div className="flex items-center gap-4">
          <span className="text-xs font-bold text-white tracking-widest">FTM COMMANDER</span>
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: status?.status === "online" ? "#22c55e" : "#ef4444", boxShadow: status?.status === "online" ? "0 0 4px rgba(34,197,94,0.6)" : undefined }} />
        </div>

        {/* P&L — the most important number */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--text-muted)" }}>P&L</span>
            <span className="text-sm font-bold" style={{ color: totalPl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
              {totalPl >= 0 ? "+" : ""}{fmt(totalPl)}
            </span>
            <span className="text-[10px]" style={{ color: totalPl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
              ({totalPlPct >= 0 ? "+" : ""}{totalPlPct.toFixed(2)}%)
            </span>
          </div>
          <span style={{ color: "var(--border-color)" }}>|</span>
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--text-muted)" }}>Day</span>
            <span style={{ color: (account?.daily_pl ?? 0) >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
              {(account?.daily_pl ?? 0) >= 0 ? "+" : ""}{fmt(account?.daily_pl ?? 0)}
            </span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {botSettings && (
            <button
              onClick={() => updateSettings({ trading_enabled: !botSettings.trading_enabled })}
              className="flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-semibold uppercase tracking-wider"
              style={botSettings.trading_enabled
                ? { background: "var(--accent-green-dim)", color: "var(--accent-green)", borderColor: "#166534" }
                : { background: "var(--accent-red-dim)", color: "var(--accent-red)", borderColor: "rgba(127,29,29,0.5)" }}
            >
              <Power className="w-3 h-3" />
              {botSettings.trading_enabled ? "ON" : "OFF"}
            </button>
          )}
          <button
            className="flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-semibold uppercase tracking-wider"
            style={{ background: "var(--accent-red-dim)", color: "var(--accent-red)", borderColor: "rgba(127,29,29,0.5)" }}
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
            className="w-7 h-7 rounded flex items-center justify-center border"
            style={{
              background: settingsOpen ? "var(--accent-green-dim)" : "var(--bg-panel)",
              borderColor: settingsOpen ? "#166534" : "var(--border-color)",
              color: settingsOpen ? "var(--accent-green)" : "var(--text-muted)",
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
      {/* MAIN BODY — two columns                                          */}
      {/* ================================================================ */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT: blotter + feed (70%) */}
        <div className="flex-1 flex flex-col overflow-hidden border-r" style={{ borderColor: "var(--border-color)" }}>

          {/* BLOTTER */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="shrink-0 flex items-center justify-between px-3 h-7 border-b" style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}>
              <span className="text-[9px] uppercase tracking-widest font-semibold" style={{ color: "var(--text-muted)" }}>
                Positions ({positions.length})
              </span>
              <div className="flex gap-2">
                {(["pnl", "pct", "symbol"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setBlotterSort(s)}
                    className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={blotterSort === s
                      ? { color: "var(--accent-green)", background: "var(--accent-green-dim)" }
                      : { color: "var(--text-muted)" }}
                  >
                    {s === "pnl" ? "P&L" : s === "pct" ? "%" : "A-Z"}
                  </button>
                ))}
              </div>
            </div>

            {/* Column headers */}
            <div className="shrink-0 grid grid-cols-[1fr_50px_65px_70px_70px_70px_70px_70px_75px] gap-1 px-3 py-1 text-[9px] uppercase tracking-wider border-b"
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

            {/* Rows */}
            <div className="flex-1 overflow-y-auto">
              {sortedPositions.length === 0 ? (
                <div className="px-3 py-6 text-center" style={{ color: "var(--text-muted)" }}>
                  No open positions
                </div>
              ) : (
                sortedPositions.map((p) => (
                  <div
                    key={p.symbol}
                    className="grid grid-cols-[1fr_50px_65px_70px_70px_70px_70px_70px_75px] gap-1 px-3 py-1.5 border-b items-center"
                    style={{ borderColor: "rgba(255,255,255,0.03)" }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-white font-semibold truncate">{p.symbol}</span>
                      {p.pattern && <span className="text-[9px] truncate" style={{ color: "var(--accent-amber)" }}>{p.pattern}</span>}
                    </div>
                    <div>
                      <span
                        className="text-[9px] px-1 py-px rounded uppercase font-semibold"
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

              {/* Blotter total row */}
              {positions.length > 0 && (
                <div
                  className="grid grid-cols-[1fr_50px_65px_70px_70px_70px_70px_70px_75px] gap-1 px-3 py-1.5 border-t"
                  style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
                >
                  <div className="text-[9px] uppercase font-semibold" style={{ color: "var(--text-muted)" }}>Total</div>
                  <div />
                  <div />
                  <div />
                  <div />
                  <div />
                  <div />
                  <div />
                  <div className="text-right font-bold" style={{ color: totalPl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}>
                    {totalPl >= 0 ? "+" : ""}{fmt(totalPl)}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* LIVE FEED */}
          <div className="shrink-0 flex flex-col" style={{ height: "40%" }}>
            <div className="shrink-0 flex items-center justify-between px-3 h-7 border-t border-b" style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}>
              <span className="text-[9px] uppercase tracking-widest font-semibold" style={{ color: "var(--text-muted)" }}>
                Live Feed
              </span>
              <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>{feed.length} events</span>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-1">
              {feed.map((e, i) => (
                <div key={i} className="flex items-start gap-2 py-0.5 leading-tight">
                  <span className="shrink-0 text-[9px] tabular-nums" style={{ color: "var(--text-muted)", opacity: 0.5 }}>
                    {ts(e.time)}
                  </span>
                  <span
                    className="shrink-0 text-[9px] px-1 py-px rounded font-semibold uppercase"
                    style={{
                      background: e.tag === "FILL" ? "var(--accent-green-dim)"
                        : e.tag === "REJECT" ? "var(--accent-red-dim)"
                        : e.tag === "NEAR" ? "rgba(205,166,97,0.15)"
                        : e.tag === "CLOSED" ? "rgba(122,136,145,0.15)"
                        : "rgba(205,166,97,0.15)",
                      color: e.tag === "FILL" ? "var(--accent-green)"
                        : e.tag === "REJECT" ? "var(--accent-red)"
                        : e.tag === "NEAR" ? "var(--accent-amber)"
                        : e.tag === "CLOSED" ? "var(--text-muted)"
                        : "var(--accent-amber)",
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
        </div>

        {/* RIGHT SIDEBAR (30%) — risk, stats, alerts */}
        <aside className="w-64 shrink-0 flex flex-col overflow-y-auto" style={{ background: "var(--bg-panel)" }}>

          {/* RISK */}
          <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-color)" }}>
            <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Risk</div>
            <Row label="Equity" value={fmt(equity)} />
            <Row label="Buying Power" value={fmt(bp)} />
            <Row label="Cash" value={fmt(account?.cash ?? bp)} />
            <div className="mt-2">
              <div className="flex justify-between text-[10px] mb-0.5">
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

          {/* STATS */}
          <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-color)" }}>
            <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Stats</div>
            <Row label="Win Rate" value={metrics ? `${metrics.win_rate}%` : "—"} color="var(--accent-green)" />
            <Row label="W / L" value={metrics ? `${metrics.wins} / ${metrics.losses}` : "—"} />
            <Row label="Profit Factor" value={metrics ? (metrics.profit_factor == null ? "—" : metrics.profit_factor === Infinity ? "INF" : metrics.profit_factor.toFixed(2)) : "—"} />
            <Row label="Trades" value={String(history.length)} />
            <Row label="Signals" value={String(signals.length)} />
            <Row label="Approaching" value={String(approaching.filter((s) => s.distancePct <= 5).length)} color="var(--accent-amber)" />
          </div>

          {/* APPROACHING (imminent only) */}
          <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-color)" }}>
            <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>
              Imminent ({approaching.filter((s) => s.distancePct <= 5).length})
            </div>
            {approaching.filter((s) => s.distancePct <= 5).slice(0, 8).map((s) => {
              const isCrypto = s.symbol.includes("/");
              const blocked = isCrypto && s.direction === "short";
              return (
                <div key={s.id} className="flex items-center justify-between py-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="text-[9px] px-1 py-px rounded uppercase font-semibold shrink-0"
                      style={{
                        background: s.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                        color: s.direction === "long" ? "var(--accent-green)" : "var(--accent-red)",
                      }}
                    >
                      {s.direction === "long" ? "L" : "S"}
                    </span>
                    <span className="text-white truncate">{s.symbol}</span>
                  </div>
                  {blocked ? (
                    <span className="text-[9px] shrink-0" style={{ color: "var(--accent-red)" }}>BLOCKED</span>
                  ) : (
                    <span
                      className="text-[9px] shrink-0 font-semibold"
                      style={{ color: s.distancePct < 2 ? "var(--accent-red)" : "var(--accent-amber)" }}
                    >
                      {s.distancePct.toFixed(1)}%
                    </span>
                  )}
                </div>
              );
            })}
            {approaching.filter((s) => s.distancePct <= 5).length === 0 && (
              <div style={{ color: "var(--text-muted)" }}>None imminent</div>
            )}
          </div>

          {/* ALERTS */}
          <div className="px-3 py-3 border-b" style={{ borderColor: "var(--border-color)" }}>
            <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Alerts</div>
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

          {/* RECENT FILLS */}
          <div className="px-3 py-3 flex-1">
            <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>
              Recent Fills ({history.length})
            </div>
            {history.slice(0, 10).map((t, i) => (
              <div key={i} className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="text-[9px] px-1 py-px rounded uppercase font-semibold shrink-0"
                    style={{
                      background: t.direction === "long" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
                      color: t.direction === "long" ? "var(--accent-green)" : "var(--accent-red)",
                    }}
                  >
                    {t.direction === "long" ? "L" : "S"}
                  </span>
                  <span className="text-white truncate">{t.symbol}</span>
                  <span className="text-[9px] shrink-0" style={{ color: "var(--text-muted)" }}>{t.pattern}</span>
                </div>
                <span className="text-[9px] shrink-0" style={{ color: "var(--text-muted)" }}>
                  {dateShort(t.filled_at)}
                </span>
              </div>
            ))}
            {history.length === 0 && (
              <div style={{ color: "var(--text-muted)" }}>No fills yet</div>
            )}
          </div>
        </aside>
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
      <span className="font-semibold" style={{ color: color || "white" }}>{value}</span>
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
    <div className="shrink-0 border-b px-4 py-3 flex gap-8 overflow-x-auto" style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}>
      {/* Patterns */}
      <div>
        <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Patterns</div>
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
                className="px-2 py-1 rounded border text-[10px] transition-colors"
                style={on
                  ? { background: "var(--accent-green-dim)", color: "var(--accent-green)", borderColor: "#166534" }
                  : { background: "var(--bg-main)", color: "var(--text-muted)", borderColor: "var(--border-color)" }}
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
          <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>Sizing</div>
          <div className="flex items-center gap-2 text-[10px]">
            <span style={{ color: "var(--text-muted)" }}>STK</span>
            <input type="range" min="1" max="20" value={Math.round(botSettings.equity_allocation * 100)}
              onChange={(e) => updateSettings({ equity_allocation: Number(e.target.value) / 100 })}
              className="flex-1 h-1" style={{ accentColor: "var(--accent-green)" }} />
            <span className="text-white w-7 text-right">{Math.round(botSettings.equity_allocation * 100)}%</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] mt-1">
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
        <div className="text-[9px] uppercase tracking-widest font-semibold mb-2" style={{ color: "var(--text-muted)" }}>
          Watchlist ({watchlist.length})
        </div>
        <div className="flex gap-1.5 mb-2">
          <input
            type="text"
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSymbol()}
            placeholder="Add symbol..."
            className="rounded px-2 py-1 text-[10px] focus:outline-none w-32"
            style={{ background: "var(--bg-main)", border: "1px solid var(--border-color)", color: "var(--text-main)", fontFamily: "inherit" }}
          />
          <button onClick={addSymbol} className="rounded px-2 py-1 text-[10px] flex items-center gap-1"
            style={{ background: "rgba(205,166,97,0.1)", color: "var(--accent-amber)", border: "1px solid rgba(205,166,97,0.2)" }}>
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          {watchlist.map((w) => (
            <div key={w.symbol} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] border"
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
