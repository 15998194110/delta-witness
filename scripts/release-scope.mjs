// Local authorization validator. Does not grant permission or contact a provider.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const scopes = new Set(['core-cloudflare','partner-gateway','base-app','npm-client','npm-mcp','pypi-client','mcp-registry','postman','apify','d1-migration','core-secrets','gateway-secrets','partner-probe','indexnow']);
export function validateReleaseScope(requested, approved, variablesPolicy) {
  const parse = text => {
    if (typeof text !== 'string' || text.length > 1024) throw new Error('release_scope_required');
    const a = JSON.parse(text);
    if (!Array.isArray(a) || !a.length || a.some(x => typeof x !== 'string' || !scopes.has(x)) || new Set(a).size !== a.length) throw new Error('invalid_release_scope');
    return a.sort();
  };
  const a = parse(requested), b = parse(approved);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('release_scope_not_approved');
  for (const [child, parent] of [['partner-gateway','core-cloudflare'],['mcp-registry','npm-mcp'],['d1-migration','core-cloudflare'],['core-secrets','core-cloudflare'],['gateway-secrets','partner-gateway'],['partner-probe','core-cloudflare'],['indexnow','base-app']]) {
    if (a.includes(child) && !a.includes(parent)) throw new Error('release_scope_dependency_missing');
  }
  if (variablesPolicy != null && variablesPolicy !== '' && !['preserve-reviewed','replace-reviewed'].includes(variablesPolicy)) throw new Error('invalid_variable_policy');
  if (a.some(x => ['core-cloudflare','partner-gateway'].includes(x)) && !['preserve-reviewed','replace-reviewed'].includes(variablesPolicy)) throw new Error('reviewed_variable_policy_required');
  return { scopes: a, variables_policy: variablesPolicy ?? null };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = validateReleaseScope(process.env.DELTA_REQUESTED_SCOPES, process.env.DELTA_APPROVED_SCOPES, process.env.DELTA_VARIABLES_POLICY);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scopes=${JSON.stringify(result.scopes)}\nvariables_policy=${result.variables_policy ?? ''}\n`);
    console.log(JSON.stringify(result));
  } catch { console.error('release_scope_or_variable_policy_not_approved'); process.exitCode = 1; }
}
