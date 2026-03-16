import { useState, useEffect, useCallback } from "react";
import {
  Settings,
  Power,
  XCircle,
  Plus,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Zap,
} from "lucide-react";

// ============================================================
// Types — kept identical to original
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
const VALIDATION_TARGET = 15;
const MONO = "'JetBrains Mono', 'IBM Plex Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

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

interface SectionVisibility {
  validation: boolean;
  positions: boolean;
  approaching: boolean;
  capital: boolean;
  issues: boolean;
  history: boolean;
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
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [visibility, setVisibility] = useState<SectionVisibility>({
    validation: true,
    positions: true,
    approaching: true,
    capital: true,
    issues: true,
    history: true,
  });

  // ---- Data fetching (ALL original fetch calls preserved) ----
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
      setLastUpdate(new Date());
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

  // ---- Derived data ----
  const closedTrades = history.length;
  const tradesRemaining = Math.max(0, VALIDATION_TARGET - closedTrades);
  const progressPct = Math.min((closedTrades / VALIDATION_TARGET) * 100, 100);
  const equity = account?.equity ?? 0;
  const buyingPower = account?.buying_power ?? 0;
  const lockedPct = equity > 0 ? ((equity - buyingPower) / equity) * 100 : 0;
  const totalUnrealizedPl = positions.reduce((s, p) => s + p.unrealized_pl, 0);
  const imminentSignals = approaching.filter((s) => s.distancePct <= 5);

  // ---- System issues ----
  const issues: { level: "fix" | "warn" | "ok"; text: string }[] = [];
  if (lockedPct > 80)
    issues.push({ level: "fix", text: `GTC orders consuming ${lockedPct.toFixed(0)}% of equity — buying power nearly exhausted` });
  if (!botSettings?.trading_enabled)
    issues.push({ level: "warn", text: "Auto-trade is OFF — signals will be saved but no orders placed" });
  if (positions.length >= 8)
    issues.push({ level: "warn", text: `${positions.length} open positions — approaching max capacity` });
  if (issues.length === 0)
    issues.push({ level: "ok", text: "All systems operational" });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-main)" }}>
        <div className="text-center">
          <Zap className="w-10 h-10 mx-auto mb-3 animate-pulse" style={{ color: "var(--accent-green)" }} />
          <p style={{ color: "var(--text-muted)", fontFamily: MONO }} className="text-sm">
            Loading FTM Commander...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--bg-main)", fontFamily: MONO }}
    >
      {/* ============================================================ */}
      {/* HEADER */}
      {/* ============================================================ */}
      <header
        className="sticky top-0 z-50 border-b"
        style={{ borderColor: "var(--border-color)", background: "var(--bg-main)" }}
      >
        <div className="max-w-[960px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-base font-bold text-white tracking-widest uppercase">
              FTM Commander
            </h1>
            <div
              className="w-2 h-2 rounded-full"
              style={{
                background: status?.status === "online" ? "#22c55e" : "#ef4444",
                boxShadow: status?.status === "online" ? "0 0 6px rgba(34,197,94,0.8)" : undefined,
              }}
            />
          </div>

          <div className="flex items-center gap-3">
            {lastUpdate && (
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                Updated {timeAgo(lastUpdate.toISOString())}
              </span>
            )}

            {/* Auto-trade toggle */}
            {botSettings && (
              <button
                onClick={() => updateSettings({ trading_enabled: !botSettings.trading_enabled })}
                className="flex items-center gap-2 px-3 py-1.5 rounded border text-xs transition-colors"
                style={
                  botSettings.trading_enabled
                    ? { background: "var(--accent-green-dim)", color: "var(--accent-green)", borderColor: "#166534" }
                    : { background: "var(--accent-red-dim)", color: "var(--accent-red)", borderColor: "rgba(127,29,29,0.5)" }
                }
              >
                <Power className="w-3.5 h-3.5" />
                <span className="uppercase font-semibold tracking-wider text-[10px]">
                  {botSettings.trading_enabled ? "Auto ON" : "Auto OFF"}
                </span>
              </button>
            )}

            {/* Kill switch */}
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs transition-colors"
              style={{ background: "var(--accent-red-dim)", color: "var(--accent-red)", borderColor: "rgba(127,29,29,0.5)" }}
              onClick={async () => {
                if (botSettings?.trading_enabled && confirm("Disable auto-trading?")) {
                  await updateSettings({ trading_enabled: false });
                }
              }}
            >
              <XCircle className="w-3.5 h-3.5" />
              <span className="uppercase font-semibold tracking-wider text-[10px]">Kill</span>
            </button>

            {/* Settings drawer toggle */}
            <button
              onClick={() => setSettingsOpen((o) => !o)}
              className="w-8 h-8 rounded flex items-center justify-center border transition-colors"
              style={{
                background: settingsOpen ? "var(--accent-green-dim)" : "var(--bg-panel)",
                borderColor: settingsOpen ? "#166534" : "var(--border-color)",
                color: settingsOpen ? "var(--accent-green)" : "var(--text-muted)",
              }}
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Settings drawer */}
        {settingsOpen && (
          <SettingsDrawer
            botSettings={botSettings}
            updateSettings={updateSettings}
            watchlist={watchlist}
            fetchAll={fetchAll}
            visibility={visibility}
            setVisibility={setVisibility}
          />
        )}
      </header>

      {/* ============================================================ */}
      {/* MAIN CONTENT */}
      {/* ============================================================ */}
      <main className="max-w-[960px] mx-auto px-4 py-6 space-y-6">
        {/* SECTION 1 — VALIDATION PROGRESS */}
        {visibility.validation && (
          <section
            className="rounded-lg border p-6"
            style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
          >
            <SectionHeader label="Validation Progress" />
            <div className="text-center mt-2">
              <div className="text-5xl font-bold text-white">
                {closedTrades}
                <span className="text-2xl" style={{ color: "var(--text-muted)" }}>
                  {" "}/ {VALIDATION_TARGET}
                </span>
              </div>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                {tradesRemaining > 0
                  ? `${tradesRemaining} trade${tradesRemaining === 1 ? "" : "s"} to go-live`
                  : "Validation complete!"}
              </p>

              {/* Progress bar */}
              <div className="mt-4 h-3 rounded-full mx-auto max-w-md" style={{ background: "var(--border-color)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${progressPct}%`,
                    background: progressPct >= 100 ? "var(--accent-green)" : "var(--accent-amber)",
                  }}
                />
              </div>

              {/* Win rate stats */}
              {metrics && (
                <div className="flex justify-center gap-8 mt-4 text-xs">
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Win Rate </span>
                    <span className="font-semibold text-white">{metrics.win_rate}%</span>
                  </div>
                  <div>
                    <span style={{ color: "var(--accent-green)" }}>W {metrics.wins}</span>
                  </div>
                  <div>
                    <span style={{ color: "var(--accent-red)" }}>L {metrics.losses}</span>
                  </div>
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>PF </span>
                    <span className="text-white">
                      {metrics.profit_factor === Infinity ? "INF" : metrics.profit_factor.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* SECTION 2 — OPEN POSITIONS */}
        {visibility.positions && (
          <section
            className="rounded-lg border"
            style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
          >
            <div className="px-5 pt-5 pb-3">
              <SectionHeader label={`Open Positions (${positions.length})`} />
            </div>

            {positions.length === 0 ? (
              <div className="px-5 pb-5 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                No open positions. Scanner is actively looking for patterns.
              </div>
            ) : (
              <div>
                {positions.map((p) => (
                  <PositionRow key={p.symbol} position={p} />
                ))}

                {/* Total unrealized P&L */}
                <div
                  className="px-5 py-3 border-t flex justify-between items-center text-xs"
                  style={{ borderColor: "var(--border-color)" }}
                >
                  <span style={{ color: "var(--text-muted)" }}>Total Unrealized P&L</span>
                  <span
                    className="font-semibold text-sm"
                    style={{ color: totalUnrealizedPl >= 0 ? "var(--accent-green)" : "var(--accent-red)" }}
                  >
                    {totalUnrealizedPl >= 0 ? "+" : ""}
                    {formatUsd(totalUnrealizedPl)}
                  </span>
                </div>
              </div>
            )}
          </section>
        )}

        {/* SECTION 3 — APPROACHING ENTRY */}
        {visibility.approaching && (
          <section
            className="rounded-lg border"
            style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
          >
            <div className="px-5 pt-5 pb-3 flex items-center justify-between">
              <SectionHeader label="Approaching Entry" />
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                {signals.length} total signals tracked
              </span>
            </div>

            {imminentSignals.length === 0 ? (
              <div className="px-5 pb-5 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                No signals within 5% of entry.
                {approaching.length > 0 && ` ${approaching.length} signal${approaching.length === 1 ? "" : "s"} tracking further out.`}
              </div>
            ) : (
              <div>
                {imminentSignals.map((s) => {
                  const isCrypto = s.symbol.includes("/");
                  const isCryptoShort = isCrypto && s.direction === "short";
                  const insufficientBp = account && equity > 0 && buyingPower < equity * 0.03;
                  const blocked = isCryptoShort
                    ? "Crypto shorts unsupported"
                    : insufficientBp
                    ? "Insufficient buying power"
                    : null;

                  return (
                    <div
                      key={s.id}
                      className="px-5 py-3 border-t flex items-center justify-between text-xs"
                      style={{ borderColor: "var(--border-color)" }}
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-white">{s.symbol}</span>
                        <SideBadge direction={s.direction} />
                        <span style={{ color: "var(--accent-amber)" }}>{s.pattern}</span>
                        <span style={{ color: "var(--text-muted)" }}>{s.timeframe}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span style={{ color: "var(--text-muted)" }}>D: {formatUsd(s.projectedD)}</span>
                        {blocked ? (
                          <span
                            className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase"
                            style={{ background: "var(--accent-red-dim)", color: "var(--accent-red)" }}
                          >
                            Blocked: {blocked}
                          </span>
                        ) : (
                          <span
                            className="px-2 py-0.5 rounded text-[10px] font-semibold"
                            style={{
                              background: s.distancePct < 2 ? "var(--accent-red-dim)" : "var(--accent-green-dim)",
                              color: s.distancePct < 2 ? "var(--accent-red)" : "var(--accent-green)",
                            }}
                          >
                            {s.distancePct.toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* SECTION 4 — CAPITAL ALLOCATION */}
        {visibility.capital && account && (
          <section
            className="rounded-lg border p-5"
            style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
          >
            <SectionHeader label="Capital Allocation" />
            <div className="grid grid-cols-3 gap-4 mt-3">
              <div>
                <div className="text-[10px] uppercase" style={{ color: "var(--text-muted)" }}>Equity</div>
                <div className="text-sm font-semibold text-white">{formatUsd(equity)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase" style={{ color: "var(--text-muted)" }}>Buying Power</div>
                <div className="text-sm font-semibold text-white">{formatUsd(buyingPower)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase" style={{ color: "var(--text-muted)" }}>Cash</div>
                <div className="text-sm font-semibold text-white">
                  {formatUsd(account.cash ?? account.buying_power)}
                </div>
              </div>
            </div>

            {/* Locked % bar */}
            <div className="mt-4">
              <div className="flex justify-between text-[10px] mb-1">
                <span style={{ color: "var(--text-muted)" }}>% Locked by GTC Orders</span>
                <span
                  className="font-semibold"
                  style={{
                    color:
                      lockedPct > 80
                        ? "var(--accent-red)"
                        : lockedPct > 50
                        ? "var(--accent-amber)"
                        : "var(--accent-green)",
                  }}
                >
                  {lockedPct.toFixed(1)}%
                </span>
              </div>
              <div className="h-2 rounded-full" style={{ background: "var(--border-color)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(lockedPct, 100)}%`,
                    background:
                      lockedPct > 80
                        ? "var(--accent-red)"
                        : lockedPct > 50
                        ? "var(--accent-amber)"
                        : "var(--accent-green)",
                  }}
                />
              </div>
            </div>
          </section>
        )}

        {/* SECTION 5 — SYSTEM ISSUES */}
        {visibility.issues && (
          <section
            className="rounded-lg border p-5"
            style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
          >
            <SectionHeader label="System Issues" />
            <div className="mt-3 space-y-2">
              {issues.map((issue, i) => (
                <div key={i} className="flex items-center gap-3 text-xs">
                  {issue.level === "fix" && (
                    <span
                      className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase"
                      style={{ background: "var(--accent-red-dim)", color: "var(--accent-red)" }}
                    >
                      FIX
                    </span>
                  )}
                  {issue.level === "warn" && (
                    <span
                      className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase"
                      style={{ background: "rgba(205,166,97,0.15)", color: "var(--accent-amber)" }}
                    >
                      WARN
                    </span>
                  )}
                  {issue.level === "ok" && (
                    <span
                      className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase"
                      style={{ background: "var(--accent-green-dim)", color: "var(--accent-green)" }}
                    >
                      OK
                    </span>
                  )}
                  <span style={{ color: "var(--text-main)" }}>{issue.text}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* SECTION 6 — TRADE HISTORY */}
        {visibility.history && (
          <section
            className="rounded-lg border"
            style={{ background: "var(--bg-panel)", borderColor: "var(--border-color)" }}
          >
            <div className="px-5 pt-5 pb-3">
              <SectionHeader label={`Trade History (last ${Math.min(history.length, 10)})`} />
            </div>

            {history.length === 0 ? (
              <div className="px-5 pb-5 text-center text-xs" style={{ color: "var(--text-muted)" }}>
                No trade history yet
              </div>
            ) : (
              <div>
                {/* Header row */}
                <div
                  className="grid grid-cols-5 gap-3 px-5 py-2 text-[9px] uppercase tracking-wider border-t"
                  style={{ borderColor: "var(--border-color)", color: "var(--text-muted)" }}
                >
                  <div>Symbol</div>
                  <div>Side</div>
                  <div>Pattern</div>
                  <div className="text-right">Date</div>
                  <div className="text-right">Fill Price</div>
                </div>

                {history.slice(0, 10).map((t, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-5 gap-3 px-5 py-2.5 border-t text-xs items-center"
                    style={{ borderColor: "var(--border-color)" }}
                  >
                    <div className="font-semibold text-white">{t.symbol}</div>
                    <div>
                      <SideBadge direction={t.direction} />
                    </div>
                    <div style={{ color: "var(--accent-amber)" }}>{t.pattern}</div>
                    <div className="text-right" style={{ color: "var(--text-muted)" }}>
                      {new Date(t.filled_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </div>
                    <div className="text-right text-white">
                      {formatUsd(t.filled_price)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function SectionHeader({ label }: { label: string }) {
  return (
    <h2
      className="text-[10px] font-semibold uppercase tracking-widest"
      style={{ color: "var(--text-muted)" }}
    >
      {label}
    </h2>
  );
}

function SideBadge({ direction }: { direction: string }) {
  const isLong = direction === "long";
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] uppercase font-semibold"
      style={{
        background: isLong ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
        color: isLong ? "var(--accent-green)" : "var(--accent-red)",
      }}
    >
      {direction}
    </span>
  );
}

/** Visual pipeline: SL ----[entry]----[current]----[TP1]----[TP2] */
function PositionRow({ position: p }: { position: Position }) {
  const sl = p.stop_loss ?? p.entry_price * (p.side === "long" ? 0.95 : 1.05);
  const tp2 = p.tp2 ?? p.entry_price * (p.side === "long" ? 1.1 : 0.9);
  const tp1 = p.tp1 ?? (p.entry_price + tp2) / 2;

  // Normalize all prices into 0-100% range between SL and TP2
  const range = Math.abs(tp2 - sl) || 1;
  const normalize = (price: number) => {
    if (p.side === "long") return ((price - sl) / range) * 100;
    return ((sl - price) / range) * 100;
  };

  const entryPct = Math.max(0, Math.min(100, normalize(p.entry_price)));
  const currentPct = Math.max(0, Math.min(100, normalize(p.current_price)));
  const tp1Pct = Math.max(0, Math.min(100, normalize(tp1)));
  const isProfitable = p.unrealized_pl >= 0;

  return (
    <div
      className="px-5 py-4 border-t"
      style={{ borderColor: "var(--border-color)" }}
    >
      {/* Row 1: symbol, side, pattern, P&L */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-white text-sm">{p.symbol}</span>
          <SideBadge direction={p.side} />
          {p.pattern && (
            <span className="text-[10px]" style={{ color: "var(--accent-amber)" }}>
              {p.pattern}
            </span>
          )}
        </div>
        <div className="text-right">
          <span
            className="text-sm font-semibold"
            style={{ color: isProfitable ? "var(--accent-green)" : "var(--accent-red)" }}
          >
            {isProfitable ? "+" : ""}
            {formatUsd(p.unrealized_pl)}
          </span>
          <span
            className="text-[10px] ml-2"
            style={{ color: isProfitable ? "var(--accent-green)" : "var(--accent-red)" }}
          >
            ({isProfitable ? "+" : ""}
            {p.unrealized_pl_pct.toFixed(2)}%)
          </span>
        </div>
      </div>

      {/* Row 2: pipeline bar */}
      <div className="relative h-5 rounded-full overflow-hidden" style={{ background: "var(--border-color)" }}>
        {/* Red zone (SL side) */}
        <div
          className="absolute left-0 top-0 h-full rounded-l-full"
          style={{
            width: `${entryPct}%`,
            background: "linear-gradient(90deg, rgba(222,107,107,0.25) 0%, rgba(222,107,107,0.05) 100%)",
          }}
        />
        {/* Green zone (TP side) */}
        <div
          className="absolute top-0 h-full rounded-r-full"
          style={{
            left: `${entryPct}%`,
            width: `${100 - entryPct}%`,
            background: "linear-gradient(90deg, rgba(103,194,152,0.05) 0%, rgba(103,194,152,0.25) 100%)",
          }}
        />

        {/* Entry marker */}
        <div
          className="absolute top-0 h-full w-0.5"
          style={{ left: `${entryPct}%`, background: "var(--text-muted)" }}
          title={`Entry: ${formatUsd(p.entry_price)}`}
        />
        {/* TP1 marker */}
        <div
          className="absolute top-0 h-full w-0.5 opacity-60"
          style={{ left: `${tp1Pct}%`, background: "var(--accent-green)" }}
          title={`TP1: ${formatUsd(tp1)}`}
        />
        {/* TP2 marker */}
        <div
          className="absolute top-0 h-full w-0.5 opacity-60"
          style={{ left: "99%", background: "var(--accent-green)" }}
          title={`TP2: ${formatUsd(tp2)}`}
        />
        {/* Current price dot */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2"
          style={{
            left: `calc(${currentPct}% - 6px)`,
            background: isProfitable ? "var(--accent-green)" : "var(--accent-red)",
            borderColor: "var(--bg-panel)",
          }}
          title={`Current: ${formatUsd(p.current_price)}`}
        />
      </div>

      {/* Row 2 labels */}
      <div className="flex justify-between mt-1 text-[9px]" style={{ color: "var(--text-muted)" }}>
        <span>SL {p.stop_loss ? formatUsd(p.stop_loss) : "—"}</span>
        <span>Entry {formatUsd(p.entry_price)}</span>
        <span>TP1 {p.tp1 ? formatUsd(p.tp1) : "—"}</span>
        <span>TP2 {p.tp2 ? formatUsd(p.tp2) : "—"}</span>
      </div>

      {/* Row 3: stats */}
      <div className="flex gap-6 mt-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
        <span>Qty: <span className="text-white">{p.qty.toFixed(4)}</span></span>
        <span>Mkt Val: <span className="text-white">{formatUsd(p.market_value)}</span></span>
        <span>Price: <span className="text-white">{formatUsd(p.current_price)}</span></span>
      </div>
    </div>
  );
}

function SettingsDrawer({
  botSettings,
  updateSettings,
  watchlist,
  fetchAll,
  visibility,
  setVisibility,
}: {
  botSettings: BotSettings | null;
  updateSettings: (patch: Partial<BotSettings>) => Promise<void>;
  watchlist: WatchlistItem[];
  fetchAll: () => Promise<void>;
  visibility: SectionVisibility;
  setVisibility: React.Dispatch<React.SetStateAction<SectionVisibility>>;
}) {
  const [newSymbol, setNewSymbol] = useState("");
  const addSymbol = async () => {
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
    } catch {}
  };
  const removeSymbol = async (sym: string) => {
    try {
      await fetch(`/api/watchlist/${encodeURIComponent(sym)}`, { method: "DELETE" });
      fetchAll();
    } catch {}
  };

  const sectionNames: { key: keyof SectionVisibility; label: string }[] = [
    { key: "validation", label: "Validation Progress" },
    { key: "positions", label: "Open Positions" },
    { key: "approaching", label: "Approaching Entry" },
    { key: "capital", label: "Capital Allocation" },
    { key: "issues", label: "System Issues" },
    { key: "history", label: "Trade History" },
  ];

  return (
    <div
      className="border-t max-w-[960px] mx-auto px-4 py-5 space-y-5"
      style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
    >
      {/* Widget visibility toggles */}
      <div>
        <h3 className="text-[10px] uppercase tracking-widest font-semibold mb-3" style={{ color: "var(--text-muted)" }}>
          Widget Visibility
        </h3>
        <div className="flex flex-wrap gap-2">
          {sectionNames.map(({ key, label }) => {
            const visible = visibility[key];
            return (
              <button
                key={key}
                onClick={() => setVisibility((prev) => ({ ...prev, [key]: !prev[key] }))}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] transition-colors"
                style={
                  visible
                    ? { background: "var(--accent-green-dim)", color: "var(--accent-green)", borderColor: "#166534" }
                    : { background: "var(--bg-main)", color: "var(--text-muted)", borderColor: "var(--border-color)" }
                }
              >
                {visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Pattern toggles */}
      <div>
        <h3 className="text-[10px] uppercase tracking-widest font-semibold mb-3" style={{ color: "var(--text-muted)" }}>
          Pattern Toggles
        </h3>
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
                style={
                  isEnabled
                    ? { background: "var(--accent-green-dim)", color: "var(--accent-green)", borderColor: "#166534" }
                    : { background: "var(--bg-main)", color: "var(--text-muted)", borderColor: "var(--border-color)" }
                }
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      {/* Position sizing sliders */}
      {botSettings && (
        <div>
          <h3 className="text-[10px] uppercase tracking-widest font-semibold mb-3" style={{ color: "var(--text-muted)" }}>
            Position Sizing
          </h3>
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-xs">
              <span style={{ color: "var(--text-muted)" }} className="w-14">Stock</span>
              <input
                type="range"
                min="1"
                max="20"
                value={Math.round(botSettings.equity_allocation * 100)}
                onChange={(e) => updateSettings({ equity_allocation: Number(e.target.value) / 100 })}
                className="flex-1 h-1.5"
                style={{ accentColor: "var(--accent-green)" }}
              />
              <span className="font-medium text-white w-10 text-right">
                {Math.round(botSettings.equity_allocation * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span style={{ color: "var(--text-muted)" }} className="w-14">Crypto</span>
              <input
                type="range"
                min="1"
                max="20"
                value={Math.round(botSettings.crypto_allocation * 100)}
                onChange={(e) => updateSettings({ crypto_allocation: Number(e.target.value) / 100 })}
                className="flex-1 h-1.5"
                style={{ accentColor: "var(--accent-amber)" }}
              />
              <span className="font-medium text-white w-10 text-right">
                {Math.round(botSettings.crypto_allocation * 100)}%
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Watchlist manager */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: "var(--text-muted)" }}>
            Watchlist
          </h3>
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            {watchlist.length} symbols
          </span>
        </div>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSymbol()}
            placeholder="Add symbol (e.g. NVDA, SOL/USD)"
            className="flex-1 rounded px-3 py-2 text-xs focus:outline-none"
            style={{
              background: "var(--bg-main)",
              border: "1px solid var(--border-color)",
              color: "var(--text-main)",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={addSymbol}
            className="rounded px-3 py-2 text-xs font-medium flex items-center gap-1 transition-colors"
            style={{ background: "rgba(205,166,97,0.1)", color: "var(--accent-amber)", border: "1px solid rgba(205,166,97,0.2)" }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
        {watchlist.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {watchlist.map((w) => (
              <div
                key={w.symbol}
                className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[10px] border"
                style={{ background: "var(--bg-main)", borderColor: "var(--border-color)" }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: w.assetClass === "crypto" ? "var(--accent-amber)" : "var(--accent-green)" }}
                />
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
  );
}
