const encoder = new TextEncoder();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function hmacSha256(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    exactArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, exactArrayBuffer(encoder.encode(input)));
  return bytesToHex(new Uint8Array(signature));
}

export async function timingSafeEqualSecret(presented: string, expected: string): Promise<boolean> {
  const [presentedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", exactArrayBuffer(encoder.encode(presented))),
    crypto.subtle.digest("SHA-256", exactArrayBuffer(encoder.encode(expected))),
  ]);
  return crypto.subtle.timingSafeEqual(presentedHash, expectedHash);
}

export function uuidFromDigest(digest: string): string {
  const hex = digest.replace(/^sha256:/, "").padEnd(32, "0").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export function randomSecret(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToHex(value);
}

