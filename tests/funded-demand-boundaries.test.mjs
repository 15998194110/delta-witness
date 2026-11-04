import {expect,it,vi} from 'vitest';
import {scanExternalDemand,deepObjects} from '../scripts/scan-external-funded-demand.mjs';

it('read-only inventory is bounded and failed channel is unknown rather than zero budget',async()=>{
  const fetchImpl=vi.fn(async(url,init)=>{expect(init.redirect).toBe('error');expect(init.method).toBeUndefined();
    return String(url).includes('riner')?new Response('large',{headers:{'content-length':'2000001'}}):Response.json({items:[]});});
  const result=await scanExternalDemand({fetchImpl,pause:async()=>{}});
  expect(result.ok).toBe(false);expect(result.coverage_complete).toBe(false);expect(result.total_delta_native_funded_requests).toBeNull();
  expect(result.results.find(x=>x.channel==='riner')).toMatchObject({discovery_status:'degraded_recoverable',error:'read_size_limit',delta_native_funded_count:null});
  expect(result.results.filter(x=>x.discovery_status==='present')).toHaveLength(4);
  expect(result.financial_or_signature_action_taken).toBe(false);expect(fetchImpl).toHaveBeenCalledTimes(7);
});
it('deeply nested inventory cannot overflow the stack or mark malformed channel healthy',async()=>{
  let nested={title:'public page proof'};for(let i=0;i<35;i++)nested={child:nested};
  expect(()=>deepObjects(nested)).toThrow('inventory_structure_limit');
  expect(()=>deepObjects(Array.from({length:10001},()=>({})))).toThrow('inventory_structure_limit');
  const result=await scanExternalDemand({fetchImpl:async()=>Response.json(nested),pause:async()=>{}});
  expect(result.ok).toBe(false);expect(result.total_adjacent_funded_requests).toBeNull();
});
it('valid empty inventory proves only the observed selection, not real funding or revenue',async()=>{
  const result=await scanExternalDemand({fetchImpl:async()=>Response.json({items:[]}),pause:async()=>{}});
  expect(result.ok).toBe(true);expect(result.total_delta_native_funded_requests).toBe(0);
  expect(result.results.every(x=>x.buyer_budget_verified===false)).toBe(true);
});
it('invalid JSON and arbitrary exception text stay degraded without leaking upstream text',async()=>{
  const result=await scanExternalDemand({fetchImpl:async()=>{throw new Error('secret_fixture_should_not_be_reported');},pause:async()=>{}});
  expect(JSON.stringify(result)).not.toContain('secret_fixture');expect(result.results.every(x=>x.error==='bounded_inventory_read_failed')).toBe(true);
});
