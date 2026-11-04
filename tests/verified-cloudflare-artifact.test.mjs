import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCloudflareArtifact, loadCloudflareArtifact, deployCloudflareArtifact, prepareCoreReleaseConfig } from '../scripts/verified-cloudflare-artifact.mjs';
const source = 'a'.repeat(40);
const authorization = { event: 'workflow_dispatch', execute: 'true', requested: source, approved: source,
  rollbackSource: 'b'.repeat(40), rollbackArtifact: 'c'.repeat(64) };
const priorDeployment={deploymentId:'11111111-1111-1111-1111-111111111111',versionId:'22222222-2222-2222-2222-222222222222'};
const deployment=after=>[{id:after?'33333333-3333-3333-3333-333333333333':priorDeployment.deploymentId,created_on:'2026-11-04T00:00:00Z',
  versions:[{version_id:after?'44444444-4444-4444-4444-444444444444':priorDeployment.versionId,percentage:100}]}];
const submit=f=>vi.fn(async()=>{f.provider.uploaded=true;});
async function fixture(kind = 'core') {
  const repository = await mkdtemp(join(tmpdir(), 'delta-cf-artifact-'));
  const root = join(repository, kind === 'pages' ? 'channels/base-app' : kind === 'gateway' ? 'channels/partner-gateway' : '.');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'node_modules/wrangler'), { recursive: true });
  await writeFile(join(root, 'node_modules/wrangler/package.json'), JSON.stringify({ version: '4.127.1' }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/wrangler': { version: '4.127.1' } } }));
  const config = { name: kind === 'core' ? 'delta-witness-api' : 'delta-witness-partner-gateway', main: 'src/index.ts',
    compatibility_date:'2026-08-31', compatibility_flags:['nodejs_compat'], workers_dev:true,
    browser:{binding:'BROWSER'}, r2_buckets:[{binding:'PROOFS',bucket_name:'delta-witness-proofs'}],
    d1_databases:[{binding:'ANALYTICS_DB',database_id:'fixture-d1'}], triggers:{crons:['*/3 * * * *']},
    vars:{APP_VERSION:'0.7.1'}, observability:{enabled:true} };
  if (kind === 'gateway') for (const key of ['browser','r2_buckets','d1_databases','triggers']) delete config[key];
  if (kind !== 'pages') await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify(config));
  await writeFile(join(root, 'dist', kind === 'pages' ? 'index.html' : 'index.js'), kind === 'pages' ? '<html>verified fixture</html>' : 'export default {fetch(){return new Response("fixture")}};');
  if (kind === 'pages') {
    await mkdir(join(root, 'dist/.well-known'));
    await mkdir(join(root, 'dist/assets'));
    await writeFile(join(root, 'dist/assets/index-fixture.js.map'), '{"version":3,"sources":[]}');
    await writeFile(join(root, 'dist/.well-known/farcaster.json'), '{"accountAssociation":{"header":"fixture-h","payload":"fixture-p","signature":"fixture-s"}}');
  }
  const provider={uploaded:false};
  const readLiveCore = vi.fn(async () => ({ script:{ compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags,observability:{enabled:true,redact_query_string:false}},
    bindings:[{type:'browser',name:'BROWSER'},{type:'r2_bucket',name:'PROOFS',bucket_name:'delta-witness-proofs'},
      {type:'d1',name:'ANALYTICS_DB',id:'fixture-d1'},{type:'plain_text',name:'APP_VERSION',text:'0.7.1'}],
    schedules:{schedules:[{cron:'*/3 * * * *'}]},subdomain:{enabled:true,previews_enabled:false},routes:[],domains:[],deployments:deployment(provider.uploaded) }));
  return { root, directory: join(repository, 'qualified'), repository, kind, source, readLiveCore, expectedCoreVersion:'0.7.1',expectedCoreDeployment:priorDeployment,provider };
}
async function qualify(f) {
  const manifest = await recordCloudflareArtifact(f);
  if (f.kind === 'core') await prepareCoreReleaseConfig({...f,variablesPolicy:'preserve-reviewed'});
  return manifest;
}
describe('immutable Cloudflare release payload; no provider calls', () => {
  it.each(['core', 'gateway', 'pages'])('submits only the recorded %s files with no rebuild and no online-success claim', async kind => {
    const f = await fixture(kind), manifest = await qualify(f);
    await writeFile(join(f.root, 'dist', manifest.entry), 'unverified second build');
    const run = submit(f);
    const result = await deployCloudflareArtifact({ ...f, authorization, variablesPolicy: 'preserve-reviewed', run });
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
    const f = await fixture(); await qualify(f);
    if (mutation === 'bytes') await writeFile(join(f.directory, 'payload/index.js'), 'changed');
    if (mutation === 'extra') await writeFile(join(f.directory, 'payload/unrecorded.js'), 'extra');
    if (mutation === 'lock') await writeFile(join(f.root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/wrangler': { version: '4.127.1' } }, changed: true }));
    if (mutation === 'config') await writeFile(join(f.root, 'wrangler.jsonc'), JSON.stringify({ name: 'delta-witness-api', main: 'src/index.ts', vars: { CHANGED: true } }));
    if (mutation === 'cli') await writeFile(join(f.root, 'node_modules/wrangler/package.json'), '{"version":"99.0.0"}');
    const run = vi.fn();
    await expect(deployCloudflareArtifact({ ...f, ...(mutation === 'source' ? { source: 'd'.repeat(40) } : {}), authorization, variablesPolicy: 'preserve-reviewed', run })).rejects.toThrow();
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
    const f = await fixture(); await qualify(f); const run = vi.fn(async () => { throw new Error('uncertain'); });
    await expect(deployCloudflareArtifact({ ...f, authorization: { ...authorization, execute: 'false' }, variablesPolicy: 'preserve-reviewed', run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await expect(deployCloudflareArtifact({ ...f, authorization, variablesPolicy: 'preserve-reviewed', run })).rejects.toThrow('uncertain'); expect(run).toHaveBeenCalledTimes(1);
  });
  it('requires explicit var policy before callback and preserves reviewed live flags only when selected', async () => {
    const f = await fixture(); await qualify(f); const run = submit(f);
    await expect(deployCloudflareArtifact({ ...f, authorization, run })).rejects.toThrow('reviewed_variable_policy_required');
    expect(run).not.toHaveBeenCalled();
    await deployCloudflareArtifact({ ...f, authorization, variablesPolicy: 'preserve-reviewed', run });
    expect(run.mock.calls[0][1]).toContain('--keep-vars');
    f.provider.uploaded=false;
    await deployCloudflareArtifact({ ...f, authorization, variablesPolicy: 'replace-reviewed', run });
    expect(run.mock.calls[1][1]).not.toContain('--keep-vars');
  });
  it('release jobs download the verified payload; Pages association remains in the uploaded hidden path', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release-train.yml', import.meta.url), 'utf8');
    const jobs = new Map(workflow.split(/(?=^  [a-z][a-z0-9-]*:\s*$)/m).map(block => [/^  ([a-z][a-z0-9-]*):/m.exec(block)?.[1], block]));
    for (const [job, kind] of [['core-cloudflare', 'core'], ['partner-gateway', 'gateway'], ['base-app', 'pages']]) {
      const body = jobs.get(job); expect(body).toMatch(/actions\/download-artifact@[a-f0-9]{40}/); expect(body).toContain(`${kind}-verified-`);
      expect(body).toContain(`verified-cloudflare-artifact.mjs deploy "$RUNNER_TEMP/delta-${kind}-verified" ${kind}`);
      expect(body).not.toMatch(/run: (?:npx wrangler (?:deploy|pages deploy)|npm run (?:build|verify))/);
    }
    expect(jobs.get('verify')).toContain('include-hidden-files: true');
  });
  it('rechecks live configuration before submission and detects post-submit drift without submitting twice', async () => {
    const f = await fixture(); await qualify(f);
    const live = await f.readLiveCore(); const run = submit(f);
    f.readLiveCore.mockResolvedValueOnce({...live,subdomain:{...live.subdomain,previews_enabled:true}});
    await expect(deployCloudflareArtifact({...f,authorization,variablesPolicy:'preserve-reviewed',run})).rejects.toThrow('preview_urls');
    expect(run).not.toHaveBeenCalled();
    f.readLiveCore.mockResolvedValueOnce(live).mockResolvedValueOnce({...live,deployments:deployment(true),script:{...live.script,observability:{enabled:true,redact_query_string:true}}});
    await expect(deployCloudflareArtifact({...f,authorization,variablesPolicy:'preserve-reviewed',run})).rejects.toThrow('query_redaction');
    expect(run).toHaveBeenCalledTimes(1);
    const args=run.mock.calls[0][1];expect(args).toContain(join(f.directory,'reviewed-core-config.json'));
    const overlay=JSON.parse(await readFile(join(f.directory,'reviewed-core-config.json'),'utf8'));
    expect(overlay.observability.redact_query_string).toBe(false);expect(overlay.preview_urls).toBe(false);
  });
  it('does not overwrite an already prepared config or deploy without a fresh live metadata reader',async()=>{
    const f=await fixture();await qualify(f);const run=vi.fn();
    await expect(prepareCoreReleaseConfig({...f,variablesPolicy:'preserve-reviewed'})).rejects.toThrow();
    await expect(deployCloudflareArtifact({...f,readLiveCore:undefined,authorization,variablesPolicy:'preserve-reviewed',run})).rejects.toThrow('core_live_readback_required');
    expect(run).not.toHaveBeenCalled();
  });
});
