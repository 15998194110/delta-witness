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

export function recordEvent(env: RuntimeEnv, event: TelemetryEvent): void {
  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [sanitizeDimension(event.channel, "direct")],
      blobs: [
        env.APP_VERSION,
        event.event,
        event.route,
        sanitizeDimension(event.channel, "direct"),
        sanitizeDimension(event.partner, "none"),
        event.success === undefined ? "unknown" : String(event.success),
        sanitizeDimension(event.reason, "none"),
        env.NETWORK,
      ],
      doubles: [
        1,
        event.grossUsd ?? 0,
        event.browserMs ?? 0,
        event.storageBytes ?? 0,
        event.variableCostUsd ?? 0,
        event.contributionMarginUsd ?? 0,
      ],
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "analytics_write_failed", message: error instanceof Error ? error.message : String(error) }));
  }
}
