import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { manifest, executeTool } from './tools.js';
import { serverInfo } from './package.js';
import { workerRetention } from './config.js';
import { createIdleLifecycle } from './idle.js';

/** Self-expiring stdio server using the same application methods as the CLI. */
export function startWorker() {
  let closing = false;
  /** @type {ReturnType<typeof serveStdio>|undefined} */
  let handle;
  /** @param {string} reason */
  const close = async reason => {
    if (closing) return;
    closing = true;
    lifecycle.stop(reason);
    await handle?.close();
    process.exit(0);
  };
  const lifecycle = createIdleLifecycle({ ...workerRetention(), close });
  handle = serveStdio(() => {
    const server = new Server(serverInfo, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => lifecycle.during('tools/list', () => ({ tools: manifest().tools })));
    server.setRequestHandler('tools/call', (request, context) => lifecycle.during('tools/call', () => executeTool(request.params.name, request.params.arguments ?? {}, context.mcpReq.signal)));
    return server;
  });
  process.stdin.once('end', () => { void close('stdin-ended'); });
  process.once('SIGINT', () => { void close('SIGINT'); });
  process.once('SIGTERM', () => { void close('SIGTERM'); });
}
