import { appendFileSync, readFileSync } from 'node:fs';
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const report = (value) => { console.log(JSON.stringify(value)); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, JSON.stringify(value) + '\n\n'); };
const sha = process.env.GITHUB_SHA;
if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Exact source commit required');
if (process.argv[2] === 'core') {
  const deployment = read('/tmp/delta-core-after.json');
  const active = deployment.versions;
  if (active?.length !== 1 || active[0].percentage !== 100) throw new Error('Expected one 100% production core version');
  const version = read('/tmp/delta-core-versions.json').find((v) => v.id === active[0].version_id);
  if (version?.annotations?.['workers/tag'] !== `conversion-${sha.slice(0, 12)}` || version?.annotations?.['workers/message'] !== `DELTA reviewed conversion release ${sha}`) throw new Error('Deployed core commit identity mismatch');
  report({ core_version: version.id, commit: sha, previous_deployment: read('/tmp/delta-core-before.json').id });
} else if (process.argv[2] === 'pages') {
  const deployed = read('/tmp/delta-pages-after.json')[0];
  if (deployed?.Environment !== 'Production' || deployed.Branch !== 'master' || deployed.Source !== sha.slice(0, 7)) throw new Error('Pages production identity mismatch');
  const expected = readFileSync('channels/base-app/dist/index.html', 'utf8');
  for (const origin of [deployed.Deployment, 'https://delta-witness-app.pages.dev']) {
    const response = await fetch(origin);
    if (!response.ok || await response.text() !== expected) throw new Error(`Deployed buyer page does not match built commit at ${origin}`);
  }
  report({ pages_deployment: deployed.Id, url: deployed.Deployment, commit: sha, previous_deployment: read('/tmp/delta-pages-before.json')[0]?.Id });
} else if (process.argv[2] === 'public') {
  const origin = 'https://delta-witness-api.ruphussten.workers.dev';
  const pages = [['/', ['FICTIONAL SCENARIO', '1 USDC', '5 USDC', '10 USDC', 'original text and screenshots are private']], ['/docs', ['Start with one public page.', '202 / processing', 'no buyer download']]];
  for (const [path, markers] of pages) {
    const response = await fetch(origin + path); const html = await response.text();
    if (!response.ok || markers.some((marker) => !html.includes(marker))) throw new Error(`Live content mismatch at ${path}`);
  }
  const response = await fetch(origin + '/v1/capture', { method: 'POST', headers: { origin: 'https://delta-witness-app.pages.dev', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/' }) });
  const exposed = response.headers.get('access-control-expose-headers')?.toLowerCase().split(/,\s*/);
  if (response.status !== 402 || response.headers.get('access-control-allow-origin') !== '*' || exposed?.join(',') !== 'payment-required,payment-response,x-payment-response' || !response.headers.get('payment-required')) throw new Error('Live unsigned x402 response or CORS exposure mismatch');
  const options = await fetch(origin + '/v1/capture', { method: 'OPTIONS', headers: { origin: 'https://delta-witness-app.pages.dev', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,payment-signature,x-delta-channel' } });
  const allowed = options.headers.get('access-control-allow-headers')?.toLowerCase() || '';
  if (options.status !== 204 || options.headers.get('access-control-allow-origin') !== '*' || !options.headers.get('access-control-allow-methods')?.split(/,\s*/).includes('POST') || !['content-type', 'payment-signature', 'x-delta-channel'].every((h) => allowed.includes(h)) || allowed.includes('x-delta-partner-user') || allowed.includes('access-control-expose-headers')) throw new Error('Live request CORS allowlist changed');
  report({ public_routes: ['/', '/docs', '/v1/capture'], unsigned_status: response.status, exposed_headers: exposed, preflight_status: options.status, paid_requests: 0 });
} else throw new Error('Expected core, pages or public');
