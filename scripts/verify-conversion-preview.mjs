import { appendFileSync, readFileSync } from 'node:fs';
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const before = read('/tmp/delta-production-before.json');
const baseline = before[0];
if (!baseline || baseline.Environment !== 'Production' || baseline.Branch !== 'master') {
  throw new Error('Cannot verify the existing master production deployment; stopping before preview publish');
}
if (process.argv[2] === 'before') {
  console.log(JSON.stringify({ production_id: baseline.Id, branch: baseline.Branch, source: baseline.Source }));
} else if (process.argv[2] === 'after') {
  const after = read('/tmp/delta-production-after.json');
  if (after[0]?.Id !== baseline.Id) throw new Error('Production deployment changed during preview; stop and investigate');
  const preview = read('/tmp/delta-previews.json').find((d) => d.Environment === 'Preview' && d.Branch === 'dot/delta-conversion-20261001' && d.Source === process.env.GITHUB_SHA.slice(0, 7));
  if (!preview || !/^https:\/\/[a-z0-9]+\.delta-witness-app\.pages\.dev$/.test(preview.Deployment)) throw new Error('No matching preview deployment returned by Cloudflare');
  const response = await fetch(`${preview.Deployment}/_release.json`);
  if (!response.ok) throw new Error(`Preview release readback HTTP ${response.status}`);
  const release = await response.json();
  if (release.commit !== process.env.GITHUB_SHA || release.core_deployed !== false) throw new Error('Preview exact-commit readback mismatch');
  const summary = { preview_url: preview.Deployment, environment: preview.Environment, branch: preview.Branch, commit: release.commit, production_unchanged: baseline.Id };
  console.log(JSON.stringify(summary));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Preview: ${preview.Deployment}\n\nCommit: ${release.commit}\n\nProduction unchanged: ${baseline.Id}\n`);
} else throw new Error('Expected before or after');
