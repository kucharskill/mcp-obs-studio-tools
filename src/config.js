import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

/** @param {NodeJS.ProcessEnv} [env] */
export function envFilePath(env = process.env) { return resolve(env.OBS_ENV_FILE ?? '.env'); }

/** Parse the environment-file option before creating the wrapper or loading configuration.
 * @param {string[]} args @param {NodeJS.ProcessEnv} [env]
 */
export function applyEnvFileOption(args, env = process.env) {
  const remaining = [];
  for (let index = 0; index < args.length; index++) {
    const match = /^(--env-file|--env_file|-env_file)(?:=(.*))?$/.exec(args[index]);
    if (!match) { remaining.push(args[index]); continue; }
    const path = match[2] ?? args[++index];
    if (!path || path.startsWith('-')) throw new Error(`${match[1]} requires a file path`);
    env.OBS_ENV_FILE = resolve(path);
  }
  return remaining;
}

/** Persist an executable discovered on this machine, preserving existing dotenv content.
 * dotenv owns parsing; writes are atomic and guarded across worker processes.
 * @param {string} executable @param {NodeJS.ProcessEnv} [env]
 */
export async function saveExecutable(executable, env = process.env) {
  return saveEnvValues({ OBS_EXECUTABLE: executable }, env);
}

/** @param {Record<string, string>} values @param {NodeJS.ProcessEnv} [env] */
export async function saveEnvValues(values, env = process.env) {
  if (Object.keys(values).some(key => !['OBS_EXECUTABLE', 'OBS_URL', 'OBS_PASSWORD'].includes(key))) throw new Error('Unsupported dotenv setting');
  const path = envFilePath(env);
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 5, minTimeout: 50, maxTimeout: 200 } });
  try {
    const current = await readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    const parsed = dotenv.parse(current);
    const changes = Object.entries(values).filter(([key, value]) => parsed[key] !== value);
    if (!changes.length) return { envFile: path, saved: false };
    const assignments = changes.map(([key, value]) => {
      const quote = ["'", '`', '"'].find(mark => !value.includes(mark) && dotenv.parse(`${key}=${mark}${value}${mark}`)[key] === value);
      if (!quote || /\r/.test(value)) throw new Error(`Setting ${key} cannot be represented safely in dotenv format`);
      return `${key}=${quote}${value}${quote}`;
    });
    const newline = current.includes('\r\n') ? '\r\n' : '\n';
    // A final assignment overrides an older value according to dotenv's parser.
    // Appending also preserves comments, unrelated keys and multiline secrets verbatim.
    const separator = current && !current.endsWith('\n') ? newline : '';
    await writeFileAtomic(path, `${current}${separator}${assignments.join(newline)}${newline}`, { mode: 0o600 });
    return { envFile: path, saved: true };
  } finally { await release(); }
}

/** Load configuration per invocation so a running adapter sees file changes. */
export function loadEnvironment() {
  const env = { ...process.env };
  const loaded = dotenv.config({ path: envFilePath(env), processEnv: env, quiet: true });
  if (loaded.error && /** @type {NodeJS.ErrnoException} */ (loaded.error).code !== 'ENOENT') throw loaded.error;
  return env;
}

export function config() {
  const env = loadEnvironment();
  const url = new URL(env.OBS_URL ?? 'ws://127.0.0.1:4455');
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('OBS_URL must be a ws:// or wss:// URL without embedded credentials.');
  const timeout = z.coerce.number().int().min(100).max(120000).parse(env.OBS_TIMEOUT_MS ?? 15000);
  return { url: url.href, password: env.OBS_PASSWORD || undefined, executable: env.OBS_EXECUTABLE, stateDir: env.OBS_STATE_DIR, timeout };
}

/** Worker-owned idle deadline, independent of operation duration. */
export function workerIdleMs() {
  return z.coerce.number().int().min(20).max(86400000).parse(loadEnvironment().OBS_WORKER_IDLE_MS ?? 1800000);
}

/** Apply and persist only supplied connection settings. Configuration merging is shared by callers.
 * @param {{address?: string, port?: number, password?: string}} [options]
 */
export async function configureConnection(options = {}) {
  const settings = config();
  const url = new URL(options.address === undefined ? settings.url : /^(ws|wss):\/\//i.test(options.address) ? options.address : `ws://${options.address}`);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Address must be a WebSocket host or URL without embedded credentials');
  if (options.address && !/^(ws|wss):\/\//i.test(options.address) && !url.port) url.port = new URL(settings.url).port;
  if (options.port !== undefined) url.port = String(options.port);
  settings.url = url.href;
  if (options.password !== undefined) settings.password = options.password || undefined;
  /** @type {Record<string, string>} */
  const values = {};
  if (options.address !== undefined || options.port !== undefined) values.OBS_URL = settings.url;
  if (options.password !== undefined) values.OBS_PASSWORD = options.password;
  if (Object.keys(values).length) await saveEnvValues(values);
  return settings;
}
