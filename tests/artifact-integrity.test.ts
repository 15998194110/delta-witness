import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32, deflateSync } from "node:zlib";
import { isPng } from "../src/png";
import { readJsonRequestBounded, readJsonResponseBounded } from "../src/security";
import { capturePage, storeCapture, type CaptureArtifacts } from "../src/capture";
import type { RuntimeEnv } from "../src/env";

function chunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, crc]);
}
function png(options: { raw?: Uint8Array; compressed?: Uint8Array; width?: number; interlace?: number; omitData?: boolean } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(options.width ?? 1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = options.interlace ?? 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr),
    ...(options.omitData ? [] : [chunk("IDAT", options.compressed ?? deflateSync(options.raw ?? Buffer.from([0,255,0,0,255])))]), chunk("IEND", Buffer.alloc(0))]);
}

afterEach(() => vi.useRealTimers());

describe("D08 PNG artifact integrity", () => {
  it("accepts a complete independently encoded RGBA image and Adam7 single pixel", async () => {
    expect(await isPng(png())).toBe(true);
    expect(await isPng(png({ interlace: 1 }))).toBe(true);
  });
  it("rejects missing image data even with valid header and end chunks", async () => {
    expect(await isPng(png({ omitData: true }))).toBe(false);
  });
  it("rejects corrupt CRC, truncated chunks, and appended bytes", async () => {
    const corrupt = png(); corrupt[corrupt.length - 1] ^= 1;
    for (const bytes of [corrupt, png().subarray(0, -1), Buffer.concat([png(), Buffer.from([0])])]) expect(await isPng(bytes)).toBe(false);
  });
  it("rejects bad compressed image even with correct chunk checksums", async () => {
    expect(await isPng(png({ compressed: Buffer.from([1,2,3,4]) }))).toBe(false);
  });
  it("rejects wrong inflated length, illegal filter, and expansion past expected size", async () => {
    for (const raw of [Buffer.alloc(4), Buffer.from([5,0,0,0,0]), Buffer.alloc(100_000)]) expect(await isPng(png({ raw }))).toBe(false);
  });
  it("rejects oversized dimensions before decompression", async () => {
    expect(await isPng(png({ width: 16_000_001 }))).toBe(false);
  });
});

describe("D08 immutable artifact publication", () => {
  function bucket() {
    const values = new Map<string, Uint8Array>();
    const put = vi.fn(async (key: string, value: string | Uint8Array, options: R2PutOptions) => {
      if (!options.onlyIf || !("etagDoesNotMatch" in options.onlyIf) || options.onlyIf.etagDoesNotMatch !== "*") throw new Error("missing_immutable_condition");
      if (values.has(key)) return null;
      values.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
      return { etag: "test" };
    });
    const get = async (key: string) => {
      const bytes = values.get(key);
      return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } : null;
    };
    return { values, env: { PROOFS: { put, get } } as unknown as RuntimeEnv };
  }
  const artifacts = { manifest: { proof_id: "immutable-test" }, html: "original", markdown: "original", screenshot: png() } as unknown as CaptureArtifacts;
  it("replays identical persisted bytes without replacing any object", async () => {
    const { values, env } = bucket();
    await storeCapture(env, artifacts);
    const original = [...values.values()];
    await storeCapture(env, artifacts);
    expect([...values.values()]).toEqual(original);
    expect(values.size).toBe(4);
  });
  it("a stale worker cannot replace the same proof with a new observation", async () => {
    const { values, env } = bucket();
    await storeCapture(env, artifacts);
    const original = [...values.entries()].map(([key, bytes]) => [key, bytes.slice()]);
    await expect(storeCapture(env, { ...artifacts, html: "changed" })).rejects.toThrow("artifact_identity_conflict");
    expect([...values.entries()]).toEqual(original);
  });
});

describe("D08/D24 operation and body deadlines", () => {
  it("bounds a body that never completes and cancels the stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const result = expect(readJsonResponseBounded(response, 100, 50)).rejects.toThrow("body_read_timeout");
    await vi.advanceTimersByTimeAsync(51);
    await result; expect(cancel).toHaveBeenCalled();
  });
  it("uses a whole-body deadline even when individual chunks keep arriving", async () => {
    vi.useFakeTimers();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }));
    const result = expect(readJsonResponseBounded(response, 100, 100)).rejects.toThrow("body_read_timeout");
    controller!.enqueue(new TextEncoder().encode('{"x":'));
    await vi.advanceTimersByTimeAsync(60);
    controller!.enqueue(new TextEncoder().encode('1'));
    await vi.advanceTimersByTimeAsync(41); await result;
  });
  it("accepts normal delayed JSON within the same deadline", async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) {
      setTimeout(() => { c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close(); }, 35);
    }}));
    const pending = readJsonResponseBounded(response, 100, 100);
    await vi.advanceTimersByTimeAsync(36);
    expect(await pending).toEqual({ ok: true });
  });
  it("bounds incoming request body without keeping an unconsumed tee alive", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const request = new Request("https://example.test", { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ cancel }), duplex: "half" } as RequestInit);
    const result = expect(readJsonRequestBounded(request, 100, 50)).rejects.toThrow("body_read_timeout");
    await vi.advanceTimersByTimeAsync(51); await result; expect(cancel).toHaveBeenCalled();
  });
  it("bounds a Browser binding that ignores its provider action timeout", async () => {
    vi.useFakeTimers();
    const quickAction = vi.fn(() => new Promise<Response>(() => {}));
    const pending = capturePage({ env: { BROWSER: { quickAction } } as unknown as RuntimeEnv, product: "capture", target: { requestedUrl: "https://example.test/", finalUrl: "https://example.test/", redirects: [] }, fulfillmentFingerprint: "offline", grossPriceUsd: 1, paymentProtocol: "x402-v2-upfront", channel: "test" });
    const result = expect(pending).rejects.toThrow("capture_response_timeout");
    await vi.advanceTimersByTimeAsync(30_001); await result;
    expect(quickAction).toHaveBeenCalledTimes(1);
  });
  it("cancels a late Browser response without starting a second observation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let resolve!: (response: Response) => void;
    const quickAction = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const pending = capturePage({ env: { BROWSER: { quickAction } } as unknown as RuntimeEnv, product: "capture", target: { requestedUrl: "https://example.test/", finalUrl: "https://example.test/", redirects: [] }, fulfillmentFingerprint: "offline", grossPriceUsd: 1, paymentProtocol: "x402-v2-upfront", channel: "test" });
    const result = expect(pending).rejects.toThrow("capture_response_timeout");
    await vi.advanceTimersByTimeAsync(30_001); await result;
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledTimes(1);
  });
});
