import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createAdapter } from '../../src/adapter.js';
import { createDiscoveryCache, reusableDiscovery } from '../../src/discovery-cache.js';
import { createDiscoveryStore, discoveryKey } from '../../src/discovery-store.js';

export const result = {
  tools: ['base', 'extension'].map(name => ({ name, description: `Complete ${name} help`, inputSchema: { type: 'object', properties: { value: { type: 'string', description: 'Argument help' } } }, annotations: { readOnlyHint: true } })),
  ttlMs: 0, cacheScope: 'private', resultType: 'complete', _meta: { fixture: 'retained' }, unknownField: { retained: ['all', 'fields'] },
};

if (process.argv[2] === 'serve') {
  const directory = process.argv[3];
  const store = createDiscoveryStore({ key: discoveryKey({ command: 'fixture', args: [], cwd: '.', env: {} }), directory, ttlMs: 600000 });
  const cache = createDiscoveryCache({ store, ttlMs: 600000, context: () => 'fixture', log: () => {}, reusable: value => reusableDiscovery(value.result), load: async () => {
    await appendFile(join(directory, 'backend-starts'), 'start\n');
    return { protocol: 1, serverInfo: { name: 'complete-fixture', version: '1' }, tools: result.tools, result };
  } });
  const handle = serveStdio(() => createAdapter(async args => {
    if (args[0] === '--tool-manifest') return cache.get();
    await appendFile(join(directory, 'operations'), 'call\n');
    return { content: [{ type: 'text', text: 'fixture operation' }] };
  }));
  process.stdin.once('end', () => { void handle.close(); });
}
