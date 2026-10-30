'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VehicleLog, debug, errorDetails } = require('../lib/logging');
function setup(config = {}) {
  const info = []; const warn = [];
  const log = { info: line => info.push(line), warn: line => warn.push(line), debug() { throw new Error('Global debug flag must not be required'); } };
  const journal = new VehicleLog(config, log, () => 'Ariya');
  return { info, warn, log, journal, changes: () => info.filter(line => line.includes('State change')) };
}
const state = () => ({ status: { vin: 'SENSITIVEVIN123456', battery: { level: 80, is_charging: false, last_updated_at: '2026-10-29T12:00:00Z' }, doors: { overall_lock: 'UNLOCKED' } }, fetched_at: '2026-10-29T12:01:00Z' });

test('default logs establish a baseline, ignore observation clocks and emit every actual reported change once', () => {
  const ctx = setup(); const data = state();
  ctx.journal.snapshot(data);
  assert.equal(ctx.changes().length, 0);
  assert.match(ctx.info[0], /baseline established.*80%/);
  data.status.battery.last_updated_at = '2026-10-29T12:02:00Z'; data.fetched_at = '2026-10-29T12:03:00Z';
  ctx.journal.snapshot(data); assert.equal(ctx.changes().length, 0);
  data.status.battery.level = 81; data.status.doors.overall_lock = 'LOCKED'; data.status.battery.is_charging = true;
  ctx.journal.snapshot(data);
  assert.equal(ctx.changes().length, 3);
  assert.ok(ctx.changes().every(line => line.includes('poll detected; cause unknown')));
  assert.match(ctx.changes().join('\n'), /level: 80 -> 81/);
  ctx.journal.snapshot(data); assert.equal(ctx.changes().length, 3);
  data.status.battery.level = null; ctx.journal.snapshot(data);
  assert.match(ctx.changes().at(-1), /81 -> unavailable/);
  delete data.status.battery.level; ctx.journal.snapshot(data);
  assert.match(ctx.changes().at(-1), /unavailable -> not reported/);
  assert.ok(!ctx.info.some(line => line.includes('[Debug]')));
});

test('only matching changes in a successful plugin follow-up are attributed as correlated plugin actions', () => {
  const ctx = setup(); const data = state(); ctx.journal.snapshot(data);
  data.status.doors.overall_lock = 'LOCKED'; data.status.battery.level = 81;
  ctx.journal.snapshot(data, { command: { label: 'C1', action: 'lock', status: 'succeeded' } });
  const changes = ctx.changes();
  assert.match(changes.find(line => line.includes('overall_lock')), /plugin action C1 lock follow-up.*causality not guaranteed/);
  assert.match(changes.find(line => line.includes('battery.level')), /poll detected; cause unknown.*C1 lock/);
  data.status.doors.overall_lock = 'UNLOCKED'; ctx.journal.snapshot(data);
  assert.match(ctx.changes().at(-1), /poll detected; cause unknown/);
  data.status.doors.overall_lock = 'LOCKED';
  ctx.journal.snapshot(data, { command: { label: 'C2', action: 'lock', status: 'failed or unconfirmed' } });
  assert.ok(!ctx.changes().at(-1).includes('plugin action'));
});

test('schedule correlation excludes concurrent changes to a different schedule', () => {
  const ctx = setup(); const data = state();
  data.charge_schedules = [{ id: 'ours', state: 'ENABLED' }, { id: 'other', state: 'ENABLED' }];
  ctx.journal.snapshot(data);
  data.charge_schedules.forEach(schedule => { schedule.state = 'DISABLED'; });
  ctx.journal.snapshot(data, { command: { label: 'C1', action: 'charge_schedule', params: { id: 'ours', enabled: false }, status: 'succeeded' } });
  assert.match(ctx.changes().find(line => line.includes('schedules.0')), /plugin action/);
  assert.match(ctx.changes().find(line => line.includes('schedules.1')), /poll detected; cause unknown/);
});

test('failed optional reads do not fabricate state removals and failures/recoveries are logged only on transitions', () => {
  const ctx = setup(); const data = state(); data.charge_config = { charge_limit_percent: 80 };
  ctx.journal.snapshot(data);
  delete data.charge_config; data.errors = { charge_config: { type: 'ApiError', status: 403 } };
  ctx.journal.snapshot(data); ctx.journal.snapshot(data);
  assert.equal(ctx.warn.length, 1); assert.equal(ctx.changes().length, 0);
  data.errors = {}; data.charge_config = { charge_limit_percent: 80 }; ctx.journal.snapshot(data);
  assert.equal(ctx.changes().length, 0); assert.ok(ctx.info.some(line => line.includes('read recovered')));
  data.charge_config = null; ctx.journal.snapshot(data);
  assert.ok(ctx.changes().some(line => line.includes('charge_limit_percent: 80 -> not reported')));
});

test('vehicle logs retain change detection without exposing identifiers, free text or location coordinates', () => {
  const ctx = setup({ debugLogging: true }); const data = state();
  data.status.secret = 'token-secret'; data.status.owner_email = 'private@example.com';
  data.status.notes = 'password-secret'; data.location = { latitude: 41.123456, longitude: -87.123456, address: 'private-address' };
  ctx.journal.snapshot(data);
  data.location.last_updated_at = '2026-10-29T12:00:00Z'; ctx.journal.snapshot(data);
  assert.equal(ctx.changes().length, 0);
  data.status.notes = 'second-password-secret'; data.location.latitude = 42.123456;
  ctx.journal.snapshot(data);
  const output = [...ctx.info, ...ctx.warn].join('\n');
  assert.match(output, /location changed \(coordinates\/address withheld\)/);
  for (const secret of ['SENSITIVEVIN', 'token-secret', 'private@example.com', 'password-secret', '41.123456', '42.123456', '-87.123456', 'private-address']) assert.ok(!output.includes(secret), secret);
});

test('debug setting works without Homebridge -D and structured error summaries omit raw upstream bodies', () => {
  const ctx = setup(); debug({}, ctx.log, 'hidden', {}); assert.equal(ctx.info.length, 0);
  debug({ debugLogging: true }, ctx.log, 'connection', { status: 401, password: 'private', access_token: 'secret' });
  assert.match(ctx.info[0], /\[Debug\].*401/); assert.ok(!ctx.info[0].includes('private')); assert.ok(!ctx.info[0].includes('secret'));
  assert.deepEqual(errorDetails(Object.assign(new Error('DEVICE_VERIFICATION token-secret'), { status: 403 })), { type: 'Error', status: 403, reason: 'DEVICE_VERIFICATION' });
  assert.equal(errorDetails({ type: 'ApiError', reason: 'ACCESS_DENIED' }).reason, 'ACCESS_DENIED');
  assert.equal(errorDetails(new Error('Nissan rejected command')).reason, 'COMMAND_REJECTED');
  assert.equal(errorDetails(new TypeError('private', { cause: { code: 'ECONNREFUSED' } })).code, 'ECONNREFUSED');
});

test('debug history correlates request IDs privately, preserves unknown callers and reports notification opt-ins without content', () => {
  const ctx = setup({ debugLogging: true });
  const data = { remote_history: { history: [
    { service_request_id: 'secret-own-id', service_type: 'DOOR_LOCK', status: 'SUCCESS', status_change_date_time: '2026-10-29T12:05:00Z' },
    { service_request_id: 'secret-external-id', service_type: 'REMOTE_CHARGING', status: 'FAILED' },
  ] }, notifications: [{ notification_category: 'VEHICLE_CHARGE', notification_type: [{ destination: 'PUSH', opt_in: true }, { destination: 'EMAIL', opt_in: false, recipient: 'private@example.com' }], content: 'private-message' }], reminders: { lock: true, window: false, address: 'private-address' } };
  ctx.journal.diagnostics(data, [{ label: 'C1', action: 'lock', requestId: 'secret-own-id' }]);
  const output = ctx.info.join('\n');
  assert.match(output, /C1 lock/); assert.match(output, /caller identity not provided/);
  assert.match(output, /VEHICLE_CHARGE/); assert.match(output, /PUSH/); assert.match(output, /not a live push-notification feed/);
  for (const secret of ['secret-own-id', 'secret-external-id', 'private@example.com', 'private-message', 'private-address']) assert.ok(!output.includes(secret), secret);
  const before = ctx.info.filter(line => line.includes('history') && !line.includes('reads completed')).length;
  ctx.journal.diagnostics(data, []);
  assert.equal(ctx.info.filter(line => line.includes('history') && !line.includes('reads completed')).length, before + 1); // Correlation changed for one entry.
});
