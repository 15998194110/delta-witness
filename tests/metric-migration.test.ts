import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { recordEvent } from "../src/telemetry";
import type { RuntimeEnv } from "../src/env";

describe("additive nullable metrics migration, in-memory SQLite only", () => {
  it("preserves legacy zero evidence and aggregates partial/failure cost as unknown", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readFileSync("migrations/0001_telemetry.sql", "utf8"));
      db.exec("INSERT INTO telemetry_events(app_version,event,route,channel,partner,success,reason,network,event_count,gross_usd,browser_ms,storage_bytes,variable_cost_usd,contribution_margin_usd) VALUES ('old','capture_completed','/v1/capture','legacy','none','true','none','eip155:8453',1,1,0,0,0,1)");
      db.exec(readFileSync("migrations/0002_metric_provenance.sql", "utf8"));
      expect(db.prepare("SELECT browser_ms, variable_cost_usd, measured_browser_ms, modeled_variable_cost_usd FROM telemetry_events").get()).toMatchObject({ browser_ms: 0, variable_cost_usd: 0, measured_browser_ms: null, modeled_variable_cost_usd: null });
      const env = { APP_VERSION: "local", NETWORK: "eip155:8453", ANALYTICS_DB: { prepare: (sql: string) => ({ bind: (...values: any[]) => ({ run: async () => db.prepare(sql).run(...values) }) }) } } as unknown as RuntimeEnv;
      await recordEvent(env, { event: "capture_completed", route: "/v1/capture", channel: "synthetic", success: true, grossUsd: 1, browserMs: 10, storageBytes: 50, variableCostUsd: 0.2, contributionMarginUsd: 0.8 });
      await recordEvent(env, { event: "capture_failed", route: "/v1/capture", channel: "synthetic", success: false });
      const query = readFileSync("scripts/query-funnel.mjs", "utf8").match(/const query = `([\s\S]*?)`;/)![1].replace("${days}", "30");
      const rows = db.prepare(query).all();
      expect(rows.find(row => row.channel === "legacy")).toMatchObject({ estimated_variable_cost_usd: null, browser_ms: null, cost_unknown_events: 1 });
      expect(rows.find(row => row.channel === "synthetic")).toMatchObject({ estimated_variable_cost_usd: null, estimated_contribution_margin_usd: null, browser_ms: null, cost_unknown_events: 1 });
    } finally { db.close(); }
  });
  it("absent migration fails telemetry visibly and does not mutate the old schema or block delivery", async () => {
    const db = new DatabaseSync(":memory:"); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.exec(readFileSync("migrations/0001_telemetry.sql", "utf8"));
      const env = { ANALYTICS_DB: { prepare: (sql: string) => db.prepare(sql) } } as unknown as RuntimeEnv;
      await expect(recordEvent(env, { event: "capture_failed", route: "/v1/capture" })).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("analytics_write_failed"));
      expect(db.prepare("SELECT count(*) AS n FROM telemetry_events").get()?.n).toBe(0);
      expect(db.prepare("PRAGMA table_info(telemetry_events)").all().some(row => row.name === "metric_schema")).toBe(false);
    } finally { log.mockRestore(); db.close(); }
  });
});
