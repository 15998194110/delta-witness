export type RuntimeEnv = Env & {
  INDEXNOW_ADMIN_SECRET?: string;
  PARTNER_GATEWAY_SECRET?: string;
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
