import { Hono } from "hono";

type BrowserRunBinding = {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
};

interface Env {
  BROWSER: BrowserRunBinding;
  PROOFS: R2Bucket;
  PARTNER_SECRET: string;
  PUBLIC_ORIGIN: string;
}

type SnapshotResult = {
  result?: { screenshot?: string; content?: string; markdown?: string };
  meta?: { status?: number; title?: string; url?: string };
};

const app = new Hono<{ Bindings: Env }>();
const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 2_000_000;
const MAX_MARKDOWN_BYTES = 1_000_000;
const MAX_SCREENSHOT_BYTES = 8_000_000;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb") || h.startsWith("ff");
}

function validateTarget(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) throw new Error("url_too_long");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid_url"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported_scheme");
  if (url.username || url.password) throw new Error("userinfo_not_allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("nonstandard_port_not_allowed");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0" || isPrivateIpv4(host) || (host.includes(":") && isPrivateIpv6(host))) throw new Error("private_target_not_allowed");
  return url;
}

async function assertPublicDns(host: string): Promise<void> {
  if (isPrivateIpv4(host) || (host.includes(":") && isPrivateIpv6(host))) throw new Error("private_target_not_allowed");
  if (isPrivateIpv4(host) || host.includes(":")) return;
  let sawAddress = false;
  for (const type of ["A", "AAAA"]) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" } });
    if (!response.ok) continue;
    const data = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
    for (const answer of data.Answer ?? []) {
      if (answer.type === 1 && answer.data) { sawAddress = true; if (isPrivateIpv4(answer.data)) throw new Error("private_dns_target_not_allowed"); }
      if (answer.type === 28 && answer.data) { sawAddress = true; if (isPrivateIpv6(answer.data)) throw new Error("private_dns_target_not_allowed"); }
    }
  }
  if (!sawAddress) throw new Error("dns_resolution_failed");
}

function authorized(req: Request, env: Env): boolean {
  if (!env.PARTNER_SECRET) return false;
  const presented = req.headers.get("x-delta-partner-secret") ?? req.headers.get("x-rapidapi-proxy-secret") ?? "";
  return presented.length > 0 && presented === env.PARTNER_SECRET;
}

app.get("/health", (c) => c.json({ ok: true, version: "0.5.0", channel: "partner-gateway" }));

app.post("/capture", async (c) => {
  if (!authorized(c.req.raw, c.env)) return c.json({ error: "unauthorized_partner" }, 401);
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > 4096) return c.json({ error: "request_too_large" }, 413);

  let body: { url?: string; external_request_id?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.url) return c.json({ error: "url_required" }, 400);

  let target: URL;
  try {
    target = validateTarget(body.url);
    await assertPublicDns(target.hostname.toLowerCase());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "invalid_target" }, 400);
  }

  const partnerUser = c.req.header("x-rapidapi-user") ?? c.req.header("x-delta-partner-user") ?? "anonymous";
  const partnerPlan = c.req.header("x-rapidapi-subscription") ?? c.req.header("x-delta-partner-plan") ?? "unknown";
  const requestId = body.external_request_id ?? crypto.randomUUID();
  const idempotencyKey = await sha256(`${partnerUser}\n${requestId}\n${target.toString()}`);
  const recordKey = `partner-requests/${idempotencyKey.replace(/^sha256:/, "")}.json`;
  const existing = await c.env.PROOFS.get(recordKey);
  if (existing) return c.json({ ...(await existing.json() as Record<string, unknown>), idempotent_replay: true });

  const startedAt = new Date().toISOString();
  const snapshotResponse = await c.env.BROWSER.quickAction("snapshot", {
    url: target.toString(),
    formats: ["content", "screenshot", "markdown"],
    screenshotOptions: { fullPage: true },
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
    gotoOptions: { waitUntil: "networkidle2", timeout: 30000 }
  });
  const browserMsRaw = snapshotResponse.headers.get("X-Browser-Ms-Used");
  const browserMsUsed = browserMsRaw ? Number.parseInt(browserMsRaw, 10) : null;
  if (!snapshotResponse.ok) return c.json({ error: "capture_failed", upstream_status: snapshotResponse.status }, 502);

  const snapshot = await snapshotResponse.json() as SnapshotResult;
  const html = snapshot.result?.content ?? "";
  const markdown = snapshot.result?.markdown ?? "";
  const screenshotB64 = snapshot.result?.screenshot ?? "";
  if (!html || !screenshotB64) return c.json({ error: "capture_incomplete" }, 502);
  const screenshot = base64ToBytes(screenshotB64);
  const htmlBytes = new TextEncoder().encode(html).byteLength;
  const markdownBytes = new TextEncoder().encode(markdown).byteLength;
  if (htmlBytes > MAX_HTML_BYTES || markdownBytes > MAX_MARKDOWN_BYTES || screenshot.byteLength > MAX_SCREENSHOT_BYTES) return c.json({ error: "capture_too_large" }, 413);

  const completedAt = new Date().toISOString();
  const proofId = crypto.randomUUID();
  const htmlHash = await sha256(html);
  const markdownHash = await sha256(markdown);
  const screenshotHash = await sha256(screenshot);
  const bundleRoot = await sha256(JSON.stringify({ requested_url: target.toString(), captured_at: completedAt, html_sha256: htmlHash, markdown_sha256: markdownHash, screenshot_sha256: screenshotHash }));

  const manifest = {
    schema: "delta-proof-bundle/v0.5.0",
    proof_id: proofId,
    requested_url: target.toString(),
    capture_started_at: startedAt,
    capture_completed_at: completedAt,
    observed_http_status: snapshot.meta?.status ?? null,
    observed_title: snapshot.meta?.title ?? null,
    observed_final_url: snapshot.meta?.url ?? null,
    hashes: { html: htmlHash, markdown: markdownHash, screenshot_png: screenshotHash, bundle_root: bundleRoot },
    artifact_sizes: { html_bytes: htmlBytes, markdown_bytes: markdownBytes, screenshot_png_bytes: screenshot.byteLength },
    execution: { browser_ms_used: Number.isFinite(browserMsUsed) ? browserMsUsed : null },
    storage: { html: `${proofId}/page.html`, markdown: `${proofId}/page.md`, screenshot: `${proofId}/screenshot.png`, manifest: `${proofId}/manifest.json` },
    payment: { protocol: "partner-marketplace", partner_user: partnerUser, partner_plan: partnerPlan, note: "Billing is handled by the upstream marketplace; the gateway accepts only authenticated marketplace traffic." },
    attestation: { status: "hash_only" },
    disclaimer: "DELTA proves what its capture system observed and stored at a time; it does not prove that statements on the source page are factually true or legally admissible in every jurisdiction."
  };

  await Promise.all([
    c.env.PROOFS.put(`${proofId}/page.html`, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
    c.env.PROOFS.put(`${proofId}/page.md`, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } }),
    c.env.PROOFS.put(`${proofId}/screenshot.png`, screenshot, { httpMetadata: { contentType: "image/png" } }),
    c.env.PROOFS.put(`${proofId}/manifest.json`, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: "application/json; charset=utf-8" } })
  ]);

  const origin = c.env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const response = { ok: true, proof_id: proofId, manifest_url: `${origin}/v1/proofs/${proofId}`, public_proof_url: `${origin}/p/${proofId}`, bundle_root: bundleRoot, captured_at: completedAt, channel: "partner-marketplace" };
  await c.env.PROOFS.put(recordKey, JSON.stringify(response), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  console.log(JSON.stringify({ event: "partner_capture_delivered", proof_id: proofId, partner_user: partnerUser, partner_plan: partnerPlan, browser_ms_used: browserMsUsed, captured_at: completedAt }));
  return c.json(response);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default { fetch: app.fetch };
