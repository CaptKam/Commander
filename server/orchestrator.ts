/**
 * Orchestrator — The Unkillable Scanner Loop
 * Central brain that ties FMP data, harmonic detection, Phase C screening,
 * and Alpaca execution into a single resilient loop.
 *
 * Key safety feature: Mutex lock prevents overlapping scans. If FMP takes
 * 40 seconds and the 30-second interval fires again, it skips gracefully
 * instead of stacking requests until Node.js OOMs.
 */

import { sendSystemBoot, sendError } from "./utils/notifier";

// ============================================================
// Scan interval and heartbeat configuration
// ============================================================
const SCAN_INTERVAL_MS = 30_000; // 30 seconds between scans
const HEARTBEAT_EVERY_N_SCANS = 10; // Log heartbeat every 10th cycle (~5 min)

// ============================================================
// State lock — prevents overlapping scans (CLAUDE.md Rule #2)
// This is the ONLY permitted in-memory state. It is ephemeral
// by nature (resets on restart) and does not represent trade data.
// ============================================================
let isScanning = false;
let scanCount = 0;
let scanIntervalId: ReturnType<typeof setInterval> | null = null;

// ============================================================
// The Scan Cycle — mutex-guarded, never overlaps
// ============================================================
async function runScanCycle(): Promise<void> {
  if (isScanning) {
    console.warn(
      "[Orchestrator] Scan already in progress — skipping this interval",
    );
    return;
  }

  isScanning = true;
  const cycleStart = Date.now();

  try {
    scanCount++;

    // ---- Heartbeat: every 10th scan (~5 min at 30s intervals) ----
    if (scanCount % HEARTBEAT_EVERY_N_SCANS === 0) {
      console.log(
        `[Orchestrator] 💓 Heartbeat: ${scanCount} scans completed. ` +
          `Engine is alive. ${new Date().toISOString()}`,
      );
    }

    // ============================================================
    // PIPELINE STUBS — wire these as each module comes online
    // ============================================================

    // Step 1: Fetch candle data from FMP
    // TODO: const candles = await fetchFmpData(watchlist, ["1D", "4H"]);

    // Step 2: Run harmonic pattern detection on candle data
    // TODO: const candidates = detectHarmonics(candles);

    // Step 3: Filter through Phase C screener (kills Crab/Deep Crab, fires Discord alerts)
    // TODO: const validSignals = await processPhaseCSignals(candidates);

    // Step 4: For each valid signal, save to DB and place Alpaca limit order
    // TODO: for (const signal of validSignals) {
    //   const parsed = insertLiveSignalSchema.parse({ ... });
    //   await db.insert(liveSignals).values(parsed);
    //   await placePhaseCLimitOrder(signal, equity, isCrypto);
    // }

    const elapsed = Date.now() - cycleStart;
    console.log(`[Orchestrator] Scan #${scanCount} complete (${elapsed}ms)`);
  } catch (err) {
    console.error("[Orchestrator] Scan cycle failed:", err);
    // Fire Discord alert — but don't let a notification failure crash the loop
    sendError(`Scan cycle #${scanCount} failed`, err).catch(() => {
      console.error("[Orchestrator] Failed to send error notification");
    });
  } finally {
    // ALWAYS release the lock, even if the scan threw
    isScanning = false;
  }
}

// ============================================================
// Boot Sequence — the single entry point for the entire bot
// ============================================================
export async function startEngine(): Promise<void> {
  console.log("[Orchestrator] Booting Pattern Bot engine...");

  // Fire the green "online" Discord embed
  try {
    await sendSystemBoot();
  } catch (err) {
    // Boot notification failure is non-fatal — keep going
    console.error("[Orchestrator] Failed to send boot notification:", err);
  }

  // Run the first scan immediately (don't wait 30s)
  await runScanCycle();

  // Start the interval loop
  scanIntervalId = setInterval(() => {
    runScanCycle();
  }, SCAN_INTERVAL_MS);

  console.log(
    `[Orchestrator] Scanner loop started: every ${SCAN_INTERVAL_MS / 1000}s. ` +
      `Heartbeat every ${HEARTBEAT_EVERY_N_SCANS} scans.`,
  );
}

/**
 * Graceful shutdown — clears the interval so Node.js can exit cleanly.
 */
export function stopEngine(): void {
  if (scanIntervalId !== null) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
    console.log("[Orchestrator] Scanner loop stopped.");
  }
}
