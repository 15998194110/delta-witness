// Only controlled application codes leave the dependency boundary. Raw error
// messages can contain authorization headers, URLs, provider bodies or secrets.
const PUBLIC_CODES = new Set([
  "invalid_request_body", "unknown_request_field", "invalid_url", "url_required", "url_too_long",
  "hostname_required", "unsupported_scheme", "userinfo_not_allowed", "unsafe_port_not_allowed",
  "private_target_not_allowed", "private_dns_target_not_allowed", "dns_resolution_failed",
  "dns_resolver_redirect_not_allowed", "too_many_redirects", "too_many_browser_redirects",
  "redirect_location_missing", "body_too_large", "request_too_large", "upstream_response_too_large",
  "content_type_must_be_application_json", "invalid_json", "invalid_upstream_json", "payment_header_too_large",
  "invalid_expected", "invalid_contains", "invalid_excludes", "invalid_html_sha256", "invalid_markdown_sha256",
  "invalid_prior_proof_id", "invalid_freshness_seconds", "empty_expected", "prior_proof_not_found",
  "prior_proof_invalid", "prior_proof_target_mismatch", "invalid_fulfillment_record", "stored_payment_amount_invalid",
  "invalid_pilot_record", "invalid_urls", "pilot_requires_https", "invalid_preflight", "invalid_preflight_url_index",
  "invalid_checks", "invalid_interval_seconds", "webhook_https_required", "settlement_identity_invalid",
  "invalid_settlement_record", "capture_incomplete", "capture_too_large", "invalid_screenshot_base64",
  "browser_cost_limit_exceeded", "policy_violation", "safety_refusal", "payment_request_binding_mismatch", "invalid_screenshot_png",
  "body_read_timeout", "capture_response_timeout", "png_validation_timeout",
  "artifact_identity_conflict",
]);

export function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "dependency_failure";
  if (PUBLIC_CODES.has(error.message) || /^capture_upstream_[1-5][0-9]{2}$/.test(error.message)) return error.message;
  if (error.name === "TimeoutError" || error.name === "AbortError") return "dependency_timeout";
  return "dependency_failure";
}

export function captureFailure(error: unknown) {
  const reason = safeErrorCode(error);
  const status = /^capture_upstream_([0-9]{3})$/.exec(reason)?.[1];
  const retryable = reason === "dependency_timeout" || reason === "body_read_timeout" || reason === "capture_response_timeout" || reason === "dns_resolution_failed" ||
    (status !== undefined && ([408, 429].includes(Number(status)) || Number(status) >= 500));
  return { reason, retryable };
}

export const MAX_FULFILLMENT_ATTEMPTS = 3;
