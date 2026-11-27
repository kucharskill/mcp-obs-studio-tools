import { Server } from '@modelcontextprotocol/server';

/** @typedef {{protocol: number, serverInfo: {name: string, version: string}, tools: import('@modelcontextprotocol/server').Tool[], result?: any}} Manifest */
/** @param {(args: string[], input?: unknown, signal?: AbortSignal) => Promise<any>} run */
export async function createAdapter(run) {
  /** @type {Manifest} */
  const initial = await run(['--tool-manifest']);
  if (initial.protocol !== 1 || !Array.isArray(initial.tools)) throw new Error('Unsupported CLI manifest');
  let previous = JSON.stringify(initial.tools);
  const server = new Server(initial.serverInfo, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler('tools/list', async (_request, context) => {
    /** @type {Manifest} */
    const current = await run(['--tool-manifest'], undefined, context.mcpReq.signal);
    if (current.protocol !== 1 || !Array.isArray(current.tools)) throw new Error('Unsupported CLI manifest');
    const serialized = JSON.stringify(current.tools);
    if (serialized !== previous) await server.sendToolListChanged();
    previous = serialized;
    return current.result ?? { tools: current.tools };
  });
  server.setRequestHandler('tools/call', async (request, context) => {
    try {
      const result = await run(['--execute-tool', request.params.name], request.params.arguments ?? {}, context.mcpReq.signal);
      if (!Array.isArray(result?.content)) throw new Error('Invalid CLI tool result');
      return result;
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}
