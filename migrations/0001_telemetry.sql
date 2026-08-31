CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  app_version TEXT NOT NULL,
  event TEXT NOT NULL,
  route TEXT NOT NULL,
  channel TEXT NOT NULL,
  partner TEXT NOT NULL,
  success TEXT NOT NULL,
  reason TEXT NOT NULL,
  network TEXT NOT NULL,
  event_count REAL NOT NULL,
  gross_usd REAL NOT NULL,
  browser_ms REAL NOT NULL,
  storage_bytes REAL NOT NULL,
  variable_cost_usd REAL NOT NULL,
  contribution_margin_usd REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS telemetry_events_time_channel
  ON telemetry_events(created_at, channel);

CREATE INDEX IF NOT EXISTS telemetry_events_event_time
  ON telemetry_events(event, created_at);
