import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createDiscoveryCache } from './discovery-cache.js';
import { createDiscoveryStore, discoveryKey } from './discovery-store.js';
import { loadEnvironment } from './config.js';
import { diagnostic } from './diagnostics.js';

/** Detect npm exec/npx using npm's execution metadata, never just an inherited PATH entry.
 * Direct node/bin and npm run launches use the installed CLI. Explicit override is available.
 * @param {NodeJS.ProcessEnv} env
 */
export function runnerMode(env = process.env) {
  const mode = env.OBS_MCP_RUNNER ?? 'auto';
  if (!['auto', 'local', 'latest'].includes(mode)) throw new Error('OBS_MCP_RUNNER must be auto, local or latest');
  if (mode !== 'auto') return mode;
  return env.npm_command === 'exec' && env.npm_lifecycle_event === 'npx' ? 'latest' : 'local';
}

/** Persistent MCP-over-stdio connection. The worker owns idle shutdown.
 * Start when disconnected; never replay failed tool calls.
 * @param {string} packageName @param {NodeJS.ProcessEnv} [env]
 */
export function createRunner(packageName, env = process.env) {
  // Resolve this once at adapter startup, not separately in child processes.
  const configured = loadEnvironment(env);
  const mode = runnerMode(configured);
  const cacheMs = z.coerce.number().int().min(0).max(86400000).parse(configured.OBS_DISCOVERY_CACHE_MS ?? 600000);
  const requestMs = z.coerce.number().int().min(20).max(86400000).parse(configured.OBS_MCP_REQUEST_TIMEOUT_MS ?? 180000);
  const command = mode === 'latest' ? 'npx' : process.execPath;
  const args = mode === 'latest' ? ['-y', '--prefer-online', `${packageName}@latest`, '--worker'] : [fileURLToPath(new URL('./cli.js', import.meta.url)), '--worker'];
  const childEnv = Object.fromEntries(Object.entries({ ...env, OBS_ENV_FILE: resolve(env.OBS_ENV_FILE ?? '.env') }).filter((entry) => entry[1] !== undefined));
  /** @type {{client: Client, transport: StdioClientTransport, ready: Promise<void>}|undefined} */
  let connection;
  let closed = false;
  async function getClient() {
    if (closed) throw new Error('MCP runner is closed');
    if (!connection) {
      const transport = new StdioClientTransport({ command, args, env: /** @type {Record<string, string>} */ (childEnv), stderr: 'inherit', maxBufferSize: 32 * 1024 * 1024 });
      const client = new Client({ name: `${packageName}-adapter`, version: '1.0.0' });
      const current = { client, transport, ready: Promise.resolve() };
      connection = current;
      client.onclose = () => {
        if (connection === current) connection = undefined;
        diagnostic({ role: 'wrapper', method: 'lifecycle', reason: 'worker-disconnected' });
      };
      client.setNotificationHandler('notifications/tools/list_changed', () => cache.invalidate());
      diagnostic({ role: 'wrapper', method: 'lifecycle', reason: 'worker-start', mode });
      current.ready = client.connect(transport, { timeout: 180000 }).catch(async error => {
        if (connection === current) connection = undefined;
        await client.close().catch(() => {});
        throw error;
      });
    }
    const current = connection;
    await current.ready;
    if (closed || connection !== current) throw new Error('Worker disconnected before the operation was sent. Retry the request.');
    const previous = cache.peek();
    if (previous && JSON.stringify(previous.serverInfo) !== JSON.stringify(current.client.getServerVersion())) await cache.invalidate();
    return current.client;
  }
  const context = () => {
    const hash = createHash('sha256');
    // File contents are hashed locally; secrets and fingerprints are never logged.
    const paths = [childEnv.OBS_ENV_FILE];
    if (mode === 'local') {
      const src = fileURLToPath(new URL('.', import.meta.url));
      paths.push(...readdirSync(src).filter(name => name.endsWith('.js')).sort().map(name => resolve(src, name)), fileURLToPath(new URL('../package.json', import.meta.url)), fileURLToPath(new URL('../data/protocol.json', import.meta.url)));
    }
    for (const path of paths) {
      hash.update(String(path));
      try { hash.update(readFileSync(path)); } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
        hash.update('missing');
      }
    }
    return hash.digest('hex');
  };
  const key = discoveryKey({ command, args, cwd: process.cwd(), env: childEnv, exclude: configured.OBS_DISCOVERY_CACHE_EXCLUDE_ENV?.split(',').map(name => name.trim()).filter(Boolean) });
  const store = createDiscoveryStore({ key, ttlMs: cacheMs, directory: configured.OBS_DISCOVERY_CACHE_DIR });
  const cache = createDiscoveryCache({ ttlMs: cacheMs, context, store, load: async () => {
    const client = await getClient();
    const result = await client.listTools({}, { timeout: requestMs });
    return { protocol: 1, serverInfo: client.getServerVersion(), tools: result.tools };
  } });
  /** @param {string[]} options @param {unknown} [input] @param {AbortSignal} [signal] */
  const run = async (options, input, signal) => {
    signal?.throwIfAborted();
    if (closed) throw new Error('MCP runner is closed');
    if (options[0] === '--tool-manifest' && options.length === 1) {
      const result = await cache.get();
      signal?.throwIfAborted();
      return result;
    }
    const client = await getClient();
    signal?.throwIfAborted();
    if (options[0] === '--execute-tool' && options.length === 2) {
      diagnostic({ role: 'wrapper', method: 'tools/call', cache: 'bypass' });
      return client.callTool({ name: options[1], arguments: /** @type {Record<string, unknown>} */ (input ?? {}) }, { signal, timeout: requestMs });
    }
    throw new Error('Unsupported CLI operation');
  };
  // Only wrapper shutdown closes this side. Request timeouts do not kill workers.
  run.close = async () => {
    closed = true;
    const current = connection;
    connection = undefined;
    if (current) {
      await current.client.close().catch(() => {});
      await current.ready.catch(() => {});
    }
  };
  run.pid = () => connection?.transport.pid ?? null;
  return run;
}
