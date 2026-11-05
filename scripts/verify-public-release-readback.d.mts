export const CORE_ORIGIN: string;
export const PROOF_ID: string;
export const NETWORK: 'eip155:8453';
export const MAX_RESPONSE_BYTES: number;
type Target = Readonly<{ id: 'core_health' | 'gateway_health' | 'original_proof_metadata' | 'openapi'; url: string }>;
export const TARGETS: readonly Target[];
export const ORIGINAL_PROOF_HASHES: Readonly<Record<'html' | 'markdown' | 'screenshot_png', string>>;
type Observation = Target & {
  method: 'GET'; requested_at: string; observed_at: string; duration_ms: number;
  http_status: number | null; body_bytes?: number; body_sha256?: string;
};
type Check = Observation & (
  { status: 'PASS'; details: Record<string, unknown>; reason?: never } |
  { status: 'FAIL' | 'UNKNOWN'; reason: string; details?: never }
);
export function runPublicReleaseReadback(options: {
  expectedCoreVersion: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number;
}): Promise<{
  schema: 'delta-public-release-readback/v1'; checked_at: string; expected_core_version: string;
  ok: boolean; checks: Check[]; max_response_bytes: number; request_deadline_ms: number;
  raw_artifacts_requested: false; payment_authorization_sent: false; credentials_used: false;
  request_telemetry: string; treasury_check: string; acceptance_scope: string; not_validated: string[];
}>;
