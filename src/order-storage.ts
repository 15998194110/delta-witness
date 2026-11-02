import type { RuntimeEnv } from "./env";
import { MAX_HTML_BYTES, MAX_MARKDOWN_BYTES, MAX_SCREENSHOT_BYTES } from "./capture";
import { withinDeadline } from "./deadline";

export const MAX_ORDER_METADATA_BYTES = 32_000;
export const MAX_EXPORT_MANIFEST_BYTES = 1_048_576;
export const ORDER_METADATA_DEADLINE_MS = 15_000;
export const ORDER_WRITE_DEADLINE_MS = 15_000;

export class MetadataReadError extends Error {
  constructor() { super("order_evidence_unavailable"); this.name = "MetadataReadError"; }
}
export class StorageWriteError extends Error {
  constructor() { super("order_storage_write_unconfirmed"); this.name = "StorageWriteError"; }
}

// A rejected/timed-out provider write may still commit. Never retry here, infer
// absence, delete a claim, or grant its late acknowledgement new authority.
export async function writeOrderObject(env: RuntimeEnv, key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) {
  try {
    return await withinDeadline(Promise.resolve().then(() => env.PROOFS.put(key, value, options)), ORDER_WRITE_DEADLINE_MS, "order_storage_write_unconfirmed");
  } catch { throw new StorageWriteError(); }
}
type Snapshot = { bytes: Uint8Array; etag: string };
function memoryObject(value: Snapshot | null) {
  return value && {
    size: value.bytes.byteLength, etag: value.etag,
    // Nested bounded readers consume a fresh stream of the same immutable
    // bytes, never an unbounded/json-only provider shortcut.
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(value.bytes.slice()); controller.close(); } }),
    arrayBuffer: async () => value.bytes.slice().buffer,
    json: async () => JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value.bytes)),
  };
}

// Shared metadata boundary for direct/legacy paths as well as already-scoped
// order recovery. Unavailable evidence is never interpreted as a missing order.
export async function readOrderMetadata<T>(env: RuntimeEnv, key: string, byteLimit = MAX_ORDER_METADATA_BYTES): Promise<{ record: T; etag: string } | null> {
  return readSnapshotMetadata<T>(createOrderReadSnapshot(env, byteLimit), key);
}
// A manifest has its separate existing 1 MiB cap; general order metadata keeps
// the strict 32 KiB default and 256 KiB maximum override.
export async function readProofManifestMetadata<T>(env: RuntimeEnv, proofId: string): Promise<{ record: T; etag: string } | null> {
  const snapshot = createOrderReadSnapshot(env);
  snapshot.allowArtifactsFor(proofId);
  return readSnapshotMetadata<T>(snapshot, `${proofId}/manifest.json`);
}
async function readSnapshotMetadata<T>(snapshot: ReturnType<typeof createOrderReadSnapshot>, key: string): Promise<{ record: T; etag: string } | null> {
  try {
    return await withinDeadline((async () => {
      const object = await snapshot.env.PROOFS.get(key);
      snapshot.assertActive();
      if (!object) return null;
      const record = await object.json<T>();
      snapshot.assertActive();
      return { record, etag: object.etag };
    })(), ORDER_METADATA_DEADLINE_MS, "order_evidence_unavailable", snapshot.cancel);
  } catch { throw new MetadataReadError(); }
  finally { snapshot.cancel(); }
}

// Request-local storage view. Metadata is fresh on every read (including auth
// rechecks and recovery CAS readback); proof artifacts form one immutable view.
// This is a read bound, not a second credential or entitlement authority.
export function createOrderReadSnapshot(source: RuntimeEnv, metadataByteLimit = MAX_ORDER_METADATA_BYTES) {
  if (!Number.isSafeInteger(metadataByteLimit) || metadataByteLimit < 1 || metadataByteLimit > 262_144) throw new Error("invalid_metadata_byte_limit");
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
    get: async (key: string) => memoryObject(await (artifactLimits.has(key) ? getArtifact(key) : readObject(key, metadataByteLimit))),
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
