import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const BASE_URL = process.env.PAYAN_BASE_URL ?? "https://payanagent.com";
const TARGET_COUNT = clampInt(process.env.PAYAN_HEALTH_LIMIT, 100, 1, 100);
const CONCURRENCY = clampInt(process.env.PAYAN_HEALTH_CONCURRENCY, 8, 1, 16);
const TIMEOUT_MS = clampInt(process.env.PAYAN_HEALTH_TIMEOUT_MS, 7_500, 1_000, 30_000);
const MAX_ATTEMPTS = 3;

const jsonFile = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
const markdownFile = process.argv.find((arg) => arg.startsWith("--markdown="))?.slice(11);

const offers = await loadOffers(TARGET_COUNT);
const results = await mapLimit(offers, CONCURRENCY, probeOffer);
const json = `${JSON.stringify(results, null, 2)}\n`;
const markdown = renderMarkdown(results);

if (jsonFile) await writeFile(jsonFile, json, "utf8");
else process.stdout.write(json);

if (markdownFile) await writeFile(markdownFile, markdown, "utf8");
else process.stderr.write(`\n${markdown}`);

async function loadOffers(targetCount) {
  const collected = [];
  let cursor = null;

  while (collected.length < targetCount) {
    const remaining = targetCount - collected.length;
    const pageSize = Math.min(100, remaining);
    const url = new URL("/api/v1/offers", BASE_URL);
    url.searchParams.set("sort", "top");
    url.searchParams.set("limit", String(pageSize));
    if (cursor) url.searchParams.set("cursor", cursor);

    const payload = await fetchJsonWithRetry(url);
    const page = Array.isArray(payload?.offers) ? payload.offers : [];
    collected.push(...page);
    cursor = typeof payload?.nextCursor === "string" && payload.nextCursor ? payload.nextCursor : null;
    if (!cursor || page.length === 0) break;
  }

  return collected.slice(0, targetCount);
}

async function fetchJsonWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "DELTA-Witness-Catalog-Health/1.0" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return await response.json();
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new Error(`catalog HTTP ${response.status}`);
      }
      await sleep(backoff(attempt));
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(backoff(attempt));
    }
  }
  throw lastError ?? new Error("catalog fetch failed");
}

async function probeOffer(offer) {
  const offerId = offer?._id ?? offer?.id ?? idFromBuyUrl(offer?.buyUrl) ?? null;
  const title = String(offer?.title ?? "Untitled offer");
  const rawEndpoint = firstString(
    offer?.endpoint,
    offer?.externalUrl,
    offer?.resourceUrl,
    offer?.url,
    offer?.buyUrl ? new URL(offer.buyUrl, BASE_URL).href : null,
  );

  if (!rawEndpoint) {
    return {
      offerId,
      title,
      endpoint: null,
      status: "dead",
      httpCode: null,
      latencyMs: null,
    };
  }

  const endpoint = redactUrl(rawEndpoint);
  const methods = ["HEAD", "OPTIONS", "GET"];
  let lastHttpCode = null;
  let lastLatencyMs = null;

  for (const method of methods) {
    const started = performance.now();
    try {
      const response = await fetch(rawEndpoint, {
        method,
        redirect: "manual",
        headers: {
          accept: "application/json,text/plain,*/*",
          "user-agent": "DELTA-Witness-Catalog-Health/1.0",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Math.round(performance.now() - started);
      const httpCode = response.status;
      lastHttpCode = httpCode;
      lastLatencyMs = latencyMs;
      try {
        await response.body?.cancel();
      } catch {
        // Liveness classification does not depend on consuming a response body.
      }

      // 402 is the expected healthy response for an unpaid x402 endpoint.
      if (httpCode === 402 || (httpCode >= 200 && httpCode < 400)) {
        return { offerId, title, endpoint, status: "alive", httpCode, latencyMs };
      }

      // HEAD/OPTIONS are frequently unsupported even when the resource itself is live.
      if ((httpCode === 405 || httpCode === 501) && method !== "GET") continue;
      if (httpCode >= 400 && httpCode < 500) {
        return { offerId, title, endpoint, status: "4xx", httpCode, latencyMs };
      }
      if (httpCode >= 500) {
        return { offerId, title, endpoint, status: "5xx", httpCode, latencyMs };
      }
      return { offerId, title, endpoint, status: "alive", httpCode, latencyMs };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      if (isTimeout(error)) {
        return { offerId, title, endpoint, status: "timeout", httpCode: null, latencyMs };
      }
      if (method !== "GET") continue;
      return { offerId, title, endpoint, status: "dead", httpCode: null, latencyMs };
    }
  }

  return {
    offerId,
    title,
    endpoint,
    status: classifyHttp(lastHttpCode),
    httpCode: lastHttpCode,
    latencyMs: lastLatencyMs,
  };
}

function renderMarkdown(results) {
  const counts = new Map(["alive", "dead", "timeout", "4xx", "5xx"].map((key) => [key, 0]));
  for (const row of results) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);

  const nonHealthy = results.filter((row) => row.status !== "alive");
  const lines = [
    "# PayanAgent catalog endpoint-health report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Offers checked: ${results.length}`,
    `Concurrency: ${CONCURRENCY}`,
    `Per-attempt timeout: ${TIMEOUT_MS} ms`,
    "",
    "## Summary",
    "",
    `- alive: ${counts.get("alive")}`,
    `- 4xx: ${counts.get("4xx")}`,
    `- 5xx: ${counts.get("5xx")}`,
    `- timeout: ${counts.get("timeout")}`,
    `- dead: ${counts.get("dead")}`,
    "",
    "The public PayanAgent offer projection intentionally hides seller upstream endpoint/externalUrl fields. When no public upstream URL is present, this checker probes the offer's public `/x402/:offerId` buy URL instead. An unpaid HTTP 402 is treated as a healthy liveness signal and no payment header is ever sent.",
    "",
    "## Non-healthy endpoints",
    "",
  ];

  if (nonHealthy.length === 0) {
    lines.push("No non-healthy endpoints were observed.");
  } else {
    lines.push("| Offer | Status | HTTP | Latency | Endpoint |", "| --- | --- | ---: | ---: | --- |");
    for (const row of nonHealthy) {
      lines.push(
        `| ${escapeMd(row.title)} | ${row.status} | ${row.httpCode ?? "—"} | ${row.latencyMs ?? "—"} ms | ${escapeMd(row.endpoint ?? "—")} |`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function classifyHttp(code) {
  if (code === 402 || (code != null && code >= 200 && code < 400)) return "alive";
  if (code != null && code >= 400 && code < 500) return "4xx";
  if (code != null && code >= 500) return "5xx";
  return "dead";
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|auth|signature|credential/i.test(key)) url.searchParams.set(key, "REDACTED");
    }
    return url.href;
  } catch {
    return String(value).replace(/([?&](?:key|token|secret|auth|signature|credential)[^=]*=)[^&]+/gi, "$1REDACTED");
  }
}

function idFromBuyUrl(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/\/x402\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) ?? null;
}

function isTimeout(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError" || /timed? ?out/i.test(String(error?.message ?? error));
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function backoff(attempt) {
  return Math.min(4_000, 500 * 2 ** (attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeMd(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
