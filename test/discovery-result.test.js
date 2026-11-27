import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server } from '@modelcontextprotocol/server';
import { createAdapter } from '../src/adapter.js';
import { createDiscoveryCache, reusableDiscovery } from '../src/discovery-cache.js';
import { createDiscoveryStore, discoveryKey } from '../src/discovery-store.js';
import { tempDir } from './temp.js';
import { result as modernResult } from './fixtures/discovery-result.mjs';

// A linked JSON transport keeps these tests on the real SDK request/response path.
async function connect(server) {
  const replies = [];
  const left = { async start() {}, async close() {}, async send(message) { right.onmessage?.(structuredClone(message)); } };
  const right = { async start() {}, async close() {}, async send(message) { replies.push(structuredClone(message)); left.onmessage?.(structuredClone(message)); } };
  const client = new Client({ name: 'discovery-result-fixture', version: '1' });
  await server.connect(right); await client.connect(left);
  return { client, replies, async close() { await client.close(); await server.close(); } };
}

test('real SDK preserves complete final discovery results cold/warm despite ttlMs zero for ten minutes', async () => {
  const directory = await tempDir('complete-discovery-');
  let now = 1000, backendLists = 0, toolCalls = 0;
  const tool = name => ({ name, description: `Full help for ${name}`, inputSchema: { type: 'object', properties: { task: { type: 'string' } } }, annotations: { readOnlyHint: true } });
  const response = { tools: [tool('backend_tool')], ttlMs: 0, cacheScope: 'private', resultType: 'complete', _meta: { fixture: { retained: true } }, extraResultField: { retained: true } };
  const backend = new Server({ name: 'fixture-backend', version: '1' }, { capabilities: { tools: {} } });
  backend.setRequestHandler('tools/list', () => { backendLists++; return response; });
  const upstream = await connect(backend);
  const store = createDiscoveryStore({ key: discoveryKey({ command: 'fixture', args: [], cwd: '.', env: {} }), directory, ttlMs: 600000, now: () => now });
  const load = async () => {
    const result = await upstream.client.listTools();
    const final = { ...result, resultType: 'complete', tools: [...result.tools, tool('adapter_extension')] };
    return { protocol: 1, serverInfo: { name: 'fixture-adapter', version: '1' }, tools: final.tools, result: final, unknownManifestField: 'retained' };
  };
  const options = { store, ttlMs: 600000, now: () => now, context: () => 'fixture', load, reusable: value => reusableDiscovery(value.result), log: () => {} };
  const cache = createDiscoveryCache(options);
  const run = async args => args[0] === '--tool-manifest' ? cache.get() : (toolCalls++, { content: [{ type: 'text', text: 'fixture operation' }] });
  const cold = await connect(await createAdapter(run));
  let warm;
  try {
    const first = await cold.client.listTools();
    const { resultType: _modernOnly, ...legacyResponse } = response;
    assert.deepEqual(first, { ...legacyResponse, tools: [...response.tools, tool('adapter_extension')] });
    assert.deepEqual(await cold.client.listTools(), first);
    await cold.client.ping(); assert.equal(backendLists, 1);
    assert.deepEqual(cold.replies.filter(reply => reply.result?.tools).map(reply => reply.id), [1, 2]);
    assert.deepEqual(cold.client.getServerCapabilities(), { tools: { listChanged: true } });
    for (const [method, field] of [['listPrompts', 'prompts'], ['listResources', 'resources'], ['listResourceTemplates', 'resourceTemplates']]) assert.deepEqual(await cold.client[method](), { [field]: [] });
    assert.equal(backendLists, 1);
    now += 599999;
    const replica = createDiscoveryCache({ ...options, load: async () => { throw new Error('Warm discovery must not start a backend'); } });
    warm = await connect(await createAdapter(async () => replica.get()));
    assert.deepEqual(await warm.client.listTools(), first);
    assert.equal((await store.read('fixture')).expiresAt, 601000);
    assert.equal((await store.read('fixture')).value.unknownManifestField, 'retained');
    assert.equal((await store.read('fixture')).value.result.resultType, 'complete');
    now++;
    assert.equal(await store.read('fixture'), undefined);
    await cache.get(); assert.equal(backendLists, 2);
    await cold.client.callTool({ name: 'backend_tool', arguments: {} });
    await cold.client.callTool({ name: 'backend_tool', arguments: {} });
    assert.equal(toolCalls, 2);
  } finally { await warm?.close(); await cold.close(); await upstream.close(); await rm(directory, { recursive: true, force: true }); }
});

test('modern SDK clients receive deep-equal full public results across stdio replicas', async () => {
  const directory = await tempDir('modern-complete-result-');
  const open = async () => {
    const client = new Client({ name: 'complete-modern-client', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('test/fixtures/discovery-result.mjs'), 'serve', directory], stderr: 'pipe' });
    try {
      await client.connect(transport);
      const frames = [], receive = transport.onmessage;
      transport.onmessage = (message, extra) => { if (message.result?.tools) frames.push(structuredClone(message.result)); receive?.(message, extra); };
      return { client, frames, close: () => client.close() };
    } catch (error) { await client.close(); throw error; }
  };
  let first, second;
  try {
    first = await open();
    const cold = await first.client.listTools();
    const wire = first.frames.at(-1);
    for (const field of Object.keys(modernResult).filter(field => field !== '_meta')) assert.deepEqual(wire[field], modernResult[field]);
    assert.equal(wire._meta.fixture, modernResult._meta.fixture);
    await first.close(); first = undefined;
    second = await open();
    assert.deepEqual(await second.client.listTools(), cold);
    assert.deepEqual(second.frames.at(-1), wire);
    assert.equal(await readFile(join(directory, 'backend-starts'), 'utf8'), 'start\n');
    await second.client.callTool({ name: 'base', arguments: {} });
    await second.client.callTool({ name: 'base', arguments: {} });
    assert.equal(await readFile(join(directory, 'operations'), 'utf8'), 'call\ncall\n');
  } finally { await first?.close(); await second?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('session/progress/interactive discovery is bypassed intact rather than stripped', async () => {
  for (const special of [{ _meta: { progressToken: 'fixture-progress' } }, { sessionId: 'fixture-session' }, { task: { taskId: 'fixture-task' } }, { resultType: 'input_required' }]) {
    const result = { tools: [], ttlMs: 0, ...special };
    let calls = 0;
    const cache = createDiscoveryCache({ context: () => 'fixture', ttlMs: 600000, reusable: reusableDiscovery, log: () => {}, load: async () => { calls++; return result; } });
    assert.deepEqual(await cache.get(), result); assert.deepEqual(await cache.get(), result);
    assert.equal(calls, 2);
  }
});
