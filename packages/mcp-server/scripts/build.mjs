// Local-only build: compile TypeScript, then package the exact shared SDK bytes.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const path = new URL('../dist/index.js', import.meta.url);
const source = await readFile(path, 'utf8');
const oldImport = '"../../js-client/src/index.js"';
if (source.split(oldImport).length !== 2) throw new Error('shared_sdk_import_not_unique');
await copyFile(new URL('../../js-client/src/index.js', import.meta.url), new URL('../dist/order-client.js', import.meta.url));
await writeFile(path, source.replace(oldImport, '"./order-client.js"'));
