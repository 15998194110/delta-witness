import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Pure local source inventory. This does not check registries or assert deployment.
export function checkLocalRelease(root = fileURLToPath(new URL('../', import.meta.url))) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const json = path => JSON.parse(read(path));
  const expected = json('package.json').version;
  const errors = [];
  const modules = ['', 'channels/base-app/', 'channels/partner-gateway/', 'channels/apify/', 'packages/mcp-server/', 'packages/js-client/'];
  const packages = modules.map(prefix => {
    const manifest = json(`${prefix}package.json`);
    if (manifest.version !== expected) errors.push(`${prefix}package.json version differs`);
    let lock_sha256 = null;
    if (prefix !== 'packages/js-client/') {
      const lockText = read(`${prefix}package-lock.json`);
      const lock = JSON.parse(lockText);
      if (lock.version !== expected || lock.packages?.['']?.version !== expected || lock.name !== manifest.name) errors.push(`${prefix}package-lock.json root metadata differs`);
      lock_sha256 = createHash('sha256').update(lockText).digest('hex');
    }
    return { path: `${prefix}package.json`, name: manifest.name, version: manifest.version, lock_sha256 };
  });
  for (const prefix of ['', 'channels/partner-gateway/']) {
    if (json(`${prefix}wrangler.jsonc`).vars.APP_VERSION !== expected) errors.push(`${prefix}wrangler.jsonc APP_VERSION differs`);
    if (!read(`${prefix}worker-configuration.d.ts`).includes(`APP_VERSION: "${expected}";`)) errors.push(`${prefix}worker-configuration.d.ts APP_VERSION differs`);
  }
  const pythonVersion = /^version\s*=\s*"([^"]+)"/m.exec(read('packages/python-client/pyproject.toml'))?.[1];
  if (pythonVersion !== expected) errors.push('Python package version differs');
  return { ok: errors.length === 0, scope: 'local_source_only', version: expected, packages, python_version: pythonVersion, errors,
    publication_verified: false, deployment_verified: false,
    warning: 'Version labels are not unique evidence of source. Bind any future release to its commit and artifact hashes; do not overwrite an existing package version.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkLocalRelease();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
