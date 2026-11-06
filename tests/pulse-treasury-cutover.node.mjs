import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ORIGIN_BLOCK as cut, ORIGIN_HASH, runPulseTreasury } from '../scripts/pulse-treasury-custody.mjs';
import { NETWORK, TRANSFER_TOPIC, TO_TOPIC, TREASURY, USDC } from '../scripts/treasury-reconciliation.mjs';

const hex = n => '0x' + n.toString(16);
const hash = n => n === cut ? ORIGIN_HASH : '0x' + n.toString(16).padStart(64, '0');
const writerSecret = 'fixture-only-synthetic-32-byte-credential';
function setup() {
  const rows = [];
  const requests = [];
  const state = { enabled: false, badHistory: false, wrongOrigin: false, dropped: false };
  const fakePayer = '0x' + '5'.repeat(40);
  const fakeTx = '0x' + 'a'.repeat(64);
  const rpc = async (method, args) => {
    let result;
    if (method === 'eth_chainId') result = hex(8453);
    else if (method === 'eth_blockNumber') result = hex(cut+15);
    else if (method === 'eth_getBlockByNumber') {
      const n = args[0] === 'finalized' ? cut+1 : Number(args[0]);
      result = { number: hex(n), hash: hash(n), parentHash: hash(n-1) };
    } else if (method === 'eth_getLogs') {
      const n = state.badHistory ? cut : cut+1;
      result = n < Number(args[0].fromBlock) || n > Number(args[0].toBlock) ? [] : [{
        address: USDC, removed:false, blockNumber: hex(n), blockHash: hash(n), transactionHash: fakeTx, logIndex:'0x0',
        topics: [TRANSFER_TOPIC,'0x' + fakePayer.slice(2).padStart(64,'0'),TO_TOPIC], data:'0x' + '5'.padStart(64,'0')
      }];
    } else throw Error('unexpected_fixture_method');
    return { result, url:'https://fixture.invalid' };
  };
  const fetchImpl = async (url, opts) => {
    assert.equal(new URL(url).origin,'https://delta-witness-api.ruphussten.workers.dev');
    assert.equal(opts.headers.authorization,'TreasuryWriter ' + writerSecret);
    assert.equal(opts.redirect,'error');
    const path = new URL(url).pathname.split('/').at(-1);
    const reply = (obj,status) => Response.json(obj,{status});
    requests.push([path,opts.method]);
    if(path==='config') return reply({ok:true,schema:'delta-treasury-custody-config/v1',origin_block:state.wrongOrigin ? cut-1 : cut,
      minimum_revision:state.enabled ? {version:1,digest:rows[0].digest} : null,allow_bootstrap:!state.enabled,network:NETWORK,asset:USDC,treasury:TREASURY},200);
    if(path==='revisions') return reply({versions:rows.map(r=>r.version),cursor:null},200);
    if(opts.method==='GET') return rows[Number(path)-1] ? reply(rows[Number(path)-1],200) : reply({ok:false,error:'custody_revision_not_found'},404);
    const v=JSON.parse(new TextDecoder().decode(opts.body));
    if(rows.length+1!==v.version) return reply({created:false,error:'treasury_custody_conflict'},409);
    rows.push(v);
    if(state.dropped){state.dropped=false;throw Error('simulated lost acknowledgment');}
    return reply({ok:true,created:true,version:v.version,digest:v.digest},201);
  };
  const run = (mode,baselineDigest) => runPulseTreasury({mode,baselineDigest,rpc,fetchImpl,writerSecret});
  return { rows,requests,state,run,fakePayer,fakeTx };
}

test('bootstrap commits exactly one empty finalized boundary, resume observes only prospective receipts, public output is limited',async()=>{
  const t=setup();
  t.state.dropped=true;
  const first=await t.run('bootstrap');
  assert.equal(first.state,'empty_boundary_persisted');
  assert.equal(first.checkpoint_after,cut);
  assert.deepEqual(t.rows[0].state.transfers,[]);
  assert.equal(first.baseline_digest,t.rows[0].digest);
  assert.equal((await t.run('bootstrap')).ok,false);
  assert.equal(t.requests.filter(r=>r[1]==='POST').length,1);
  t.state.enabled=true;
  const saved=JSON.stringify(t.rows[0]);
  assert.equal((await t.run('remote','c'.repeat(64))).ok,false);
  const result=await t.run('remote',first.baseline_digest);
  assert.equal(result.state,'range_verified');
  assert.equal(result.checkpoint_after,cut+3);
  assert.equal(t.rows.at(-1).state.transfers.length,1);
  assert.equal(t.rows.at(-1).state.transfers[0].block_number,cut+1);
  assert.equal((await t.run('remote',first.baseline_digest)).ok,true);
  assert.equal(t.rows.at(-1).state.transfers.length,1);
  assert.equal(saved,JSON.stringify(t.rows[0]));
  assert.equal(result.customer_revenue,'UNKNOWN');
  for(const forbidden of [t.fakeTx,t.fakePayer,writerSecret,'raw_amount','transfers','known_non_customer_raw'])
    assert.equal(JSON.stringify(result).includes(forbidden),false);
});
test('historical transfer, stale/missing floor and wrong origin fail before publication',async()=>{
  const t=setup();
  assert.equal((await t.run('remote')).ok,false);
  t.state.badHistory=true;
  assert.equal((await t.run('bootstrap')).failure_stage,'baseline_evidence');
  t.state.wrongOrigin=true;
  assert.equal((await t.run('bootstrap')).failure_stage,'activation_identity');
  assert.equal(t.rows.length,0);
});
test('rolling diagnostics are read-only and must not claim continuity',async()=>{
  const t=setup();
  const report=await t.run('window');
  assert.equal(report.ok,true);
  assert.equal(report.mode,'window'); assert.equal(report.checkpoint_after,null);
  assert.equal(t.requests.length,0);
});
test('one scheduled Pulse, one Treasury consumer and a distinct credential, isolated from commercial steps',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/discovery-pulse.yml',import.meta.url),'utf8');
  assert.equal((workflow.match(/cron: /g)||[]).length,1);
  assert.equal((workflow.match(/node scripts\/pulse-treasury-custody\.mjs/g)||[]).length,1);
  const [treasury,business]=workflow.split(/^  ping:/m);
  assert.ok(!treasury.includes('OPERATIONS_ADMIN_SECRET'));
  assert.ok(!business.includes('TREASURY_WRITER_SECRET'));
  assert.match(business,/if: github\.event_name != 'workflow_dispatch' \|\| inputs\.treasury_bootstrap != true/);
  assert.ok(!business.includes('scripts/reconcile-treasury.mjs'));
  assert.ok(!workflow.includes('/tmp/delta-treasury.json'));
  assert.ok(treasury.includes('persist-credentials: false'));
});
