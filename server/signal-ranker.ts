/**
 * Signal Ranker — Scores and ranks competing patterns per symbol
 *
 * When multiple patterns qualify on the same symbol, this module
 * picks the single best trade. Scoring is based on:
 *   1. Backtest win rate by pattern type (40% weight)
 *   2. Fibonacci ratio precision (25% weight)
 *   3. Risk-to-reward ratio (20% weight)
 *   4. Timeframe reliability (10% weight)
 *   5. Profit target magnitude (5% weight)
 *
 * Only the #1 ranked signal per symbol gets an order placed.
 * Others are logged as "outranked" for analysis.
 */

import type { PhaseCSignal, HarmonicPattern, Timeframe } from "./screener";
import { calcRetrace } from "./harmonics";

// ============================================================
// Backtest win rates (static, from 25,222 trade backtest)
// ============================================================
const PATTERN_WIN_RATES: Record<HarmonicPattern, number> = {
  Gartley: 0.85,
  Bat: 0.85,
  "Alt Bat": 0.72,
  Butterfly: 0.75,
  ABCD: 0.70,
};

const TIMEFRAME_RELIABILITY: Record<Timeframe, number> = {
  "1D": 1.0,  // Daily patterns are most reliable
  "4H": 0.85, // 4H patterns are slightly less reliable
};

// ============================================================
// Ideal Fibonacci ratios (mirrors quality-filters.ts)
// ============================================================
const IDEAL_RATIOS: Record<HarmonicPattern, { xb: number; xd: number }> = {
  Gartley:   { xb: 0.618, xd: 0.786 },
  Bat:       { xb: 0.441, xd: 0.886 },
  "Alt Bat": { xb: 0.382, xd: 1.130 },
  Butterfly: { xb: 0.786, xd: 1.445 },
  ABCD:      { xb: 0.618, xd: 1.000 },
};

// ============================================================
// Scored signal type
// ============================================================
export interface ScoredSignal {
  signal: PhaseCSignal;
  score: number;           // 0-100 composite score
  breakdown: {
    winRateScore: number;  // 0-100 from backtest WR
    fibScore: number;      // 0-100 from ratio precision (100 = perfect ratios)
    rrScore: number;       // 0-100 from R:R (capped at 5:1 = 100)
    tfScore: number;       // 0-100 from timeframe reliability
    profitScore: number;   // 0-100 from profit target % (capped at 10% = 100)
  };
  rank: number;            // 1 = best for this symbol, 2 = second best, etc.
  outrankedBy: string | null; // null if rank 1, otherwise description of winner
}

// ============================================================
// Score a single signal
// ============================================================
export function scoreSignal(signal: PhaseCSignal): ScoredSignal {
  // 1. Win rate score (40% weight)
  const wr = PATTERN_WIN_RATES[signal.pattern] ?? 0.70;
  const winRateScore = wr * 100;

  // 2. Fibonacci precision score (25% weight)
  const xbRatio = calcRetrace(signal.xPrice, signal.aPrice, signal.bPrice);
  const xdRatio = calcRetrace(signal.xPrice, signal.aPrice, signal.projectedD);
  const ideal = IDEAL_RATIOS[signal.pattern];

  let fibScore: number;
  if (signal.pattern === "ABCD") {
    const xbDev = Math.abs(xbRatio - ideal.xb) / ideal.xb;
    fibScore = Math.max(0, 100 - xbDev * 500); // 0% dev = 100, 20% dev = 0
  } else {
    const xbDev = Math.abs(xbRatio - ideal.xb) / ideal.xb;
    const xdDev = Math.abs(xdRatio - ideal.xd) / ideal.xd;
    const avgDev = (xbDev + xdDev) / 2;
    fibScore = Math.max(0, 100 - avgDev * 500);
  }

  // 3. R:R score (20% weight)
  const reward = Math.abs(signal.tp1Price - signal.limitPrice);
  const risk = Math.abs(signal.limitPrice - signal.stopLossPrice);
  const rr = risk > 0 ? reward / risk : 0;
  const rrScore = Math.min(100, (rr / 5) * 100); // 5:1 R:R = 100, 2.5:1 = 50

  // 4. Timeframe score (10% weight)
  const tfReliability = TIMEFRAME_RELIABILITY[signal.timeframe] ?? 0.85;
  const tfScore = tfReliability * 100;

  // 5. Profit target score (5% weight)
  const profitPct =
    (Math.abs(signal.tp1Price - signal.limitPrice) / signal.limitPrice) * 100;
  const profitScore = Math.min(100, (profitPct / 10) * 100); // 10%+ target = 100

  // Composite score
  const score =
    winRateScore * 0.40 +
    fibScore * 0.25 +
    rrScore * 0.20 +
    tfScore * 0.10 +
    profitScore * 0.05;

  return {
    signal,
    score,
    breakdown: { winRateScore, fibScore, rrScore, tfScore, profitScore },
    rank: 0,           // assigned by rankSignals()
    outrankedBy: null,  // assigned by rankSignals()
  };
}

// ============================================================
// Rank all signals — assign rank per symbol group
// ============================================================
export function rankSignals(signals: PhaseCSignal[]): ScoredSignal[] {
  // Group by symbol
  const groups = new Map<string, PhaseCSignal[]>();
  for (const s of signals) {
    const group = groups.get(s.symbol);
    if (group) {
      group.push(s);
    } else {
      groups.set(s.symbol, [s]);
    }
  }

  const allScored: ScoredSignal[] = [];

  for (const [, group] of groups) {
    // Score every signal in this group
    const scored = group.map((s) => scoreSignal(s));
    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    const winner = scored[0];
    for (let i = 0; i < scored.length; i++) {
      scored[i].rank = i + 1;
      if (i > 0) {
        scored[i].outrankedBy =
          `Outranked by ${winner.signal.pattern} ${winner.signal.timeframe} ` +
          `${winner.signal.direction.toUpperCase()} (score ${winner.score.toFixed(1)} vs ${scored[i].score.toFixed(1)})`;
      }
    }

    allScored.push(...scored);
  }

  // Sort final array by symbol then rank
  allScored.sort((a, b) => {
    const symCmp = a.signal.symbol.localeCompare(b.signal.symbol);
    if (symCmp !== 0) return symCmp;
    return a.rank - b.rank;
  });

  return allScored;
}

// ============================================================
// Select best signals — returns winners + outranked for logging
// ============================================================
export function selectBestSignals(signals: PhaseCSignal[]): {
  selected: ScoredSignal[];
  outranked: ScoredSignal[];
} {
  if (signals.length === 0) {
    return { selected: [], outranked: [] };
  }

  const allScored = rankSignals(signals);
  const selected: ScoredSignal[] = [];
  const outranked: ScoredSignal[] = [];

  // Group scored signals by symbol for logging
  const symbolGroups = new Map<string, ScoredSignal[]>();
  for (const s of allScored) {
    const group = symbolGroups.get(s.signal.symbol);
    if (group) {
      group.push(s);
    } else {
      symbolGroups.set(s.signal.symbol, [s]);
    }
  }

  for (const [symbol, group] of symbolGroups) {
    const winner = group[0]; // rank 1
    selected.push(winner);

    if (group.length === 1) {
      console.log(
        `[Ranker] ${symbol}: Selected ${winner.signal.pattern} ${winner.signal.timeframe} ` +
        `${winner.signal.direction.toUpperCase()} (score ${winner.score.toFixed(1)}) — only candidate`,
      );
    } else {
      console.log(
        `[Ranker] ${symbol}: Selected ${winner.signal.pattern} ${winner.signal.timeframe} ` +
        `${winner.signal.direction.toUpperCase()} (score ${winner.score.toFixed(1)}) over ${group.length - 1} alternatives`,
      );
      for (let i = 1; i < group.length; i++) {
        const s = group[i];
        console.log(
          `[Ranker]   #${s.rank} ${s.signal.pattern} ${s.signal.timeframe} ` +
          `${s.signal.direction.toUpperCase()} (${s.score.toFixed(1)}) — outranked`,
        );
        outranked.push(s);
      }
    }
  }

  console.log(
    `[Ranker] Selected ${selected.length} best signals from ${signals.length} candidates across ${symbolGroups.size} symbols`,
  );

  return { selected, outranked };
}
