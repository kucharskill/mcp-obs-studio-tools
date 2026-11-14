import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { manifest, executeTool } from './tools.js';
import { serverInfo } from './package.js';
import { workerIdleMs } from './config.js';

/** Self-expiring stdio server using the same application methods as the CLI. */
export function startWorker() {
  const idleMs = workerIdleMs();
  let active = 0;
  let closing = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @type {ReturnType<typeof serveStdio>|undefined} */
  let handle;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    await handle?.close();
    process.exit(0);
  };
  const arm = () => {
    clearTimeout(timer);
    if (!closing && active === 0) timer = setTimeout(() => { void close(); }, idleMs);
  };
  /** @template T @param {() => Promise<T>|T} action */
  const during = async action => {
    if (closing) throw new Error('Worker is shutting down');
    active++;
    clearTimeout(timer);
    try { return await action(); }
    finally { active--; arm(); }
  };
  handle = serveStdio(() => {
    const server = new Server(serverInfo, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => during(() => ({ tools: manifest().tools })));
    server.setRequestHandler('tools/call', (request, context) => during(() => executeTool(request.params.name, request.params.arguments ?? {}, context.mcpReq.signal)));
    return server;
  });
  process.stdin.once('end', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  arm();
}
