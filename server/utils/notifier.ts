/**
 * Discord Notification Engine — Visual Command Center
 * Eliminates silent failures by pushing alerts to Discord via webhook.
 *
 * Three notification types:
 *   1. System Boot   — confirms bot is alive and DB connected
 *   2. Error Alert   — immediate red alert on Alpaca/system failures
 *   3. Phase C Signal — clickable TradingView deep-link for visual verification
 */

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// TradingView interval mapping: our timeframes -> TV format
const TV_INTERVAL_MAP: Record<string, string> = {
  "1D": "D",
  "4H": "240",
};

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
}

async function sendWebhook(
  content: string,
  embeds: DiscordEmbed[],
): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn(
      "[Notifier] DISCORD_WEBHOOK_URL not set — skipping notification",
    );
    return;
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Pattern Bot",
      content,
      embeds,
    }),
  });

  if (!res.ok) {
    // Log but never throw — notifications must not crash the trading engine
    // (CLAUDE.md Rule #4: Decoupled Architecture)
    console.error(
      `[Notifier] Discord webhook failed: ${res.status} ${res.statusText}`,
    );
  }
}

/**
 * Green alert: Bot is online and database is connected.
 */
export async function sendSystemBoot(): Promise<void> {
  await sendWebhook("", [
    {
      title: "🟢 Pattern Bot Online",
      description:
        "System booted successfully. Database connected. Scanners active.",
      color: 0x00ff00,
      timestamp: new Date().toISOString(),
    },
  ]);
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
      ? error.stack.slice(0, 1000)
      : "No stack trace";

  await sendWebhook("", [
    {
      title: "🔴 Pattern Bot Error",
      description: `**Context:** ${context}`,
      color: 0xff0000,
      fields: [
        {
          name: "Error",
          value: `\`\`\`${errorMessage}\`\`\``,
          inline: false,
        },
        {
          name: "Stack",
          value: `\`\`\`${errorStack}\`\`\``,
          inline: false,
        },
      ],
      timestamp: new Date().toISOString(),
    },
  ]);
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

  await sendWebhook("", [
    {
      title: `${directionEmoji} Phase C Signal: ${symbol}`,
      description: `**${pattern}** detected on **${timeframe}** — [Open in TradingView](${tvUrl})`,
      color: direction === "long" ? 0x00ff00 : 0xff0000,
      fields: [
        { name: "Pattern", value: pattern, inline: true },
        { name: "Direction", value: direction.toUpperCase(), inline: true },
        { name: "Timeframe", value: timeframe, inline: true },
        {
          name: "Limit Price",
          value: `$${limitPrice.toLocaleString()}`,
          inline: true,
        },
        {
          name: "TradingView",
          value: `[Click to View Chart](${tvUrl})`,
          inline: false,
        },
      ],
      timestamp: new Date().toISOString(),
    },
  ]);
}
