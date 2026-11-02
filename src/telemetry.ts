import type { AnalyticsEventName, RuntimeEnv } from "./env";
import { sanitizeDimension } from "./security";
import { safeErrorCode } from "./failures";
import { withinDeadline } from "./deadline";

export const TELEMETRY_DEADLINE_MS = 1_000;

export type TelemetryEvent = {
  event: AnalyticsEventName;
  route: string;
  channel?: string;
  partner?: string;
  success?: boolean;
  reason?: string;
  requestId?: string;
  grossUsd?: number;
  browserMs?: number | null;
  storageBytes?: number | null;
  variableCostUsd?: number | null;
  contributionMarginUsd?: number | null;
};

function measured(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function recordEvent(env: RuntimeEnv, event: TelemetryEvent): Promise<void> {
  try {
    await withinDeadline(Promise.resolve().then(() => env.ANALYTICS_DB.prepare(`
      INSERT INTO telemetry_events (
        app_version, event, route, channel, partner, success, reason, network,
        event_count, gross_usd, browser_ms, storage_bytes, variable_cost_usd, contribution_margin_usd,
        metric_schema, measured_browser_ms, measured_storage_bytes, modeled_variable_cost_usd, modeled_contribution_margin_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      "delta-metrics/v2",
      measured(event.browserMs),
      measured(event.storageBytes),
      measured(event.variableCostUsd),
      typeof event.contributionMarginUsd === "number" && Number.isFinite(event.contributionMarginUsd) ? event.contributionMarginUsd : null,
    ).run()), TELEMETRY_DEADLINE_MS, "analytics_write_timeout");
  } catch (error) {
    console.error(JSON.stringify({ event: "analytics_write_failed", reason: error instanceof Error && error.message === "analytics_write_timeout" ? "analytics_write_timeout" : safeErrorCode(error) }));
  }
}
