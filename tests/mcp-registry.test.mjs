import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { registryMetadataStatus, lookupMcpVersion, reconcileMcpPublication } from '../scripts/check-mcp-registry.mjs';

const OFFICIAL='io.modelcontextprotocol.registry/official';
const planned=JSON.parse((await readFile(new URL('../distribution/mcp/server.template.json',import.meta.url),'utf8')).replaceAll('__OWNER__','15998194110'));
function entry(server=structuredClone(planned)) {return {server,_meta:{[OFFICIAL]:{status:'active',publishedAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',isLatest:true}}};}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('MCP immutable metadata readback, fixture transport only',()=>{
  it('a matching active name/version with a different package cannot pass the real checker CLI',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'delta-mcp-registry-fixture-'));
    const metadata=join(directory,'server.json'),stub=join(directory,'fixture.mjs');
    const wrong=entry();wrong.server.packages[0].identifier='fixture-different-package';
    await writeFile(metadata,JSON.stringify(planned),{flag:'wx'});
    await writeFile(stub,`globalThis.fetch = async url => Response.json(String(url).includes('/versions/') ? ${JSON.stringify(wrong)} : {servers:[${JSON.stringify(wrong)}]});\n`,{flag:'wx'});
    const result=spawnSync(process.execPath,['--import',pathToFileURL(stub).href,resolve('scripts/check-mcp-registry.mjs'),metadata],{timeout:5000,encoding:'utf8'});
    expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
  });
  it('compares complete server metadata while allowing only explicit outer registry-owned fields',()=>{
    const same=entry(Object.fromEntries(Object.entries(planned).reverse()));
    same._meta[OFFICIAL].isLatest=false;same._meta[OFFICIAL].statusMessage='fixture unchanged';
    expect(registryMetadataStatus(planned,same)).toBe('match');
    for(const modify of [
      s=>{s.description='different';},s=>{s.packages[0].identifier='other';},s=>{s.packages[0].version='0.0.0';},
      s=>{s.packages[0].transport={type:'sse',url:'https://example.invalid/mcp'};},
      s=>{s.packages[0].environmentVariables=[{name:'UNREVIEWED',value:'fixture'}];},
      s=>{s.packages[0].packageArguments=[{type:'positional',value:'other-command'}];},
      s=>{s.repository.url='https://example.invalid/other';},s=>{s.repository.id='unreviewed';},
      s=>{s._meta={'io.modelcontextprotocol.registry/publisher-provided':{unreviewed:true}};},
      s=>{s.packages.push(structuredClone(s.packages[0]));},s=>{delete s.$schema;},
    ]) {const wrong=entry();modify(wrong.server);expect(registryMetadataStatus(planned,wrong)).toBe('metadata_mismatch');}
    const wrong=entry();wrong._meta[OFFICIAL].unknownField='not-reviewed';expect(()=>registryMetadataStatus(planned,wrong)).toThrow('mcp_registry_invalid_response');
  });
  it('an already exact active record avoids every publisher callback',async()=>{
    const publish=vi.fn();expect(await reconcileMcpPublication({expected:planned,lookup:async()=>entry(),publish})).toMatchObject({action:'existing_exact_metadata'});
    expect(publish).not.toHaveBeenCalled();
  });
  it.each(['metadata_mismatch','deprecated','deleted','malformed','unavailable'])('existing %s cannot become permission to publish',async kind=>{
    const record=entry(),publish=vi.fn();
    if(kind==='metadata_mismatch')record.server.packages[0].identifier='different';
    if(['deprecated','deleted'].includes(kind))record._meta[OFFICIAL].status=kind;
    if(kind==='malformed')delete record._meta;
    const lookup=async()=>{if(kind==='unavailable')throw new Error('mcp_registry_unavailable');return record;};
    await expect(reconcileMcpPublication({expected:planned,lookup,publish})).rejects.toThrow();expect(publish).not.toHaveBeenCalled();
  });
  it.each([false,true])('only a matching post-readback confirms a single attempted publication (publisher exit uncertain=%s)',async uncertain=>{
    const lookup=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(entry());
    const publish=vi.fn(async()=>{if(uncertain)throw new Error('invalid version: cannot publish duplicate version');});
    const result=await reconcileMcpPublication({expected:planned,lookup,publish});
    expect(result).toMatchObject({action:'metadata_confirmed_after_single_attempt',publisher_result:uncertain?'uncertain_exit':'returned'});
    expect(publish).toHaveBeenCalledExactlyOnceWith(planned);expect(lookup).toHaveBeenCalledTimes(2);
  });
  it.each(['absent','different','inactive','malformed','unavailable'])('duplicate text plus %s post-readback is failure, never success or a second publication',async kind=>{
    const record=entry(),publish=vi.fn(async()=>{throw new Error('invalid version: cannot publish duplicate version');});
    if(kind==='different')record.server.packages[0].version='0.0.0';if(kind==='inactive')record._meta[OFFICIAL].status='deprecated';
    if(kind==='malformed')delete record.server;
    const lookup=vi.fn().mockResolvedValueOnce(null);
    if(kind==='unavailable')lookup.mockRejectedValueOnce(new Error('mcp_registry_unavailable'));
    else lookup.mockResolvedValueOnce(kind==='absent'?null:record);
    await expect(reconcileMcpPublication({expected:planned,lookup,publish})).rejects.toThrow();expect(publish).toHaveBeenCalledTimes(1);expect(lookup).toHaveBeenCalledTimes(2);
  });
  it('mutating supplied metadata during lookup cannot change the intended publication/readback comparison',async()=>{
    const expected=structuredClone(planned),publish=vi.fn();let count=0;
    const lookup=async input=>{if(count++===0){input.packages[0].identifier='wrong';expected.packages[0].identifier='wrong';return null;}return entry();};
    expect(await reconcileMcpPublication({expected,lookup,publish})).toMatchObject({ok:true});expect(publish).toHaveBeenCalledExactlyOnceWith(planned);
  });
  it('uses exact escaped version lookup including tombstones; only explicit 404 means absent',async()=>{
    const transport=vi.fn(async()=>new Response('',{status:404}));
    expect(await lookupMcpVersion(planned,transport)).toBeNull();
    expect(transport.mock.calls[0][0]).toBe(`https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(planned.name)}/versions/${planned.version}?include_deleted=true`);
    expect(transport.mock.calls[0][1]).toMatchObject({redirect:'error'});
    expect(await lookupMcpVersion(planned,async()=>Response.json(entry()))).toEqual(entry());
    for(const response of [new Response('fixture-provider-error',{status:502}),new Response('',{status:403}),new Response('',{status:302}),new Response('invalid-json'),Response.json({servers:[]}),Response.json(null)]) {
      await expect(lookupMcpVersion(planned,async()=>response)).rejects.toThrow();
    }
    await expect(lookupMcpVersion(planned,async()=>new Response('x'.repeat(128001)))).rejects.toThrow('mcp_registry_response_limit');
  });
  it.each(['get','body'])('a stalled %s read expires without authorizing publication or accepting a late result',async mode=>{
    vi.useFakeTimers();let release;const cancel=vi.fn();
    const transport=mode==='get'?()=>new Promise(resolve=>{release=resolve;}):async()=>new Response(new ReadableStream({cancel}));
    const publish=vi.fn(),pending=reconcileMcpPublication({expected:planned,lookup:value=>lookupMcpVersion(value,transport),publish});
    const failure=expect(pending).rejects.toThrow('mcp_registry_unavailable');await vi.advanceTimersByTimeAsync(15001);await failure;
    if(release)release(new Response('',{status:404}));await vi.advanceTimersByTimeAsync(1);
    expect(publish).not.toHaveBeenCalled();if(mode==='body')expect(cancel).toHaveBeenCalled();
  });
  it('read-only CLI distinguishes exact active, explicit absence and unavailable while withholding provider error bodies',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'delta-mcp-check-exit-fixture-')),metadata=join(directory,'server.json');
    await writeFile(metadata,JSON.stringify(planned),{flag:'wx'});
    for(const [status,body,exit] of [[200,JSON.stringify(entry()),0],[404,'fixture-private-provider-body',2],[502,'fixture-private-provider-body',1]]){
      const stub=join(directory,`fixture-${status}.mjs`);
      await writeFile(stub,`globalThis.fetch = async () => new Response(${JSON.stringify(body)}, {status:${status}});\n`,{flag:'wx'});
      const result=spawnSync(process.execPath,['--import',pathToFileURL(stub).href,resolve('scripts/check-mcp-registry.mjs'),metadata],{timeout:5000,encoding:'utf8'});
      expect(result.error).toBeUndefined();expect(result.status).toBe(exit);expect(result.stdout+result.stderr).not.toContain('fixture-private-provider-body');
    }
  });
  it('unauthorized publication mode rejects before reading files or performing any provider operation',async()=>{
    const result=spawnSync(process.execPath,[resolve('scripts/check-mcp-registry.mjs'),'missing-fixture.json','--publish-if-absent'],
      {timeout:5000,encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'false'}});
    expect(result.status).toBe(1);expect(result.stderr).toContain('release_not_authorized_for_exact_candidate');expect(result.stderr).not.toContain('ENOENT');
  });
  it('release job uses the tested single-attempt reconciler behind exact-source authorization and contains no duplicate-success bypass',async()=>{
    const workflow=await readFile(new URL('../.github/workflows/release-train.yml',import.meta.url),'utf8');
    const block=workflow.split(/(?=^  [a-z][a-z0-9-]*:\s*$)/m).find(value=>/^  mcp-registry:/m.test(value));
    expect(block).toContain('needs: [npm-mcp, authorize-release]');expect(block).toContain('DELTA_REQUESTED_SOURCE');
    expect(block).toContain('node scripts/check-mcp-registry.mjs server.json --publish-if-absent');
    expect(block).not.toContain('PUBLISH_OUTPUT');expect(block).not.toContain('cannot publish duplicate version');expect(block).not.toContain('treating duplicate publish as idempotent success');
    expect(block).not.toContain('/latest/');expect(block).toContain('MCP_PUBLISHER_RELEASE_TAG: ${{ vars.MCP_PUBLISHER_RELEASE_TAG }}');
    expect(block).toContain('MCP_PUBLISHER_LINUX_AMD64_SHA256: ${{ vars.MCP_PUBLISHER_LINUX_AMD64_SHA256 }}');
    expect(block).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+$');expect(block).toContain('^[0-9a-f]{64}$');
    expect(block).toContain('/mcp-publisher_linux_amd64.tar.gz');
    expect(block.indexOf('Approved MCP publisher tag')).toBeLessThan(block.indexOf('curl --fail'));
    expect(block.indexOf('sha256sum --check --strict')).toBeLessThan(block.indexOf('tar -xzf'));
    expect(block.indexOf('sha256sum --check --strict')).toBeLessThan(block.indexOf('./mcp-publisher validate'));
  });
});
