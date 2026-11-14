import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createRunner } from '../src/runner.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** @param {() => boolean} predicate */
async function eventually(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Lifecycle condition did not complete');
    await delay(20);
  }
}

test('worker self-expiry also ends its npx launcher without killing the parent', async () => {
  const transport = new StdioClientTransport({ command: 'npx', args: ['--offline', '-c', 'node src/cli.js --worker'], env: { ...process.env, OBS_WORKER_IDLE_MS: '750' }, stderr: 'pipe' });
  const client = new Client({ name: 'npx-lifecycle-test', version: '1' });
  let disconnected = false;
  client.onclose = () => { disconnected = true; };
  try {
    await client.connect(transport);
    await client.listTools();
    const pid = transport.pid;
    assert.ok(pid);
    await eventually(() => disconnected);
    assert.throws(() => process.kill(pid, 0));
  } finally { await client.close(); }
});

test('worker reuses one stdio process, expires itself and restarts lazily without closing the runner', async () => {
  const run = createRunner('local-worker-test', { ...process.env, OBS_MCP_RUNNER: 'local', OBS_WORKER_IDLE_MS: '250' });
  try {
    assert.equal(run.pid(), null);
    await run(['--tool-manifest']);
    const firstPid = run.pid();
    assert.ok(firstPid);
    const results = await Promise.all([
      run(['--execute-tool', 'obs_commands'], { name: 'StartRecord' }),
      run(['--execute-tool', 'obs_commands'], { name: 'StopRecord' }),
    ]);
    assert.ok(results.every(result => !result.isError));
    assert.equal(run.pid(), firstPid);
    await eventually(() => run.pid() === null);
    assert.throws(() => process.kill(firstPid, 0));
    const next = await run(['--tool-manifest']);
    assert.equal(next.tools.length, 11);
    assert.ok(run.pid());
    assert.notEqual(run.pid(), firstPid);
  } finally { await run.close(); }
});

test('long active work and overlapping requests prevent idle shutdown; cancellation does not kill the worker', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  let getVersionRequests = 0;
  server.on('connection', socket => {
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.7.2', rpcVersion: 1 } }));
    socket.on('message', async bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.op === 1) { socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); return; }
      if (message.op !== 6) return;
      getVersionRequests++;
      await delay(450);
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify({ op: 7, d: { requestType: message.d.requestType, requestId: message.d.requestId, requestStatus: { result: true, code: 100 }, responseData: { availableRequests: ['GetVersion'], obsVersion: 'fixture' } } }));
    });
  });
  const run = createRunner('local-worker-test', { ...process.env, OBS_MCP_RUNNER: 'local', OBS_WORKER_IDLE_MS: '250', OBS_URL: `ws://127.0.0.1:${server.address().port}`, OBS_PASSWORD: '', OBS_TIMEOUT_MS: '5000' });
  try {
    const operation = run(['--execute-tool', 'obs_execute'], { requests: [{ requestType: 'GetVersion' }] });
    await eventually(() => getVersionRequests > 0);
    const pid = run.pid();
    await delay(350);
    await run(['--tool-manifest']);
    assert.equal(run.pid(), pid);
    const result = await operation;
    assert.ok(!result.isError);
    assert.equal(run.pid(), pid);
    assert.equal(getVersionRequests, 2);
    const controller = new AbortController();
    const requestsBeforeCancel = getVersionRequests;
    const cancelled = run(['--execute-tool', 'obs_execute'], { requests: [{ requestType: 'GetVersion' }] }, controller.signal);
    // Attach the rejection handler before aborting.
    const rejected = assert.rejects(cancelled);
    await eventually(() => getVersionRequests > requestsBeforeCancel);
    controller.abort();
    await rejected;
    const healthy = await run(['--execute-tool', 'obs_commands'], { name: 'GetVersion' });
    assert.ok(!healthy.isError);
    assert.equal(run.pid(), pid);
    await eventually(() => run.pid() === null);
    assert.throws(() => process.kill(pid, 0));
    // One cancelled read was sent, with no replay by the wrapper.
    assert.equal(getVersionRequests, requestsBeforeCancel + 1);
  } finally {
    await run.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
