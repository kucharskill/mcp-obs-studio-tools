import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

/** @typedef {{path: string, date: string, dateKind: string, source: string}} Recording */
/** @param {string} url @param {string|undefined} root */
function directory(url, root) { return join(root ?? join(tmpdir(), 'obs-mcp'), createHash('sha256').update(url).digest('hex').slice(0, 24)); }

/** @param {string} url @param {string|undefined} root @param {string} path */
export async function rememberRecording(url, root, path) {
  const dir = directory(url, root);
  await mkdir(dir, { recursive: true });
  const record = { path, date: new Date().toISOString(), dateKind: 'completedAt', source: 'observed-stop' };
  await writeFile(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(record), { flag: 'wx' });
  return record;
}

/** @param {string} url @param {string|undefined} root @param {string|undefined} recordDirectory */
export async function lastRecording(url, root, recordDirectory) {
  /** @type {Recording[]} */
  const records = [];
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  const dir = directory(url, root);
  const files = await readdir(dir).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const file of files.filter(name => name.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readFile(join(dir, file), 'utf8'));
      if (typeof record.path === 'string' && typeof record.date === 'string' && Date.parse(record.date) >= cutoff) records.push(record);
    } catch { /* Ignore incomplete or damaged individual history records. */ }
  }
  // Filesystem discovery is local-only and only used when OBS reports recording inactive.
  if (recordDirectory && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    const entries = await readdir(recordDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !['.mkv', '.mp4', '.mov', '.flv', '.ts', '.m4v', '.webm'].includes(extname(entry.name).toLowerCase())) continue;
      const path = join(recordDirectory, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info && info.mtimeMs >= cutoff && info.size > 0 && !records.some(record => record.path === path)) {
        records.push({ path, date: info.mtime.toISOString(), dateKind: 'modifiedAt', source: 'recording-directory' });
      }
    }
  }
  records.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return records[0] ?? null;
}
