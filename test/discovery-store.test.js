import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { discoveryKey, createDiscoveryStore } from '../src/discovery-store.js';
import { createDiscoveryCache } from '../src/discovery-cache.js';
import { tempDir } from './temp.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const manifest = version => ({ protocol: 1, serverInfo: { name: 'fixture', version }, tools: [{ name: `tool_${version}`, description: 'Fixture help', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] });

test('invocation keys use full environment, canonical Windows names and explicit exclusions', () => {
  const base = { command: 'node', args: ['cli.js', '--worker'], cwd: '/one', env: { Path: 'bin', PASSWORD: 'synthetic', CODEX_TOOL_CALL_ID: 'one' }, platform: 'win32' };
  const key = discoveryKey(base);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, discoveryKey({ ...base, env: { codex_tool_call_id: 'two', password: 'synthetic', PATH: 'bin' } }));
  for (const changed of [{ command: 'npx' }, { args: ['cli.js --worker'] }, { cwd: '/two' }, { env: { ...base.env, PASSWORD: 'other' } }, { env: { ...base.env, EXTRA: 'x' } }]) assert.notEqual(key, discoveryKey({ ...base, ...changed }));
  assert.equal(discoveryKey({ ...base, exclude: ['password'] }), discoveryKey({ ...base, exclude: ['PASSWORD'], env: { ...base.env, PASSWORD: 'changed' } }));
  assert.notEqual(discoveryKey({ ...base, platform: 'linux' }), discoveryKey({ ...base, platform: 'linux', env: { PATH: 'bin', PASSWORD: 'synthetic' } }));
});

test('shared records validate format/context/TTL, remain fixed on hits, serialize writes and invalidate other caches', async () => {
  const directory = await tempDir('shared-record-');
  let now = 1000, calls = 0, context = 'revision-a';
  const key = discoveryKey({ command: 'fixture', args: [], cwd: '.', env: {} });
  const store = createDiscoveryStore({ key, directory, ttlMs: 600000, now: () => now });
  const options = { ttlMs: 600000, context: () => context, now: () => now, log: () => {}, store, load: async () => manifest(String(++calls)) };
  const first = createDiscoveryCache(options), replica = createDiscoveryCache(options);
  try {
    await first.get();
    const original = await readFile(store.path, 'utf8');
    now++;
    assert.equal((await replica.get()).serverInfo.version, '1'); assert.equal(calls, 1);
    assert.equal(await readFile(store.path, 'utf8'), original);
    assert.ok(!original.includes('PASSWORD'));
    context = 'revision-b'; await replica.get(); assert.equal(calls, 2);
    await replica.invalidate(); await first.get(); assert.equal(calls, 3);
    now += 600000; await first.get(); assert.equal(calls, 4);
    for (const invalid of ['{', JSON.stringify({ format: 0 }), JSON.stringify({ ...JSON.parse(await readFile(store.path, 'utf8')), value: { protocol: 1, serverInfo: {}, tools: [] } })]) {
      await writeFile(store.path, invalid); await first.get();
    }
    assert.equal(calls, 7);
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.write({ key: context, until: now + 600000, value: manifest(String(i)) })));
    assert.ok(await store.read(context));
    assert.deepEqual(await readdir(directory), [key + '.json']);
    const disabled = createDiscoveryStore({ key, directory, ttlMs: 0, now: () => now });
    assert.equal(await disabled.read(context), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalidation during a refresh or write cannot restore stale metadata; failed loads remain misses', async () => {
  let finishLoad, finishWrite, written, loads = 0;
  const store = { read: async () => written, remove: async () => { written = undefined; }, write: async entry => {
    await new Promise(resolve => { finishWrite = resolve; });
    written = { value: entry.value, until: entry.until };
  } };
  const cache = createDiscoveryCache({ context: () => 'fixture', ttlMs: 1000, store, log: () => {}, load: async () => {
    loads++;
    return new Promise(resolve => { finishLoad = resolve; });
  } });
  const waiting = cache.get();
  while (!finishLoad) await delay(1);
  await cache.invalidate(); finishLoad(manifest('1')); await waiting;
  assert.equal(written, undefined);
  finishLoad = undefined;
  const writing = cache.get();
  while (!finishLoad) await delay(1);
  finishLoad(manifest('2'));
  while (!finishWrite) await delay(1);
  const invalidated = cache.invalidate();
  finishWrite(); await Promise.all([writing, invalidated]);
  assert.equal(written, undefined); assert.equal(loads, 2);
  const failed = createDiscoveryCache({ context: () => 'fixture', ttlMs: 1000, store, log: () => {}, load: async () => { throw new Error('fixture load failed'); } });
  await assert.rejects(failed.get()); await assert.rejects(failed.get()); assert.equal(written, undefined);
});

/** Raw legacy client keeps ping testing independent of SDK client era selection. */
function legacy(env) {
  const child = spawn(process.execPath, [resolve('src/cli.js'), 'mcp'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data', bytes => { stderr += bytes; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(message.error) : waiter.resolve(message.result); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`Timed out: ${method}`)); }, 15000);
    pending.set(callId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method, ...(params ? { params } : {}) }) + '\n');
  });
  return { request, logs: () => stderr, async initialize() {
    const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return result;
  }, async close() { const exited = once(child, 'exit'); child.stdin.end(); await exited; lines.close(); } };
}

test('two wrapper processes share discovery; legacy ping and warm init/list never start or retain a worker', async () => {
  const directory = await tempDir('replica-cache-');
  const env = { ...process.env, OBS_DISCOVERY_CACHE_DIR: directory, OBS_ENV_FILE: join(directory, 'absent.env'), OBS_MCP_RUNNER: 'local', OBS_MCP_DIAGNOSTICS: '1', OBS_WORKER_DISCOVERY_IDLE_MS: '150', OBS_WORKER_IDLE_MS: '600', CODEX_TOOL_CALL_ID: 'first' };
  const first = legacy(env);
  try {
    const init = await first.initialize();
    assert.equal(init.protocolVersion, '2025-11-25');
    assert.deepEqual(init.capabilities, { tools: { listChanged: true } });
    assert.equal((await first.request('tools/list')).tools.length, 11);
    assert.match(first.logs(), /worker-start/);
    for (let i = 0; i < 8; i++) { assert.deepEqual(await first.request('ping'), {}); await first.request('tools/list'); await delay(80); }
    assert.match(first.logs(), /idle-expired/);
    assert.equal((first.logs().match(/worker-start/g) ?? []).length, 1);
  } finally { await first.close(); }
  const second = legacy({ ...env, CODEX_TOOL_CALL_ID: 'second' });
  try {
    await second.initialize();
    assert.equal((await second.request('tools/list')).tools.length, 11);
    assert.deepEqual(await second.request('ping'), {});
    assert.doesNotMatch(second.logs(), /worker-start/);
    const cacheFile = join(directory, (await readdir(directory)).find(name => name.endsWith('.json')));
    const outdated = JSON.parse(await readFile(cacheFile, 'utf8'));
    outdated.value.serverInfo.version = 'stale-backend';
    await writeFile(cacheFile, JSON.stringify(outdated));
    await second.request('tools/list');
    const result = await second.request('tools/call', { name: 'obs_commands', arguments: { name: 'GetVersion' } });
    assert.ok(!result.isError); assert.match(second.logs(), /worker-start/);
    assert.equal(JSON.parse(result.content[0].text).command.requestType, 'GetVersion');
    assert.ok(!(await readdir(directory)).some(name => name.endsWith('.json')), 'Detected identity changes invalidate the shared record');
    await second.request('tools/list');
    // Expiry never removes the shared discovery file.
    assert.ok((await readdir(directory)).some(name => name.endsWith('.json')));
  } finally { await second.close(); }
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'mcp'], env, stderr: 'pipe' });
  let modernLogs = '';
  transport.stderr.on('data', bytes => { modernLogs += bytes; });
  const modern = new Client({ name: 'modern-fixture', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await modern.connect(transport);
    assert.equal((await modern.listTools()).tools.length, 11);
    await assert.rejects(modern.ping(), /ping|legacy|removed|supported/i);
    assert.doesNotMatch(modernLogs, /worker-start/);
  } finally { await modern.close(); await rm(directory, { recursive: true, force: true }); }
});
