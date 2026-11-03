import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCloudflareArtifact, loadCloudflareArtifact, deployCloudflareArtifact } from '../scripts/verified-cloudflare-artifact.mjs';
const source = 'a'.repeat(40);
const authorization = { event: 'workflow_dispatch', execute: 'true', requested: source, approved: source,
  rollbackSource: 'b'.repeat(40), rollbackArtifact: 'c'.repeat(64) };
async function fixture(kind = 'core') {
  const repository = await mkdtemp(join(tmpdir(), 'delta-cf-artifact-'));
  const root = join(repository, kind === 'pages' ? 'channels/base-app' : kind === 'gateway' ? 'channels/partner-gateway' : '.');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'node_modules/wrangler'), { recursive: true });
  await writeFile(join(root, 'node_modules/wrangler/package.json'), JSON.stringify({ version: '4.127.1' }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/wrangler': { version: '4.127.1' } } }));
  if (kind !== 'pages') await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ name: kind === 'core' ? 'delta-witness-api' : 'delta-witness-partner-gateway', main: 'src/index.ts' }));
  await writeFile(join(root, 'dist', kind === 'pages' ? 'index.html' : 'index.js'), kind === 'pages' ? '<html>verified fixture</html>' : 'export default {fetch(){return new Response("fixture")}};');
  if (kind === 'pages') {
    await mkdir(join(root, 'dist/.well-known'));
    await mkdir(join(root, 'dist/assets'));
    await writeFile(join(root, 'dist/assets/index-fixture.js.map'), '{"version":3,"sources":[]}');
    await writeFile(join(root, 'dist/.well-known/farcaster.json'), '{"accountAssociation":{"header":"fixture-h","payload":"fixture-p","signature":"fixture-s"}}');
  }
  return { root, directory: join(repository, 'qualified'), repository, kind, source };
}
describe('immutable Cloudflare release payload; no provider calls', () => {
  it.each(['core', 'gateway', 'pages'])('submits only the recorded %s files with no rebuild and no online-success claim', async kind => {
    const f = await fixture(kind), manifest = await recordCloudflareArtifact(f);
    await writeFile(join(f.root, 'dist', manifest.entry), 'unverified second build');
    const run = vi.fn(async () => {});
    const result = await deployCloudflareArtifact({ ...f, authorization, run });
    expect(result).toMatchObject({ submission_completed: true, online_acceptance: false, manifest });
    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0][1];
    expect(args).not.toContain('build');
    if (kind === 'pages') {
      expect(args).toContain(join(f.directory, 'payload')); expect(args).toContain('delta-witness-app');
      expect(await readFile(join(f.directory, 'payload/.well-known/farcaster.json'), 'utf8')).toContain('fixture-s');
    } else { expect(args).toContain('--no-bundle'); expect(args).toContain(join(f.directory, 'payload/index.js')); }
  });
  it.each(['bytes', 'extra', 'source', 'lock', 'config', 'cli'])('rejects %s drift before the submission callback', async mutation => {
    const f = await fixture(); await recordCloudflareArtifact(f);
    if (mutation === 'bytes') await writeFile(join(f.directory, 'payload/index.js'), 'changed');
    if (mutation === 'extra') await writeFile(join(f.directory, 'payload/unrecorded.js'), 'extra');
    if (mutation === 'lock') await writeFile(join(f.root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/wrangler': { version: '4.127.1' } }, changed: true }));
    if (mutation === 'config') await writeFile(join(f.root, 'wrangler.jsonc'), JSON.stringify({ name: 'delta-witness-api', main: 'src/index.ts', vars: { CHANGED: true } }));
    if (mutation === 'cli') await writeFile(join(f.root, 'node_modules/wrangler/package.json'), '{"version":"99.0.0"}');
    const run = vi.fn();
    await expect(deployCloudflareArtifact({ ...f, ...(mutation === 'source' ? { source: 'd'.repeat(40) } : {}), authorization, run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['build', 'rules', 'env', 'migrations', 'assets', 'wasm_modules'])('rejects unreviewed config %s before recording any payload', async key => {
    const f = await fixture();
    await writeFile(join(f.root, 'wrangler.jsonc'), JSON.stringify({ name: 'delta-witness-api', main: 'src/index.ts', [key]: {} }));
    await expect(recordCloudflareArtifact(f)).rejects.toThrow('unreviewed_cloudflare_build_config');
  });
  it('rejects a symlinked payload directory and a private file in public Pages output', async () => {
    const f = await fixture(); await recordCloudflareArtifact(f);
    const redirected = join(f.repository, 'redirected'); await mkdir(redirected);
    await symlink(join(f.directory, 'payload'), join(redirected, 'payload'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(redirected, 'verified-artifact.json'), await readFile(join(f.directory, 'verified-artifact.json')));
    await expect(loadCloudflareArtifact({ ...f, directory: redirected })).rejects.toThrow('invalid_cloudflare_artifact');
    const pages = await fixture('pages'); await writeFile(join(pages.root, 'dist/.env'), 'synthetic-not-a-secret');
    await expect(recordCloudflareArtifact(pages)).rejects.toThrow('invalid_cloudflare_artifact');
  });
  it('never retries an uncertain submission and never grants authority merely from a valid manifest', async () => {
    const f = await fixture(); await recordCloudflareArtifact(f); const run = vi.fn(async () => { throw new Error('uncertain'); });
    await expect(deployCloudflareArtifact({ ...f, authorization: { ...authorization, execute: 'false' }, run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await expect(deployCloudflareArtifact({ ...f, authorization, run })).rejects.toThrow('uncertain'); expect(run).toHaveBeenCalledTimes(1);
  });
  it('release jobs download the verified payload; Pages association remains in the uploaded hidden path', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release-train.yml', import.meta.url), 'utf8');
    const jobs = new Map(workflow.split(/(?=^  [a-z][a-z0-9-]*:\s*$)/m).map(block => [/^  ([a-z][a-z0-9-]*):/m.exec(block)?.[1], block]));
    for (const [job, kind] of [['core-cloudflare', 'core'], ['partner-gateway', 'gateway'], ['base-app', 'pages']]) {
      const body = jobs.get(job); expect(body).toContain('actions/download-artifact@v4'); expect(body).toContain(`${kind}-verified-`);
      expect(body).toContain(`verified-cloudflare-artifact.mjs deploy "$RUNNER_TEMP/delta-${kind}-verified" ${kind}`);
      expect(body).not.toMatch(/run: (?:npx wrangler (?:deploy|pages deploy)|npm run (?:build|verify))/);
    }
    expect(jobs.get('verify')).toContain('include-hidden-files: true');
  });
});
