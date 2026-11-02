import { mkdir, lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_REVISIONS = 4096;

/** Private local filesystem store. Each revision is create-only: partial writes
 * remain evidence and block further signing. Never remove a revision to recover. */
export class FileOrderStore {
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error('order_store_absolute_directory_required');
  }
  private async folder(id: string) {
    if (!ID.test(id)) throw new Error('invalid_order_id');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error('invalid_order_store');
    const folder = join(this.directory, id);
    await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(folder)).isDirectory()) throw new Error('invalid_order_store');
    return folder;
  }
  async load(id: string): Promise<any | null> {
    const folder = await this.folder(id);
    const names = await readdir(folder);
    if (!names.length) return null;
    if (names.length > MAX_REVISIONS || names.some(name => !/^\d{6}\.json$/.test(name))) throw new Error('order_store_invalid');
    names.sort();
    if (names.some((name, i) => name !== `${String(i).padStart(6, '0')}.json`)) throw new Error('order_store_invalid');
    const path = join(folder, names.at(-1)!);
    if (!(await lstat(path)).isFile()) throw new Error('order_store_invalid');
    const file = await open(path, 'r');
    try {
      const bytes = Buffer.alloc(32_769);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 32_768) throw new Error('order_store_invalid');
      const record = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (record.order_id !== id || record.revision !== names.length - 1) throw new Error('order_store_invalid');
      return record;
    } finally { await file.close(); }
  }
  async compareAndSet(id: string, revision: number | null, record: any): Promise<boolean> {
    if (record.order_id !== id || record.revision !== (revision === null ? 0 : revision + 1) ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 || record.revision >= MAX_REVISIONS) throw new Error('order_store_invalid');
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > 32_768) throw new Error('order_store_invalid');
    const current = await this.load(id);
    if ((current?.revision ?? null) !== revision) return false;
    const folder = await this.folder(id);
    let file;
    try { file = await open(join(folder, `${String(record.revision).padStart(6, '0')}.json`), 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    // Sync directory entries where the host supports it. Windows requires the
    // owner's private ACL; mode bits alone cannot establish that ACL.
    if (process.platform !== 'win32') {
      const directory = await open(folder, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return true;
  }
}

/** Save downloaded bytes as data, never execute/render them. No overwrite. */
export async function saveOrderExport(directory: string, id: string, filename: string, bytes: Uint8Array) {
  if (!isAbsolute(directory) || !ID.test(id) || !/^delta-[0-9a-f-]{36}-(page\.html|page\.md|screenshot\.png|manifest\.json)$/.test(filename) || bytes.length > 9_000_000) throw new Error('invalid_export');
  const folder = join(directory, 'exports');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (!(await lstat(folder)).isDirectory()) throw new Error('invalid_export');
  const path = join(folder, `${id}-${filename}`);
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lstat(path)).isFile()) throw error;
    const previous = await open(path, 'r');
    try {
      if ((await previous.stat()).size !== bytes.length) throw new Error('export_conflict');
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65_536);
      let position = 0;
      while (position < bytes.length) {
        const { bytesRead } = await previous.read(buffer, 0, Math.min(buffer.length, bytes.length - position), position);
        if (!bytesRead) throw new Error('export_conflict');
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if ((await previous.stat()).size !== bytes.length) throw new Error('export_conflict');
      if (hash.digest('hex') !== createHash('sha256').update(bytes).digest('hex')) throw new Error('export_conflict');
    } finally { await previous.close(); }
    return path;
  }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return path;
}
