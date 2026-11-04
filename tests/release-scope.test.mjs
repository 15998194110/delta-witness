import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateReleaseScope } from '../scripts/release-scope.mjs';
describe('explicit production operation boundary', () => {
  it('a Core-only release grants no migration, secret write or publication', () => {
    expect(validateReleaseScope('["core-cloudflare"]','["core-cloudflare"]','preserve-reviewed').scopes).toEqual(['core-cloudflare']);
  });
  it.each(['[]','null','["all"]','["core-cloudflare","core-cloudflare"]','["d1-migration"]','["partner-gateway"]','["mcp-registry"]'])('rejects invalid/incomplete scope %s', value => {
    expect(() => validateReleaseScope(value,value,'preserve-reviewed')).toThrow();
  });
  it('rejects widening, missing independent approval and implicit variable replacement', () => {
    expect(() => validateReleaseScope('["core-cloudflare","d1-migration"]','["core-cloudflare"]','preserve-reviewed')).toThrow();
    expect(() => validateReleaseScope('["core-cloudflare"]',undefined,'preserve-reviewed')).toThrow();
    expect(() => validateReleaseScope('["core-cloudflare"]','["core-cloudflare"]',undefined)).toThrow();
  });
  it('normalizes order only, retaining separately approved operations', () => {
    expect(validateReleaseScope('["core-cloudflare","d1-migration"]','["d1-migration","core-cloudflare"]','replace-reviewed').scopes).toEqual(['core-cloudflare','d1-migration']);
  });
  it('rejects workflow-output injection even for scopes not using Worker variables', () => {
    for (const value of ['unreviewed','preserve-reviewed\nscopes=["core-cloudflare"]',{},1])
      expect(() => validateReleaseScope('["npm-client"]','["npm-client"]',value)).toThrow('invalid_variable_policy');
    expect(validateReleaseScope('["npm-client"]','["npm-client"]',undefined).variables_policy).toBeNull();
    expect(validateReleaseScope('["base-app"]','["base-app"]','').variables_policy).toBe('');
  });
  it('every publishing lane consumes only validated outputs; independent mutations require own scope', () => {
    const y=readFileSync(new URL('../.github/workflows/release-train.yml',import.meta.url),'utf8');
    for(const key of ['core-cloudflare','partner-gateway','base-app','npm-client','npm-mcp','pypi-client','mcp-registry','postman','apify','d1-migration','core-secrets','gateway-secrets','partner-probe','indexnow'])
      expect(y).toContain(`contains(fromJSON(needs.authorize-release.outputs.scopes || '[]'), '${key}')`);
    expect(y).toContain('steps.scope.outputs.scopes');
    expect(y).toContain('vars.DELTA_APPROVED_RELEASE_SCOPES');
  });
});
