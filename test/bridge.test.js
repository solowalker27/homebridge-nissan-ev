'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { PythonBridge } = require('../lib/bridge');

function setup() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const requests = [];
  child.stdin.on('data', chunk => requests.push(JSON.parse(chunk.toString())));
  child.kill = () => child.emit('exit', 1);
  const bridge = new PythonBridge({ authFile: '/private/auth.json' }, {}, () => child);
  const reply = (id, result) => child.stdout.write(JSON.stringify({ id, result }) + '\n');
  return { child, bridge, requests, reply };
}

test('RPC sends one request at a time, keeping credentials out of arguments', async () => {
  const ctx = setup();
  const first = ctx.bridge.request('snapshot', { vin: 'test' });
  const second = ctx.bridge.request('command', { vin: 'test', action: 'lock' });
  assert.equal(ctx.requests.length, 1);
  ctx.reply(ctx.requests[0].id, { ok: true });
  await first;
  assert.equal(ctx.requests.length, 2);
  ctx.reply(ctx.requests[1].id, { complete: true });
  assert.deepEqual(await second, { complete: true });
  ctx.bridge.stop();
});

test('worker crash rejects pending and queued requests without executing queued writes', async () => {
  const ctx = setup();
  const first = ctx.bridge.request('snapshot');
  const second = ctx.bridge.request('command', { action: 'unlock' });
  const expected = [assert.rejects(first), assert.rejects(second)];
  ctx.child.emit('exit', 1);
  await Promise.all(expected);
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.bridge.queue.length, 0);
  ctx.bridge.stop();
});

test('timeout kills worker and cancels queued writes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = setup();
  const first = ctx.bridge.request('vehicles');
  const second = ctx.bridge.request('command', { action: 'unlock' });
  const expected = [assert.rejects(first), assert.rejects(second)];
  t.mock.timers.tick(45000);
  await Promise.all(expected);
  assert.equal(ctx.requests.length, 1);
  ctx.bridge.stop();
});
