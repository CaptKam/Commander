import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Wallet,
  DollarSign,
  Zap,
  CircleDot,
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
  status: string;
  createdAt: string;
}

interface Status {
  status: string;
  uptime: number;
}

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
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [acctRes, posRes, sigRes, statRes] = await Promise.allSettled([
        fetch("/api/account").then((r) => r.json()),
        fetch("/api/positions").then((r) => r.json()),
        fetch("/api/signals").then((r) => r.json()),
        fetch("/api/status").then((r) => r.json()),
      ]);
      if (acctRes.status === "fulfilled") setAccount(acctRes.value);
      if (posRes.status === "fulfilled" && Array.isArray(posRes.value))
        setPositions(posRes.value);
      if (sigRes.status === "fulfilled" && Array.isArray(sigRes.value))
        setSignals(sigRes.value);
      if (statRes.status === "fulfilled") setStatus(statRes.value);
    } catch {
      // silent — dashboard will show stale data
    } finally {
      setLoading(false);
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

        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
      </header>

      {/* ==================== BODY: TWO COLUMNS ==================== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* LEFT: Positions */}
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
                    <th className="text-right px-4 py-2">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr
                      key={p.symbol}
                      className="border-b border-gray-800/50 hover:bg-gray-800/40"
                    >
                      <td className="px-4 py-2.5 font-medium">{p.symbol}</td>
                      <td className="px-4 py-2.5 text-right text-gray-300">
                        {p.qty}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-300">
                        {formatUsd(p.entry_price)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-300">
                        {formatUsd(p.current_price)}
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
