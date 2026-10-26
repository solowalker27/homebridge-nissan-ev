'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { AuthUi } = require('../lib/auth-ui');

function setup() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let input = '';
  child.stdin.on('data', chunk => { input += chunk; });
  child.kill = () => { child.emit('close', 1); };
  let invocation;
  const auth = new AuthUi('/private/homebridge', { exists: () => true, spawnProcess(...args) { invocation = args; return child; } });
  return { auth, child, get input() { return input; }, get invocation() { return invocation; },
    reply(value) { child.stdout.write(JSON.stringify(value)); child.emit('close', 0); } };
}

test('UI login uses private stdin, automatic host paths, and returns no credentials', async () => {
  const ctx = setup();
  const request = ctx.auth.request('login', { email: 'driver@example.com', password: 'password-secret' });
  assert.equal(ctx.invocation[0], '/private/homebridge/nissan-connect/venv/bin/python');
  assert.equal(ctx.invocation[2].shell, false);
  assert.ok(!JSON.stringify(ctx.invocation).includes('password-secret'));
  assert.equal(JSON.parse(ctx.input).password, 'password-secret');
  ctx.reply({ result: { connected: true, verified: true, vehicles: [{ model: 'ARIYA', vinSuffix: '1234' }] } });
  const result = await request;
  assert.equal(result.settings.authFile, '/private/homebridge/nissan-connect/auth.json');
  assert.equal(result.verified, true);
  assert.ok(!JSON.stringify(result).includes('password-secret'));
});

test('UI blocks concurrent requests and rejects unsafe paths before starting a helper', async () => {
  const ctx = setup();
  await assert.rejects(ctx.auth.request('status', { config: { authFile: '../auth.json' } }), /absolute/);
  assert.equal(ctx.invocation, undefined);
  const pending = ctx.auth.request('status');
  await assert.rejects(ctx.auth.request('check'), /already running/);
  ctx.reply({ result: { connected: false } });
  await pending;
  assert.equal(ctx.auth.busy, false);
});

test('upstream errors and malformed output cannot leak raw diagnostics', async () => {
  const ctx = setup();
  const request = ctx.auth.request('check');
  ctx.child.stderr.write('password-secret token-secret account@example.com');
  ctx.reply({ error: { type: 'AuthenticationError', status: 401, message: 'token-secret' } });
  await assert.rejects(request, error => /Nissan rejected/.test(error.message) && !error.message.includes('secret'));
  const next = setup();
  const malformed = next.auth.request('status');
  next.child.stdout.write('token-secret');
  next.child.emit('close', 1);
  await assert.rejects(malformed, error => /Python is not ready/.test(error.message) && !error.message.includes('secret'));
});

test('a UI timeout terminates the helper and frees the single-flight guard', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = setup();
  const pending = ctx.auth.request('check');
  const rejection = assert.rejects(pending);
  t.mock.timers.tick(90000);
  await rejection;
  assert.equal(ctx.auth.busy, false);
  assert.equal(ctx.auth.children.size, 0);
});

test('official UI server handles real IPC and the installed Python helper without networking', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nissan-ui-'));
  const child = fork(path.join(__dirname, '../homebridge-ui/server.js'), [], {
    env: { ...process.env, HOMEBRIDGE_STORAGE_PATH: temp }, silent: true,
  });
  t.after(async () => { child.kill(); await fs.rm(temp, { recursive: true, force: true }); });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const [ready] = await once(child, 'message');
  assert.equal(ready.action, 'ready');
  const responsePromise = once(child, 'message');
  child.send({ action: 'request', requestId: 'status-1', path: '/auth/status', body: {
    config: { pythonPath: path.join(__dirname, '../.venv/bin/python') },
  } });
  const [response] = await responsePromise;
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.data.connected, false);
  assert.equal(response.payload.data.runtimeReady, true);
  const errorPromise = once(child, 'message');
  child.send({ action: 'request', requestId: 'login-1', path: '/auth/login', body: { email: '', password: 'password-secret' } });
  const [error] = await errorPromise;
  assert.equal(error.payload.success, false);
  assert.ok(!logs.includes('password-secret'));
  assert.ok(!JSON.stringify(error).includes('password-secret'));
});

test('settings form clears password, preserves configuration, and treats saved auth as unverified', async () => {
  const source = await fs.readFile(path.join(__dirname, '../homebridge-ui/public/app.js'), 'utf8');
  const elements = new Map();
  for (const id of ['nissan-signin', 'nissan-email', 'nissan-password', 'nissan-connect', 'nissan-check', 'nissan-status', 'nissan-status-title', 'nissan-status-detail']) {
    elements.set(id, { value: '', dataset: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  }
  let blocks = [{ platform: 'NissanConnect', name: 'Existing', readOnly: false, vehicles: [{ vin: 'TESTVIN', name: 'Bluebird' }], _bridge: { username: 'AA:BB' } }];
  const requests = [];
  let rejectLogin = false;
  const ui = {
    async getPluginConfig() { return structuredClone(blocks); },
    async updatePluginConfig(next) { blocks = structuredClone(next); },
    async request(action, body) {
      requests.push(structuredClone({ action, body }));
      if (action.endsWith('/login') && rejectLogin) throw new Error('Nissan rejected this sign-in.');
      return { connected: true, verified: action.endsWith('/login'), settings: { pythonPath: '/python', authFile: '/auth' }, vehicles: [] };
    },
    disableSaveButton() {}, enableSaveButton() {}, showSchemaForm() {}, hideSchemaForm() {},
  };
  await vm.runInNewContext(source, { window: { homebridge: ui }, document: { getElementById: id => elements.get(id) } });
  assert.equal(elements.get('nissan-status-title').textContent, 'Saved sign-in found');
  elements.get('nissan-email').value = 'driver@example.com';
  elements.get('nissan-password').value = 'password-secret';
  elements.get('nissan-signin').listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('nissan-password').value, '');
  assert.equal(elements.get('nissan-status-title').textContent, 'Connected to Nissan');
  assert.equal(requests.at(-1).body.password, 'password-secret');
  assert.equal(blocks[0].vehicles[0].name, 'Bluebird');
  assert.equal(blocks[0]._bridge.username, 'AA:BB');
  assert.equal(blocks[0].readOnly, false);
  assert.ok(!JSON.stringify(blocks).includes('password-secret'));
  rejectLogin = true;
  elements.get('nissan-password').value = 'another-secret';
  elements.get('nissan-signin').listeners.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('nissan-password').value, '');
  assert.equal(elements.get('nissan-status-title').textContent, 'Connection needs attention');
  assert.equal(elements.get('nissan-connect').disabled, false);
});
