import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOperatorTarget, projectOperatorTransition, readCanonicalPipeline, updateCanonicalPipeline } from '../scripts/operator-coordination.mjs';

const at='2026-11-02T00:00:00.000Z', payload_hash=`sha256:${'a'.repeat(64)}`;
const prepare=(action_id='fixture-1',target='Buyer@EXAMPLE.test')=>({transition:'prepare',action_id,target,payload_hash,at});
const initial=()=>({opportunities:[],contact_suppressions:[],distribution_submissions:[],
  revenue_cursor:{through:100,unknown:true},sprint_closure:{status:'closed_target_missed',new_sprint_acquisition_enabled:false},
  customer_extension:{keep:'original'}});
const evidence=(outcome='no_match')=>({source:'gmail_sent',outcome,target:'buyer@example.test',payload_hash,checked_at:at,evidence_ref:'synthetic-sent-readback',
  ...(outcome==='confirmed'?{message_id:'synthetic-message-1',thread_id:'synthetic-thread-1'}:{})});
async function fixture(document=initial()) {
  const dir=await mkdtemp(join(tmpdir(),'delta-operator-fixture-'));
  const path=join(dir,'pipeline.json');await writeFile(path,JSON.stringify(document),{flag:'wx'});
  return {dir,path,snapshot:await readCanonicalPipeline(path)};
}
afterEach(()=>vi.unstubAllGlobals());
describe('canonical operator coordination candidate, synthetic local files only',()=>{
  it('normalizes exact contacts and retains a shared domain fence',()=>{
    expect(normalizeOperatorTarget('Buyer@EXAMPLE.test')).toEqual({target:'buyer@example.test',keys:['domain:example.test','email:buyer@example.test']});
    expect(()=>normalizeOperatorTarget('https://example.test/?secret=x')).toThrow('invalid_operator_target');
  });
  it('preserves original cursors, suppression, unknown fields and closed sprint through one atomic document update',async()=>{
    const f=await fixture();vi.stubGlobal('fetch',()=>{throw new Error('unexpected network');});
    const result=await updateCanonicalPipeline({path:f.path,expectedSha256:f.snapshot.sha256,command:prepare()});
    const actual=await readCanonicalPipeline(f.path);
    expect(result).toMatchObject({state:'prepared',external_action_performed:false,external_readback_verified:false});
    const {delta_action_coordination,...unchanged}=actual.document;expect(unchanged).toEqual(initial());
    expect(delta_action_coordination.revision).toBe(1);expect(await readdir(f.dir)).toEqual(['pipeline.json']);
  });
  it('one concurrent version wins without losing the original revenue cursor or adding two claims',async()=>{
    const f=await fixture();
    const results=await Promise.allSettled(['fixture-1','fixture-2'].map(id=>updateCanonicalPipeline({path:f.path,expectedSha256:f.snapshot.sha256,command:prepare(id)})));
    expect(results.filter(value=>value.status==='fulfilled')).toHaveLength(1);
    const actual=(await readCanonicalPipeline(f.path)).document;
    expect(actual.delta_action_coordination.actions).toHaveLength(1);expect(actual.revenue_cursor).toEqual(initial().revenue_cursor);
  });
  it('a stale snapshot fails and preserves its durable lock for reconciliation instead of deleting unknown state',async()=>{
    const f=await fixture();await writeFile(f.path,JSON.stringify({...initial(),revenue_cursor:{through:200,unknown:false}}));
    await expect(updateCanonicalPipeline({path:f.path,expectedSha256:f.snapshot.sha256,command:prepare()})).rejects.toThrow('canonical_version_conflict');
    expect((await readCanonicalPipeline(f.path)).document.revenue_cursor.through).toBe(200);
    expect(await readdir(f.dir)).toContain('.pipeline.delta-write-lock');
    await expect(updateCanonicalPipeline({path:f.path,expectedSha256:(await readCanonicalPipeline(f.path)).sha256,command:prepare()})).rejects.toThrow('operator_lock_exists_or_unavailable_readback_required');
  });
  it('never removes an unknown lock even when old or incomplete',async()=>{
    const f=await fixture();const lock=join(f.dir,'.pipeline.delta-write-lock');await writeFile(lock,'partial historical lock',{flag:'wx'});
    await expect(updateCanonicalPipeline({path:f.path,expectedSha256:f.snapshot.sha256,command:prepare()})).rejects.toThrow('operator_lock_exists_or_unavailable_readback_required');
    expect(await readFile(lock,'utf8')).toBe('partial historical lock');expect((await readCanonicalPipeline(f.path)).sha256).toBe(f.snapshot.sha256);
  });
  it('original SENT IDs and contact suppressions prevent another first contact under a different action ID',()=>{
    const prior=initial();prior.opportunities.push({contact:'Buyer <buyer@example.test>',sent_message_id:'synthetic-already-sent'});
    expect(()=>projectOperatorTransition(prior,prepare('new'))).toThrow('prior_contact_or_submission_requires_reconciliation');
    const suppressed=initial();suppressed.contact_suppressions.push({recipient:'buyer@example.test',reason:'fixture'});
    expect(()=>projectOperatorTransition(suppressed,prepare('new'))).toThrow('prior_contact_or_submission_requires_reconciliation');
  });
  it('a crash after attempted reservation is reconciled from SENT, never retried or reported as a second send',async()=>{
    const f=await fixture();
    const apply=async command=>updateCanonicalPipeline({path:f.path,expectedSha256:(await readCanonicalPipeline(f.path)).sha256,command});
    await apply(prepare());await apply({transition:'attempt',action_id:'fixture-1',at,readback:evidence()});
    // Reopen the original file, representing another session after an external
    // result was lost. No send function exists in this adapter or test.
    const snapshot=await readCanonicalPipeline(f.path);
    expect(()=>projectOperatorTransition(snapshot.document,{transition:'attempt',action_id:'fixture-1',at,readback:evidence()})).toThrow('operator_attempt_already_reserved');
    await apply({transition:'confirm_from_readback',action_id:'fixture-1',at,readback:evidence('confirmed')});
    await apply({transition:'report',action_id:'fixture-1',at,report_evidence_ref:'synthetic-report'});
    const action=(await readCanonicalPipeline(f.path)).document.delta_action_coordination.actions[0];
    expect(action).toMatchObject({state:'confirmed',bookkeeping_state:'recorded',reporting_state:'reported',readback:{message_id:'synthetic-message-1'}});
  });
  it('unknown submission and an attempted claim keep their target reserved across sessions and alternate addresses',()=>{
    let doc=projectOperatorTransition(initial(),prepare());
    doc=projectOperatorTransition(doc,{transition:'attempt',action_id:'fixture-1',at,readback:evidence()});
    doc=projectOperatorTransition(doc,{transition:'unknown',action_id:'fixture-1',at});
    expect(()=>projectOperatorTransition(doc,prepare('second','other@example.test'))).toThrow('prior_contact_or_submission_requires_reconciliation');
    expect(()=>projectOperatorTransition(doc,{transition:'attempt',action_id:'fixture-1',at,readback:evidence()})).toThrow('operator_attempt_already_reserved');
  });
  it('absence of local records alone does not authorize attempting without fresh external readback evidence',()=>{
    const doc=projectOperatorTransition(initial(),prepare());
    expect(()=>projectOperatorTransition(doc,{transition:'attempt',action_id:'fixture-1',at})).toThrow('current_external_readback_required');
    expect(()=>projectOperatorTransition(doc,{transition:'attempt',action_id:'fixture-1',at,readback:{...evidence(),checked_at:'2026-11-01T00:00:00.000Z'}})).toThrow('current_external_readback_required');
  });
  it('only bounded non-secret correlation data enters readback; supplied provider claims remain explicit assertions',()=>{
    const doc=projectOperatorTransition(initial(),prepare());
    expect(()=>projectOperatorTransition(doc,{transition:'confirm_from_readback',action_id:'fixture-1',at,readback:{...evidence('confirmed'),body:'private mail'}})).toThrow('current_external_readback_required');
    expect(()=>projectOperatorTransition(doc,{transition:'confirm_from_readback',action_id:'fixture-1',at,readback:{...evidence('confirmed'),payload_hash:`sha256:${'b'.repeat(64)}`}})).toThrow('current_external_readback_required');
    const result=projectOperatorTransition(doc,{transition:'confirm_from_readback',action_id:'fixture-1',at,readback:evidence('confirmed')});
    expect(result.delta_action_coordination.actions[0].readback.assurance).toBe('caller_attestation_requires_provider_readback');
  });
});
