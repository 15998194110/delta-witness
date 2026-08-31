import type { RuntimeEnv } from "./env";
import type { ProofManifest } from "./capture";
import { sha256, stableJson } from "./crypto";
import { validateTarget } from "./security";

export type CaptureRequest = {
  url: string;
};

export type PreflightRequest = {
  url: string;
  prior_proof_id?: string;
  expected?: {
    html_sha256?: string;
    markdown_sha256?: string;
    contains?: string[];
    excludes?: string[];
  };
  freshness_seconds?: number;
};

export type PaidRequest = CaptureRequest | PreflightRequest;

export type DeliveryResponse = {
  ok: true;
  product: "capture" | "preflight";
  proof_id: string;
  manifest_url: string;
  public_proof_url: string;
  bundle_root: string;
  observed_at: string;
  safe?: boolean | null;
  changed?: boolean | null;
  reason?: string;
  diff?: Record<string, unknown>;
  idempotent_replay?: boolean;
};

export type FulfillmentRecord = {
  schema: "delta-fulfillment/v1";
  state: "processing" | "retryable_failure" | "complete";
  route: string;
  request_hash: string;
  requested_url: string;
  fulfillment_fingerprint: string;
  payment_fingerprint?: string;
  partner?: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  error?: string;
  response?: DeliveryResponse;
  payment_response_header?: string;
};

export type StoredFulfillment = { record: FulfillmentRecord; etag: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unknown_request_field");
}

export function parseCaptureRequest(value: unknown): CaptureRequest {
  if (!isPlainObject(value)) throw new Error("invalid_request_body");
  assertOnlyKeys(value, ["url"]);
  const url = validateTarget(value.url).toString();
  return { url };
}

function parseTextExpectations(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new Error(`invalid_${field}`);
  const parsed = value.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 200) throw new Error(`invalid_${field}`);
    return item;
  });
  return parsed.length ? parsed : undefined;
}

export function parsePreflightRequest(value: unknown): PreflightRequest {
  if (!isPlainObject(value)) throw new Error("invalid_request_body");
  assertOnlyKeys(value, ["url", "prior_proof_id", "expected", "freshness_seconds"]);
  const url = validateTarget(value.url).toString();
  const result: PreflightRequest = { url };
  if (value.prior_proof_id !== undefined) {
    if (typeof value.prior_proof_id !== "string" || !UUID_PATTERN.test(value.prior_proof_id)) {
      throw new Error("invalid_prior_proof_id");
    }
    result.prior_proof_id = value.prior_proof_id;
  }
  if (value.freshness_seconds !== undefined) {
    if (!Number.isInteger(value.freshness_seconds) || Number(value.freshness_seconds) < 0 || Number(value.freshness_seconds) > 2_592_000) {
      throw new Error("invalid_freshness_seconds");
    }
    result.freshness_seconds = Number(value.freshness_seconds);
  }
  if (value.expected !== undefined) {
    if (!isPlainObject(value.expected)) throw new Error("invalid_expected");
    assertOnlyKeys(value.expected, ["html_sha256", "markdown_sha256", "contains", "excludes"]);
    const expected: NonNullable<PreflightRequest["expected"]> = {};
    for (const field of ["html_sha256", "markdown_sha256"] as const) {
      const candidate = value.expected[field];
      if (candidate !== undefined) {
        if (typeof candidate !== "string" || !HASH_PATTERN.test(candidate)) throw new Error(`invalid_${field}`);
        expected[field] = candidate.toLowerCase();
      }
    }
    expected.contains = parseTextExpectations(value.expected.contains, "contains");
    expected.excludes = parseTextExpectations(value.expected.excludes, "excludes");
    if (Object.values(expected).every((item) => item === undefined)) throw new Error("empty_expected");
    result.expected = expected;
  }
  return result;
}

export async function paidRequestHash(route: string, body: PaidRequest): Promise<string> {
  return sha256(`${route}\n${stableJson(body)}`);
}

export function fulfillmentRecordKey(fingerprint: string): string {
  return `fulfillments/${fingerprint.replace(/^sha256:/, "")}.json`;
}

export async function readFulfillment(env: RuntimeEnv, key: string): Promise<StoredFulfillment | null> {
  const object = await env.PROOFS.get(key);
  if (!object) return null;
  const record = await object.json<FulfillmentRecord>();
  if (record.schema !== "delta-fulfillment/v1") throw new Error("invalid_fulfillment_record");
  return { record, etag: object.etag };
}

export async function reserveInitialFulfillment(
  env: RuntimeEnv,
  key: string,
  record: FulfillmentRecord,
): Promise<boolean> {
  const created = await env.PROOFS.put(key, JSON.stringify(record), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return created !== null;
}

export async function claimRetry(
  env: RuntimeEnv,
  key: string,
  stored: StoredFulfillment,
): Promise<FulfillmentRecord | null> {
  const now = new Date().toISOString();
  const next: FulfillmentRecord = {
    ...stored.record,
    state: "processing",
    attempts: stored.record.attempts + 1,
    updated_at: now,
    error: undefined,
  };
  const claimed = await env.PROOFS.put(key, JSON.stringify(next), {
    onlyIf: { etagMatches: stored.etag },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return claimed ? next : null;
}

export async function writeFulfillment(
  env: RuntimeEnv,
  key: string,
  record: FulfillmentRecord,
): Promise<void> {
  await env.PROOFS.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

export function initialFulfillment(input: {
  route: string;
  requestHash: string;
  requestedUrl: string;
  fulfillmentFingerprint: string;
  paymentFingerprint?: string;
  partner?: string;
}): FulfillmentRecord {
  const now = new Date().toISOString();
  return {
    schema: "delta-fulfillment/v1",
    state: "processing",
    route: input.route,
    request_hash: input.requestHash,
    requested_url: input.requestedUrl,
    fulfillment_fingerprint: input.fulfillmentFingerprint,
    payment_fingerprint: input.paymentFingerprint,
    partner: input.partner,
    attempts: 1,
    created_at: now,
    updated_at: now,
  };
}

export function fulfillmentMatches(record: FulfillmentRecord, route: string, requestHash: string): boolean {
  return record.route === route && record.request_hash === requestHash;
}

export type PreflightEvaluation = {
  safe: boolean | null;
  changed: boolean | null;
  reason: "unchanged" | "changed" | "expectation_failed" | "observation_only_no_baseline";
  diff: {
    prior_proof_id?: string;
    hash_changes: Array<{ field: "html" | "markdown"; expected: string; observed: string }>;
    missing_text: string[];
    excluded_text_found: string[];
  };
};

export function evaluatePreflight(
  request: PreflightRequest,
  manifest: ProofManifest,
  markdown: string,
  prior?: ProofManifest,
): PreflightEvaluation {
  const hashChanges: PreflightEvaluation["diff"]["hash_changes"] = [];
  const missingText: string[] = [];
  const excludedTextFound: string[] = [];
  const expectedHtml = request.expected?.html_sha256 ?? prior?.hashes.html;
  const expectedMarkdown = request.expected?.markdown_sha256 ?? prior?.hashes.markdown;
  if (expectedHtml && expectedHtml !== manifest.hashes.html) {
    hashChanges.push({ field: "html", expected: expectedHtml, observed: manifest.hashes.html });
  }
  if (expectedMarkdown && expectedMarkdown !== manifest.hashes.markdown) {
    hashChanges.push({ field: "markdown", expected: expectedMarkdown, observed: manifest.hashes.markdown });
  }
  for (const text of request.expected?.contains ?? []) {
    if (!markdown.includes(text)) missingText.push(text);
  }
  for (const text of request.expected?.excludes ?? []) {
    if (markdown.includes(text)) excludedTextFound.push(text);
  }
  const hasHashBaseline = Boolean(expectedHtml || expectedMarkdown);
  const hasTextExpectations = Boolean((request.expected?.contains?.length ?? 0) + (request.expected?.excludes?.length ?? 0));
  const failed = hashChanges.length > 0 || missingText.length > 0 || excludedTextFound.length > 0;
  const changed = hasHashBaseline ? hashChanges.length > 0 : null;
  let reason: PreflightEvaluation["reason"];
  if (!hasHashBaseline && !hasTextExpectations) reason = "observation_only_no_baseline";
  else if (failed && hashChanges.length > 0) reason = "changed";
  else if (failed) reason = "expectation_failed";
  else reason = "unchanged";
  return {
    safe: hasHashBaseline || hasTextExpectations ? !failed : null,
    changed,
    reason,
    diff: {
      prior_proof_id: request.prior_proof_id,
      hash_changes: hashChanges,
      missing_text: missingText,
      excluded_text_found: excludedTextFound,
    },
  };
}
