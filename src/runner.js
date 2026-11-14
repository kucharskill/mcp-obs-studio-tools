import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

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
  const mode = runnerMode(env);
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
      client.onclose = () => { if (connection === current) connection = undefined; };
      current.ready = client.connect(transport, { timeout: 180000 }).catch(async error => {
        if (connection === current) connection = undefined;
        await client.close().catch(() => {});
        throw error;
      });
    }
    const current = connection;
    await current.ready;
    if (closed || connection !== current) throw new Error('Worker disconnected before the operation was sent. Retry the request.');
    return current.client;
  }
  /** @param {string[]} options @param {unknown} [input] @param {AbortSignal} [signal] */
  const run = async (options, input, signal) => {
    signal?.throwIfAborted();
    const client = await getClient();
    signal?.throwIfAborted();
    if (options[0] === '--tool-manifest' && options.length === 1) {
      const result = await client.listTools({}, { signal, timeout: 180000 });
      return { protocol: 1, serverInfo: client.getServerVersion(), tools: result.tools };
    }
    if (options[0] === '--execute-tool' && options.length === 2) return client.callTool({ name: options[1], arguments: /** @type {Record<string, unknown>} */ (input ?? {}) }, { signal, timeout: 180000 });
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
