import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { withObs } from '../src/obs.js';
import { createIdleLifecycle } from '../src/idle.js';

test('aborted transport still holds worker activity until local application work finishes', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', socket => {
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.7.2', rpcVersion: 1 } }));
    socket.on('message', data => { if (JSON.parse(data.toString()).op === 1) socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); });
  });
  const closed = [];
  const idle = createIdleLifecycle({ discoveryMs: 100, callMs: 200, close: reason => { closed.push(reason); }, log: () => {} });
  const controller = new AbortController();
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let finish;
  const work = new Promise(resolve => { finish = resolve; });
  const operation = idle.during('tools/call', () => withObs(async () => { started(); await work; }, controller.signal, { url: `ws://127.0.0.1:${server.address().port}`, password: undefined, executable: undefined, stateDir: undefined, timeout: 3000 }));
  const rejected = assert.rejects(operation, /cancelled|timed out/);
  try {
    await began;
    controller.abort();
    await delay(250);
    assert.equal(idle.snapshot().active, 1);
    assert.deepEqual(closed, []);
    finish(); await rejected;
    assert.equal(idle.snapshot().active, 0);
    assert.ok(idle.snapshot().expiresAt >= Date.now() + 150);
  } finally {
    finish(); await rejected; idle.stop('test-complete');
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
