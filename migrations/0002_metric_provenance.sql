-- Additive candidate only; do not run against production without migration approval.
-- Old numeric fields remain audit history, including old zero/unknown ambiguity.
-- NULL in new columns is unknown, never an actual zero or invoice.
ALTER TABLE telemetry_events ADD COLUMN metric_schema TEXT;
ALTER TABLE telemetry_events ADD COLUMN measured_browser_ms REAL;
ALTER TABLE telemetry_events ADD COLUMN measured_storage_bytes REAL;
ALTER TABLE telemetry_events ADD COLUMN modeled_variable_cost_usd REAL;
ALTER TABLE telemetry_events ADD COLUMN modeled_contribution_margin_usd REAL;
