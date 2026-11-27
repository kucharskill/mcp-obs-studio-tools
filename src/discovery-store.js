import { createHash } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

const defaultDirectory = join(tmpdir(), 'obs-mcp', 'discovery');

/** Best-effort startup record of the original wrapper environment, kept local only.
 * @param {string|undefined} directory @param {NodeJS.ProcessEnv} env @param {string} startedAt
 */
export function writeEnvironmentSnapshot(directory, env, startedAt) {
  try {
    const target = directory ?? defaultDirectory;
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const path = join(target, 'env-startup.jsonl');
    appendFileSync(path, JSON.stringify({ pid: process.pid, startedAt, env }) + '\n', { mode: 0o600 });
    return path;
  } catch { return undefined; }
}

const toolsSchema = z.array(z.object({ name: z.string(), inputSchema: z.object({ type: z.literal('object') }).passthrough() }).passthrough());
const manifestSchema = z.object({
  protocol: z.literal(1),
  serverInfo: z.object({ name: z.string(), version: z.string() }).passthrough(),
  tools: toolsSchema,
  result: z.object({ tools: toolsSchema }).passthrough().optional(),
}).passthrough();
const recordSchema = z.object({
  format: z.literal(2), key: z.string(), context: z.string(),
  createdAt: z.number().finite(), expiresAt: z.number().finite(), value: manifestSchema,
});

/** Hash only the target invocation. Exclusions never change the environment sent to it.
 * @param {{command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, exclude?: string[], platform?: string}} invocation
 */
export function discoveryKey({ command, args, cwd, env, exclude = [], platform = process.platform }) {
  const normalize = (/** @type {string} */ name) => platform === 'win32' ? name.toUpperCase() : name;
  const excluded = new Set(['CODEX_TOOL_CALL_ID', 'PATH', ...exclude].map(name => name.toUpperCase()));
  const canonical = new Map();
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (value !== undefined && !excluded.has(upper) && !upper.startsWith('INIT_') && !upper.startsWith('NPM_')) canonical.set(normalize(name), value);
  }
  const entries = [...canonical.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash('sha256').update(JSON.stringify([command, args, cwd, entries])).digest('hex');
}

/** Shared metadata only; keys and freshness fingerprints contain no readable environment.
 * Atomic replacement plus a per-key write lock protects concurrent writers/removers.
 * @param {{key: string, directory?: string, ttlMs: number, now?: () => number}} options
 */
export function createDiscoveryStore({ key, directory = defaultDirectory, ttlMs, now = Date.now }) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid discovery cache key');
  const path = join(directory, `${key}.json`);
  /** @param {() => Promise<void>} action */
  async function mutate(action) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
    try { await action(); } finally { await release(); }
  }
  return {
    path,
    /** @param {string} context */
    async read(context) {
      try {
        const bytes = await readFile(path, 'utf8');
        if (bytes.length > 8 * 1024 * 1024) return undefined;
        const record = JSON.parse(bytes);
        const parsed = recordSchema.safeParse(record);
        if (!parsed.success) return undefined;
        if (record.key !== key || record.context !== context || record.createdAt > now() || record.expiresAt <= now() || record.expiresAt > record.createdAt + ttlMs) return undefined;
        return { ...record, until: record.expiresAt };
      } catch { return undefined; }
    },
    /** @param {{key: string, until: number, value: any}} entry */
    async write(entry) {
      manifestSchema.parse(entry.value);
      await mutate(() => {
        const createdAt = now();
        return writeFileAtomic(path, JSON.stringify({ format: 2, key, context: entry.key, createdAt, expiresAt: createdAt + ttlMs, value: entry.value }), { mode: 0o600 });
      });
    },
    async remove() { await mutate(() => rm(path, { force: true })); },
  };
}
