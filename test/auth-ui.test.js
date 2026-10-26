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
  const auth = new AuthUi('/private/homebridge', { runtime: { ensure: async python => python, stop() {} }, spawnProcess(...args) { invocation = args; return child; } });
  return { auth, child, get input() { return input; }, get invocation() { return invocation; },
    reply(value) { child.stdout.write(JSON.stringify(value)); child.emit('close', 0); } };
}

test('UI login uses private stdin, automatic host paths, and returns no credentials', async () => {
  const ctx = setup();
  const request = ctx.auth.request('login', { email: 'driver@example.com', password: 'password-secret' });
  await settleForm();
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
  await settleForm();
  ctx.reply({ result: { connected: false } });
  await pending;
  assert.equal(ctx.auth.busy, false);
});

test('upstream errors and malformed output cannot leak raw diagnostics', async () => {
  const ctx = setup();
  const request = ctx.auth.request('check');
  await settleForm();
  ctx.child.stderr.write('password-secret token-secret account@example.com');
  ctx.reply({ error: { type: 'AuthenticationError', status: 401, message: 'token-secret' } });
  await assert.rejects(request, error => /Nissan rejected/.test(error.message) && !error.message.includes('secret'));
  const next = setup();
  const malformed = next.auth.request('status');
  await settleForm();
  next.child.stdout.write('token-secret');
  next.child.emit('close', 1);
  await assert.rejects(malformed, error => /helper could not start/.test(error.message) && !error.message.includes('secret'));
});

test('a UI timeout terminates the helper and frees the single-flight guard', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = setup();
  const pending = ctx.auth.request('check');
  const rejection = assert.rejects(pending);
  await settleForm();
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
  const streams = [];
  child.on('message', message => { if (message.action === 'stream') streams.push(message.payload.event); });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const [ready] = await once(child, 'message');
  assert.equal(ready.action, 'ready');
  const responsePromise = matchingMessage(child, m => m.action === 'response');
  child.send({ action: 'request', requestId: 'status-1', path: '/auth/status', body: {
    config: { pythonPath: path.join(__dirname, '../.venv/bin/python') },
  } });
  const response = await responsePromise;
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.data.connected, false);
  assert.equal(response.payload.data.runtimeReady, true);
  assert.ok(streams.includes('runtime-progress'));
  const errorPromise = matchingMessage(child, m => m.action === 'response');
  child.send({ action: 'request', requestId: 'login-1', path: '/auth/login', body: { email: '', password: 'password-secret' } });
  const error = await errorPromise;
  assert.equal(error.payload.success, false);
  assert.ok(!logs.includes('password-secret'));
  assert.ok(!JSON.stringify(error).includes('password-secret'));
});

function matchingMessage(child, predicate) {
  return new Promise(resolve => {
    const listener = message => {
      if (!predicate(message)) return;
      child.removeListener('message', listener);
      resolve(message);
    };
    child.on('message', listener);
  });
}

async function formHarness(requestHandler) {
  const source = await fs.readFile(path.join(__dirname, '../homebridge-ui/public/app.js'), 'utf8');
  const elements = new Map();
  for (const id of ['nissan-signin', 'nissan-email', 'nissan-password', 'nissan-password-toggle', 'nissan-connect', 'nissan-check', 'nissan-status', 'nissan-status-title', 'nissan-status-detail']) {
    elements.set(id, {
      value: '', type: 'password', maxLength: 4096, selectionStart: 0, selectionEnd: 0,
      dataset: {}, listeners: {}, attributes: {}, events: [],
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; },
      dispatchEvent(event) { this.events.push(event.type); },
    });
  }
  let blocks = [{ platform: 'NissanConnect', name: 'Existing', readOnly: false, vehicles: [{ vin: 'TESTVIN', name: 'Bluebird' }], _bridge: { username: 'AA:BB' } }];
  const requests = [];
  const ui = {
    async getPluginConfig() { return structuredClone(blocks); },
    async updatePluginConfig(next) { blocks = structuredClone(next); },
    async request(action, body) {
      requests.push(structuredClone({ action, body }));
      if (requestHandler) return requestHandler(action, body);
      return formResponse(action.endsWith('/login'));
    },
    listeners: {},
    disableSaveButton() {}, enableSaveButton() {}, showSchemaForm() {}, hideSchemaForm() {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
  const ready = vm.runInNewContext(source, { window: { homebridge: ui }, Event, document: { getElementById: id => elements.get(id) } });
  return { ui, elements, requests, ready, get blocks() { return blocks; },
    submit() { elements.get('nissan-signin').listeners.submit({ preventDefault() {} }); } };
}
function formResponse(verified = false) {
  return { connected: true, verified, settings: { pythonPath: '/python', authFile: '/auth' }, vehicles: [] };
}
const settleForm = () => new Promise(resolve => setImmediate(resolve));

test('settings form clears password, preserves configuration, and treats saved auth as unverified', async () => {
  let rejectLogin = false;
  const ctx = await formHarness(action => {
    if (action.endsWith('/login') && rejectLogin) throw new Error('Nissan rejected this sign-in.');
    return formResponse(action.endsWith('/login'));
  });
  await ctx.ready;
  const { elements, requests } = ctx;
  assert.equal(elements.get('nissan-status-title').textContent, 'Saved sign-in found');
  elements.get('nissan-email').value = 'driver@example.com';
  elements.get('nissan-password').value = 'password-secret';
  ctx.submit();
  await settleForm();
  assert.equal(elements.get('nissan-password').value, '');
  assert.equal(elements.get('nissan-status-title').textContent, 'Connected to Nissan');
  assert.equal(requests.at(-1).body.password, 'password-secret');
  assert.equal(ctx.blocks[0].vehicles[0].name, 'Bluebird');
  assert.equal(ctx.blocks[0]._bridge.username, 'AA:BB');
  assert.equal(ctx.blocks[0].readOnly, false);
  assert.ok(!JSON.stringify(ctx.blocks).includes('password-secret'));
  rejectLogin = true;
  elements.get('nissan-password').value = 'another-secret';
  ctx.submit();
  await settleForm();
  assert.equal(elements.get('nissan-password').value, '');
  assert.equal(elements.get('nissan-status-title').textContent, 'Connection needs attention');
  assert.equal(elements.get('nissan-connect').disabled, false);
});

test('password paste handles WebKit text clipboard data, replaces selection, and preserves spaces', async () => {
  const ctx = await formHarness();
  await ctx.ready;
  const input = ctx.elements.get('nissan-password');
  input.value = 'abOLDcd'; input.selectionStart = 2; input.selectionEnd = 5;
  let prevented = false; let stopped = false;
  input.listeners.paste({
    clipboardData: { getData: type => type === 'text' ? ' P@ss word! ' : '' },
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
  });
  assert.equal(input.value, 'ab P@ss word! cd');
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(input.events, ['input']);
  input.value = ''; input.selectionStart = input.selectionEnd = 0; input.maxLength = 4;
  input.listeners.paste({ clipboardData: { getData: () => '123456' }, preventDefault() {}, stopPropagation() {} });
  assert.equal(input.value, '1234');
  input.listeners.paste({ preventDefault() { assert.fail('Native paste must remain available'); } });
});

test('background status completion or failure never clears a password pasted while it runs', async () => {
  for (const fail of [false, true]) {
    let complete;
    const pending = new Promise((resolve, reject) => { complete = () => fail ? reject(new Error('Runtime not ready')) : resolve(formResponse()); });
    const ctx = await formHarness(() => pending);
    await settleForm();
    ctx.ui.listeners['runtime-progress']({ data: { message: 'Installing the Nissan connection dependencies...' } });
    assert.equal(ctx.elements.get('nissan-status-title').textContent, 'Preparing Nissan connection...');
    assert.match(ctx.elements.get('nissan-status-detail').textContent, /Installing/);
    ctx.elements.get('nissan-password').value = 'pasted-before-status-finished';
    complete();
    await ctx.ready;
    assert.equal(ctx.elements.get('nissan-password').value, 'pasted-before-status-finished');
  }
});

test('login captures password before async settings reads and conceals the revealed field', async () => {
  const ctx = await formHarness();
  await ctx.ready;
  const input = ctx.elements.get('nissan-password');
  const toggle = ctx.elements.get('nissan-password-toggle');
  input.value = 'pasted-login-password';
  toggle.listeners.click();
  assert.equal(input.type, 'text');
  assert.equal(toggle.attributes['aria-pressed'], 'true');
  const originalGetConfig = ctx.ui.getPluginConfig;
  let continueRead;
  ctx.ui.getPluginConfig = () => new Promise(resolve => { continueRead = async () => { ctx.ui.getPluginConfig = originalGetConfig; resolve(await originalGetConfig()); }; });
  ctx.submit();
  assert.equal(input.value, '');
  assert.equal(input.type, 'password');
  assert.equal(toggle.attributes['aria-pressed'], 'false');
  input.value = 'password-for-next-attempt';
  await continueRead();
  await settleForm();
  assert.equal(ctx.requests.at(-1).body.password, 'pasted-login-password');
  assert.equal(input.value, 'password-for-next-attempt');
  assert.ok(!JSON.stringify(ctx.blocks).includes('pasted-login-password'));
});
