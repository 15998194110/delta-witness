import { describe, expect, it } from "vitest";
import {
  evaluatePreflight,
  fulfillmentMatches,
  initialFulfillment,
  parsePreflightRequest,
  reserveInitialFulfillment,
} from "../src/fulfillment";
import type { ProofManifest } from "../src/capture";
import type { RuntimeEnv } from "../src/env";

describe("payment replay and idempotency", () => {
  it("atomically reserves a fulfillment key once", async () => {
    let stored = false;
    const bucket = {
      put: async (_key: string, _value: string, options?: R2PutOptions) => {
        if (options?.onlyIf && stored) return null;
        stored = true;
        return { key: "x", version: "1", size: 1, etag: "1", uploaded: new Date(), httpEtag: "1", checksums: {} };
      },
    } as unknown as R2Bucket;
    const env = { PROOFS: bucket } as RuntimeEnv;
    const record = initialFulfillment({ route: "/v1/capture", requestHash: "sha256:a", requestedUrl: "https://example.com/", fulfillmentFingerprint: "sha256:b" });
    expect(await reserveInitialFulfillment(env, "fulfillments/x.json", record)).toBe(true);
    expect(await reserveInitialFulfillment(env, "fulfillments/x.json", record)).toBe(false);
    expect(fulfillmentMatches(record, "/v1/capture", "sha256:a")).toBe(true);
    expect(fulfillmentMatches(record, "/v1/capture", "sha256:different")).toBe(false);
  });
});

describe("preflight semantics", () => {
  it("reports deterministic text and hash changes without claiming truth", () => {
    const request = parsePreflightRequest({
      url: "https://example.com/",
      expected: { html_sha256: `sha256:${"1".repeat(64)}`, contains: ["refund"], excludes: ["final sale"] },
    });
    const manifest = { hashes: { html: `sha256:${"2".repeat(64)}`, markdown: `sha256:${"3".repeat(64)}` } } as ProofManifest;
    const result = evaluatePreflight(request, manifest, "This is a final sale.");
    expect(result.safe).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("changed");
    expect(result.diff.missing_text).toEqual(["refund"]);
    expect(result.diff.excluded_text_found).toEqual(["final sale"]);
  });
});
