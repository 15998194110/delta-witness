import type { RuntimeEnv } from "./env";

export type StoredClaim<T> = { record: T; etag: string };

// The ETag returned by every successful write is the authority for the next
// transition. A lost or indeterminate write never grants a new lease.
export async function createClaim<T>(env: RuntimeEnv, key: string, record: T): Promise<StoredClaim<T> | null> {
  const saved = await env.PROOFS.put(key, JSON.stringify(record), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return saved ? { record, etag: saved.etag } : null;
}

export async function commitClaim<T>(env: RuntimeEnv, key: string, claim: StoredClaim<T>, record: T): Promise<StoredClaim<T> | null> {
  const saved = await env.PROOFS.put(key, JSON.stringify(record), {
    onlyIf: { etagMatches: claim.etag },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return saved ? { record, etag: saved.etag } : null;
}

export function lostClaimBody() {
  return { ok: false, state: "fulfillment_unknown", retryable: false, requires_fulfillment_reconciliation: true };
}
