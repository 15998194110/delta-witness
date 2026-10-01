import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
if (config.name !== 'delta-witness-api') throw new Error('Unexpected core target');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Existing Cloudflare deployment credentials are required');
// Read only the existing worker metadata. Never print API payloads or secret bindings.
async function get(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Cloudflare metadata read failed: HTTP ${response.status}`);
  const result = await response.json();
  if (!result.success) throw new Error('Cloudflare metadata read was unsuccessful');
  return result.result;
}
const service = await get(`/workers/services/${config.name}`);
const environment = service.default_environment?.environment;
if (typeof environment !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(environment)) throw new Error('Cannot resolve the existing worker environment');
const base = `/workers/services/${config.name}/environments/${environment}`;
const [bindings, metadata, schedules, subdomain, routes, domains] = await Promise.all([
  get(`${base}/bindings`), get(base), get(`/workers/scripts/${config.name}/schedules`),
  get(`${base}/subdomain`), get(`${base}/routes?show_zonename=true`),
  get(`/workers/domains/records?page=0&per_page=5&service=${config.name}&environment=${environment}`),
]);
const script = metadata.script;
const errors = [];
const check = (condition, label) => { if (!condition) errors.push(label); };
check(script?.compatibility_date === config.compatibility_date, 'compatibility_date');
check(isDeepStrictEqual([...(script?.compatibility_flags || [])].sort(), [...(config.compatibility_flags || [])].sort()), 'compatibility_flags');
check(isDeepStrictEqual((schedules.schedules || []).map((s) => s.cron).sort(), [...(config.triggers?.crons || [])].sort()), 'cron schedules');
check(subdomain.enabled === config.workers_dev && typeof subdomain.previews_enabled === 'boolean', 'workers.dev/public preview state');
check(Array.isArray(routes) && routes.length === 0 && Array.isArray(domains) && domains.length === 0, 'routes/custom domains');
const resources = bindings.filter((b) => !['plain_text', 'json', 'secret_text'].includes(b.type)).map((b) => {
  if (b.type === 'browser') return { type: b.type, name: b.name };
  if (b.type === 'r2_bucket') return { type: b.type, name: b.name, bucket_name: b.bucket_name, jurisdiction: b.jurisdiction || null };
  if (b.type === 'd1') return { type: b.type, name: b.name, id: b.id };
  return { type: b.type, name: b.name, unreviewed: true };
}).sort((a, b) => a.name.localeCompare(b.name));
const expected = [
  { type: 'browser', name: config.browser.binding },
  ...config.r2_buckets.map((b) => ({ type: 'r2_bucket', name: b.binding, bucket_name: b.bucket_name, jurisdiction: b.jurisdiction || null })),
  ...config.d1_databases.map((b) => ({ type: 'd1', name: b.binding, id: b.database_id })),
].sort((a, b) => a.name.localeCompare(b.name));
check(isDeepStrictEqual(resources, expected), 'resource bindings');
for (const [name, value] of Object.entries(config.vars)) {
  const binding = bindings.find((b) => b.name === name);
  check(binding?.type === 'plain_text' && binding.text === value, `configured variable ${name}`);
}
// The defaults are those of the pinned Wrangler 4.127.1 comparison logic.
function observability(value) {
  const enabled = value?.enabled === true;
  const defaults = { enabled, head_sampling_rate: 1, logs: { enabled, head_sampling_rate: 1, invocation_logs: true, persist: true }, traces: { enabled: false, persist: true, head_sampling_rate: 1 } };
  const fill = (current, fallback) => {
    const result = { ...(current || {}) };
    for (const [key, value] of Object.entries(fallback)) {
      if (result[key] === undefined) result[key] = value;
      else if (value && typeof value === 'object') result[key] = fill(result[key], value);
    }
    return result;
  };
  return fill(value, defaults);
}
const liveObservability = observability(script.observability);
const expectedObservability = observability(config.observability);
if (!isDeepStrictEqual(liveObservability, expectedObservability)) {
  const safeValue = (value) => value === undefined ? 'unset' : value === null || typeof value === 'boolean' || typeof value === 'number' ? value : Array.isArray(value) ? `array(${value.length})` : typeof value;
  const differences = [];
  const compare = (live, expected, path) => {
    if (isDeepStrictEqual(live, expected)) return;
    if (live && expected && typeof live === 'object' && typeof expected === 'object' && !Array.isArray(live) && !Array.isArray(expected)) {
      for (const key of new Set([...Object.keys(live), ...Object.keys(expected)])) compare(live[key], expected[key], `${path}.${key}`);
    } else differences.push({ field: path, live: safeValue(live), expected: safeValue(expected) });
  };
  compare(liveObservability, expectedObservability, 'observability');
  console.log(JSON.stringify({ configuration_drift_diagnostic: differences }));
}
check(isDeepStrictEqual(liveObservability, expectedObservability), 'observability');
check(!script.placement_mode || script.placement_mode === 'off', 'placement');
check(!script.limits || Object.keys(script.limits).length === 0, 'limits');
check(!script.tail_consumers || script.tail_consumers.length === 0, 'tail consumers');
check(!script.logpush, 'logpush');
if (errors.length) throw new Error(`Production configuration drift; no deployment authorized by this check: ${errors.join(', ')}`);
// Explicitly preserve the live Version URL setting, rather than Wrangler's implicit default.
const runtimeConfig = { ...config, main: resolve(config.main), $schema: resolve(config.$schema), preview_urls: subdomain.previews_enabled };
writeFileSync('/tmp/delta-conversion-wrangler.jsonc', JSON.stringify(runtimeConfig, null, 2) + '\n');
console.log(JSON.stringify({ worker: config.name, existing_configuration_matches: true, resource_binding_names: resources.map((b) => b.name), crons_unchanged: true, preview_urls_preserved: subdomain.previews_enabled }));
