/**
 * Telegram Notification Engine — Visual Command Center
 * Eliminates silent failures by pushing alerts to Telegram via Bot API.
 *
 * Three notification types:
 *   1. System Boot   — confirms bot is alive and DB connected
 *   2. Error Alert   — immediate red alert on Alpaca/system failures
 *   3. Phase C Signal — clickable TradingView deep-link for visual verification
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// TradingView interval mapping: our timeframes -> TV format
const TV_INTERVAL_MAP: Record<string, string> = {
  "1D": "D",
  "4H": "240",
};

/**
 * Sends an HTML-formatted message to Telegram.
 * Logs but never throws — notifications must not crash the trading engine.
 * (CLAUDE.md Rule #4: Decoupled Architecture)
 */
async function sendTelegram(html: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn(
      "[Notifier] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping",
    );
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[Notifier] Telegram send failed: ${res.status} — ${body}`);
  }
}

/**
 * Escapes special HTML characters for Telegram's HTML parse mode.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Green alert: Bot is online and database is connected.
 */
export async function sendSystemBoot(): Promise<void> {
  await sendTelegram(
    `🟢 <b>Pattern Bot Online</b>\n\n` +
      `System booted successfully.\n` +
      `Database connected. Scanners active.\n` +
      `<i>${new Date().toISOString()}</i>`,
  );
}

/**
 * Red alert: Something failed (Alpaca rejection, DB error, etc.)
 */
export async function sendError(
  context: string,
  error: unknown,
): Promise<void> {
  const errorMessage =
    error instanceof Error ? error.message : String(error);
  const errorStack =
    error instanceof Error && error.stack
      ? error.stack.slice(0, 800)
      : "No stack trace";

  await sendTelegram(
    `🔴 <b>Pattern Bot Error</b>\n\n` +
      `<b>Context:</b> ${escapeHtml(context)}\n\n` +
      `<b>Error:</b>\n<code>${escapeHtml(errorMessage)}</code>\n\n` +
      `<b>Stack:</b>\n<code>${escapeHtml(errorStack)}</code>\n\n` +
      `<i>${new Date().toISOString()}</i>`,
  );
}

/**
 * Phase C forming pattern alert with clickable TradingView deep-link.
 */
export async function sendPhaseCSignal(
  symbol: string,
  timeframe: string,
  pattern: string,
  direction: string,
  limitPrice: number,
): Promise<void> {
  const tvInterval = TV_INTERVAL_MAP[timeframe] ?? "D";
  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}&interval=${tvInterval}`;
  const directionEmoji = direction === "long" ? "🟢" : "🔴";

  await sendTelegram(
    `${directionEmoji} <b>Phase C Signal: ${escapeHtml(symbol)}</b>\n\n` +
      `<b>Pattern:</b> ${escapeHtml(pattern)}\n` +
      `<b>Direction:</b> ${direction.toUpperCase()}\n` +
      `<b>Timeframe:</b> ${timeframe}\n` +
      `<b>Limit Price:</b> $${limitPrice.toLocaleString()}\n\n` +
      `📊 <a href="${tvUrl}">Open in TradingView</a>\n\n` +
      `<i>${new Date().toISOString()}</i>`,
  );
}
