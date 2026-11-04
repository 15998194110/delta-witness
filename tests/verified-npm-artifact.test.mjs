import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { recordVerifiedNpmArtifact, reconcileVerifiedNpmArtifact, registryVersion } from '../scripts/verified-npm-artifact.mjs';
const name='delta-witness-ruphussten',version='0.7.1',source='a'.repeat(40);
function archive(metadata) {
  const json=Buffer.from(JSON.stringify(metadata)),header=Buffer.alloc(512);
  header.write('package/package.json');header.write(json.length.toString(8).padStart(11,'0')+'\0',124);header.write('0',156);
  return gzipSync(Buffer.concat([header,json,Buffer.alloc((512-json.length%512)%512+1024)]));
}
async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'delta-npm-artifact-fixture-'));
  const bytes=archive({name,version}),filename=`${name}-${version}.tgz`;
  const sri=`sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  await writeFile(join(directory,filename),bytes,{flag:'wx'});
  await writeFile(join(directory,'package.json'),JSON.stringify({name,version}),{flag:'wx'});
  await writeFile(join(directory,'pack.json'),JSON.stringify([{name,version,filename,integrity:sri}]),{flag:'wx'});
  const manifest=await recordVerifiedNpmArtifact(directory,directory,name,source);
  return {directory,name,source,manifest,record:{name,version,dist:{integrity:sri}}};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('verified npm archive qualification, no real registry or publication',()=>{
  it('existing matching version succeeds only for the exact verified archive without republishing',async()=>{
    const f=await fixture(),publish=vi.fn();const lookup=vi.fn(async()=>f.record);
    expect(await reconcileVerifiedNpmArtifact({...f,lookup,publish})).toMatchObject({action:'existing_exact_artifact',source_commit:source});expect(publish).not.toHaveBeenCalled();
  });
  it('an existing version with old or missing integrity fails closed instead of claiming package parity',async()=>{
    const f=await fixture();for(const record of [{...f.record,dist:{integrity:'old-bytes'}},{...f.record,dist:{}}]){
      const publish=vi.fn();await expect(reconcileVerifiedNpmArtifact({...f,lookup:async()=>record,publish})).rejects.toThrow('existing_npm_version_has_different_artifact');expect(publish).not.toHaveBeenCalled();
    }
  });
  it('a new version publishes the recorded tarball once and requires exact registry readback',async()=>{
    const f=await fixture(),publish=vi.fn(),lookup=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(f.record);
    expect(await reconcileVerifiedNpmArtifact({...f,lookup,publish})).toMatchObject({action:'published_exact_artifact'});
    expect(publish).toHaveBeenCalledExactlyOnceWith(join(f.directory,f.manifest.filename));
  });
  it('uncertain or wrong post-publication evidence never repeats the publication callback',async()=>{
    for(const readback of [null,{name,version,dist:{integrity:'wrong'}}]){
      const f=await fixture(),publish=vi.fn(),lookup=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(readback);
      await expect(reconcileVerifiedNpmArtifact({...f,lookup,publish})).rejects.toThrow('npm_publication_readback_unconfirmed');expect(publish).toHaveBeenCalledTimes(1);
    }
  });
  it('source mismatch or altered archive is rejected before registry and publication',async()=>{
    const f=await fixture(),lookup=vi.fn(),publish=vi.fn();
    await expect(reconcileVerifiedNpmArtifact({...f,source:'b'.repeat(40),lookup,publish})).rejects.toThrow('verified_npm_identity_mismatch');
    const path=join(f.directory,f.manifest.filename);await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('tampered')]));
    await expect(reconcileVerifiedNpmArtifact({...f,lookup,publish})).rejects.toThrow();expect(lookup).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
  });
  it('a changed archive during registry lookup cannot reach the publication callback',async()=>{
    const f=await fixture(),publish=vi.fn(),lookup=async()=>{
      await writeFile(join(f.directory,f.manifest.filename),archive({name,version,extra:'changed'}));return null;
    };
    await expect(reconcileVerifiedNpmArtifact({...f,lookup,publish})).rejects.toThrow('verified_npm_artifact_mismatch');expect(publish).not.toHaveBeenCalled();
  });
  it('reads a real offline npm pack archive and never runs package lifecycle scripts',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'delta-npm-realpack-fixture-'));
    const metadata={name,version,files:['index.js'],scripts:{prepack:'node -e "throw new Error(\'must not run\')"'}};
    await writeFile(join(directory,'package.json'),JSON.stringify(metadata),{flag:'wx'});
    await writeFile(join(directory,'index.js'),'export const syntheticFixture = true;\n',{flag:'wx'});
    // npm_execpath is the already installed CLI that launched this local suite;
    // no dependency installation, registry call or publication is allowed.
    if(!process.env.npm_execpath?.endsWith('npm-cli.js'))throw new Error('installed_npm_cli_required');
    const output=execFileSync(process.execPath,[process.env.npm_execpath,'pack','--offline','--ignore-scripts','--json','--pack-destination',directory],{cwd:directory,timeout:30000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    await writeFile(join(directory,'pack.json'),output,{flag:'wx'});
    const manifest=await recordVerifiedNpmArtifact(directory,directory,name,source);
    expect(manifest).toMatchObject({package_name:name,version,source_commit:source});
  }, 35_000); // The real, offline child process itself has a 30-second deadline.
  it('a registry denial, oversized body or malformed response cannot authorize publication',async()=>{
    await expect(registryVersion(name,version,async()=>new Response('fixture-secret',{status:403}))).rejects.toThrow('npm_registry_unavailable');
    await expect(registryVersion(name,version,async()=>new Response('x'.repeat(128001)))).rejects.toThrow('npm_registry_response_limit');
    await expect(registryVersion(name,version,async()=>new Response('invalid-json'))).rejects.toThrow();
    expect(await registryVersion(name,version,async()=>new Response('',{status:404}))).toBeNull();
  });
  it('a stalled registry body times out, cancels, and cannot turn cancelled EOF into absence',async()=>{
    vi.useFakeTimers();const cancel=vi.fn();const pending=registryVersion(name,version,async()=>new Response(new ReadableStream({cancel})));
    const result=expect(pending).rejects.toThrow('npm_registry_unavailable');await vi.advanceTimersByTimeAsync(15001);await result;expect(cancel).toHaveBeenCalled();
  });
  it('workflow prepares before real packaging and publishes only the uploaded verified archive',async()=>{
    const workflow=await readFile(new URL('../.github/workflows/release-train.yml',import.meta.url),'utf8');
    expect(workflow).not.toContain('already published; skipping');
    expect(workflow.match(/verified-npm-artifact\.mjs record/g)).toHaveLength(2);
    expect(workflow.match(/verified-npm-artifact\.mjs publish/g)).toHaveLength(2);
    for(const block of workflow.split(/(?=^  [a-z][a-z0-9-]*:\s*$)/m).filter(value=>/^  npm-(client|mcp):/m.test(value))){
      expect(block).toMatch(/actions\/download-artifact@[a-f0-9]{40}/);expect(block).not.toContain('npm publish');expect(block).not.toContain('npm ci');expect(block).toContain('authorize-release');
    }
    expect(workflow.indexOf('prepare-npm-publish.mjs')).toBeLessThan(workflow.indexOf('verified-npm-artifact.mjs record'));
  });
});
