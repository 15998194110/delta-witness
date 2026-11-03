import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importFinancialEvidence,main} from '../scripts/import-financial-evidence.mjs';
const source=()=>({schema:'delta-financial-source/v1',source_ref:'synthetic-notice',observed_at:'2026-11-04T00:00:00.000Z',collection:'connected_gmail_metadata',kind:'invoice_notice',
  payload:{provider:'cloudflare',invoice_id:'SYNTHETIC-INVOICE',issued_at:'2026-10-30T14:05:56.000Z',amount_due_usd_raw:'0',dkim_pass:true,dmarc_pass:true,invoice_items_available:false,order_allocation_available:false}});
afterEach(()=>vi.unstubAllGlobals());
it('offline import retains append-only evidence and cannot import live-verification authority',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'delta-financial-source-fixture-')),store=join(directory,'sources'),network=vi.fn(()=>{throw Error('no network');});vi.stubGlobal('fetch',network);
  const input={schema:'delta-financial-evidence-import/v1',sources:[source()]},first=await importFinancialEvidence(input,store);
  expect(first).toMatchObject({state:'retained',source_count:1,provider_verification_performed:false,financial_recognition_performed:false,actual_variable_cost_raw:null});
  const files=await readdir(store);expect(files).toHaveLength(1);const original=await readFile(join(store,files[0]),'utf8');
  expect(JSON.parse(original).source.collection).toBe('local_import');expect((await importFinancialEvidence(input,store)).receipts[0].replayed).toBe(true);
  expect(await readFile(join(store,files[0]),'utf8')).toBe(original);expect(network).not.toHaveBeenCalled();
  // Synthetic scratch files are deliberately retained. No live data deletion
  // or recursive filesystem cleanup is part of this importer/test contract.
});
it('CLI output is create-only and does not overwrite an existing acceptance record',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'delta-financial-source-fixture-')),input=join(directory,'input.json'),output=join(directory,'result.json'),store=join(directory,'sources');
  await writeFile(input,JSON.stringify({schema:'delta-financial-evidence-import/v1',sources:[source()]}),{flag:'wx'});
  await writeFile(output,'preserve-evidence',{flag:'wx'});
  await expect(main(['--input',input,'--store',store,'--output',output])).rejects.toThrow();expect(await readFile(output,'utf8')).toBe('preserve-evidence');
});
it('unknown source fields and arbitrary file keys are rejected rather than copied',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'delta-financial-source-fixture-'));
  await expect(importFinancialEvidence({schema:'delta-financial-evidence-import/v1',sources:[{...source(),private_key:'never-copy'}]},join(directory,'source'))).rejects.toThrow('invalid_financial_source');
});
