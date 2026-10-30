import { describe, expect, it, vi, afterEach } from "vitest";
import { createRetentionSnapshot, evaluateRetention, parseRetentionPolicy, planRetentionDryRun, retentionTimeline, verifyRetentionSnapshot, type RetentionPolicy, type RetentionInventoryOrder } from "../src/retention";
import { sha256, stableJson } from "../src/crypto";

const bought = "2026-10-29T00:00:00.000Z";
const settled = "2026-10-29T00:00:10.000Z";
const completed = "2026-10-29T00:00:30.000Z";
const at = "2026-10-29T00:01:40.000Z";
const base = { order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenant_id: "synthetic-buyer-a", proof_id: "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb", payment_fingerprint: "sha256:" + "a".repeat(64), purchased_at: bought };
function policy(): RetentionPolicy {
  return { schema: "delta-retention-policy/v1", policy_id: "synthetic-duration-seconds-not-a-promise",
    classes: {
      raw_artifacts: { start_event: "fulfillment_completed", retain_seconds: 60, deletion_window_seconds: 120 },
      minimal_metadata: { start_event: "fulfillment_completed", retain_seconds: 600, deletion_window_seconds: 120 },
      transaction_audit: { start_event: "fulfillment_completed", retain_seconds: 1200, deletion_window_seconds: 120 },
    }, export_rights: { raw_artifacts: "authenticated_until_raw_expiry", minimal_metadata: "authenticated_until_metadata_expiry" } };
}
async function inventory(): Promise<RetentionInventoryOrder> {
  const snapshot = await createRetentionSnapshot(policy(), base);
  return { ...base, snapshot, authoritative_snapshot_hash: snapshot.snapshot_hash, events: { settlement_confirmed_at: settled, fulfillment_completed_at: completed },
    fulfillment_state: "complete", settlement_state: "settlement_confirmed", obligation_state: "cleared", legal_hold: false,
    objects: ["page.html", "page.md", "screenshot.png"].map(name => ({ key: `${base.proof_id}/${name}`, etag: `synthetic-etag-${name}`, sha256: "sha256:" + "b".repeat(64), bytes: 100 })) };
}
const plan = (orders: RetentionInventoryOrder[], time = at, tenant = base.tenant_id) => planRetentionDryRun({ schema: "delta-retention-inventory/v1", tenant_id: tenant, at: time, orders });
afterEach(() => vi.restoreAllMocks());

describe("D07 pure retention policy and immutable purchase snapshots", () => {
  it("has no default policy and rejects invalid explicit configuration", () => {
    expect(parseRetentionPolicy(undefined)).toBeUndefined();
    for (const invalid of ["", "not-json", null, {}, "null", "{}", true]) expect(() => parseRetentionPolicy(invalid)).toThrow();
    expect(parseRetentionPolicy(JSON.stringify(policy()))).toEqual(policy());
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects unsafe duration %s", invalid => {
    const value = policy(); value.classes.raw_artifacts.retain_seconds = invalid;
    expect(() => parseRetentionPolicy(value)).toThrow();
  });
  it("rejects unspecified deletion windows, unsupported start event and unbounded export rights", () => {
    const value = policy() as any;
    delete value.classes.raw_artifacts.deletion_window_seconds; expect(() => parseRetentionPolicy(value)).toThrow();
    value.classes.raw_artifacts.deletion_window_seconds = 20; value.classes.raw_artifacts.start_event = "last_download"; expect(() => parseRetentionPolicy(value)).toThrow();
    value.classes.raw_artifacts.start_event = "fulfillment_completed"; value.export_rights.raw_artifacts = "forever"; expect(() => parseRetentionPolicy(value)).toThrow();
  });
  it("D07-T01 snapshots full purchased policy without retroactive configuration references", async () => {
    const original = policy(); const snapshot = await createRetentionSnapshot(original, base); const originalJson = stableJson(snapshot);
    original.classes.raw_artifacts.retain_seconds = 1; original.policy_id = "later-config";
    expect(stableJson(snapshot)).toBe(originalJson);
    expect(snapshot.policy.classes.raw_artifacts.retain_seconds).toBe(60);
    expect(await verifyRetentionSnapshot(snapshot, snapshot.snapshot_hash)).toEqual(snapshot);
    const later = await createRetentionSnapshot(original, base); expect(later.snapshot_hash).not.toBe(snapshot.snapshot_hash);
    expect((await evaluateRetention(snapshot, { settlement_confirmed_at: settled, fulfillment_completed_at: completed }, "2026-10-29T00:01:00Z")).export_allowed).toBe(true);
  });
  it("rejects a self-consistent shortened snapshot without original journal authority", async () => {
    const first = await createRetentionSnapshot(policy(), base); const next = policy(); next.classes.raw_artifacts.retain_seconds = 1;
    const changed = await createRetentionSnapshot(next, base);
    await expect(verifyRetentionSnapshot(changed, first.snapshot_hash)).rejects.toThrow("retention_snapshot_inconsistent");
  });
  it("rejects mutation of snapshot identity, rights or hash", async () => {
    const first = await createRetentionSnapshot(policy(), base);
    for (const patch of [{ tenant_id: "other-buyer" }, { snapshot_hash: "sha256:" + "0".repeat(64) }, { purchased_at: settled }]) {
      await expect(verifyRetentionSnapshot({ ...first, ...patch }, first.snapshot_hash)).rejects.toThrow();
    }
  });
  it("D07-T02 exact expiry and timezone boundaries use the original event", async () => {
    const snapshot = await createRetentionSnapshot(policy(), base), events = { settlement_confirmed_at: settled, fulfillment_completed_at: completed };
    const before = await evaluateRetention(snapshot, events, "2026-10-29T08:01:29.999+08:00");
    const equal = await evaluateRetention(snapshot, events, "2026-10-29T00:01:30.000Z");
    const after = await evaluateRetention(snapshot, events, "2026-10-29T00:01:30.001Z");
    expect(before.export_allowed).toBe(true); expect(equal.export_allowed).toBe(false); expect(after.export_allowed).toBe(false);
    expect(equal.raw_expires_at).toBe("2026-10-29T00:01:30.000Z");
    expect((await evaluateRetention(snapshot, events, "2026-11-29T00:00:00Z")).raw_expires_at).toBe(equal.raw_expires_at);
  });
  it("missing event stays pending; recovery or query time does not restart retention", async () => {
    const snapshot = await createRetentionSnapshot(policy(), base);
    const result = await evaluateRetention(snapshot, { settlement_confirmed_at: settled }, at);
    expect(result).toMatchObject({ state: "pending_start", raw_expires_at: null, export_allowed: null });
  });
  it.each([
    { settlement_confirmed_at: "2026-10-28T00:00:00Z" },
    { fulfillment_completed_at: completed },
    { settlement_confirmed_at: settled, fulfillment_completed_at: bought },
    { settlement_confirmed_at: "2027-10-29T00:00:00Z" },
    { settlement_confirmed_at: "2026-10-29 00:00:10" },
  ])("rejects impossible/unzoned event sequence %j", async events => {
    const snapshot = await createRetentionSnapshot(policy(), base);
    await expect(evaluateRetention(snapshot, events, at)).rejects.toThrow();
  });
  it.each(["minimal_metadata", "transaction_audit"] as const)("rejects %s duration inversion before snapshot/purchase", async category => {
    const value = policy(); value.classes[category].retain_seconds = 1;
    expect(() => parseRetentionPolicy(value)).toThrow("retention_policy_conflicts_with_evidence_obligation");
    await expect(createRetentionSnapshot(value, base)).rejects.toThrow("retention_policy_conflicts_with_evidence_obligation");
  });
  it.each(["minimal_metadata", "transaction_audit"] as const)("rejects %s start-event inversion even with a longer duration", async category => {
    const value = policy(); value.classes[category].start_event = "settlement_confirmed";
    expect(() => parseRetentionPolicy(JSON.stringify(value))).toThrow("retention_policy_conflicts_with_evidence_obligation");
    await expect(createRetentionSnapshot(value, base)).rejects.toThrow("retention_policy_conflicts_with_evidence_obligation");
  });
  it("accepts equal durations and forward event ordering with arbitrarily delayed completion", async () => {
    const value = policy(); value.classes.raw_artifacts.start_event = "settlement_confirmed";
    for (const category of Object.keys(value.classes) as Array<keyof RetentionPolicy["classes"]>) value.classes[category].retain_seconds = 60;
    expect(parseRetentionPolicy(value)).toEqual(value);
    const snapshot = await createRetentionSnapshot(value, base);
    const timeline = retentionTimeline(snapshot, { settlement_confirmed_at: settled, fulfillment_completed_at: "2026-11-29T00:00:00Z" }, "2026-11-29T00:00:01Z");
    expect(Date.parse(timeline.minimal_metadata.expires_at!)).toBeGreaterThan(Date.parse(timeline.raw_artifacts.expires_at!));
    expect(timeline.transaction_audit.expires_at).toBe(timeline.minimal_metadata.expires_at);
  });
  it.each(["2026-02-30T00:00:00Z", "2026-10-29T24:00:00Z", "2026-10-29T00:00:60Z"])("rejects normalized-invalid calendar time %s", async invalid => {
    await expect(createRetentionSnapshot(policy(), { ...base, purchased_at: invalid })).rejects.toThrow();
  });
  it("D07-T04 keeps legacy policy unknown, not zero or implicitly expired", async () => {
    expect(await evaluateRetention(undefined, {}, at)).toEqual({ state: "legacy_policy_unknown", raw_expires_at: null, export_allowed: null, timeline: null });
  });
});

describe("D07 audit-only dry-run plans (no execution capability)", () => {
  it("D07-T03 plans only exact raw keys and preserves minimal metadata/audit", async () => {
    const order = await inventory(); const network = vi.fn(); vi.stubGlobal("fetch", network);
    const report = await plan([order]);
    expect(report).toMatchObject({ dry_run: true, execution_authorized: false, actual_deletions: 0, protected_categories: ["minimal_metadata", "transaction_audit"] });
    expect(report.candidates).toHaveLength(1); expect(report.excluded).toHaveLength(0);
    expect(report.candidates[0].objects.map(object => object.key)).toEqual([`${base.proof_id}/page.html`, `${base.proof_id}/page.md`, `${base.proof_id}/screenshot.png`]);
    expect(report.schedules[0]).toMatchObject({ raw_export_state: "expired", metadata_action: "preserve_requires_separate_review", audit_action: "preserve_requires_separate_review" });
    expect(network).not.toHaveBeenCalled();
  });
  it("same inventory and time produce identical plan; stable candidate IDs survive repeated runs", async () => {
    const order = await inventory(); const original = stableJson(order);
    const one = await plan([order]), two = await plan([order]), later = await plan([order], "2026-10-29T00:01:41Z");
    expect(two).toEqual(one); expect(later.candidates[0].candidate_id).toBe(one.candidates[0].candidate_id);
    expect(stableJson(order)).toBe(original);
    const { plan_hash, ...body } = one; expect(plan_hash).toBe(await sha256(stableJson(body)));
  });
  it.each(["other-tenant", "live", "unknown-settlement", "open-obligation", "unknown-obligation", "hold", "unknown-hold", "legacy", "missing-authority"])("excludes %s without changing inventory", async mode => {
    const order = await inventory();
    if (mode === "other-tenant") order.tenant_id = "synthetic-buyer-b";
    if (mode === "live") order.fulfillment_state = "processing";
    if (mode === "unknown-settlement") order.settlement_state = "settlement_unknown";
    if (mode === "open-obligation") order.obligation_state = "open";
    if (mode === "unknown-obligation") order.obligation_state = "unknown";
    if (mode === "hold") order.legal_hold = true;
    if (mode === "unknown-hold") order.legal_hold = "unknown";
    if (mode === "legacy") order.snapshot = undefined;
    if (mode === "missing-authority") order.authoritative_snapshot_hash = undefined;
    const before = stableJson(order), report = await plan([order]);
    expect(report.candidates).toHaveLength(0); expect(report.excluded).toHaveLength(1); expect(report.actual_deletions).toBe(0); expect(stableJson(order)).toBe(before);
  });
  it("protects unexpired and missed deletion-window orders rather than extending authorization", async () => {
    const order = await inventory();
    const early = await plan([order], "2026-10-29T00:01:29.999Z");
    const final = await plan([order], "2026-10-29T00:03:29.999Z");
    const missed = await plan([order], "2026-10-29T00:03:30Z");
    expect(early.excluded[0].reason).toBe("retained"); expect(final.candidates).toHaveLength(1); expect(missed.excluded[0].reason).toBe("expired_window_missed");
  });
  it.each(["missing", "traversal", "metadata", "duplicate", "wrong-proof", "bad-etag", "nonstring-etag", "extra-metadata", "bad-size", "bad-hash"])("rejects %s artifact inventories", async mode => {
    const order = await inventory();
    if (mode === "missing") order.objects.pop();
    if (mode === "traversal") order.objects[0].key = "../other-buyer/page.html";
    if (mode === "metadata") order.objects.push({ ...order.objects[0], key: `${base.proof_id}/manifest.json` });
    if (mode === "duplicate") order.objects[0] = { ...order.objects[1] };
    if (mode === "wrong-proof") order.proof_id = "cccccccc-cccc-5ccc-8ccc-cccccccccccc";
    if (mode === "bad-etag") order.objects[0].etag = "";
    if (mode === "nonstring-etag") (order.objects[0] as any).etag = 123;
    if (mode === "extra-metadata") (order.objects[0] as any).unneeded_private_note = "synthetic-extra-metadata";
    if (mode === "bad-size") order.objects[0].bytes = -1;
    if (mode === "bad-hash") order.objects[0].sha256 = "unknown";
    const report = await plan([order]); expect(report.candidates).toHaveLength(0); expect(report.excluded[0].reason).toBe("invalid_or_inconsistent_evidence");
  });
  it("excludes duplicate orders and conflicting object ownership across orders", async () => {
    const order = await inventory(); const clone = structuredClone(order);
    expect((await plan([order, clone])).candidates).toHaveLength(0);
    clone.order_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    clone.snapshot = await createRetentionSnapshot(policy(), clone); clone.authoritative_snapshot_hash = clone.snapshot.snapshot_hash;
    const report = await plan([order, clone]); expect(report.candidates).toHaveLength(0); expect(report.excluded.every(item => item.reason === "duplicate_or_conflicting_ownership")).toBe(true);
  });
  it("unknown or legacy neighbors do not erase a valid candidate", async () => {
    const order = await inventory(); const legacy = { ...await inventory(), order_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", proof_id: "cccccccc-cccc-5ccc-8ccc-cccccccccccc", snapshot: undefined, objects: [] };
    const report = await plan([order, legacy]); expect(report.candidates).toHaveLength(1); expect(report.excluded).toHaveLength(1);
  });
  it("bounds inventory size and rejects unknown top-level schema", async () => {
    const order = await inventory();
    await expect(plan(Array.from({ length: 501 }, () => order))).rejects.toThrow("invalid_retention_inventory");
    await expect(planRetentionDryRun({ schema: "invalid", tenant_id: base.tenant_id, at, orders: [] } as any)).rejects.toThrow();
  });
});
