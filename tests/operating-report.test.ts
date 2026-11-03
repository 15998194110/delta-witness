import { describe, expect, it, vi } from 'vitest';
import { projectOperatingReport, DEFAULT_ALERT_POLICY, type Evidence, type OperatingReportInput } from '../src/operating-report';

const now=Date.parse('2026-11-03T04:00:00.000Z');
const iso=(seconds=0)=>new Date(now-seconds*1000).toISOString();
const fact=<T>(value:T, evidence_id='fixture-evidence', age=0):Evidence<T>=>({value,evidence_id,observed_at:iso(age)});
const covered=(value:number, status:'complete'|'partial'='complete')=>({...fact(value),coverage:{status,from:iso(3600),through:iso()}});
const notification={permission:fact('available' as const,'notifier-scope')};
const unpaid=():OperatingReportInput=>({notification,business:{paid_undelivered:[{id:'order-1',confirmed:fact(true,'payment-episode-1'),since:iso(600)}]}});
const key='delta:paid_undelivered:order-1:payment-episode-1';
const report=(input:OperatingReportInput={})=>projectOperatingReport(input,now);
const emitted=(stage:'initial'|'escalated'='initial',status:'queued'|'provider_accepted'|'delivered'|'failed'|'unconfirmed'='delivered')=>
  fact({severity:'SEV1' as const,stage,status},'notification-operation-1');

describe('pure unified operating projection',()=>{
  it('missing data stays unknown separately for every financial stage and operating layer',()=>{
    const output=report();
    expect(output.schedulers).toEqual([]);expect(output.persistence.state).toBe('unknown');expect(output.notification.state).toBe('unknown');
    expect(output.rpc_coverage.state).toBe('unknown');expect(output.alerts).toEqual([]);
    expect(Object.keys(output.business.metrics)).toHaveLength(9);
    for(const stage of Object.values(output.business.metrics))expect(stage).toMatchObject({state:'unknown',value:null,all_time:false});
  });
  it('provider enabled, successful run, financial state, persistence and delivery are independent',()=>{
    const output=report({schedulers:[{id:'pulse',provider_config:fact('enabled'),run:fact({id:'run-1',outcome:'success',started_at:iso(60),completed_at:iso(),duration_ms:60000})}],
      persistence:fact('failed'),notification:{status:fact('provider_accepted'),receipt_id:'receipt-1'}});
    expect(output.schedulers[0].run.value?.outcome).toBe('success');expect(output.persistence.value).toBe('failed');
    expect(output.notification.value).toBe('provider_accepted');expect(output.business.metrics.customer_revenue_usdc.value).toBeNull();
    expect(output.schedulers[0].last_success.state).toBe('unknown');expect(output.schedulers[0].next_run.state).toBe('unknown');
  });
  it('a count of settled requests cannot manufacture receipt, delivery, revenue or cost',()=>{
    const output=report({business:{metrics:{settlement_confirmed_count:covered(4)}}});
    expect(output.business.metrics.settlement_confirmed_count.value).toBe(4);
    for(const name of ['treasury_received_usdc','fulfillment_completed_count','customer_revenue_usdc','variable_cost_usdc','contribution_margin_usdc'])
      expect(output.business.metrics[name].value).toBeNull();
  });
  it('zero is known only for its explicit completely covered interval, never all-time',()=>{
    const output=report({business:{metrics:{treasury_received_usdc:covered(0)}}});
    expect(output.business.metrics.treasury_received_usdc).toMatchObject({state:'known',value:0,coverage:{status:'complete'},all_time:false});
    expect(output.business.all_time_verified).toBe(false);
  });
  it('a partial signed margin is a partial observation, not a lower bound or total',()=>{
    const output=report({business:{metrics:{contribution_margin_usdc:covered(-2,'partial')}}});
    expect(output.business.metrics.contribution_margin_usdc).toMatchObject({state:'partial',value:-2,unit:'USDC',all_time:false});
    expect(output.alerts).toEqual([]);
  });
  it.each(['missing','reversed','future','after_observation'])('rejects %s coverage rather than claiming a zero total',kind=>{
    const metric:any=covered(0);
    if(kind==='missing')delete metric.coverage;
    if(kind==='reversed')metric.coverage.from=iso(-60);
    if(kind==='future')metric.coverage.through=iso(-60);
    if(kind==='after_observation')metric.observed_at=iso(60);
    expect(report({business:{metrics:{customer_revenue_usdc:metric}}}).business.metrics.customer_revenue_usdc).toMatchObject({state:'unknown',value:null});
  });
  it.each([NaN,Infinity,-1,1.5])('invalid count %s is unknown, not rounded or clamped',value=>{
    expect(report({business:{metrics:{payment_intent_count:covered(value)}}}).business.metrics.payment_intent_count.value).toBeNull();
  });
  it('future and invalid fact times are rejected; old valid intervals remain explicitly stale',()=>{
    const old={...covered(0),observed_at:iso(7200),coverage:{status:'complete' as const,from:iso(8000),through:iso(7300)}};
    const output=report({persistence:{...fact('stored'),observed_at:iso(-1)},business:{metrics:{customer_revenue_usdc:old}}});
    expect(output.persistence.state).toBe('unknown');expect(output.business.metrics.customer_revenue_usdc).toMatchObject({state:'stale',freshness:'stale',value:0});
    expect(report({persistence:{...fact('stored'),observed_at:'2026-02-31T04:00:00.000Z'}}).persistence.state).toBe('unknown');
  });
  it('an observation cannot know about a run completion or last success that happens after it',()=>{
    const output=report({schedulers:[{id:'pulse',last_success:fact(iso(),'success-reader',60),
      run:fact({id:'run-1',outcome:'success',started_at:iso(120),completed_at:iso(),duration_ms:120000},'run-reader',60)}]});
    expect(output.schedulers[0].run.state).toBe('unknown');expect(output.schedulers[0].last_success.state).toBe('unknown');
  });
  it('strips nested secrets, raw messages and arbitrary provider fields from every projection',()=>{
    const input:any={secret:'do-not-copy',notification:{status:fact('delivered'),receipt_id:'receipt-1',secret:'do-not-copy'},
      schedulers:[{id:'pulse',secret:'do-not-copy',run:fact({id:'run-1',outcome:'success',started_at:iso(5),completed_at:iso(),duration_ms:null,secret:'do-not-copy'})}],
      rpc_coverage:fact({status:'complete',from_block:10,through_block:20,secret:'do-not-copy'}),
      business:{metrics:{customer_revenue_usdc:{...covered(1),secret:'do-not-copy'}}}};
    expect(JSON.stringify(report(input))).not.toContain('do-not-copy');
  });
  it('does not accept URLs or email addresses as evidence or subject IDs',()=>{
    expect(report({persistence:fact('stored','https://private.test/token')}).persistence.state).toBe('unknown');
    expect(report({schedulers:[{id:'owner@example.test'}]}).schedulers).toEqual([]);
  });
  it('duplicate row identities are not silently merged and no input is mutated or I/O attempted',()=>{
    const input:OperatingReportInput={schedulers:[{id:'same',provider_config:fact('enabled')},{id:'same',provider_config:fact('disabled')}]};
    const before=JSON.stringify(input),network=vi.fn();vi.stubGlobal('fetch',network);
    try{expect(report(input).schedulers).toEqual([]);expect(JSON.stringify(input)).toBe(before);expect(network).not.toHaveBeenCalled();}
    finally{vi.unstubAllGlobals();}
  });
});

describe('candidate alert decisions without sending or changing authority',()=>{
  it('detects stale enabled scheduler and consecutive failures without marking scheduler disabled',()=>{
    const output=report({notification,schedulers:[{id:'watch',provider_config:fact('enabled'),expected_interval_seconds:fact(180),
      run:fact({id:'old-run',outcome:'failed',started_at:iso(1000),completed_at:iso(990),duration_ms:10000}),consecutive_failures:fact(3)}]});
    expect(output.alerts.map(a=>a.code)).toEqual(['scheduler_stale','scheduler_consecutive_failures']);
    expect(output.schedulers[0].provider_config.value).toBe('enabled');expect(output.alerts.every(a=>a.notification_decision.enqueued===false)).toBe(true);
  });
  it('unknown provider or stale provider evidence cannot assert enabled; future run metadata is unknown',()=>{
    const base={id:'watch',expected_interval_seconds:fact(180),run:fact({id:'old',outcome:'failed' as const,started_at:iso(1000),completed_at:iso(990),duration_ms:10000})};
    expect(report({schedulers:[base]}).alerts).toEqual([]);
    expect(report({schedulers:[{...base,provider_config:fact('enabled','provider',7200)}]}).alerts).toEqual([]);
    expect(report({schedulers:[{...base,run:fact({...base.run.value,started_at:iso(-1)})}]}).schedulers[0].run.state).toBe('unknown');
  });
  it('paid but undelivered alert requires explicit verified condition and original age, not a fresh snapshot age',()=>{
    const output=report(unpaid());expect(output.alerts[0]).toMatchObject({code:'paid_undelivered',severity:'SEV1',first_seen_at:iso(600),
      acknowledgment:{state:'unknown'},notification:{state:'unknown'},notification_decision:{action:'queue_candidate',enqueued:false}});
    const input=unpaid();input.business!.paid_undelivered![0].since=iso(60);expect(report(input).alerts).toEqual([]);
  });
  it('stale or false incident evidence cannot assert a current paid-undelivered condition',()=>{
    const input=unpaid();input.business!.paid_undelivered![0].confirmed=fact(true,'old-condition',7200);expect(report(input).alerts).toEqual([]);
    input.business!.paid_undelivered![0].confirmed=fact(false);expect(report(input).alerts).toEqual([]);
  });
  it('receipt mismatch, valid RPC gap, expired permission and negative cost basis remain separate alerts',()=>{
    const output=report({notification,business:{receipt_unmatched:[{id:'receipt-1',confirmed:fact(true),since:iso(1)}],
      negative_margin:[{id:'route-1',margin_usdc:fact(-1),cost_basis:'modeled'},{id:'order-2',margin_usdc:fact(-2),cost_basis:'actual'}]},
      rpc_coverage:fact({status:'gap',from_block:10,through_block:20,gap_from_block:15,gap_through_block:20}),permissions:[{id:'cloudflare',status:fact('expired')}]});
    expect(output.alerts.map(a=>a.code)).toEqual(['receipt_unmatched','negative_margin','negative_margin','rpc_coverage_gap','permission_expired']);
    expect(output.alerts.filter(a=>a.code==='negative_margin').map(a=>[a.severity,a.cost_basis])).toEqual([['SEV3','modeled'],['SEV2','actual']]);
    expect(output.business.metrics.customer_revenue_usdc.value).toBeNull();
  });
  it('invalid RPC range is unknown rather than gap or complete',()=>{
    const output=report({rpc_coverage:fact({status:'gap',from_block:10,through_block:20,gap_from_block:9,gap_through_block:20})});
    expect(output.rpc_coverage.state).toBe('unknown');expect(output.alerts).toEqual([]);
  });
  it('same evidence episode has stable dedupe; new evidence episode cannot inherit an old acknowledgment',()=>{
    const input=unpaid();input.alert_history=[{dedupe_key:key,first_seen_at:iso(600),acknowledgment:fact({severity:'SEV1'})}];
    const first=report(input).alerts[0];expect(first.dedupe_key).toBe(key);expect(first.notification_decision.action).toBe('suppress');
    input.business!.paid_undelivered![0].confirmed=fact(true,'payment-episode-2');
    expect(report(input).alerts[0].notification_decision.action).toBe('queue_candidate');
  });
  it('time passing escalates an unacknowledged incident but never acknowledges or dispatches it',()=>{
    const input=unpaid();input.business!.paid_undelivered![0].since=iso(4000);
    const alert=report(input).alerts[0];expect(alert.escalation).toMatchObject({state:'due',dispatched:false});expect(alert.acknowledgment.state).toBe('unknown');
  });
  it('unchanged delivered alert is suppressed; escalation can create one new queue candidate',()=>{
    const input=unpaid();input.alert_history=[{dedupe_key:key,first_seen_at:iso(600),last_emission:emitted()}];
    expect(report(input).alerts[0].notification_decision).toMatchObject({action:'suppress',reason:'unchanged_condition'});
    input.alert_history[0].first_seen_at=iso(4000);
    expect(report(input).alerts[0].notification_decision).toMatchObject({action:'queue_candidate',reason:'worsened_or_escalated'});
    input.alert_history[0].last_emission=emitted('escalated');expect(report(input).alerts[0].notification_decision.action).toBe('suppress');
  });
  it.each(['queued','provider_accepted','unconfirmed'] as const)('%s delivery remains a reconciliation task even when escalation is due',status=>{
    const input=unpaid();input.alert_history=[{dedupe_key:key,first_seen_at:iso(4000),last_emission:emitted('initial',status)}];
    expect(report(input).alerts[0].notification_decision).toMatchObject({action:'reconcile',reason:'original_delivery_unconfirmed'});
  });
  it('duplicate or incomplete prior history never authorizes repeat delivery',()=>{
    const input=unpaid();input.alert_history=[{dedupe_key:key,first_seen_at:iso(600)}];expect(report(input).alerts[0].notification_decision.action).toBe('reconcile');
    input.alert_history.push({...input.alert_history[0],last_emission:emitted()});expect(report(input).alerts[0].notification_decision.action).toBe('reconcile');
  });
  it('pre-episode emission and delivery evidence cannot suppress or mark a current episode delivered',()=>{
    const input=unpaid();input.alert_history=[{dedupe_key:key,first_seen_at:iso(600),
      last_emission:fact({severity:'SEV1',stage:'initial',status:'delivered'},'older-operation',1200),
      notification:{status:fact('delivered','older-ack',1200),receipt_id:'older-receipt'}}];
    const alert=report(input).alerts[0];expect(alert.notification_decision).toMatchObject({action:'reconcile',reason:'previous_emission_unknown'});
    expect(alert.notification).toMatchObject({state:'unknown',value:null,receipt_id:null});
  });
  it('worsened severity is not suppressed by a lower severity acknowledgment',()=>{
    const input:OperatingReportInput={notification,business:{negative_margin:[{id:'route-1',margin_usdc:fact(-3,'margin-episode'),cost_basis:'actual'}]},
      alert_history:[{dedupe_key:'delta:negative_margin:route-1:margin-episode',first_seen_at:iso(60),acknowledgment:fact({severity:'SEV3'}),
        last_emission:fact({severity:'SEV3',stage:'initial',status:'delivered'})}]};
    expect(report(input).alerts[0].notification_decision).toMatchObject({action:'queue_candidate',reason:'worsened_or_escalated'});
  });
  it('notification missing permission and unconfirmed delivery alerts are local only, never recursive notifications',()=>{
    const input=unpaid();input.notification={permission:fact('missing'),status:fact('unconfirmed')};
    const output=report(input);expect(output.alerts[0].notification_decision.action).toBe('blocked');
    expect(output.alerts.filter(a=>a.subject==='reporter').map(a=>a.notification_decision.action)).toEqual(['local_only','local_only']);
  });
  it('delivery needs an independent receipt; an accepted request is never delivery',()=>{
    expect(report({notification:{status:fact('delivered')}}).notification.state).toBe('unknown');
    expect(report({notification:{status:fact('provider_accepted'),receipt_id:'provider-1'}}).notification.value).toBe('provider_accepted');
    expect(report({notification:{status:fact('delivered'),receipt_id:'provider-1'}}).notification.value).toBe('delivered');
  });
  it('candidate thresholds are explicit and malformed overrides do not disable guardrails',()=>{
    const output=projectOperatingReport({},now,{consecutive_failure_threshold:0,escalate_after_seconds:NaN});
    expect(output.policy.consecutive_failure_threshold).toBe(DEFAULT_ALERT_POLICY.consecutive_failure_threshold);
    expect(output.policy.source).toBe('local_candidate_thresholds_not_recovered_attachment_text');
    expect(()=>projectOperatingReport({},NaN)).toThrow('invalid_report_time');
  });
});

describe('lead qualification follows evidence without creating budget or permission',()=>{
  it('a browsed lead is unqualified until relevant evidence exists; unknown budget is null',()=>{
    const lead=report({leads:[{id:'lead-1',need:fact(true)}]}).leads[0];
    expect(lead.qualification).toBe('unknown');expect(lead.budget_usdc.value).toBeNull();expect(lead.purchase_authorized.value).toBeNull();
    expect(lead.evidence_score).toMatchObject({supported_points:20,assessed_points:20,maximum:100});
  });
  it('explicit budget, payment ability and fit support review only; none grants purchase or outreach authority',()=>{
    const lead=report({leads:[{id:'lead-1',independent:fact(true),need:fact(true),product_fit:fact(true),payment_capability:fact(true),budget_usdc:fact(10)}]}).leads[0];
    expect(lead.qualification).toBe('evidence_supported_for_review');expect(lead.budget_usdc.value).toBe(10);
    expect(lead.purchase_authorized.state).toBe('unknown');expect(lead.purchasing_authority_granted).toBe(false);
    expect(lead.outreach_performed).toBe(false);expect(lead.expected_roi).toBeNull();
  });
  it('zero budget is explicit disqualification, stale budget unknown, purchase authorization independent',()=>{
    const input:OperatingReportInput={leads:[{id:'lead-1',budget_usdc:fact(0),purchase_authorized:fact(true)}]};
    expect(report(input).leads[0].qualification).toBe('not_qualified');expect(report(input).leads[0].purchase_authorized.value).toBe(true);
    input.leads![0].budget_usdc=fact(10,'old-budget',7200);expect(report(input).leads[0].budget_usdc.value).toBeNull();
  });
});
