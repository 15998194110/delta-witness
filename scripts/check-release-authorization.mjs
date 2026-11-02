#!/usr/bin/env node
// Read-only gate. Successful local tests/tags cannot authorize deployment,
// migrations, registry publication or external registration.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export function assertReleaseAuthorization(input) {
  const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && !/^0+$/.test(value);
  const artifact = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && !/^0+$/.test(value);
  if (input.event !== 'workflow_dispatch' || input.execute !== 'true' || !sha(input.source) ||
      input.source !== input.requested || input.source !== input.approved ||
      !sha(input.rollbackSource) || !artifact(input.rollbackArtifact)) throw new Error('release_not_authorized_for_exact_candidate');
  return { ok: true, source_commit: input.source, rollback_source_commit: input.rollbackSource, rollback_artifact_sha256: input.rollbackArtifact };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(assertReleaseAuthorization({ event: process.env.GITHUB_EVENT_NAME,
    execute: process.env.DELTA_EXECUTE_RELEASE, source: process.env.GITHUB_SHA,
    requested: process.env.DELTA_REQUESTED_SOURCE, approved: process.env.DELTA_APPROVED_SOURCE,
    rollbackSource: process.env.DELTA_ROLLBACK_SOURCE, rollbackArtifact: process.env.DELTA_ROLLBACK_ARTIFACT_SHA256 })));
  } catch { console.error(JSON.stringify({ ok: false, error: 'release_not_authorized_for_exact_candidate' })); process.exitCode = 1; }
}
