import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reviewedCoreConfig, reviewedCoreDeployment, coreMetadataReader } from '../scripts/cloudflare-live-config-guard.mjs';

async function fixture() {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const live = { script:{compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags,
    observability:{enabled:true,head_sampling_rate:1,redact_query_string:false,logs:{enabled:true,head_sampling_rate:1,persist:true,invocation_logs:true},traces:{enabled:true,persist:true,head_sampling_rate:0.05}}},
    bindings:[...Object.entries(config.vars).map(([name,text])=>({type:'plain_text',name,text:name==='APP_VERSION'?'0.7.0':text})),
      {type:'secret_text',name:'FIXTURE_SECRET',text:'SYNTHETIC_NEVER_PERSIST'},
      {type:'browser',name:'BROWSER'},{type:'r2_bucket',name:'PROOFS',bucket_name:'delta-witness-proofs'},
      {type:'d1',name:'ANALYTICS_DB',id:config.d1_databases[0].database_id}],
    schedules:{schedules:config.triggers.crons.map(cron=>({cron}))},subdomain:{enabled:true,previews_enabled:false},routes:[],domains:[],deployments:[]};
  return {config,root:'/fixture',live,expectedAppVersion:'0.7.0',variablesPolicy:'preserve-reviewed'};
}
describe('Core production configuration preservation; isolated provider doubles only',()=>{
  it('copies only checked-in configuration and reviewed observability/preview settings, never the provider secret bindings',async()=>{
    const f=await fixture();
    const output=reviewedCoreConfig(f);
    expect(output.vars.APP_VERSION).toBe('0.7.1');expect(output.preview_urls).toBe(false);
    expect(output.observability).toEqual(f.live.script.observability);
    expect(JSON.stringify(output)).not.toContain('SYNTHETIC_');
    f.live.bindings.push({type:'plain_text',name:'EXISTING_EXTRA_FLAG',text:'SYNTHETIC_PRIVATE_LIVE_VALUE'});
    for(const variablesPolicy of ['preserve-reviewed','replace-reviewed'])expect(()=>reviewedCoreConfig({...f,variablesPolicy})).toThrow('unreviewed_variable_inventory');
  });
  it.each(['redaction','observability','resource','cron','price','version','preview','domain','duplicate','limits','unknown-observability'])('blocks %s drift rather than silently overwriting it',async field=>{
    const f=await fixture();
    if(field==='redaction')f.live.script.observability.redact_query_string=true;
    if(field==='observability')f.live.script.observability.logs.persist=false;
    if(field==='resource')f.live.bindings.find(x=>x.type==='d1').id='other';
    if(field==='cron')f.live.schedules.schedules=[];
    if(field==='price')f.live.bindings.find(x=>x.name==='CAPTURE_BASE_PRICE_USD').text='0.01';
    if(field==='version')f.expectedAppVersion='0.6.0';
    if(field==='preview')f.previousPreview=true;
    if(field==='domain')f.live.domains=[{hostname:'new.example'}];
    if(field==='duplicate')f.live.bindings.push({...f.live.bindings[0]});
    if(field==='limits')f.live.script.limits={cpu_ms:100};
    if(field==='unknown-observability')f.live.script.observability.new_field=true;
    expect(()=>reviewedCoreConfig(f)).toThrow('core_configuration_drift');
  });
  it('requires explicit prior version and explicit live redaction before preparing a release',async()=>{
    const f=await fixture();expect(()=>reviewedCoreConfig({...f,expectedAppVersion:undefined})).toThrow('reviewed_release_inputs_required');
    delete f.live.script.observability.redact_query_string;expect(()=>reviewedCoreConfig(f)).toThrow('query_redaction');
  });
  it('reads only metadata GETs, disallows redirects and cannot write, deploy, migrate or retrieve secret values',async()=>{
    const f=await fixture();
    const fetchImpl=vi.fn(async(url,options)=>{
      expect(options.method).toBe('GET');expect(options.redirect).toBe('error');expect(options.body).toBeUndefined();
      const path=new URL(url).pathname;
      const result=path.endsWith('/services/delta-witness-api')?{default_environment:{environment:'production'}}:
        path.endsWith('/bindings')?f.live.bindings:path.endsWith('/schedules')?f.live.schedules:
        path.endsWith('/subdomain')?f.live.subdomain:path.endsWith('/routes')?f.live.routes:
        path.endsWith('/domains/records')?f.live.domains:path.endsWith('/deployments')?f.live.deployments:{script:f.live.script};
      return Response.json({success:true,result});
    });
    const read=coreMetadataReader({account:'a'.repeat(32),token:'synthetic-token',fetchImpl});
    expect(await read()).toEqual(f.live);expect(fetchImpl).toHaveBeenCalledTimes(8);
    fetchImpl.mockResolvedValueOnce(Response.json({success:false},{status:403}));
    await expect(read()).rejects.toThrow('metadata_http_403');
  });
  it('guards before migration/secret writes in the release workflow and preserves explicit prior-version input',async()=>{
    const source=await readFile(new URL('../.github/workflows/release-train.yml',import.meta.url),'utf8');
    expect(source.indexOf('guard-core "$RUNNER_TEMP/delta-core-verified" core')).toBeLessThan(source.indexOf('npx wrangler d1 migrations apply'));
    expect(source).toContain('DELTA_APPROVED_CORE_PREVIOUS_APP_VERSION: ${{ vars.DELTA_APPROVED_CORE_PREVIOUS_APP_VERSION }}');
  });
  it('cancels an oversized metadata body before buffering the remaining stream',async()=>{
    const cancel=vi.fn();let reads=0;
    const fetchImpl=vi.fn(async()=>new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(128_001));},cancel})));
    await expect(coreMetadataReader({account:'a'.repeat(32),token:'synthetic-token',fetchImpl})()).rejects.toThrow('metadata_size');
    expect(cancel).toHaveBeenCalledTimes(1);expect(reads).toBeLessThanOrEqual(3);
  });
  it('rejects same-app-version deployment drift and distinguishes old pre-upload identity from new post-upload identity',()=>{
    const expected={deploymentId:'11111111-1111-1111-1111-111111111111',versionId:'22222222-2222-2222-2222-222222222222'};
    const live={deployments:{deployments:[{id:expected.deploymentId,created_on:'2026-11-04T00:00:00Z',versions:[{version_id:expected.versionId,percentage:100}]}]}};
    expect(reviewedCoreDeployment(live,expected)).toEqual(expected);
    expect(()=>reviewedCoreDeployment(live,expected,true)).toThrow('new_deployment_not_observed');
    live.deployments.deployments[0].id='33333333-3333-3333-3333-333333333333';live.deployments.deployments[0].versions[0].version_id='44444444-4444-4444-4444-444444444444';
    expect(()=>reviewedCoreDeployment(live,expected)).toThrow('deployment_identity');
    expect(reviewedCoreDeployment(live,expected,true).deploymentId).toBe(live.deployments.deployments[0].id);
    live.deployments.deployments[0].versions[0].percentage=50;expect(()=>reviewedCoreDeployment(live,expected,true)).toThrow('deployment_traffic_split');
  });
});
