// Read-only Core release guard. Adapted from the af949027 release-only guard.
// Never persist provider payloads, secret bindings, tokens or arbitrary live vars.
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';

const fail = field => { throw new Error(`core_configuration_drift:${field}`); };
const equal = (actual, expected, field) => { if (!isDeepStrictEqual(actual, expected)) fail(field); };
const sorted = values => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
export function reviewedCoreDeployment(live, expected, after = false) {
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
  if (!uuid(expected?.deploymentId) || !uuid(expected?.versionId)) fail('approved_deployment_identity_required');
  const deployments = Array.isArray(live?.deployments) ? live.deployments : live?.deployments?.deployments;
  if (!Array.isArray(deployments) || !deployments.length || deployments.some(item => !Number.isFinite(Date.parse(item.created_on)))) fail('deployment_shape');
  const current = [...deployments].sort((a,b) => Date.parse(b.created_on)-Date.parse(a.created_on))[0];
  if (!uuid(current.id) || current.versions?.length !== 1 || !uuid(current.versions[0].version_id) || current.versions[0].percentage !== 100) fail('deployment_traffic_split');
  const identity = { deploymentId:current.id, versionId:current.versions[0].version_id };
  if (after) {
    if (identity.deploymentId === expected.deploymentId || identity.versionId === expected.versionId) fail('new_deployment_not_observed');
  } else equal(identity, expected, 'deployment_identity');
  return identity;
}
function normalizedObservability(value) {
  const enabled = value?.enabled === true;
  const defaults = { enabled, head_sampling_rate: 1, redact_query_string: false,
    logs: { enabled, head_sampling_rate: 1, invocation_logs: true, persist: true },
    traces: { enabled: false, persist: true, head_sampling_rate: 1 } };
  const fill = (current, fallback) => {
    const output = { ...(current || {}) };
    for (const [key, item] of Object.entries(fallback)) {
      if (output[key] === undefined) output[key] = item;
      else if (item && typeof item === 'object') output[key] = fill(output[key], item);
    }
    return output;
  };
  return fill(value, defaults);
}

export function reviewedCoreConfig({ config, root, live, expectedAppVersion, variablesPolicy, previousPreview }) {
  if (config.name !== 'delta-witness-api' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(expectedAppVersion || '') ||
    !['preserve-reviewed', 'replace-reviewed'].includes(variablesPolicy)) fail('reviewed_release_inputs_required');
  const { script, bindings, schedules, subdomain, routes, domains } = live || {};
  if (!script || !Array.isArray(bindings) || !Array.isArray(schedules?.schedules)) fail('metadata_shape');
  equal(script.compatibility_date, config.compatibility_date, 'compatibility_date');
  equal(sorted(script.compatibility_flags || []), sorted(config.compatibility_flags || []), 'compatibility_flags');
  equal(sorted(schedules.schedules.map(item => item.cron)), sorted(config.triggers?.crons || []), 'cron_schedules');
  if (subdomain?.enabled !== config.workers_dev || typeof subdomain?.previews_enabled !== 'boolean') fail('public_urls');
  if (previousPreview !== undefined) equal(subdomain.previews_enabled, previousPreview, 'preview_urls');
  equal(routes, [], 'routes'); equal(domains, [], 'custom_domains');
  const resources = bindings.filter(item => !['plain_text', 'json', 'secret_text'].includes(item.type)).map(item => {
    if (item.type === 'browser') return { type: item.type, name: item.name };
    if (item.type === 'r2_bucket') return { type: item.type, name: item.name, bucket_name: item.bucket_name, jurisdiction: item.jurisdiction || null };
    if (item.type === 'd1') return { type: item.type, name: item.name, id: item.id };
    return { type: item.type, name: item.name, unreviewed: true };
  });
  const expectedResources = [ { type: 'browser', name: config.browser?.binding },
    ...(config.r2_buckets || []).map(item => ({ type: 'r2_bucket', name: item.binding, bucket_name: item.bucket_name, jurisdiction: item.jurisdiction || null })),
    ...(config.d1_databases || []).map(item => ({ type: 'd1', name: item.binding, id: item.database_id })) ];
  equal(sorted(resources), sorted(expectedResources), 'resource_bindings');
  if (new Set(bindings.map(item => item.name)).size !== bindings.length) fail('duplicate_bindings');
  for (const [name, value] of Object.entries(config.vars || {})) {
    const binding = bindings.find(item => item.name === name);
    if (binding?.type !== 'plain_text' || binding.text !== (name === 'APP_VERSION' ? expectedAppVersion : value)) fail(`configured_variable_${name}`);
  }
  if (!config.vars?.APP_VERSION) fail('candidate_version_required');
  // --keep-vars is not approval to retain unknown execution/permission flags.
  // Both policies require the reviewed complete nonsecret binding inventory.
  equal(sorted(bindings.filter(item => ['plain_text', 'json'].includes(item.type)).map(item => item.name)), sorted(Object.keys(config.vars)), 'unreviewed_variable_inventory');
  // Current reviewed live state is false. A concurrent privacy change must stop
  // the release, not be silently overwritten by this historical baseline.
  equal(script.observability?.redact_query_string, false, 'query_redaction');
  equal(normalizedObservability(script.observability), normalizedObservability({ ...config.observability, redact_query_string: false }), 'observability');
  if (script.placement_mode && script.placement_mode !== 'off') fail('placement');
  if (script.limits && Object.keys(script.limits).length) fail('limits');
  if (script.tail_consumers?.length) fail('tail_consumers');
  if (script.logpush) fail('logpush');
  return { ...config, main: resolve(root, config.main), ...(config.$schema ? { $schema: resolve(root, config.$schema) } : {}),
    preview_urls: subdomain.previews_enabled,
    observability: normalizedObservability({ ...config.observability, redact_query_string: false }) };
}

export function coreMetadataReader({ account, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/.test(account || '') || typeof token !== 'string' || !token.trim()) fail('provider_credentials_required');
  return async () => {
    async function get(path) {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
        method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) fail(`metadata_http_${response.status}`);
      const reader = response.body?.getReader(); if (!reader) fail('metadata_body');
      const chunks = []; let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 256_000) { await reader.cancel(); fail('metadata_size'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, length);
      const payload = JSON.parse(bytes.toString('utf8')); if (payload.success !== true) fail('metadata_unsuccessful');
      return payload.result;
    }
    const service = await get('/workers/services/delta-witness-api');
    const environment = service.default_environment?.environment;
    if (!/^[a-zA-Z0-9_-]+$/.test(environment || '')) fail('worker_environment');
    const base = `/workers/services/delta-witness-api/environments/${environment}`;
    const [bindings, metadata, schedules, subdomain, routes, domains, deployments] = await Promise.all([
      get(`${base}/bindings`), get(base), get('/workers/scripts/delta-witness-api/schedules'),
      get(`${base}/subdomain`), get(`${base}/routes?show_zonename=true`),
      get(`/workers/domains/records?page=0&per_page=5&service=delta-witness-api&environment=${environment}`),
      get('/workers/scripts/delta-witness-api/deployments'),
    ]);
    return { bindings, script: metadata.script, schedules, subdomain, routes, domains, deployments };
  };
}
