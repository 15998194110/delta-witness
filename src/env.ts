export type RuntimeEnv = Env & {
  ORDER_RECOVERY_TTL_SECONDS?: string;
  R2_READ_COST_PER_MILLION_USD?: string;
  PARTNER_BILLING_COORDINATION_ENABLED?: string;
  SCHEDULED_OPERATIONS_OBSERVABILITY_ENABLED?: string;
  OPERATIONS_CLOUD_ENABLED?: string;
  OPERATIONS_ADMIN_SECRET?: string;
  OPERATIONS_RELEASE_SHA?: string;
  PAID_ORDER_DRAFT_RECOVERY_ENABLED?: string;
  PULSE_WATCHDOG_ENABLED?: string;
  GITHUB_ACTIONS_DISPATCH_TOKEN?: string;
  TREASURY_CUSTODY_ENABLED?: string;
  TREASURY_CUSTODY_ORIGIN_BLOCK?: string;
  TREASURY_CUSTODY_MINIMUM_VERSION?: string;
  TREASURY_CUSTODY_MINIMUM_DIGEST?: string;
  TREASURY_CUSTODY_ALLOW_BOOTSTRAP?: string;
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
