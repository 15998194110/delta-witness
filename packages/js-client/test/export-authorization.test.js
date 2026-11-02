import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaWitness } from '../src/index.js';

const origin='https://delta.test',id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const proofId='56347db8-1aa5-447f-a0e4-3bb052d7aa89';
const proof={ok:true,product:'preflight',proof_id:proofId,manifest_url:`${origin}/v1/proofs/${proofId}`,public_proof_url:`${origin}/p/${proofId}`,
  bundle_root:'sha256:'+'a'.repeat(64),observed_at:'2026-11-02T00:00:00.000Z',safe:false,changed:true,reason:'expectations_not_met'};
function store(){
  const values=new Map();return {values,async load(id){return values.has(id)?structuredClone(values.get(id)):null;},
    async compareAndSet(id,revision,next){if((values.get(id)?.revision??null)!==revision)return false;values.set(id,structuredClone(next));return true;}};
}
const client=(orderStore,fetchImpl,timeout=1000)=>new DeltaWitness({baseUrl:origin,orderStore,fetchImpl,requestTimeoutMs:timeout});
async function fixture(){
  const state=store(),delta=client(state,()=>{throw new Error('fixture-network-not-configured');});
  await delta.prepareOrder('preflight',{url:'https://example.com/'},{orderId:id});
  let paid=0;await delta.executeOrder(id,async()=>{paid++;return Response.json(proof);});
  return {state,paid,original:await state.load(id)};
}
function envelope(authorization){return {ok:true,order_id:id,authorization};}
function metadata(body,generation=body.expected_generation+1){return {operation_id:body.operation_id,generation,
  expires_at:new Date(Date.now()+60000).toISOString(),scope:['export'],state:'active'};}
function provider(state){
  const calls=[];let current=null;
  return {calls,get current(){return current;},set current(value){current=value;},async fetch(url,init){
    calls.push({url,method:init.method});assert.equal(url,`${origin}/v1/orders/${id}/export-authorization`);assert.equal(init.redirect,'error');
    assert.equal(init.headers['x-delta-recovery-token'],(await state.load(id)).recovery_token);
    assert.equal(new Headers(init.headers).has('payment-signature'),false);assert.equal(new Headers(init.headers).has('x-payment'),false);
    if(init.method==='GET'){assert.equal(init.body,undefined);return Response.json(envelope(current));}
    const body=JSON.parse(init.body),local=(await state.load(id)).export_authorization;
    assert.deepEqual(body,{operation_id:local.operation_id,token:local.token,ttl_seconds:local.ttl_seconds,expected_generation:local.expected_generation});
    assert.equal(local.phase,'pending');assert.notEqual(body.token,(await state.load(id)).recovery_token);assert.equal(Buffer.from(body.token,'base64url').length,32);
    assert.equal(body.expected_generation,current?.generation??0);current=metadata(body);return Response.json(envelope(current),{status:201});
  }};
}
test('negative original delivery persists one private export operation before unsigned POST and returns metadata only',async()=>{
  const f=await fixture(),remote=provider(f.state),delta=client(f.state,remote.fetch);
  const result=await delta.renewExportAuthorization(id,{ttlSeconds:60}),record=await f.state.load(id);
  assert.deepEqual(remote.calls.map(call=>call.method),['GET','POST']);assert.equal(record.export_authorization.phase,'confirmed');
  assert.equal(record.export_authorization.generation,1);assert.equal(record.phase,'complete');assert.equal(record.request_digest,f.original.request_digest);
  assert.equal(record.recovery_token,f.original.recovery_token);assert.equal(f.paid,1);
  assert.deepEqual(result,envelope(remote.current));assert.equal(JSON.stringify(result).includes(record.export_authorization.token),false);
  assert.equal(JSON.stringify(result).includes(record.recovery_token),false);
});
test('explicit confirmed rotation reads the current generation and replaces only the original private record subfield',async()=>{
  const f=await fixture(),remote=provider(f.state),delta=client(f.state,remote.fetch);
  await delta.renewExportAuthorization(id);const first=await f.state.load(id);
  await delta.renewExportAuthorization(id,{ttlSeconds:120});const second=await f.state.load(id);
  assert.equal(second.export_authorization.expected_generation,1);assert.equal(second.export_authorization.generation,2);
  assert.notEqual(second.export_authorization.token,first.export_authorization.token);
  assert.equal(second.recovery_token,first.recovery_token);assert.equal(second.phase,'complete');assert.equal(f.state.values.size,1);
});
test('lost POST response after commit is reconciled by a restarted client with GET only',async()=>{
  const f=await fixture(),remote=provider(f.state);
  const delta=client(f.state,async(...args)=>{const response=await remote.fetch(...args);if(args[1].method==='POST')throw new Error('fixture-lost-ack');return response;});
  await assert.rejects(delta.renewExportAuthorization(id),error=>error.code==='order_export_authorization_unconfirmed'&&!error.message.includes('fixture-lost-ack'));
  const pending=await f.state.load(id);assert.equal(pending.export_authorization.phase,'pending');
  const result=await client(f.state,remote.fetch).renewExportAuthorization(id);
  assert.equal(result.authorization.operation_id,pending.export_authorization.operation_id);assert.equal((await f.state.load(id)).export_authorization.phase,'confirmed');
  assert.deepEqual(remote.calls.map(call=>call.method),['GET','POST','GET']);
});
for(const status of [409,503])test(`HTTP ${status} leaves the exact operation pending; repeated calls never POST again`,async()=>{
  const f=await fixture(),methods=[];
  const delta=client(f.state,async(_url,init)=>{methods.push(init.method);return init.method==='GET'?Response.json(envelope(null)):Response.json({ok:false,error:'fixture-private-message'},{status});});
  await assert.rejects(delta.renewExportAuthorization(id),error=>error.status===status&&!error.message.includes('fixture-private-message'));
  const before=await f.state.load(id);for(let i=0;i<2;i++)await assert.rejects(delta.renewExportAuthorization(id),/order_export_authorization_unconfirmed/);
  assert.deepEqual(await f.state.load(id),before);assert.equal(methods.filter(m=>m==='POST').length,1);
});
test('a persistence ACK lost before POST leaves pending intact and restart does not infer permission from remote absence',async()=>{
  const f=await fixture(),remote=provider(f.state),cas=f.state.compareAndSet;
  f.state.compareAndSet=async(...args)=>{await cas(...args);throw new Error('fixture-store-secret');};
  await assert.rejects(client(f.state,remote.fetch).renewExportAuthorization(id),error=>error.code==='order_store_unavailable'&&!error.message.includes('fixture-store-secret'));
  f.state.compareAndSet=cas;const pending=await f.state.load(id);assert.equal(pending.export_authorization.phase,'pending');
  await assert.rejects(client(f.state,remote.fetch).renewExportAuthorization(id));assert.deepEqual(await f.state.load(id),pending);
  assert.equal(remote.calls.filter(call=>call.method==='POST').length,0);
});
test('two concurrent clients create at most one POST and never overwrite a newer confirmed generation',async()=>{
  const f=await fixture(),remote=provider(f.state),a=client(f.state,remote.fetch),b=client(f.state,remote.fetch);
  const results=await Promise.allSettled([a.renewExportAuthorization(id),b.renewExportAuthorization(id)]);
  assert.equal(remote.calls.filter(call=>call.method==='POST').length,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await f.state.load(id)).export_authorization.generation,1);
});
test('an older pending GET completion cannot overwrite a newer locally recorded generation',async()=>{
  const f=await fixture(),remote=provider(f.state);let release;
  await assert.rejects(client(f.state,async(...args)=>{const response=await remote.fetch(...args);if(args[1].method==='POST')throw new Error();return response;}).renewExportAuthorization(id));
  const old=await f.state.load(id),oldRemote=structuredClone(remote.current);
  const recovery=client(f.state,()=>new Promise(resolve=>{release=resolve;})).recoverExportAuthorization(id);
  while(!release)await new Promise(resolve=>setTimeout(resolve,0));
  const newer={...old,revision:old.revision+1,export_authorization:{...old.export_authorization,operation_id:other,token:'B'.repeat(42)+'A',
    expected_generation:1,phase:'confirmed',generation:2,expires_at:new Date(Date.now()+60000).toISOString()}};
  f.state.values.set(id,structuredClone(newer));release(Response.json(envelope(oldRemote)));
  await assert.rejects(recovery,/order_store_conflict/);assert.deepEqual(await f.state.load(id),newer);
});
for(const mode of ['wrong-order','wrong-operation','wrong-generation','extra-token','extra-root-token','extra-scope'])test(`POST ${mode} response cannot confirm or expose a child capability`,async()=>{
  const f=await fixture(),remote=provider(f.state);
  const delta=client(f.state,async(...args)=>{
    const response=await remote.fetch(...args);if(args[1].method==='GET')return response;
    const body=await response.json(),record=await f.state.load(id);
    if(mode==='wrong-order')body.order_id=other;if(mode==='wrong-operation')body.authorization.operation_id=other;
    if(mode==='wrong-generation')body.authorization.generation++;
    if(mode==='extra-token')body.authorization.token=record.export_authorization.token;
    if(mode==='extra-root-token')body.token=record.recovery_token;
    if(mode==='extra-scope')body.authorization.scope.push('recover');return Response.json(body,{status:201});
  });
  await assert.rejects(delta.renewExportAuthorization(id),error=>!JSON.stringify(error).includes(f.original.recovery_token));
  assert.equal((await f.state.load(id)).export_authorization.phase,'pending');
});
test('derived export explicitly rechecks current operation then sends only its confirmed child token',async()=>{
  const f=await fixture(),remote=provider(f.state),delta=client(f.state,remote.fetch);await delta.renewExportAuthorization(id);
  const record=await f.state.load(id),bytes=new TextEncoder().encode('fixture opaque artifact');
  const hash='sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');let artifactCalls=0;
  const exported=await client(f.state,async(url,init)=>{
    if(url.endsWith('/export-authorization'))return remote.fetch(url,init);
    artifactCalls++;assert.equal(init.headers['x-delta-recovery-token'],record.export_authorization.token);assert.equal(init.method,'GET');assert.equal(init.body,undefined);
    return new Response(bytes,{headers:{'content-disposition':'attachment;','content-length':String(bytes.length),'x-delta-content-sha256':hash}});
  }).exportArtifact(id,'html',{authorization:'derived'});
  assert.deepEqual(exported.bytes,bytes);assert.equal(artifactCalls,1);assert.equal(exported.content_type,'application/octet-stream');
});
for(const mode of ['unknown','expired','rotated','missing-local'])test(`derived export ${mode} fails without falling back to root or requesting artifacts`,async()=>{
  const f=await fixture(),remote=provider(f.state),delta=client(f.state,remote.fetch);
  if(mode!=='missing-local')await delta.renewExportAuthorization(id);
  if(mode==='unknown')remote.current=null;if(mode==='rotated'){remote.current={...remote.current,operation_id:other,generation:2};}
  if(mode==='expired')remote.current={...remote.current,state:'expired'};
  const urls=[];await assert.rejects(client(f.state,async(url,init)=>{urls.push(url);return remote.fetch(url,init);}).exportArtifact(id,'html',{authorization:'derived'}),/order_export_authorization_unconfirmed/);
  assert.equal(urls.some(url=>url.includes('/artifacts/')),false);
});
test('explicit original export still works with a pending child and never selects that unknown token',async()=>{
  const f=await fixture(),remote=provider(f.state);await assert.rejects(client(f.state,async(...args)=>{const response=await remote.fetch(...args);if(args[1].method==='POST')throw new Error();return response;}).renewExportAuthorization(id));
  const bytes=new Uint8Array([1]),hash='sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  await client(f.state,async(url,init)=>{assert.ok(url.endsWith('/artifacts/screenshot'));assert.equal(init.headers['x-delta-recovery-token'],f.original.recovery_token);
    return new Response(bytes,{headers:{'content-disposition':'attachment;','content-length':'1','x-delta-content-sha256':hash}});}).exportArtifact(id,'screenshot');
});
for(const mode of ['get','post'])test(`stalled ${mode} times out and late completion cannot write confirmed local state`,async()=>{
  const f=await fixture(),remote=provider(f.state);let release;
  const delta=client(f.state,async(url,init)=>{
    if(init.method===mode.toUpperCase())return new Promise(resolve=>{release=async()=>resolve(await remote.fetch(url,init));});
    return remote.fetch(url,init);
  },20);
  await assert.rejects(delta.renewExportAuthorization(id),/order_export_authorization_unconfirmed/);
  const before=await f.state.load(id);await release();await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(await f.state.load(id),before);
  if(mode==='post')assert.equal(before.export_authorization.phase,'pending');else assert.equal(before.export_authorization,undefined);
});
test('strict optional private child schema rejects corrupt capability data before any request',async()=>{
  const f=await fixture(),remote=provider(f.state);await client(f.state,remote.fetch).renewExportAuthorization(id);const valid=await f.state.load(id);
  for(const change of [a=>{a.token=f.original.recovery_token;},a=>{a.scope=['export'];},a=>{a.expected_generation=-1;},a=>{a.generation=2;},a=>{a.ttl_seconds=3601;},a=>{a.operation_id='not-uuid';}]){
    const bad=structuredClone(valid);change(bad.export_authorization);f.state.values.set(id,bad);let calls=0;
    await assert.rejects(client(f.state,()=>{calls++;}).recoverExportAuthorization(id),/order_store_invalid/);assert.equal(calls,0);
  }
});
test('invalid TTL and incomplete original order cannot create a child operation',async()=>{
  const f=await fixture();let calls=0;const delta=client(f.state,()=>{calls++;});
  for(const ttlSeconds of [0,59,3601,1.5,'60'])await assert.rejects(delta.renewExportAuthorization(id,{ttlSeconds}),/invalid_export_authorization_ttl/);
  f.state.values.set(id,{...f.original,phase:'uncertain'});await assert.rejects(delta.renewExportAuthorization(id),/order_delivery_required/);assert.equal(calls,0);
});
