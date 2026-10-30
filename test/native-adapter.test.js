'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Adapter,privateWrite,privateRead,withAuthLock}=require('../lib/adapter');
const {Tokens,ServiceRequest,ServiceRequestKind,ServiceRequestResult,ServiceRequestStatus}=require('@solowalker27/nissan-connect-sdk');
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nissan-native-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'auth.json');await privateWrite(file,{tokens:{access_token:'access',refresh_token:'refresh'},device_id:'device'});return file;}
test('native adapter uses existing tokens and persists rotation without credentials',async t=>{
 const file=await setup(t);let options;
 const adapter=new Adapter(file,{clientFactory:opts=>{options=opts;return {close(){},async async_get_vehicles(){await opts.token_listener(new Tokens('rotated','new-refresh'));return [{vin:'synthetic',model:'ARIYA'}];}};}});
 const vehicles=await adapter.dispatch('vehicles');assert.equal(vehicles[0].model,'ARIYA');assert.equal(options.read_only,true);assert.equal(options.oauth_device_id,'device');assert.equal((await privateRead(file)).tokens.access_token,'rotated');assert.equal((await fs.stat(file)).mode&0o777,0o600);
});
test('snapshot reports optional failures and never silently loses the required battery status',async t=>{
 const file=await setup(t);let calls=[];
 const adapter=new Adapter(file,{clientFactory:()=>new Proxy({close(){}},{get(target,key){if(key in target)return target[key];return async(...args)=>{calls.push([key,...args]);if(key==='async_get_vehicle_status')return {battery:{level:72}};throw new Error('private upstream message');};}})});
 const result=await adapter.dispatch('snapshot',{vin:'VIN',location:false});assert.equal(result.status.battery.level,72);assert.equal(Object.keys(result.errors).length,7);assert.ok(!JSON.stringify(result).includes('private upstream'));assert.ok(!calls.some(c=>c[0]==='async_get_vehicle_location'));
});
test('start and stop charge stay distinct and accepted requests remain pending',async t=>{
 const file=await setup(t);const calls=[];
 const adapter=new Adapter(file,{clientFactory:opts=>({close(){},async async_start_charge(vin){calls.push(['start',vin,opts.read_only]);return new ServiceRequest('start-id',ServiceRequestKind.CHARGE);},async async_stop_charge(vin){calls.push(['stop',vin,opts.read_only]);return new ServiceRequest('stop-id',ServiceRequestKind.CHARGE);},async async_check_service_request(){return new ServiceRequestResult(ServiceRequestStatus.FAILED);}})});
 const start=await adapter.dispatch('command',{vin:'VIN',action:'start_charge'});const stop=await adapter.dispatch('command',{vin:'VIN',action:'stop_charge'});assert.equal(start.complete,false);assert.equal(stop.complete,false);assert.equal(stop.request.id,'stop-id');assert.deepEqual(calls,[['start','VIN',false],['stop','VIN',false]]);
});
test('invalid climate, percentage and schedule inputs fail before calling Nissan',async t=>{
 const file=await setup(t);let writes=0;const adapter=new Adapter(file,{clientFactory:()=>new Proxy({close(){}},{get(target,key){return key in target?target[key]:async()=>{writes++;};}})});
 for(const [action,params] of [['start_climate',{temperature:true}],['charge_limit',{percent:50.5}],['charge_schedule',{id:'x',enabled:'yes'}],['edit_climate_schedule',{start:'2026-10-01T12:00:00',temperature:21}]]) await assert.rejects(adapter.dispatch('command',{vin:'VIN',action,params}));assert.equal(writes,0);
});
test('token reads reject symlinks and permissive files',async t=>{
 const file=await setup(t);await fs.chmod(file,0o644);await assert.rejects(privateRead(file));await fs.chmod(file,0o600);await fs.symlink(file,file+'.link');await assert.rejects(privateRead(file+'.link'));
});
test('UI and plugin sessions serialize on the same lock',async t=>{
 const file=await setup(t);const events=[];let release;const first=withAuthLock(file,async()=>{events.push('first');await new Promise(r=>release=r);events.push('released');});while(!release)await new Promise(r=>setImmediate(r));const second=withAuthLock(file,async()=>events.push('second'));await new Promise(r=>setTimeout(r,10));assert.deepEqual(events,['first']);release();await Promise.all([first,second]);assert.deepEqual(events,['first','released','second']);
});
test('UI authentication and battery reads use the actual TypeScript SDK over the native fetch boundary',async t=>{
 const file=await setup(t);
 const {AuthUi}=require('../lib/auth-ui');
 const sdk=require('@solowalker27/nissan-connect-sdk');
 const sessions=[];const calls=[];
 const clientFactory=options=>{
  const session=new sdk.FetchSession(async(url,request)=>{
   calls.push({url:String(url),body:String(request.body)});
   const operation=String(url).endsWith('/token')?null:JSON.parse(request.body).operationName;
   const data=operation==='VehiclesStaticData'?{vehicles:[{vin:'SYNTHETICVIN123456',model:'ARIYA',year:'2023'}]}:{vehicle:{__typename:'ElectricAVK2Vehicle',batteryStatus:{level:73,isCharging:false,isPluggedIn:true}}};
   return new Response(JSON.stringify(operation?{data}:{access_token:'new-access',refresh_token:'new-refresh'}),{status:200});
  });sessions.push(session);return new sdk.NissanClient(session,options);
 };
 t.after(()=>sessions.forEach(s=>s.close()));
 const ui=new AuthUi(path.dirname(file),{adapterFactory:()=>new Adapter(file,{clientFactory})});
 const login=await ui.request('login',{email:'driver@example.test',password:'secret'});
 assert.equal(login.connected,true);assert.equal(login.vehicles[0].model,'ARIYA');
 const snapshot=await new Adapter(file,{clientFactory}).dispatch('snapshot',{vin:'SYNTHETICVIN123456'});
 assert.equal(snapshot.status.battery.level,73);assert.equal(snapshot.status.battery.is_plugged_in,true);
 assert.ok(!JSON.stringify(await privateRead(file)).includes('secret'));
 assert.ok(calls.slice(1).every(c=>!c.body.includes('secret')));
});

test('lock and unlock traverse the actual SDK, native HTTP and door completion parser', async t => {
 const file = await setup(t);
 const sdk = require('@solowalker27/nissan-connect-sdk');
 const operations = [];
 const sessions = [];
 const adapter = new Adapter(file, { clientFactory: options => {
  const session = new sdk.FetchSession(async (url, request) => {
   const body = JSON.parse(request.body); operations.push(body);
   const data = body.operationName === 'CheckDoorServiceRequest'
    ? { checkDoorServiceRequest: { status: 'SUCCESS' } }
    : { [body.operationName === 'DoorLock' ? 'doorLock' : 'doorUnlock']: { serviceRequestId: 'door-request' } };
   return new Response(JSON.stringify({ data }), { status: 200 });
  });
  sessions.push(session); return new sdk.NissanClient(session, options);
 } });
 t.after(() => { adapter.close(); sessions.forEach(session => session.close()); });
 for (const action of ['lock', 'unlock']) {
  const submitted = await adapter.dispatch('command', { vin: 'SYNTHETICVIN', action });
  assert.deepEqual(submitted, { complete: false, request: { id: 'door-request', kind: sdk.ServiceRequestKind.DOOR.value } });
  const completed = await adapter.dispatch('command_status', { vin: 'SYNTHETICVIN', request: submitted.request });
  assert.equal(completed.terminal, true); assert.equal(completed.success, true);
 }
 assert.deepEqual(operations.map(op => op.operationName), ['DoorLock', 'CheckDoorServiceRequest', 'DoorUnlock', 'CheckDoorServiceRequest']);
 assert.ok(operations.every(op => op.variables.vin === 'SYNTHETICVIN'));
 assert.equal(operations[1].variables.serviceRequestId, 'door-request');
});

test('native debug HTTP and session-renewal details never log OAuth forms, credentials or tokens', async t => {
 const file = await setup(t); const events = []; let graphqlCalls = 0;
 t.mock.method(globalThis, 'fetch', async (url, request) => {
  if (String(url).endsWith('/token')) return new Response(JSON.stringify({ access_token: 'rotated-access-secret', refresh_token: 'rotated-refresh-secret' }), { status: 200 });
  if (++graphqlCalls === 1) return new Response(JSON.stringify({ error: 'private-upstream-body' }), { status: 401 });
  return new Response(JSON.stringify({ data: { vehicles: [] } }), { status: 200 });
 });
 const adapter = new Adapter(file, { diagnostic: (event, detail) => events.push({ event, detail }) }); t.after(() => adapter.close());
 await adapter.dispatch('vehicles');
 const output = JSON.stringify(events);
 assert.ok(events.some(item => item.event === 'HTTP response headers received' && item.detail.status === 401));
 assert.ok(events.some(item => item.event === 'HTTP request started' && item.detail.operation === 'OAuth token exchange'));
 assert.ok(events.some(item => item.event === 'Renewed tokens saved'));
 assert.ok(events.some(item => item.event === 'Authentication file lock acquired'));
 for (const secret of ['rotated-access-secret', 'rotated-refresh-secret', 'private-upstream-body', 'Authorization', 'grant_type']) assert.ok(!output.includes(secret), secret);
 assert.equal((await privateRead(file)).tokens.access_token, 'rotated-access-secret');
 assert.equal(adapter.clients.size, 0);
});

test('diagnostics only use read-only history and notification queries; command checks retain reason and timestamps', async t => {
 const file = await setup(t); const calls = [];
 const adapter = new Adapter(file, { clientFactory: options => ({ close() {},
  async async_get_remote_service_history(vin, pagination) { calls.push({ name: 'history', readOnly: options.read_only, pagination }); return { history: [] }; },
  async async_get_notification_preferences() { calls.push({ name: 'notifications', readOnly: options.read_only }); return []; },
  async async_get_reminder_notifications_after_leaving_vehicle() { calls.push({ name: 'reminders', readOnly: options.read_only }); throw Object.assign(new Error('private-body'), { status: 403 }); },
  async async_check_service_request() { return { is_terminal: true, is_success: false, status: 'FAILED', status_details: 'TIMED_OUT', status_change_date_time: '2026-10-29T12:00:00Z' }; },
 }) });
 const diagnostic = await adapter.dispatch('diagnostics', { vin: 'SYNTHETICVIN' });
 assert.equal(calls.length, 3); assert.ok(calls.every(call => call.readOnly === true));
 assert.deepEqual(calls[0].pagination, { page_number: 1, items_per_page: 10 });
 assert.equal(diagnostic.errors.reminders.status, 403); assert.ok(!JSON.stringify(diagnostic).includes('private-body'));
 const checked = await adapter.dispatch('command_status', { vin: 'SYNTHETICVIN', request: { id: 'test', kind: 'door' } });
 assert.equal(checked.status_details, 'TIMED_OUT'); assert.equal(checked.status_change_date_time, '2026-10-29T12:00:00Z');
});

test('closing a debug-enabled adapter aborts its instrumented HTTP session', async t => {
 const file = await setup(t); let started = false;
 t.mock.method(globalThis, 'fetch', async (url, request) => new Promise((resolve, reject) => {
  started = true;
  request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
 }));
 const adapter = new Adapter(file, { diagnostic() {} });
 const pending = adapter.dispatch('vehicles'); const check = assert.rejects(pending);
 while (!started) await new Promise(resolve => setImmediate(resolve));
 adapter.close(); await check; assert.equal(adapter.clients.size, 0);
});
