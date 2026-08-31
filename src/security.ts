import { sha256 } from "./crypto";

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

export function isNonPublicIpv6(host: string): boolean {
  const value = normalizeHost(host);
  if (!value.includes(":")) return false;
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value)) return true;
  if (value.startsWith("ff")) return true;
  const mapped = value.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return mapped ? isNonPublicIpv4(mapped[1]) : false;
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
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        cf: { cacheTtl: 60, cacheEverything: true },
      },
    );
    if (!response.ok) continue;
    const body = (await readJsonResponseBounded(response, 64_000)) as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };
    if (body.Status !== undefined && body.Status !== 0) continue;
    for (const answer of body.Answer ?? []) {
      if (answer.type === 1 && answer.data) {
        sawAddress = true;
        if (isNonPublicIpv4(answer.data)) throw new Error("private_dns_target_not_allowed");
      }
      if (answer.type === 28 && answer.data) {
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

async function readStreamBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        void reader.cancel("body_too_large");
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
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

export async function readJsonRequestBounded(request: Request, limit: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new Error("request_too_large");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("content_type_must_be_application_json");
  const bytes = await readStreamBounded(request.clone().body, limit);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
}

export async function readJsonResponseBounded(response: Response, limit: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new Error("upstream_response_too_large");
  const bytes = await readStreamBounded(response.body, limit);
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
  "^https?://(?:[^@/]+@)?(?:localhost|[^./]+\\.localhost|[^./]+\\.local)(?::|/|$)",
  "^https?://(?:0|10|127|169\\.254|172\\.(?:1[6-9]|2[0-9]|3[01])|192\\.168)(?:\\.|:|/|$)",
  "^https?://(?:100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))(?:\\.|:|/|$)",
  "^https?://\\[(?:::1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*|ff[0-9a-f:]*)\\](?::|/|$)",
  "^https?://(?:169\\.254\\.169\\.254|metadata\\.google\\.internal|instance-data\\.ec2\\.internal)(?::|/|$)",
];
