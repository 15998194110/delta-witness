import { sha256 } from "./crypto";
import { withinDeadline } from "./deadline";

export const MAX_URL_LENGTH = 2_048;
export const MAX_CAPTURE_BODY_BYTES = 4_096;
export const MAX_PREFLIGHT_BODY_BYTES = 8_192;
export const MAX_PARTNER_BODY_BYTES = 12_288;
export const MAX_REDIRECTS = 5;
export const MAX_PAYMENT_HEADER_BYTES = 32_768;

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.google.internal.",
  "instance-data",
  "instance-data.ec2.internal",
]);

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

export function isNonPublicIpv4(host: string): boolean {
  const octets = parseIpv4(normalizeHost(host));
  if (!octets) return false;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Words(host: string): number[] | null {
  try {
    // WHATWG canonicalization handles expanded/IPv4-tail forms consistently
    // with the HTTP client; a text prefix check misses ::ffff:7f00:1.
    const canonical = normalizeHost(new URL(`http://[${normalizeHost(host)}]/`).hostname);
    const sides = canonical.split("::");
    const left = sides[0] ? sides[0].split(":").map(x => parseInt(x, 16)) : [];
    const right = sides.length === 2 && sides[1] ? sides[1].split(":").map(x => parseInt(x, 16)) : [];
    const words = sides.length === 2 ? [...left, ...Array(8-left.length-right.length).fill(0), ...right] : left;
    return words.length === 8 && words.every(n => Number.isInteger(n) && n >= 0 && n <= 65535) ? words : null;
  } catch { return null; }
}

export function isNonPublicIpv6(host: string): boolean {
  if (!normalizeHost(host).includes(":")) return false;
  const words = ipv6Words(host);
  if (!words) return true;
  // Conservative public-web policy: global unicast only, excluding special,
  // documentation and transition ranges. This also denies mapped/NAT64 local
  // destinations; it does not infer public reachability from encoded IPv4.
  // IANA IPv6 special-purpose registry (reviewed 2026-11-04).
  return (words[0] & 0xe000) !== 0x2000 ||
    (words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) ||
    words[0] === 0x2002 || words[0] === 0x3ffe || (words[0] === 0x3fff && words[1] < 0x1000);
}

export function validateTarget(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("url_required");
  if (raw.length > MAX_URL_LENGTH) throw new Error("url_too_long");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported_scheme");
  if (url.username || url.password) throw new Error("userinfo_not_allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("unsafe_port_not_allowed");
  if (url.href.length > MAX_URL_LENGTH) throw new Error("url_too_long");

  const host = normalizeHost(url.hostname);
  if (!host) throw new Error("hostname_required");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    METADATA_HOSTS.has(host) ||
    isNonPublicIpv4(host) ||
    isNonPublicIpv6(host)
  ) {
    throw new Error("private_target_not_allowed");
  }
  return url;
}

export async function assertPublicDns(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const normalized = normalizeHost(host);
  if (isNonPublicIpv4(normalized) || isNonPublicIpv6(normalized)) {
    throw new Error("private_target_not_allowed");
  }
  if (parseIpv4(normalized) || normalized.includes(":")) return;

  let sawAddress = false;
  for (const type of ["A", "AAAA"] as const) {
    const response = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(normalized)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
        cf: { cacheTtl: 60, cacheEverything: true },
      },
    );
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("dns_resolver_redirect_not_allowed");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error("dns_resolution_failed");
    }
    const body = (await readJsonResponseBounded(response, 64_000)) as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };
    // A public A response cannot excuse an unavailable/private AAAA view.
    if (!body || body.Status !== 0 || (body.Answer !== undefined && !Array.isArray(body.Answer))) throw new Error("dns_resolution_failed");
    for (const answer of body.Answer ?? []) {
      if (!answer || typeof answer !== "object") throw new Error("dns_resolution_failed");
      if (answer.type === 1) {
        if (typeof answer.data !== "string" || !parseIpv4(answer.data)) throw new Error("dns_resolution_failed");
        sawAddress = true;
        if (isNonPublicIpv4(answer.data)) throw new Error("private_dns_target_not_allowed");
      }
      if (answer.type === 28) {
        if (typeof answer.data !== "string" || !ipv6Words(answer.data)) throw new Error("dns_resolution_failed");
        sawAddress = true;
        if (isNonPublicIpv6(answer.data)) throw new Error("private_dns_target_not_allowed");
      }
    }
  }
  if (!sawAddress) throw new Error("dns_resolution_failed");
}

export type RedirectResolution = {
  requestedUrl: string;
  finalUrl: string;
  redirects: Array<{ status: number; from: string; to: string }>;
};

export async function resolvePublicRedirects(
  raw: string,
  fetchImpl: typeof fetch = fetch,
  maxRedirects = MAX_REDIRECTS,
): Promise<RedirectResolution> {
  const initial = validateTarget(raw);
  let current = initial;
  const redirects: RedirectResolution["redirects"] = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicDns(current.hostname, fetchImpl);
    const response = await fetchImpl(current, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        range: "bytes=0-0",
        "user-agent": "DELTA-Witness-Preflight/0.6 (+https://delta-witness-api.ruphussten.workers.dev/docs)",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();

    if (response.status < 300 || response.status >= 400) {
      return { requestedUrl: initial.toString(), finalUrl: current.toString(), redirects };
    }
    if (hop === maxRedirects) throw new Error("too_many_redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect_location_missing");
    const next = validateTarget(new URL(location, current).toString());
    redirects.push({ status: response.status, from: current.toString(), to: next.toString() });
    current = next;
  }
  throw new Error("too_many_redirects");
}

async function readStreamBounded(stream: ReadableStream<Uint8Array> | null, limit: number, timeoutMs: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const expiresAt = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) throw new Error("body_read_timeout");
      const { done, value } = await withinDeadline(reader.read(), remaining, "body_read_timeout", () => {
        void reader.cancel("body_read_timeout").catch(() => {});
      });
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel("body_too_large").catch(() => {});
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readJsonRequestBounded(request: Request, limit: number, timeoutMs = 10_000): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new Error("request_too_large");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("content_type_must_be_application_json");
  const bytes = await readStreamBounded(request.body, limit, timeoutMs);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
}

export async function readJsonResponseBounded(response: Response, limit: number, timeoutMs = 15_000): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new Error("upstream_response_too_large");
  const bytes = await readStreamBounded(response.body, limit, timeoutMs);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_upstream_json");
  }
}

export function getPaymentHeader(request: Request): string | null {
  const value = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
  if (!value) return null;
  if (new TextEncoder().encode(value).byteLength > MAX_PAYMENT_HEADER_BYTES) {
    throw new Error("payment_header_too_large");
  }
  return value;
}

export async function requestFingerprint(route: string, body: unknown): Promise<string> {
  return sha256(`${route}\n${JSON.stringify(body)}`);
}

export function sanitizeDimension(value: unknown, fallback = "direct"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : fallback;
}

export function referrerChannel(request: Request): string {
  const explicit = request.headers.get("x-delta-channel") ?? new URL(request.url).searchParams.get("channel");
  if (explicit) return sanitizeDimension(explicit);
  const referrer = request.headers.get("referer");
  if (!referrer) return "direct";
  try {
    const host = normalizeHost(new URL(referrer).hostname);
    if (host.endsWith("google.com") || host.endsWith("bing.com") || host.endsWith("duckduckgo.com")) return "search";
    return "referral";
  } catch {
    return "direct";
  }
}

export const BROWSER_REJECT_PATTERNS = [
  "^https?://[^/]*@",
  "^https?://(?:localhost|(?:[^./]+\\.)+(?:localhost|local))(?::|/|$)",
  "^https?://(?:0|10|127|169\\.254|172\\.(?:1[6-9]|2[0-9]|3[01])|192\\.168)(?:\\.|:|/|$)",
  "^https?://(?:100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))(?:\\.|:|/|$)",
  "^https?://\\[(?:::1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*|ff[0-9a-f:]*)\\](?::|/|$)",
  "^https?://\\[(?:::|::ffff:|64:ff9b:|100:|2001:(?:0:|1:|2:|10:|20:|30:|db8:)|2002:|3ffe:|3fff:|5f00:)[^\\]]*\\]",
  "^https?://(?:192\\.0\\.(?:0|2)|192\\.88\\.99|198\\.(?:18|19)|198\\.51\\.100|203\\.0\\.113)(?:\\.|:|/|$)",
  "^https?://(?:169\\.254\\.169\\.254|metadata\\.google\\.internal|instance-data\\.ec2\\.internal)(?::|/|$)",
];
