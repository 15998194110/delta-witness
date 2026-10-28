import type { RuntimeEnv } from "./env";
import { MAX_HTML_BYTES, MAX_MARKDOWN_BYTES, MAX_SCREENSHOT_BYTES } from "./capture";

export const MAX_ORDER_METADATA_BYTES = 32_000;
export const MAX_EXPORT_MANIFEST_BYTES = 1_048_576;
type Snapshot = { bytes: Uint8Array; etag: string };
function memoryObject(value: Snapshot | null) {
  return value && {
    size: value.bytes.byteLength, etag: value.etag,
    arrayBuffer: async () => value.bytes.slice().buffer,
    json: async () => JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value.bytes)),
  };
}

// Request-local storage view. Metadata is fresh on every read (including auth
// rechecks and recovery CAS readback); proof artifacts form one immutable view.
// This is a read bound, not a second credential or entitlement authority.
export function createOrderReadSnapshot(source: RuntimeEnv) {
  let expired = false;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const assertActive = () => { if (expired) throw new Error("order_evidence_unavailable"); };
  const cancel = () => {
    expired = true;
    for (const reader of readers) void reader.cancel("order_evidence_deadline").catch(() => {});
  };
  const readObject = async (key: string, limit: number): Promise<Snapshot | null> => {
    assertActive();
    const object = await source.PROOFS.get(key);
    if (expired) { void object?.body?.cancel().catch(() => {}); assertActive(); }
    if (!object) return null;
    if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > limit || !object.body) {
      void object.body?.cancel().catch(() => {});
      throw new Error("order_evidence_unavailable");
    }
    const reader = object.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    readers.add(reader);
    const bytes = new Uint8Array(object.size);
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        assertActive();
        if (done) break;
        size += value.byteLength;
        if (size > limit || size > object.size) throw new Error("order_evidence_unavailable");
        bytes.set(value, size - value.byteLength);
      }
      if (size !== object.size) throw new Error("order_evidence_unavailable");
    } finally {
      readers.delete(reader);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return { bytes, etag: object.etag };
  };
  const artifactLimits = new Map<string, number>();
  const snapshot = new Map<string, Promise<Snapshot | null>>();
  const getArtifact = (key: string) => {
    assertActive();
    const limit = artifactLimits.get(key);
    if (limit === undefined) throw new Error("order_evidence_unavailable");
    if (!snapshot.has(key)) snapshot.set(key, readObject(key, limit));
    return snapshot.get(key)!;
  };
  const proofs = {
    get: async (key: string) => memoryObject(await (artifactLimits.has(key) ? getArtifact(key) : readObject(key, MAX_ORDER_METADATA_BYTES))),
    // Recovery uses Core's existing CAS; the storage view never invents a write.
    put: (key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) => { assertActive(); return source.PROOFS.put(key, value, options); },
  } as unknown as R2Bucket;
  return {
    env: { ...source, PROOFS: proofs }, assertActive, cancel,
    allowArtifactsFor(proofId: string) {
      assertActive();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(proofId)) throw new Error("order_evidence_unavailable");
      artifactLimits.set(`${proofId}/page.html`, MAX_HTML_BYTES);
      artifactLimits.set(`${proofId}/page.md`, MAX_MARKDOWN_BYTES);
      artifactLimits.set(`${proofId}/screenshot.png`, MAX_SCREENSHOT_BYTES);
      artifactLimits.set(`${proofId}/manifest.json`, MAX_EXPORT_MANIFEST_BYTES);
    },
    async readArtifact(key: string): Promise<Uint8Array> {
      const value = await getArtifact(key);
      assertActive();
      if (!value) throw new Error("order_evidence_unavailable");
      return value.bytes;
    },
  };
}
