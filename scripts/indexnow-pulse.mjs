import { pathToFileURL } from "node:url";

const CORE_ORIGIN = "https://delta-witness-api.ruphussten.workers.dev";
const BASE_APP_ORIGIN = "https://delta-witness-app.pages.dev";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const INDEXNOW_KEY = "delta-witness-2026-8f0c5a3d6e7b91ac";
const DEFAULT_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20_000;

export async function runIndexNowPulse(target, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const adminSecret = options.adminSecret ?? process.env.DELTA_INDEXNOW_ADMIN_SECRET;

  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("IndexNow attempts must be an integer from 1 to 10");
  }
  if (target === "core" && !adminSecret) {
    const result = { ok: false, target, error: "missing_admin_secret", attempts: 0 };
    log({ event: "indexnow_configuration_error", ...result });
    return result;
  }
  if (target !== "core" && target !== "base-app") {
    throw new Error(`Unknown IndexNow target: ${target}`);
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const request = requestFor(target, adminSecret);
      const response = await fetchImpl(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const responseBody = truncate(await response.text());
      const retryable = isRetryable(response.status);
      const diagnostic = {
        event: "indexnow_attempt",
        target,
        attempt,
        max_attempts: attempts,
        ok: response.ok,
        http_status: response.status,
        retryable,
        response_body: responseBody || null,
      };
      log(diagnostic);
      if (response.ok) return { ok: true, target, attempts: attempt, status: response.status };
      if (!retryable || attempt === attempts) {
        return { ok: false, target, attempts: attempt, status: response.status, responseBody };
      }
    } catch (error) {
      const diagnostic = {
        event: "indexnow_attempt",
        target,
        attempt,
        max_attempts: attempts,
        ok: false,
        http_status: null,
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      };
      log(diagnostic);
      if (attempt === attempts) return { ok: false, target, attempts: attempt, error: diagnostic.error };
    }
    await sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
  }

  return { ok: false, target, attempts };
}

function requestFor(target, adminSecret) {
  if (target === "core") {
    return {
      url: `${CORE_ORIGIN}/internal/indexnow`,
      init: {
        method: "POST",
        headers: { authorization: `Bearer ${adminSecret}` },
      },
    };
  }
  return {
    url: INDEXNOW_ENDPOINT,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: new URL(BASE_APP_ORIGIN).hostname,
        key: INDEXNOW_KEY,
        keyLocation: `${BASE_APP_ORIGIN}/${INDEXNOW_KEY}.txt`,
        urlList: [`${BASE_APP_ORIGIN}/`],
      }),
    },
  };
}

function isRetryable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function truncate(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const target = process.argv[2];
  const result = await runIndexNowPulse(target);
  console.log(JSON.stringify({ event: "indexnow_result", ...result }));
  if (!result.ok) process.exitCode = 1;
}
