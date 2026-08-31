import type { AnalyticsEventName, RuntimeEnv } from "./env";
import { sanitizeDimension } from "./security";

export type TelemetryEvent = {
  event: AnalyticsEventName;
  route: string;
  channel?: string;
  partner?: string;
  success?: boolean;
  reason?: string;
  requestId?: string;
  grossUsd?: number;
  browserMs?: number;
  storageBytes?: number;
  variableCostUsd?: number;
  contributionMarginUsd?: number;
};

export async function recordEvent(env: RuntimeEnv, event: TelemetryEvent): Promise<void> {
  try {
    await env.ANALYTICS_DB.prepare(`
      INSERT INTO telemetry_events (
        app_version, event, route, channel, partner, success, reason, network,
        event_count, gross_usd, browser_ms, storage_bytes, variable_cost_usd, contribution_margin_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).bind(
      env.APP_VERSION,
      event.event,
      event.route,
      sanitizeDimension(event.channel, "direct"),
      sanitizeDimension(event.partner, "none"),
      event.success === undefined ? "unknown" : String(event.success),
      sanitizeDimension(event.reason, "none"),
      env.NETWORK,
      event.grossUsd ?? 0,
      event.browserMs ?? 0,
      event.storageBytes ?? 0,
      event.variableCostUsd ?? 0,
      event.contributionMarginUsd ?? 0,
    ).run();
  } catch (error) {
    console.error(JSON.stringify({ event: "analytics_write_failed", message: error instanceof Error ? error.message : String(error) }));
  }
}
