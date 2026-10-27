'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { AuthUi } = require('../lib/auth-ui');
function setup() {
 let reply, reject, credentials;
 const pending = new Promise((yes,no)=>{reply=yes;reject=no;});
 const adapter={authenticate(email,password){credentials={email,password};return pending;},status(){return pending;},dispatch(){return pending;},close(){this.closed=true;}};
 const auth=new AuthUi('/private/homebridge',{adapterFactory:()=>adapter});
 return {auth,adapter,reply,reject,get credentials(){return credentials;}};
}
test('native UI login passes credentials directly in memory and returns only safe connection labels',async()=>{
 const c=setup();const pending=c.auth.request('login',{email:'driver@example.com',password:'password-secret'});await settleForm();assert.equal(c.credentials.password,'password-secret');c.reply({connected:true,verified:true,vehicles:[{model:'ARIYA',vinSuffix:'1234'}]});const result=await pending;assert.equal(result.settings.authFile,'/private/homebridge/nissan-connect/auth.json');assert.ok(!JSON.stringify(result).includes('password-secret'));assert.ok(!('pythonPath' in result.settings));assert.equal(c.adapter.closed,true);
});
test('UI single-flight guard and path validation run before contacting Nissan',async()=>{
 const c=setup();await assert.rejects(c.auth.request('status',{config:{authFile:'../auth'}}),/absolute/);const pending=c.auth.request('status');await assert.rejects(c.auth.request('check'),/already running/);c.reply({connected:false});await pending;assert.equal(c.auth.busy,false);
});
test('upstream UI errors cannot leak credentials, tokens, or account diagnostics',async()=>{
 const c=setup();const pending=c.auth.request('check');c.reject(Object.assign(new Error('password-secret token-secret'),{status:401}));await assert.rejects(pending,e=>/Nissan rejected/.test(e.message)&&!e.message.includes('secret'));assert.equal(c.auth.busy,false);
});
test('UI timeout closes the native session and releases its guard',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const c=setup();const pending=c.auth.request('check');const rejection=assert.rejects(pending,/timed out/);t.mock.timers.tick(90000);await rejection;assert.equal(c.adapter.closed,true);assert.equal(c.auth.busy,false);assert.equal(c.auth.adapters.size,0);
});
test('official UI server handles IPC with the packaged Node SDK and no network or Python setup',async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nissan-ui-'));
 const child=fork(path.join(__dirname,'../homebridge-ui/server.js'),[],{env:{...process.env,HOMEBRIDGE_STORAGE_PATH:temp},silent:true});
 t.after(async()=>{child.kill();await fs.rm(temp,{recursive:true,force:true});});
 let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 const [ready]=await once(child,'message');assert.equal(ready.action,'ready');
 const pending=matchingMessage(child,m=>m.action==='response');child.send({action:'request',requestId:'status',path:'/auth/status',body:{}});const result=await pending;
 assert.equal(result.payload.success,true);assert.equal(result.payload.data.connected,false);assert.equal(result.payload.data.runtimeReady,true);assert.ok(!('pythonPath' in result.payload.data.settings));
 const rejected=matchingMessage(child,m=>m.action==='response');child.send({action:'request',requestId:'invalid',path:'/auth/login',body:{email:'',password:'password-secret'}});const error=await rejected;assert.equal(error.payload.success,false);assert.ok(!logs.includes('password-secret'));assert.ok(!JSON.stringify(error).includes('password-secret'));
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

async function formHarness(requestHandler, initialBlocks) {
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
  if (initialBlocks !== undefined) blocks = structuredClone(initialBlocks);
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
  return { connected: true, verified, settings: { authFile: '/auth' }, vehicles: [] };
}
const settleForm = () => new Promise(resolve => setImmediate(resolve));

test('setup defaults vehicle controls to enabled and preserves explicit status-only choices', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(__dirname, '../config.schema.json'), 'utf8'));
  assert.equal(schema.schema.properties.readOnly.default, false);
  for (const initialBlocks of [[], [{ platform: 'NissanConnect' }], [{ readOnly: false }], [{ readOnly: true }]]) {
    const expected = initialBlocks[0]?.readOnly ?? false;
    const ctx = await formHarness(undefined, initialBlocks);
    await ctx.ready;
    assert.equal(ctx.requests[0].body.config.readOnly, expected);
    assert.equal(ctx.blocks[0].readOnly, expected);
    ctx.elements.get('nissan-email').value = 'driver@example.com';
    ctx.elements.get('nissan-password').value = 'password-secret';
    ctx.submit();
    await settleForm();
    assert.equal(ctx.requests.at(-1).body.config.readOnly, expected);
    assert.equal(ctx.blocks[0].readOnly, expected);
  }
});

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
