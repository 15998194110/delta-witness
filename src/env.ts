export type RuntimeEnv = Env & {
  ORDER_RECOVERY_TTL_SECONDS?: string;
  R2_READ_COST_PER_MILLION_USD?: string;
  PARTNER_BILLING_COORDINATION_ENABLED?: string;
  RETENTION_POLICY_JSON?: string;
  INDEXNOW_ADMIN_SECRET?: string;
  PARTNER_GATEWAY_SECRET?: string;
  MESHKORE_API_KEY?: string;
  MESHKORE_AGENT_ID?: string;
};

export type AnalyticsEventName =
  | "page_view"
  | "quote_issued"
  | "qualified_request"
  | "payment_required"
  | "payment_verified"
  | "capture_started"
  | "capture_completed"
  | "capture_failed"
  | "proof_opened"
  | "repeat_call"
  | "partner_request"
  | "watch_registered"
  | "watch_checked"
  | "watch_webhook";
