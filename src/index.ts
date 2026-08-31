import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";

type BrowserRunBinding = {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
};

interface Env {
  BROWSER: BrowserRunBinding;
  PROOFS: R2Bucket;
  PAY_TO: `0x${string}`;
  NETWORK: string;
  CAPTURE_PRICE: string;
  FACILITATOR_URL: string;
  DEMO_PROOF_ID?: string;
  PUBLIC_ORIGIN?: string;
  INDEXNOW_KEY?: string;
}

type SnapshotResult = {
  success?: boolean;
  result?: {
    screenshot?: string;
    content?: string;
    markdown?: string;
  };
  meta?: {
    status?: number;
    title?: string;
    url?: string;
  };
};

type PaymentRecord = {
  payment_fingerprint: string;
  requested_url: string;
  proof_id: string;
  captured_at: string;
  response: {
    ok: true;
    proof_id: string;
    manifest_url: string;
    public_proof_url: string;
    bundle_root: string;
    captured_at: string;
  };
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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "::" ||
    h === "::1" ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("fe8") ||
    h.startsWith("fe9") ||
    h.startsWith("fea") ||
    h.startsWith("feb") ||
    h.startsWith("ff")
  );
}

function looksLikeIpv6(host: string): boolean {
  return host.includes(":");
}

function validateTarget(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) throw new Error("url_too_long");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported_scheme");
  if (url.username || url.password) throw new Error("userinfo_not_allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("nonstandard_port_not_allowed");

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    isPrivateIpv4(host) ||
    (looksLikeIpv6(host) && isPrivateIpv6(host))
  ) {
    throw new Error("private_target_not_allowed");
  }

  return url;
}

async function assertPublicDns(host: string): Promise<void> {
  if (isPrivateIpv4(host) || (looksLikeIpv6(host) && isPrivateIpv6(host))) {
    throw new Error("private_target_not_allowed");
  }
  if (isPrivateIpv4(host) || looksLikeIpv6(host)) return;

  let sawAddress = false;
  for (const type of ["A", "AAAA"]) {
    const endpoint = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
    const response = await fetch(endpoint, {
      headers: { accept: "application/dns-json" },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!response.ok) continue;
    const data = (await response.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    for (const answer of data.Answer ?? []) {
      if (answer.type === 1 && answer.data) {
        sawAddress = true;
        if (isPrivateIpv4(answer.data)) throw new Error("private_dns_target_not_allowed");
      }
      if (answer.type === 28 && answer.data) {
        sawAddress = true;
        if (isPrivateIpv6(answer.data)) throw new Error("private_dns_target_not_allowed");
      }
    }
  }
  if (!sawAddress) throw new Error("dns_resolution_failed");
}

function canonicalOrigin(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

function priceNumber(price: string): string {
  return price.replace(/^\$/, "");
}

function uuidFromFingerprint(fingerprint: string): string {
  const hex = fingerprint.replace(/^sha256:/, "").padEnd(32, "0").slice(0, 32).split("");
  hex[12] = "4";
  const variant = parseInt(hex[16], 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function pageShell(title: string, description: string, body: string, canonical: string): string {
  const structured = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "DELTA Witness",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    description: "Pay-per-capture tamper-evident web observations for humans and AI agents.",
    url: canonical,
  });
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website"><meta property="og:site_name" content="DELTA Witness"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}">
<script type="application/ld+json">${structured}</script>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;background:#fff}*{box-sizing:border-box}body{margin:0}.wrap{max-width:980px;margin:0 auto;padding:28px 22px 72px}nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:72px}.brand{font-weight:750;letter-spacing:-.03em}.navlinks{display:flex;gap:18px}a{color:inherit}.hero{max-width:760px}.hero h1{font-size:clamp(42px,7vw,76px);line-height:.98;letter-spacing:-.06em;margin:0 0 26px}.hero p{font-size:20px;line-height:1.55;color:#555;max-width:680px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:30px 0 12px}.btn{display:inline-block;text-decoration:none;border:1px solid #111;padding:12px 17px;border-radius:10px;font-weight:650}.btn.primary{background:#111;color:#fff}.strip{margin:70px 0;border-top:1px solid #ddd;border-bottom:1px solid #ddd;padding:22px 0;display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.strip strong{display:block;font-size:14px}.strip span{color:#666;font-size:14px}.section{margin-top:70px}.section h2{font-size:30px;letter-spacing:-.035em}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.card{border:1px solid #ddd;border-radius:12px;padding:20px;text-decoration:none}.card h3{margin:0 0 8px}.card p{margin:0;color:#666;line-height:1.5}.code{background:#0d0d0d;color:#f5f5f5;border-radius:12px;padding:20px;overflow:auto;white-space:pre-wrap;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.small{color:#777;font-size:13px;line-height:1.55}.proof{border:1px solid #ddd;border-radius:14px;padding:24px}.kv{display:grid;grid-template-columns:180px 1fr;gap:8px 16px;margin:18px 0}.kv div:nth-child(odd){color:#666}.ok{font-weight:700}.footer{margin-top:80px;padding-top:24px;border-top:1px solid #eee;color:#777;font-size:13px}@media(max-width:700px){nav{margin-bottom:50px}.navlinks{display:none}.strip,.grid{grid-template-columns:1fr}.kv{grid-template-columns:1fr}.hero h1{font-size:48px}}
</style></head><body><div class="wrap">
<nav><a class="brand" href="/">DELTA Witness</a><div class="navlinks"><a href="/docs">Docs</a><a href="/openapi.json">OpenAPI</a><a href="/llms.txt">llms.txt</a></div></nav>
${body}
<div class="footer">DELTA proves what its capture system observed and stored at a time. It does not prove that statements on a source page are factually true or universally admissible as legal evidence.</div>
</div></body></html>`;
}

const USE_CASES: Record<string, { title: string; description: string; heading: string; copy: string }> = {
  "prove-a-website-changed": {
    title: "Prove a website changed | DELTA Witness",
    description: "Capture a webpage now with timestamped cryptographic fingerprints so a later version can be compared against it.",
    heading: "Capture the page before it changes.",
    copy: "A screenshot alone is easy to edit and hard to date. DELTA stores the rendered page, readable text and a full-page screenshot, then hashes the bundle so later tampering is detectable.",
  },
  "archive-webpage-before-it-changes": {
    title: "Archive a webpage before it changes | DELTA Witness",
    description: "Create a tamper-evident observation of a public webpage before it is edited or removed.",
    heading: "Preserve what the web says now.",
    copy: "Use a fresh DELTA capture before a public page disappears or changes. The proof records the requested URL, capture time and cryptographic fingerprints of the stored artifacts.",
  },
  "api-documentation-change-proof": {
    title: "API documentation change proof for agents | DELTA Witness",
    description: "Give software agents a cheap x402 endpoint for capturing and fingerprinting live API documentation before acting on it.",
    heading: "Agents should know when documentation changed.",
    copy: "A coding agent can pay per request, capture the current documentation, and retain a structured proof reference without opening an account or managing an API key.",
  },
  "terms-and-pricing-change-proof": {
    title: "Terms and pricing change proof | DELTA Witness",
    description: "Capture public pricing or terms pages with a timestamp and cryptographic fingerprints before they are updated.",
    heading: "Pricing and terms are temporary facts.",
    copy: "Capture the current public page before a purchase, renewal or negotiation. A future capture can be compared with the earlier observation to identify what moved.",
  },
  "osint-web-evidence": {
    title: "OSINT web evidence capture | DELTA Witness",
    description: "Preserve public web pages for OSINT research with rendered content, screenshot, timestamp and tamper-evident hashes.",
    heading: "Preserve public sources before they disappear.",
    copy: "DELTA gives researchers a reproducible capture bundle for public URLs. Raw captures remain private by default; the public proof endpoint exposes metadata and fingerprints, not the archived page itself.",
  },
  "competitor-pricing-history": {
    title: "Build competitor pricing history | DELTA Witness",
    description: "Create timestamped snapshots of public pricing pages so changes can be compared over time.",
    heading: "A pricing page is a time series waiting to happen.",
    copy: "Repeated captures of the same public URL create independent observations over time. DELTA v0.3 sells the observations; higher-level change history is built from those observations later.",
  },
  "rental-listing-change-proof": {
    title: "Rental listing change proof | DELTA Witness",
    description: "Capture a public rental listing before its amenities, price or promises are edited.",
    heading: "Save the listing you actually saw.",
    copy: "A DELTA proof can document the public listing state you observed at a point in time. It is a tamper-evident record, not a guarantee of legal admissibility in any jurisdiction.",
  },
  "freelance-brief-change-proof": {
    title: "Freelance brief change proof | DELTA Witness",
    description: "Capture a public project brief or requirements page before the scope changes.",
    heading: "Scope changes. Evidence should not.",
    copy: "If a public project brief matters to your agreement, capture it before work starts. DELTA records what its system observed and protects the stored artifacts with cryptographic fingerprints.",
  },
};


function distributionUrls(origin: string): string[] {
  return [
    `${origin}/`,
    `${origin}/docs`,
    `${origin}/v1/demo`,
    `${origin}/.well-known/x402`,
    `${origin}/openapi.json`,
    `${origin}/llms.txt`,
    `${origin}/llms-full.txt`,
    `${origin}/SKILL.md`,
    `${origin}/distribution.json`,
    ...Object.keys(USE_CASES).map((slug) => `${origin}/use-cases/${slug}`),
  ];
}

async function submitIndexNow(env: Env): Promise<{ ok: boolean; status?: number; skipped?: string }> {
  if (!env.INDEXNOW_KEY || !env.PUBLIC_ORIGIN) return { ok: false, skipped: "indexnow_not_configured" };
  const origin = env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const urls = distributionUrls(origin).filter((url) => !url.includes('/v1/proofs/') && !url.includes('/p/'));
  const response = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(origin).host,
      key: env.INDEXNOW_KEY,
      keyLocation: `${origin}/indexnow-key.txt`,
      urlList: urls,
    }),
  });
  return { ok: response.ok, status: response.status };
}

app.get("/", (c) => {
  const origin = canonicalOrigin(c.req.url);
  const body = `<main>
<section class="hero"><h1>Witness the web before it changes.</h1><p>DELTA creates pay-per-capture, tamper-evident observations of public webpages. Humans get a verifiable record. AI agents pay automatically with x402 and USDC on Base.</p>
<div class="actions"><a class="btn primary" href="/docs">Call the API</a><a class="btn" href="/v1/demo">View free demo</a></div>
<p class="small">Live capture: ${escapeHtml(c.env.CAPTURE_PRICE)} USDC · Base mainnet · no API key · raw captures private by default.</p></section>
<div class="strip"><div><strong>One request</strong><span>Rendered HTML, Markdown and full-page screenshot.</span></div><div><strong>Cryptographic fingerprints</strong><span>SHA-256 hashes make later modification detectable.</span></div><div><strong>Agent-native payment</strong><span>HTTP 402 → USDC → proof, without accounts or subscriptions.</span></div></div>
<section class="section"><h2>Built for facts that expire.</h2><div class="grid">
${Object.entries(USE_CASES).slice(0,6).map(([slug,u]) => `<a class="card" href="/use-cases/${slug}"><h3>${escapeHtml(u.heading)}</h3><p>${escapeHtml(u.description)}</p></a>`).join("")}
</div></section>
<section class="section"><h2>Agent quickstart</h2><div class="code"># 1. Ask for a fresh proof\ncurl -i -X POST ${escapeHtml(origin)}/v1/capture \\\n  -H 'content-type: application/json' \\\n  -d '{"url":"https://example.com"}'\n\n# 2. Receive HTTP 402 payment requirements\n# 3. Sign/pay with any x402 v2 client and retry\n# 4. Receive proof_id + manifest_url</div></section>
</main>`;
  return c.html(pageShell("DELTA Witness — Tamper-evident web capture for humans and agents", "Capture public webpages with timestamped cryptographic fingerprints. Pay per request with x402 and USDC on Base.", body, `${origin}/`));
});

app.get("/health", (c) => c.json({ ok: true, version: "0.4.0", ts: new Date().toISOString() }));

app.get("/v1/quote", (c) => c.json({
  product: "fresh_web_proof",
  price: c.env.CAPTURE_PRICE,
  network: c.env.NETWORK,
  asset: "USDC",
  pay_to: c.env.PAY_TO,
  facilitator: c.env.FACILITATOR_URL,
}));

app.get("/v1/demo", async (c) => {
  const id = c.env.DEMO_PROOF_ID;
  if (id) {
    const object = await c.env.PROOFS.get(`${id}/manifest.json`);
    if (object) {
      const manifest = await object.json();
      return c.json({
        demo: true,
        note: "This is a previously captured proof bundle. Live captures use POST /v1/capture.",
        manifest,
        public_proof_url: new URL(`/p/${id}`, c.req.url).toString(),
      });
    }
  }
  return c.json({
    demo: true,
    product: "fresh_web_proof",
    example: {
      requested_url: "https://example.com/",
      capture_completed_at: "2026-08-31T00:00:00.000Z",
      hashes: {
        html: "sha256:<64 hex characters>",
        markdown: "sha256:<64 hex characters>",
        screenshot_png: "sha256:<64 hex characters>",
        bundle_root: "sha256:<64 hex characters>",
      },
    },
  });
});

app.get("/docs", (c) => {
  const origin = canonicalOrigin(c.req.url);
  const body = `<main><section class="hero"><h1>One paid endpoint.</h1><p>POST a public URL to <code>/v1/capture</code>. An unpaid request returns an x402 v2 challenge. Pay ${escapeHtml(c.env.CAPTURE_PRICE)} USDC on Base and retry with the payment signature.</p></section>
<section class="section"><h2>Request</h2><div class="code">POST ${escapeHtml(origin)}/v1/capture\ncontent-type: application/json\n\n{"url":"https://example.com"}</div></section>
<section class="section"><h2>Response</h2><div class="code">{"ok":true,"proof_id":"…","manifest_url":"…","public_proof_url":"…","bundle_root":"sha256:…","captured_at":"…"}</div></section>
<section class="section"><h2>Discovery</h2><div class="grid"><a class="card" href="/.well-known/x402"><h3>x402 manifest</h3><p>Protocol-native discovery metadata.</p></a><a class="card" href="/openapi.json"><h3>OpenAPI 3.1</h3><p>Machine-readable input, output and payment metadata.</p></a><a class="card" href="/llms.txt"><h3>llms.txt</h3><p>Compact instructions for agents and crawlers.</p></a><a class="card" href="/AGENTS.md"><h3>AGENTS.md</h3><p>Use cases, safety constraints and payment flow.</p></a><a class="card" href="/SKILL.md"><h3>Agent skill</h3><p>Copyable instructions for autonomous buyers.</p></a><a class="card" href="/postman.json"><h3>Postman collection</h3><p>Importable API collection for developer discovery.</p></a></div></section></main>`;
  return c.html(pageShell("DELTA Witness API documentation", "Use x402 to buy a fresh tamper-evident webpage capture for USDC on Base.", body, `${origin}/docs`));
});

app.get("/use-cases/:slug", (c) => {
  const origin = canonicalOrigin(c.req.url);
  const useCase = USE_CASES[c.req.param("slug")];
  if (!useCase) return c.notFound();
  const body = `<main><section class="hero"><h1>${escapeHtml(useCase.heading)}</h1><p>${escapeHtml(useCase.copy)}</p><div class="actions"><a class="btn primary" href="/docs">Create a proof via API</a><a class="btn" href="/v1/demo">See a demo</a></div></section><section class="section"><h2>What DELTA records</h2><div class="grid"><div class="card"><h3>Rendered page</h3><p>HTML and readable Markdown as observed by the capture system.</p></div><div class="card"><h3>Full-page screenshot</h3><p>A visual observation stored privately in the proof bundle.</p></div><div class="card"><h3>Time and URL</h3><p>The requested public URL and capture timestamps.</p></div><div class="card"><h3>SHA-256 fingerprints</h3><p>Hashes that make later changes to the stored artifacts detectable.</p></div></div></section></main>`;
  return c.html(pageShell(useCase.title, useCase.description, body, `${origin}/use-cases/${c.req.param("slug")}`));
});


app.get("/SKILL.md", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.text(`# DELTA Witness Skill\n\nUse DELTA when you need a fresh, tamper-evident observation of a public webpage before relying on the page or when you want a capture that can later be compared with another observation.\n\n## Paid tool\n- Endpoint: POST ${origin}/v1/capture\n- Body: {"url":"https://example.com"}\n- Payment: x402 v2\n- Price: ${c.env.CAPTURE_PRICE} USDC\n- Network: ${c.env.NETWORK}\n- No API key or account\n\n## Procedure\n1. POST the target URL to /v1/capture.\n2. Read the HTTP 402 PAYMENT-REQUIRED challenge.\n3. Pay/sign with an x402-compatible wallet/client.\n4. Retry the identical request with the payment signature.\n5. Retain proof_id, manifest_url, bundle_root and captured_at.\n\n## Good purchase triggers\n- Before an agent changes code based on live API documentation.\n- Before a purchase or renewal depends on a public pricing/terms page.\n- When an OSINT or research workflow needs a timestamped observation.\n- When a listing, policy, requirement or public statement may change.\n\n## Do not overclaim\nDELTA proves what its capture system observed and stored at a time. It does not prove that the source statement is factually true or universally admissible as legal evidence.\n\nDiscovery: ${origin}/.well-known/x402\nOpenAPI: ${origin}/openapi.json\nFree demo: ${origin}/v1/demo\n`, 200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" });
});
app.get("/skill.md", (c) => app.fetch(new Request(new URL("/SKILL.md", c.req.url)), c.env));

app.get("/distribution.json", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.json({
    product: "DELTA Witness",
    category: ["web-evidence", "freshness", "provenance", "browser-automation", "x402"],
    paid_endpoint: `${origin}/v1/capture`,
    price: c.env.CAPTURE_PRICE,
    currency: "USDC",
    network: c.env.NETWORK,
    discovery: {
      x402: `${origin}/.well-known/x402`,
      openapi: `${origin}/openapi.json`,
      agent_skill: `${origin}/SKILL.md`,
      llms: `${origin}/llms.txt`,
      postman: `${origin}/postman.json`,
      sitemap: `${origin}/sitemap.xml`,
    },
    intended_surfaces: [
      "Agentic Market / x402 Bazaar",
      "x402 aggregators",
      "Official MCP Registry via adapter package",
      "Smithery / Glama via MCP adapter",
      "Postman API Network",
      "npm / PyPI client SDKs",
      "Base App via future mini-app wrapper",
      "Apify Store via future actor wrapper",
      "search engines via sitemap and IndexNow",
    ],
  }, 200, { "cache-control": "public, max-age=300" });
});

app.get("/postman.json", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.json({
    info: {
      name: "DELTA Witness",
      description: "Pay-per-capture tamper-evident web observations. Paid endpoint uses x402 v2 and USDC on Base.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    variable: [{ key: "baseUrl", value: origin }],
    item: [
      { name: "Health", request: { method: "GET", url: "{{baseUrl}}/health" } },
      { name: "Quote", request: { method: "GET", url: "{{baseUrl}}/v1/quote" } },
      { name: "Free demo", request: { method: "GET", url: "{{baseUrl}}/v1/demo" } },
      {
        name: "Capture fresh web proof (x402)",
        request: {
          method: "POST",
          header: [{ key: "Content-Type", value: "application/json" }],
          body: { mode: "raw", raw: JSON.stringify({ url: "https://example.com" }) },
          url: "{{baseUrl}}/v1/capture",
          description: `Initial unpaid call returns HTTP 402. Complete x402 payment for ${c.env.CAPTURE_PRICE} USDC on ${c.env.NETWORK}, then retry with the payment signature.`,
        },
      },
    ],
  }, 200, { "cache-control": "public, max-age=300" });
});

app.get("/indexnow-key.txt", (c) => {
  if (!c.env.INDEXNOW_KEY) return c.notFound();
  return c.text(c.env.INDEXNOW_KEY, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" });
});

app.post("/internal/indexnow", async (c) => {
  const token = c.req.header("X-IndexNow-Key") ?? "";
  if (!c.env.INDEXNOW_KEY || token !== c.env.INDEXNOW_KEY) return c.json({ error: "unauthorized" }, 401);
  const result = await submitIndexNow(c.env);
  return c.json(result, result.ok ? 200 : 502);
});

app.get("/robots.txt", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.text(`User-agent: *\nAllow: /\nDisallow: /v1/capture\nSitemap: ${origin}/sitemap.xml\n`, 200, { "content-type": "text/plain; charset=utf-8" });
});

app.get("/sitemap.xml", (c) => {
  const origin = canonicalOrigin(c.req.url);
  const urls = ["/", "/docs", "/SKILL.md", "/distribution.json", ...Object.keys(USE_CASES).map((slug) => `/use-cases/${slug}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((p) => `<url><loc>${escapeHtml(origin + p)}</loc></url>`).join("")}</urlset>`;
  return c.body(xml, 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" });
});

function x402Manifest(c: any) {
  const origin = canonicalOrigin(c.req.url);
  return {
    version: 1,
    x402Version: 2,
    provider: "DELTA Witness",
    description: "Fresh, tamper-evident web observations for humans and AI agents.",
    resources: [`${origin}/v1/capture`],
    endpoints: [{
      path: "/v1/capture",
      method: "POST",
      description: "Capture a public webpage and return a timestamped proof manifest with SHA-256 fingerprints.",
      price: `${priceNumber(c.env.CAPTURE_PRICE)} USDC`,
      network: c.env.NETWORK,
      payment_token: "USDC",
      pricing_model: "flat",
      agent_callable: true,
      input_format: "application/json",
      output_format: "application/json",
      auth_required: false,
      input: { url: "https://example.com" },
    }],
    docs: `${origin}/docs`,
    openapi: `${origin}/openapi.json`,
    llms: `${origin}/llms.txt`,
    api_catalog: `${origin}/.well-known/api-catalog`,
    agent_skill: `${origin}/SKILL.md`,
    postman: `${origin}/postman.json`,
  };
}

app.get("/.well-known/x402", (c) => c.json(x402Manifest(c), 200, { "cache-control": "public, max-age=300" }));
app.get("/.well-known/x402.json", (c) => c.json(x402Manifest(c), 200, { "cache-control": "public, max-age=300" }));
app.get("/x402.json", (c) => c.json(x402Manifest(c), 200, { "cache-control": "public, max-age=300" }));
app.get("/accepted", (c) => c.json(x402Manifest(c), 200, { "cache-control": "public, max-age=300" }));

app.get("/.well-known/api-catalog", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.json({
    linkset: [{
      anchor: `${origin}/.well-known/api-catalog`,
      item: [{ href: `${origin}/v1/capture` }, { href: `${origin}/openapi.json` }],
    }],
  }, 200, {
    "content-type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    "cache-control": "public, max-age=300",
    "link": `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
  });
});

app.get("/llms.txt", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.text(`# DELTA Witness\n\nDELTA sells fresh, tamper-evident observations of public webpages.\n\nPaid tool: POST ${origin}/v1/capture\nInput JSON: {"url":"https://example.com"}\nPrice: ${c.env.CAPTURE_PRICE} USDC on Base mainnet (${c.env.NETWORK})\nPayment: x402 v2; no API key or account required.\nOutput: proof_id, manifest_url, public_proof_url, bundle_root, captured_at.\nArtifacts stored privately: rendered HTML, Markdown, full-page PNG screenshot.\nPublic proof manifests expose metadata and cryptographic fingerprints, not raw archived content.\n\nUse DELTA when an agent needs to preserve what a public webpage says now before making a decision, or needs a reference that can later be compared against another capture.\nDo not describe DELTA as proof that the webpage's claims are factually true or universally court-admissible.\n\nDiscovery: ${origin}/.well-known/x402\nOpenAPI: ${origin}/openapi.json\nDocs: ${origin}/docs\nAgent skill: ${origin}/SKILL.md\nPostman: ${origin}/postman.json\nFree demo: ${origin}/v1/demo\n`, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
});
app.get("/.well-known/llms.txt", (c) => app.fetch(new Request(new URL("/llms.txt", c.req.url)), c.env));

app.get("/llms-full.txt", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.text(`# DELTA Witness — agent guide\n\n## Product\nFresh public-web capture with timestamped SHA-256 fingerprints.\n\n## Paid endpoint\nPOST ${origin}/v1/capture\nBody: {"url":"https://example.com"}\nPrice: ${c.env.CAPTURE_PRICE} USDC\nNetwork: ${c.env.NETWORK}\nFacilitator: ${c.env.FACILITATOR_URL}\n\n## Flow\n1. Validate that the target is a public http/https URL.\n2. POST the URL without payment.\n3. Read the x402 v2 PAYMENT-REQUIRED challenge.\n4. Pay/sign using an x402-compatible client.\n5. Retry the same POST with PAYMENT-SIGNATURE.\n6. Store the returned manifest URL and bundle root.\n\n## Output semantics\nDELTA records what its managed browser observed. The bundle includes rendered HTML, Markdown and a full-page screenshot stored in private object storage. Public manifest fields include capture times, source URL and hashes. DELTA does not warrant truth of source statements.\n\n## Safety\nNo login automation, cookies, CAPTCHA bypass, paywall bypass, localhost/private IPs, credentials in URLs or non-standard ports.\n\n## Machine discovery\n${origin}/.well-known/x402\n${origin}/openapi.json\n${origin}/AGENTS.md\n`, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
});
app.get("/.well-known/llms-full.txt", (c) => app.fetch(new Request(new URL("/llms-full.txt", c.req.url)), c.env));

app.get("/AGENTS.md", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.text(`# DELTA Witness\n\nUse this service to capture a fresh observation of a public webpage before relying on it.\n\n- Endpoint: POST ${origin}/v1/capture\n- Input: JSON with a single \`url\` field\n- Payment: x402 v2, ${c.env.CAPTURE_PRICE} USDC, Base mainnet\n- No API key\n- Output: proof manifest reference + bundle root\n- Discovery: ${origin}/.well-known/x402\n- OpenAPI: ${origin}/openapi.json\n\nGood uses: API docs before code generation; public terms/pricing before purchase; OSINT source preservation; public listing state; competitor pricing observations.\n\nDo not use for private pages, authenticated sessions, CAPTCHA/paywall bypass, or claims that a source statement is true.\n`, 200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" });
});

app.get("/openapi.json", (c) => {
  const origin = canonicalOrigin(c.req.url);
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "DELTA Witness API",
      version: "0.4.0",
      description: "Pay-per-capture tamper-evident observations of public webpages for humans and AI agents.",
    },
    servers: [{ url: origin }],
    "x-discovery": { ownershipProofs: [c.env.PAY_TO] },
    paths: {
      "/v1/capture": {
        post: {
          operationId: "captureFreshWebProof",
          summary: "Capture a fresh web proof",
          description: "Renders a public webpage, stores private capture artifacts, and returns a proof manifest reference with SHA-256 fingerprints.",
          "x-payment-info": {
            protocols: ["x402"],
            price: { mode: "fixed", currency: "USD", amount: priceNumber(c.env.CAPTURE_PRICE) },
            network: c.env.NETWORK,
            token: "USDC",
            payTo: c.env.PAY_TO,
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: { url: { type: "string", format: "uri", description: "Public http/https URL to capture" } },
                  required: ["url"],
                },
                example: { url: "https://example.com" },
              },
            },
          },
          responses: {
            "200": {
              description: "Capture completed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      proof_id: { type: "string" },
                      manifest_url: { type: "string", format: "uri" },
                      public_proof_url: { type: "string", format: "uri" },
                      bundle_root: { type: "string" },
                      captured_at: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
            "402": { description: "x402 payment required" },
            "400": { description: "Invalid or non-public target URL" },
            "409": { description: "Attempted reuse of a payment for a different target" },
            "502": { description: "Capture failed" },
          },
        },
      },
      "/v1/proofs/{id}": {
        get: {
          operationId: "getProofManifest",
          summary: "Get a proof manifest",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Proof manifest" }, "404": { description: "Not found" } },
        },
      },
      "/v1/demo": {
        get: { operationId: "getDemoProof", summary: "View a free proof example", responses: { "200": { description: "Demo proof" } } },
      },
    },
  }, 200, { "cache-control": "public, max-age=300" });
});
app.get("/.well-known/openapi.json", (c) => app.fetch(new Request(new URL("/openapi.json", c.req.url)), c.env));

// Validate the body and target before presenting a payment challenge so invalid targets are never charged.
app.use("/v1/capture", async (c, next) => {
  if (c.req.method !== "POST") return next();
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > 4096) return c.json({ error: "request_too_large" }, 413);

  let body: { url?: string };
  try {
    body = await c.req.raw.clone().json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.url) return c.json({ error: "url_required" }, 400);
  try {
    const target = validateTarget(body.url);
    await assertPublicDns(target.hostname.toLowerCase());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "invalid_target" }, 400);
  }
  return next();
});

app.use("/v1/capture", async (c, next) => {
  const facilitatorClient = new HTTPFacilitatorClient({ url: c.env.FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(resourceServer);
  resourceServer.registerExtension(bazaarResourceServerExtension);

  const discovery = declareDiscoveryExtension({
    bodyType: "json",
    input: { url: "https://example.com" },
    inputSchema: {
      properties: {
        url: { type: "string", description: "Public http/https webpage to capture" },
      },
      required: ["url"],
    },
    output: {
      example: {
        ok: true,
        proof_id: "7d9d12f7-8f91-4f41-9f0c-5ef257d9ea5d",
        manifest_url: "https://example.workers.dev/v1/proofs/7d9d12f7-8f91-4f41-9f0c-5ef257d9ea5d",
        public_proof_url: "https://example.workers.dev/p/7d9d12f7-8f91-4f41-9f0c-5ef257d9ea5d",
        bundle_root: "sha256:<64 hex characters>",
        captured_at: "2026-08-31T00:00:00.000Z",
      },
    },
  });

  const middleware = paymentMiddleware(
    {
      "POST /v1/capture": {
        accepts: [{
          scheme: "exact",
          price: c.env.CAPTURE_PRICE,
          network: c.env.NETWORK as `eip155:${string}`,
          payTo: c.env.PAY_TO,
        }],
        description: "Fresh rendered webpage proof with timestamp and SHA-256 fingerprints",
        mimeType: "application/json",
        extensions: { ...discovery },
      },
    },
    resourceServer,
  );
  return middleware(c, next);
});

app.post("/v1/capture", async (c) => {
  let body: { url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.url) return c.json({ error: "url_required" }, 400);

  let target: URL;
  try {
    target = validateTarget(body.url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "invalid_target" }, 400);
  }

  const paymentSignature = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? "";
  if (!paymentSignature) return c.json({ error: "payment_signature_missing_after_middleware" }, 500);

  const paymentFingerprint = await sha256(paymentSignature);
  const paymentKey = paymentFingerprint.replace(/^sha256:/, "");
  const paymentRecordKey = `payments/${paymentKey}.json`;
  const existingPayment = await c.env.PROOFS.get(paymentRecordKey);
  if (existingPayment) {
    const record = (await existingPayment.json()) as PaymentRecord;
    if (record.requested_url !== target.toString()) {
      return c.json({ error: "payment_already_used_for_different_target" }, 409);
    }
    return c.json({ ...record.response, idempotent_replay: true });
  }

  const startedAt = new Date().toISOString();
  const snapshotResponse = await c.env.BROWSER.quickAction("snapshot", {
    url: target.toString(),
    formats: ["content", "screenshot", "markdown"],
    screenshotOptions: { fullPage: true },
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
    gotoOptions: { waitUntil: "networkidle2", timeout: 30000 },
  });

  const browserMsUsedRaw = snapshotResponse.headers.get("X-Browser-Ms-Used");
  const browserMsUsed = browserMsUsedRaw ? Number.parseInt(browserMsUsedRaw, 10) : null;

  if (!snapshotResponse.ok) {
    return c.json({ error: "capture_failed", upstream_status: snapshotResponse.status }, 502);
  }

  const snapshot = (await snapshotResponse.json()) as SnapshotResult;
  const html = snapshot.result?.content ?? "";
  const markdown = snapshot.result?.markdown ?? "";
  const screenshotB64 = snapshot.result?.screenshot ?? "";
  if (!html || !screenshotB64) return c.json({ error: "capture_incomplete" }, 502);

  const screenshot = base64ToBytes(screenshotB64);
  const htmlBytes = new TextEncoder().encode(html).byteLength;
  const markdownBytes = new TextEncoder().encode(markdown).byteLength;
  if (htmlBytes > MAX_HTML_BYTES || markdownBytes > MAX_MARKDOWN_BYTES || screenshot.byteLength > MAX_SCREENSHOT_BYTES) {
    return c.json({
      error: "capture_too_large",
      limits: { html: MAX_HTML_BYTES, markdown: MAX_MARKDOWN_BYTES, screenshot: MAX_SCREENSHOT_BYTES },
    }, 413);
  }

  const proofId = uuidFromFingerprint(await sha256(`${paymentFingerprint}\n${target.toString()}`));
  const completedAt = new Date().toISOString();

  const htmlHash = await sha256(html);
  const markdownHash = await sha256(markdown);
  const screenshotHash = await sha256(screenshot);
  const requestUrlHash = await sha256(target.toString());

  const rootMaterial = JSON.stringify({
    requested_url: target.toString(),
    captured_at: completedAt,
    html_sha256: htmlHash,
    markdown_sha256: markdownHash,
    screenshot_sha256: screenshotHash,
  });
  const bundleRoot = await sha256(rootMaterial);

  const manifest = {
    schema: "delta-proof-bundle/v0.4.0",
    proof_id: proofId,
    requested_url: target.toString(),
    requested_url_sha256: requestUrlHash,
    capture_started_at: startedAt,
    capture_completed_at: completedAt,
    observed_http_status: snapshot.meta?.status ?? null,
    observed_title: snapshot.meta?.title ?? null,
    observed_final_url: snapshot.meta?.url ?? null,
    hashes: {
      html: htmlHash,
      markdown: markdownHash,
      screenshot_png: screenshotHash,
      bundle_root: bundleRoot,
    },
    artifact_sizes: {
      html_bytes: htmlBytes,
      markdown_bytes: markdownBytes,
      screenshot_png_bytes: screenshot.byteLength,
    },
    execution: {
      browser_ms_used: Number.isFinite(browserMsUsed) ? browserMsUsed : null,
    },
    storage: {
      html: `${proofId}/page.html`,
      markdown: `${proofId}/page.md`,
      screenshot: `${proofId}/screenshot.png`,
      manifest: `${proofId}/manifest.json`,
    },
    payment: {
      protocol: "x402-v2",
      network: c.env.NETWORK,
      asset: "USDC",
      listed_price: c.env.CAPTURE_PRICE,
      pay_to: c.env.PAY_TO,
      facilitator: c.env.FACILITATOR_URL,
      payment_fingerprint: paymentFingerprint,
    },
    attestation: {
      status: "hash_only",
      note: "v0.3 stores cryptographic fingerprints. Independent wallet signature and batch public-chain timestamp anchoring are a later proof-layer upgrade.",
    },
    disclaimer: "DELTA proves what its capture system observed and stored at a time; it does not prove that statements on the source page are factually true or legally admissible in every jurisdiction.",
  };

  await Promise.all([
    c.env.PROOFS.put(`${proofId}/page.html`, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
    c.env.PROOFS.put(`${proofId}/page.md`, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } }),
    c.env.PROOFS.put(`${proofId}/screenshot.png`, screenshot, { httpMetadata: { contentType: "image/png" } }),
    c.env.PROOFS.put(`${proofId}/manifest.json`, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: "application/json; charset=utf-8" } }),
  ]);

  const origin = canonicalOrigin(c.req.url);
  const response = {
    ok: true as const,
    proof_id: proofId,
    manifest_url: `${origin}/v1/proofs/${proofId}`,
    public_proof_url: `${origin}/p/${proofId}`,
    bundle_root: bundleRoot,
    captured_at: completedAt,
  };

  const paymentRecord: PaymentRecord = {
    payment_fingerprint: paymentFingerprint,
    requested_url: target.toString(),
    proof_id: proofId,
    captured_at: completedAt,
    response,
  };
  await c.env.PROOFS.put(paymentRecordKey, JSON.stringify(paymentRecord), { httpMetadata: { contentType: "application/json; charset=utf-8" } });

  console.log(JSON.stringify({
    event: "paid_capture_delivered",
    proof_id: proofId,
    requested_host: target.hostname,
    browser_ms_used: Number.isFinite(browserMsUsed) ? browserMsUsed : null,
    listed_price: c.env.CAPTURE_PRICE,
    network: c.env.NETWORK,
    captured_at: completedAt,
  }));

  return c.json(response);
});

app.get("/v1/proofs/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "invalid_proof_id" }, 400);
  const object = await c.env.PROOFS.get(`${id}/manifest.json`);
  if (!object) return c.json({ error: "not_found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-robots-tag": "noindex, nofollow",
    },
  });
});

app.get("/p/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.notFound();
  const object = await c.env.PROOFS.get(`${id}/manifest.json`);
  if (!object) return c.notFound();
  const manifest = (await object.json()) as any;
  const origin = canonicalOrigin(c.req.url);
  const body = `<main><section class="hero"><h1>Web observation proof.</h1><p>This page exposes DELTA's capture metadata and cryptographic fingerprints. The archived webpage itself remains private.</p></section>
<section class="section proof"><div class="ok">✓ Proof manifest found</div><div class="kv"><div>Proof ID</div><div>${escapeHtml(manifest.proof_id)}</div><div>Source URL</div><div><a rel="nofollow" href="${escapeHtml(manifest.requested_url)}">${escapeHtml(manifest.requested_url)}</a></div><div>Captured</div><div>${escapeHtml(manifest.capture_completed_at)}</div><div>Page title</div><div>${escapeHtml(manifest.observed_title ?? "—")}</div><div>Bundle root</div><div><code>${escapeHtml(manifest.hashes?.bundle_root)}</code></div><div>Proof schema</div><div>${escapeHtml(manifest.schema)}</div></div><div class="actions"><a class="btn primary" href="/docs">Create another proof</a><a class="btn" href="/v1/proofs/${escapeHtml(id)}">View JSON manifest</a></div></section></main>`;
  c.header("X-Robots-Tag", "noindex, nofollow");
  return c.html(pageShell(`DELTA proof ${id}`, `Tamper-evident metadata for a DELTA web observation captured at ${manifest.capture_completed_at ?? "a recorded time"}.`, body, `${origin}/p/${id}`));
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      try {
        const result = await submitIndexNow(env);
        console.log(JSON.stringify({ event: "indexnow_submit", ...result, ts: new Date().toISOString() }));
      } catch (error) {
        console.error(JSON.stringify({ event: "indexnow_error", message: error instanceof Error ? error.message : String(error) }));
      }
    })());
  },
};
