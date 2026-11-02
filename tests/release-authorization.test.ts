import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
// @ts-expect-error reviewed import-safe gate
import { assertReleaseAuthorization } from '../scripts/check-release-authorization.mjs';
const approved = { event: 'workflow_dispatch', execute: 'true', source: 'a'.repeat(40), requested: 'a'.repeat(40), approved: 'a'.repeat(40), rollbackSource: 'b'.repeat(40), rollbackArtifact: 'c'.repeat(64) };
it('requires explicit current-source approval and compatible fallback identity even after tests pass', () => {
  expect(assertReleaseAuthorization(approved)).toMatchObject({ ok: true, source_commit: approved.source });
  for (const key of Object.keys(approved)) expect(() => assertReleaseAuthorization({ ...approved, [key]: undefined })).toThrow();
  expect(() => assertReleaseAuthorization({ ...approved, event: 'push' })).toThrow();
  expect(() => assertReleaseAuthorization({ ...approved, requested: 'master' })).toThrow();
  expect(() => assertReleaseAuthorization({ ...approved, approved: 'd'.repeat(40) })).toThrow();
  expect(() => assertReleaseAuthorization({ ...approved, rollbackArtifact: '0'.repeat(64) })).toThrow();
});
it('all direct release jobs depend on approval; dependent publication cannot bypass it', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-train.yml', import.meta.url), 'utf8');
  const jobs = new Map<string, string>();
  for (const block of workflow.split(/(?=^  [a-z][a-z0-9-]*:\s*$)/m)) {
    const match = /^  ([a-z][a-z0-9-]*):/m.exec(block); if (match) jobs.set(match[1], block);
  }
  const guarded = (name: string, visited = new Set<string>()): boolean => {
    if (name === 'authorize-release') return true;
    if (visited.has(name)) return false; visited.add(name);
    const body = jobs.get(name) ?? '';
    if (/^    if:.*always\(/m.test(body)) return false;
    const needs = /^    needs:\s*(.*)$/m.exec(body)?.[1].match(/[a-z][a-z0-9-]*/g) ?? [];
    return needs.some(parent => guarded(parent, new Set(visited)));
  };
  for (const name of ['core-cloudflare','partner-gateway','base-app','npm-client','npm-mcp','pypi-client','mcp-registry','postman','apify']) expect(guarded(name), name).toBe(true);
  expect(jobs.get('authorize-release')).toContain('environment: production-release');
  expect(jobs.get('authorize-release')).toContain("github.event_name == 'workflow_dispatch' && inputs.execute_release");
});
