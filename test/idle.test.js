import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdleLifecycle } from '../src/idle.js';
import { createDiscoveryCache } from '../src/discovery-cache.js';

test('one deadline uses max retention and remains suspended until every operation settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const events = [], closed = [];
  const idle = createIdleLifecycle({ discoveryMs: 60, callMs: 1800, close: reason => { closed.push(reason); }, log: event => events.push(event) });
  await idle.during('tools/call', () => 'ok');
  assert.equal(idle.snapshot().expiresAt, 2800);
  t.mock.timers.tick(100);
  await idle.during('tools/list', () => 'metadata');
  assert.equal(idle.snapshot().expiresAt, 2800);
  let finishFirst, finishSecond;
  const first = idle.during('tools/call', () => new Promise(resolve => { finishFirst = resolve; }));
  const second = idle.during('tools/list', () => new Promise(resolve => { finishSecond = resolve; }));
  t.mock.timers.tick(10000);
  assert.equal(idle.snapshot().active, 2);
  assert.deepEqual(closed, []);
  finishFirst(); await first;
  assert.equal(idle.snapshot().expiresAt, 12900);
  assert.equal(idle.snapshot().active, 1);
  t.mock.timers.tick(100);
  finishSecond(); await second;
  assert.equal(idle.snapshot().expiresAt, 12900);
  t.mock.timers.tick(1699);
  assert.deepEqual(closed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(closed, ['idle-expired']);
  assert.ok(events.some(event => event.active === 2));
  idle.stop('test-complete');
});

test('errors settle activity; client timeout alone does not settle an executing action', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const closed = [];
  const idle = createIdleLifecycle({ discoveryMs: 60, callMs: 300, close: reason => { closed.push(reason); }, log: () => {} });
  await assert.rejects(idle.during('tools/call', () => { throw new Error('fixture'); }));
  assert.equal(idle.snapshot().active, 0);
  let finish;
  const operation = idle.during('tools/call', () => new Promise(resolve => { finish = resolve; }));
  t.mock.timers.tick(5000);
  assert.equal(idle.snapshot().active, 1);
  assert.deepEqual(closed, []);
  finish(); await operation;
  assert.equal(idle.snapshot().expiresAt, 6300);
  t.mock.timers.tick(299); assert.deepEqual(closed, []);
  t.mock.timers.tick(1); assert.deepEqual(closed, ['idle-expired']);
  idle.stop('test-complete');
});

test('discovery cache coalesces misses, expires by age/context and never caches failures', async () => {
  let now = 0, context = 'a', calls = 0, version = '1';
  const events = [];
  const cache = createDiscoveryCache({ ttlMs: 100, now: () => now, context: () => context, log: event => events.push(event), load: async () => { calls++; return { version, tools: ['tool'] }; } });
  const initial = await Promise.all([cache.get(), cache.get()]);
  assert.equal(calls, 1);
  initial[0].tools.push('poison');
  assert.deepEqual((await cache.get()).tools, ['tool']);
  now = 99; await cache.get(); assert.equal(calls, 1);
  now = 100; version = '2'; assert.equal((await cache.get()).version, '2');
  context = 'b'; await cache.get(); assert.equal(calls, 3);
  cache.invalidate(); await cache.get(); assert.equal(calls, 4);
  assert.ok(events.some(event => event.cache === 'hit'));
  let attempts = 0;
  const failed = createDiscoveryCache({ ttlMs: 100, context: () => 'one', log: () => {}, load: async () => { attempts++; throw new Error('failure'); } });
  await assert.rejects(failed.get()); await assert.rejects(failed.get()); assert.equal(attempts, 2);
});
