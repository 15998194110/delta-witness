import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { pulseDeadmanDecision, startPulseDeadman, finishPulseDeadman } from '../scripts/pulse-deadman.mjs';
const now = Date.parse('2026-11-04T03:25:00.000Z');
const run = { id: '123456789', attempt: 1, source_sha: 'a'.repeat(40) };
const pingUrl = 'https://hc-ping.com/11111111-1111-4111-8111-111111111111';
const original = { schema: 'delta-pulse-deadman-start/v1', run, ping_run_id: '22222222-2222-4222-8222-222222222222', started_at: new Date(now - 60000).toISOString(), runner_started_at: new Date(now - 120000).toISOString() };
const report = { schema: 'delta-pulse-status/v1', run, critical_ok: true, completed_at: new Date(now - 1000).toISOString(),
  reporting: { phase: 'final', canonical_artifact: 'success' }, outcome: 'success' };
const outcomes = Object.fromEntries(['report_status', 'report_final', 'canonical_artifact', 'status_artifact', 'operating_publish', 'pulse_critical_gate', 'pulse_deadman_start'].map(x => [x, { outcome: 'success' }]));
const roots = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'delta-pulse-monitor-')); roots.push(path); return path; }
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep) || !path.includes('delta-pulse-monitor-')) throw Error('cleanup_outside_fixture');
    await rm(path, { recursive: true });
  }
});
it('recognizes original critical completion only, never customer income or a fresh run created_at', () => {
  expect(pulseDeadmanDecision(original, report, outcomes, run, now)).toMatchObject({ phase: 'success', customer_revenue_verified: false,
    last_verified_critical_completion_at: report.completed_at });
  for (const status of ['queued', 'in_progress', 'failed', 'unknown']) {
    expect(pulseDeadmanDecision(original, { ...report, outcome: status, created_at: new Date(now).toISOString() }, outcomes, run, now).phase).toBe('fail');
  }
  expect(pulseDeadmanDecision(original, { ...report, outcome: 'degraded' }, outcomes, run, now).reason).toBe('critical_verified_supplemental_degraded');
});
it('missing original, wrong run attempt/SHA, future report, job timeout and failure stay fail closed', () => {
  const cases = [
    [null, report, outcomes, run, now],
    [original, null, outcomes, run, now],
    [original, report, outcomes, { ...run, attempt: 2 }, now],
    [original, { ...report, run: { ...run, source_sha: 'b'.repeat(40) } }, outcomes, run, now],
    [original, { ...report, completed_at: new Date(now + 1).toISOString() }, outcomes, run, now],
    [original, report, outcomes, run, Date.parse(original.started_at) + 55 * 60000],
    [original, report, outcomes, run, Date.parse(original.runner_started_at) + 55 * 60000],
    [original, report, { ...outcomes, pulse_critical_gate: { outcome: 'failure' } }, run, now],
    [original, report, { ...outcomes, pulse_deadman_start: { outcome: 'failure' } }, run, now],
    [original, { ...report, critical_ok: false }, outcomes, run, now],
    [original, report, { ...outcomes, status_artifact: { outcome: 'failure' } }, run, now],
  ];
  for (const args of cases) expect(pulseDeadmanDecision(...args).phase).toBe('fail');
  expect(pulseDeadmanDecision(original, report, { ...outcomes, operating_publish: 'failure' }, run, now, true).phase).toBe('fail');
});
it('an unknown/failed finish cannot be replaced by a success ping for the same original run', async () => {
  const resultPath = join(await directory(), 'finish.json'), fetcher = vi.fn(async () => { throw Error('provider unavailable'); });
  const first = await finishPulseDeadman({ original, report: null, outcomes, run, resultPath, pingUrl, fetcher, now: () => now });
  expect(first.phase).toBe('fail'); expect(first.heartbeat.state).toBe('unconfirmed'); expect(fetcher).toHaveBeenCalledOnce();
  await expect(finishPulseDeadman({ original, report, outcomes, run, resultPath, pingUrl, fetcher, now: () => now })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce(); expect(JSON.parse(await readFile(resultPath, 'utf8')).phase).toBe('fail');
  expect(await readFile(resultPath, 'utf8')).not.toContain(pingUrl);
});
it('start/finish persists immutable identity and handles explicit fail without claiming delivery', async () => {
  const root = await directory(), fetcher = vi.fn(async () => new Response('OK'));
  const start = await startPulseDeadman({ path: join(root, 'start.json'), run, pingUrl, fetcher, now: () => now - 60000 });
  const finish = await finishPulseDeadman({ original: start, report, outcomes, run, resultPath: join(root, 'finish.json'), pingUrl, fetcher, now: () => now });
  expect(finish.phase).toBe('success'); expect(finish.heartbeat.state).toBe('accepted'); expect(finish.notification_delivered).toBeNull();
  expect(fetcher.mock.calls[0][0]).toContain('/start?rid='); expect(fetcher.mock.calls[1][0]).not.toContain('/fail');
  expect(fetcher.mock.calls[1][0].split('rid=')[1]).toBe(start.ping_run_id);
  await expect(startPulseDeadman({ path: join(root, 'start.json'), run, pingUrl, fetcher })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('third timer is already armed if no Runner ever starts; killed Runner cannot mask missing finish', async () => {
  const root = await directory(), requests = [], timerEvents = [];
  // Independent fixture timer starts before any producer ping. This is protocol
  // fault injection, not a claim about the unconfigured live Healthchecks account.
  let timer = setTimeout(() => timerEvents.push('never_started'), 50);
  await new Promise(resolve => setTimeout(resolve, 80)); expect(timerEvents).toEqual(['never_started']);
  const server = http.createServer((req, res) => { requests.push(req.url); res.end('OK'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const moduleUrl = new URL('../scripts/pulse-deadman.mjs', import.meta.url).href;
  const code = `import {startPulseDeadman} from ${JSON.stringify(moduleUrl)};
    const run=${JSON.stringify(run)}; await startPulseDeadman({path:process.argv[1],run,pingUrl:${JSON.stringify(pingUrl)},
      fetcher:(url,init)=>{const u=new URL(url);if(u.origin!=='https://hc-ping.com')throw Error('not_fixture');return fetch('http://127.0.0.1:'+process.argv[2]+u.pathname+u.search,init);}});
    process.send('started'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, join(root, 'child-start.json'), String(server.address().port)],
    { env: Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]])), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let exited;
  try {
    await new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(Error('child_start_timeout')), 5000);
      child.once('message', message => { clearTimeout(deadline); resolve(message); }); child.once('error', reject); });
    exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    timer = setTimeout(() => timerEvents.push('finish_missing'), 50);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(timerEvents).toEqual(['never_started', 'finish_missing']); expect(requests).toHaveLength(1); expect(requests[0]).toContain('/start?');
    expect(JSON.parse(await readFile(join(root, 'child-start.json'), 'utf8')).notification_delivered).toBeNull();
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await new Promise(resolve => server.close(resolve)); }
}, 10000);
it('candidate wiring stays gated, records outcomes after the critical gate, and does not add a business scheduler', async () => {
  const workflow = await readFile(new URL('../.github/workflows/discovery-pulse.yml', import.meta.url), 'utf8');
  expect(workflow.match(/cron:/g)).toHaveLength(2); expect(workflow).toContain('timeout-minutes: 55');
  expect(workflow).toContain("vars.DELTA_PULSE_DEADMAN_ENABLED == 'true' && vars.DELTA_APPROVED_PULSE_DEADMAN_SHA == github.sha");
  expect(workflow.indexOf('id: pulse_critical_gate')).toBeLessThan(workflow.indexOf('id: pulse_deadman_finish'));
  expect(workflow).toContain('delta-pulse-deadman-${{ github.run_id }}-${{ github.run_attempt }}');
  const observer = await readFile(new URL('../.github/workflows/operations-observer.yml', import.meta.url), 'utf8');
  expect(observer.match(/cron:/g)).toHaveLength(1);
  expect(observer).toContain("cron: '2-59/5 * * * *'");
  expect(observer).toContain("if: ${{ vars.DELTA_INDEPENDENT_MONITOR_ENABLED == 'true' && vars.DELTA_APPROVED_MONITOR_SHA == github.sha }}");
  expect(observer).toContain('permissions:\n  contents: read'.replaceAll('\n', observer.includes('\r\n') ? '\r\n' : '\n'));
  expect(observer).toContain('timeout-minutes: 3');
  expect(observer).not.toMatch(/(workflow_dispatch.*dispatches|publish-operating-pulse|reconcile-treasury|wrangler deploy)/);
});
