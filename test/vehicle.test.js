'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');
const { PlatformAccessory } = require('../node_modules/homebridge/dist/platformAccessory.js');
const { VehicleAccessory } = require('../lib/vehicle');
const { NissanPlatform } = require('../lib/platform');
const { active, locked, opened, celsius, maintenanceStatus, chargeSettingEvidence, serviceEvidence, maintenanceEvidence } = require('../lib/state');

const vin = 'TESTVIN00000000001';
function snapshot() {
  return {
    status: {
      vin, battery: { level: 92, is_charging: false, is_plugged_in: true, remaining_mileage: { value: 281, unit: 'MILE' } },
      doors: { overall_lock: 'LOCKED', front_left: { ajar: 'CLOSED', window: 'CLOSED', lock: 'LOCKED' }, hatch_ajar: 'CLOSED' },
      climate: { state: 'OFF', temperature: { value: 21, unit: 'CELSIUS' } },
      mileage: { total: 12000, unit: 'MILE' }, tire_pressure: { front_left: 36 },
    },
    defaults: { climate: { value: 22, unit: 'CELSIUS' }, parameters: { steering_wheel_heater: false, seats: { front_driver: 'OFF' } } },
    capabilities: { services: [] }, charge_config: { charge_limit_percent: 80 },
    charge_schedules: [{ id: 'weekday', state: 'ENABLED', duration: 'PT2H' }],
    climate_schedules: { schedules: [] }, fetched_at: new Date().toISOString(), errors: {},
  };
}
function setup(config = {}, settings = {}, accessory) {
  const calls = [];
  let data = snapshot();
  let request = async (method, args) => {
    calls.push({ method, args });
    if (method === 'snapshot') return data;
    if (method === 'vehicles') return [{ vin, model: 'ARIYA', year: '2023' }];
    return { complete: true };
  };
  const api = { hap, platformAccessory: PlatformAccessory, updatePlatformAccessories() {} };
  const platform = { api, config, bridge: { request: (...args) => request(...args) }, log: { info() {}, warn() {} } };
  accessory ||= new PlatformAccessory('Ariya', hap.uuid.generate(`homebridge-nissan-connect:${vin}`));
  accessory._associatedPlugin = 'homebridge-nissan-ev';
  accessory._associatedPlatform = 'NissanConnect';
  const controller = new VehicleAccessory(platform, accessory, { vin, model: 'ARIYA', year: '2023' }, settings);
  return { controller, accessory, platform, calls, setData(value) { data = value; }, setRequest(value) { request = value; } };
}
const char = (ctx, key, Type) => ctx.accessory.services.find(s => s.subtype === `nissan:${key}`).getCharacteristic(Type);

test('one accessory contains correctly linked standard services and preserves observed state', async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  assert.equal(await char(ctx, 'battery', hap.Characteristic.BatteryLevel).handleGetRequest(), 92);
  assert.equal(await char(ctx, 'lock', hap.Characteristic.LockCurrentState).handleGetRequest(), 1);
  assert.equal(await char(ctx, 'charge', hap.Characteristic.On).handleGetRequest(), false);
  assert.equal(await char(ctx, 'plug', hap.Characteristic.ContactSensorState).handleGetRequest(), 0);
  assert.equal(await char(ctx, 'front_left-ajar', hap.Characteristic.ContactSensorState).handleGetRequest(), 0);
  for (const service of ctx.accessory.services) {
    if (service.subtype && service !== ctx.controller.primary) assert.ok(ctx.controller.primary.linkedServices.includes(service));
  }
  assert.deepEqual(ctx.calls.map(c => c.method), ['snapshot']);
  ctx.controller.stop();
});

test('renaming and restart preserve accessory UUID, service identities, and selected name', async () => {
  const ctx = setup({}, { name: 'Bluebird' });
  await ctx.controller.refresh();
  const ids = ctx.accessory.services.map(s => s.getServiceId());
  const uuid = ctx.accessory.UUID;
  ctx.controller.rename('Roadrunner');
  ctx.controller.stop();
  const restored = PlatformAccessory.deserialize(PlatformAccessory.serialize(ctx.accessory));
  const next = setup({}, { name: 'Bluebird' }, restored);
  await next.controller.refresh();
  assert.equal(next.controller.name, 'Roadrunner');
  assert.equal(next.accessory.UUID, uuid);
  assert.deepEqual(next.accessory.services.map(s => s.getServiceId()), ids);
  next.controller.stop();
  const renamed = setup({}, { name: 'New Config Name' }, restored);
  assert.equal(renamed.controller.name, 'New Config Name');
  assert.equal(renamed.accessory.UUID, uuid);
  renamed.controller.stop();
});

test('a large telemetry payload stays within HomeKit service limits', async () => {
  const ctx = setup();
  const data = snapshot();
  data.capabilities.extra = Object.fromEntries(Array.from({ length: 260 }, (_, i) => [`field${i}`, i]));
  ctx.setData(data);
  await ctx.controller.refresh();
  assert.ok(ctx.controller.online);
  assert.ok(ctx.controller.customPaths.size > 260);
  assert.ok(ctx.accessory.services.every(s => s.characteristics.length <= 100));
  ctx.controller.stop();
});

test('unknown, missing, and stale data are not falsely mapped to closed/off', async () => {
  assert.equal(opened('UNKNOWN'), undefined);
  assert.equal(locked(null), undefined);
  assert.equal(active('UNKNOWN__'), undefined);
  assert.equal(celsius({ value: 68, unit: 'FAHRENHEIT' }), 20);
  const ctx = setup();
  await ctx.controller.refresh();
  ctx.controller.data.status.battery.level = null;
  await assert.rejects(char(ctx, 'battery', hap.Characteristic.BatteryLevel).handleGetRequest());
  ctx.controller.lastRead = 0;
  await assert.rejects(char(ctx, 'charge', hap.Characteristic.On).handleGetRequest());
  ctx.controller.stop();
});

test('startup cached accessories are unavailable when discovery cannot run', async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  NissanPlatform.prototype.configureAccessory.call({ cached: new Map(), api: ctx.platform.api }, ctx.accessory);
  await assert.rejects(char(ctx, 'battery', hap.Characteristic.BatteryLevel).handleGetRequest());
  await assert.rejects(char(ctx, 'charge', hap.Characteristic.On).handleSetRequest(true));
  ctx.controller.stop();
});

test('unlock routes to Nissan once without pretending observed lock state changed', async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  await char(ctx, 'lock', hap.Characteristic.LockTargetState).handleSetRequest(0);
  await ctx.controller.commandPromise;
  assert.equal(ctx.calls.filter(c => c.method === 'command').length, 1);
  assert.equal(ctx.calls.find(c => c.method === 'command').args.action, 'unlock');
  assert.equal(await char(ctx, 'lock', hap.Characteristic.LockCurrentState).handleGetRequest(), 1);
  assert.equal(ctx.controller.commandState, 'unlock: succeeded');
  ctx.controller.stop();
});

test('read-only, feature blocks, and concurrent-command guard prevent writes', async () => {
  for (const [config, settings] of [[{ readOnly: true }, {}], [{}, { disabledFeatures: ['lock'] }]]) {
    const ctx = setup(config, settings);
    assert.throws(() => ctx.controller.enqueue('unlock', {}, 'lock'));
    assert.equal(ctx.calls.length, 0);
    ctx.controller.stop();
  }
  const ctx = setup();
  let finish;
  ctx.setRequest(() => new Promise(resolve => { finish = resolve; }));
  ctx.controller.enqueue('lock', {}, 'lock');
  assert.throws(() => ctx.controller.enqueue('unlock', {}, 'lock'));
  ctx.controller.stop();
  finish({ complete: true });
  await ctx.controller.commandPromise;
});

test('failed submission is recorded, momentary switch resets, and no retry occurs', async () => {
  const ctx = setup();
  ctx.setRequest(async () => { throw new Error('Nissan ApiError (HTTP 403)'); });
  await char(ctx, 'horn', hap.Characteristic.On).handleSetRequest(true);
  await ctx.controller.commandPromise;
  assert.equal(ctx.controller.busy, false);
  assert.equal(ctx.controller.commandFault, true);
  assert.equal(await char(ctx, 'horn', hap.Characteristic.On).handleGetRequest(), false);
  assert.equal(ctx.controller.commandState, 'horn: failed or unconfirmed');
  ctx.controller.stop();
});

test('climate off setpoint stays local, while running climate sends an adjustment', async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  await char(ctx, 'climate', hap.Characteristic.TargetTemperature).handleSetRequest(23);
  assert.equal(ctx.calls.filter(c => c.method === 'command').length, 0);
  ctx.controller.data.status.climate.state = 'ON';
  await char(ctx, 'climate', hap.Characteristic.TargetTemperature).handleSetRequest(24);
  await ctx.controller.commandPromise;
  const request = ctx.calls.find(c => c.method === 'command');
  assert.equal(request.args.action, 'adjust_climate');
  assert.equal(request.args.params.temperature, 24);
  ctx.controller.stop();
});

test('schedule switch maps to its stable Nissan ID', async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  await char(ctx, 'charge-schedule-weekday', hap.Characteristic.On).handleSetRequest(false);
  await ctx.controller.commandPromise;
  const request = ctx.calls.find(c => c.method === 'command');
  assert.deepEqual(request.args.params, { id: 'weekday', enabled: false });
  ctx.controller.stop();
});

test('only a confirmed missing schedule removes its service', async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  const data = snapshot();
  delete data.charge_schedules;
  data.errors.charge_schedules = { type: 'ApiError' };
  ctx.setData(data);
  await ctx.controller.refresh();
  assert.ok(ctx.accessory.services.find(s => s.subtype === 'nissan:charge-schedule-weekday'));
  data.charge_schedules = [];
  delete data.errors.charge_schedules;
  await ctx.controller.refresh();
  assert.equal(ctx.accessory.services.find(s => s.subtype === 'nissan:charge-schedule-weekday'), undefined);
  ctx.controller.stop();
});

test('asynchronous Nissan failure is never treated as successful completion', async () => {
  const ctx = setup();
  let polls = 0;
  ctx.setRequest(async method => {
    if (method === 'command') return { complete: false, request: { id: 'request', kind: 'DOOR' } };
    if (method === 'command_status') { polls++; return { terminal: true, success: false, status: 'FAILED' }; }
    throw new Error('Unexpected refresh after failure');
  });
  ctx.controller.enqueue('unlock', {}, 'lock');
  await ctx.controller.commandPromise;
  assert.equal(polls, 1);
  assert.equal(ctx.controller.commandFault, true);
  assert.equal(ctx.controller.commandState, 'unlock: failed or unconfirmed');
  ctx.controller.stop();
});

test('maintenance exposes next odometer/date and distinguishes date versus mileage due', async () => {
  const ctx = setup();
  const data = snapshot();
  data.maintenance = { next_service_mileage: 15000, remaining_service_mileage: 1200, next_service_date: '2099-01-01', mileage_unit: 'MILE', remaining_service_months: 1 };
  ctx.setData(data);
  await ctx.controller.refresh();
  const service = ctx.accessory.services.find(s => s.subtype === 'nissan:maintenance');
  assert.ok(ctx.controller.primary.linkedServices.includes(service));
  const odometer = service.characteristics.find(c => c.displayName === 'Next Service Odometer');
  assert.equal(await odometer.handleGetRequest(), 15000);
  assert.equal(maintenanceStatus(data.maintenance, new Date(2026, 9, 26)), 'Upcoming');
  assert.equal(maintenanceStatus({ ...data.maintenance, remaining_service_mileage: 0 }, new Date(2026, 9, 26)), 'Due by mileage');
  assert.equal(maintenanceStatus({ ...data.maintenance, next_service_date: '2026-10-26' }, new Date(2026, 9, 26)), 'Due by date');
  // Zero remaining months can be a rounded value, not proof the due date has passed.
  assert.equal(maintenanceStatus({ ...data.maintenance, remaining_service_months: 0 }, new Date(2026, 9, 26)), 'Upcoming');
  assert.equal(maintenanceStatus(null), undefined);
  delete data.maintenance;
  data.errors.maintenance = { type: 'ApiError' };
  await ctx.controller.refresh();
  await assert.rejects(odometer.handleGetRequest());
  assert.equal(await char(ctx, 'battery', hap.Characteristic.BatteryLevel).handleGetRequest(), 92);
  ctx.controller.stop();
});

test('charge feature evidence separates unknown, absent, and reported values', () => {
  assert.equal(chargeSettingEvidence(null, 'charge_limit_percent'), 'Not checked');
  assert.match(chargeSettingEvidence({ errors: { charge_config: {} } }, 'charge_limit_percent'), /Unknown/);
  assert.match(chargeSettingEvidence({ charge_config: null }, 'charge_limit_percent'), /Not reported/);
  assert.match(chargeSettingEvidence({ charge_config: { charge_limit_percent: 80 } }, 'charge_limit_percent'), /Reported: 80%.*not yet verified/);
});

test('eligibility distinguishes explicit false, unknown subscription, and failed query', () => {
  const data = { capabilities: { services: [{ type: 'REMOTE_CHARGING', enabled: true, subscribed: null }] } };
  assert.match(serviceEvidence(data, 'REMOTE_CHARGING'), /Enabled: yes; subscribed: unknown/);
  data.capabilities.services[0].enabled = false;
  assert.match(serviceEvidence(data, 'REMOTE_CHARGING'), /Enabled: no/);
  assert.match(serviceEvidence(data, 'REMOTE_DOOR_UNLOCK'), /Not reported/);
  data.errors = { capabilities: { type: 'ApiError' } };
  assert.match(serviceEvidence(data, 'REMOTE_CHARGING'), /query failed/);
  assert.match(maintenanceEvidence({ maintenance: null }), /no maintenance timeline/);
  assert.match(maintenanceEvidence({ errors: { maintenance: {} } }), /query failed/);
});

test('missing charge settings cannot leave a working stale slider', async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  const slider = ctx.controller.details.characteristics.find(c => c.displayName === 'Charge Limit Percent');
  assert.ok(slider);
  const data = snapshot();
  delete data.charge_config;
  data.errors.charge_config = { type: 'ApiError' };
  ctx.setData(data);
  await ctx.controller.refresh();
  await assert.rejects(slider.handleSetRequest(70));
  assert.equal(ctx.calls.filter(c => c.method === 'command').length, 0);
  data.charge_config = null;
  delete data.errors.charge_config;
  await ctx.controller.refresh();
  assert.equal(ctx.controller.details.characteristics.find(c => c.UUID === slider.UUID), undefined);
  ctx.controller.stop();
});

test('primary renames do not add Doors to the vehicle name or any linked service', async () => {
  const ctx = setup({}, { name: 'Bluebird' });
  await ctx.controller.refresh();
  const primary = char(ctx, 'lock', hap.Characteristic.ConfiguredName);
  assert.equal(await primary.handleGetRequest(), 'Bluebird');
  await primary.handleSetRequest('Roadrunner');
  await primary.handleSetRequest(await primary.handleGetRequest());
  await ctx.controller.refresh();
  assert.equal(ctx.controller.name, 'Roadrunner');
  assert.equal(await primary.handleGetRequest(), 'Roadrunner');
  assert.equal(ctx.accessory.getService(hap.Service.AccessoryInformation).getCharacteristic(hap.Characteristic.Name).value, 'Roadrunner');
  assert.equal(char(ctx, 'charge', hap.Characteristic.Name).value, 'Roadrunner Charging');
  assert.ok(ctx.accessory.services.every(service => !service.displayName.includes('Doors Doors')));
  assert.ok(ctx.calls.every(call => call.method === 'snapshot'));
  ctx.controller.stop();
});

test('individual core, optional and custom service names survive refresh, restart and vehicle renames', async () => {
  const ctx = setup({}, { name: 'Bluebird' });
  await ctx.controller.refresh();
  const names = {
    charge: 'Plug Me In', 'front_left-ajar': 'Driver Door',
    'charge-schedule-weekday': 'Night Charging', steering_wheel_heater: 'Warm Wheel',
    'seat-front_driver-HEAT': 'Driver Seat Heat', telemetry: 'Car Details',
    maintenance: 'Service Reminder', 'telemetry-0': 'Car Readings',
  };
  for (const [key, name] of Object.entries(names)) await char(ctx, key, hap.Characteristic.ConfiguredName).handleSetRequest(name);
  for (let i = 0; i < 2; i++) await ctx.controller.refresh();
  for (const [key, name] of Object.entries(names)) {
    assert.equal(char(ctx, key, hap.Characteristic.Name).value, name, key);
    assert.equal(await char(ctx, key, hap.Characteristic.ConfiguredName).handleGetRequest(), name, key);
  }
  const ids = ctx.accessory.services.map(service => service.getServiceId());
  ctx.controller.stop();
  const restored = PlatformAccessory.deserialize(PlatformAccessory.serialize(ctx.accessory));
  const next = setup({}, { name: 'Bluebird' }, restored);
  await next.controller.refresh();
  next.controller.rename('Roadrunner');
  await next.controller.refresh();
  for (const [key, name] of Object.entries(names)) {
    assert.equal(char(next, key, hap.Characteristic.Name).value, name, key);
    assert.equal(await char(next, key, hap.Characteristic.ConfiguredName).handleGetRequest(), name, key);
  }
  assert.equal(char(next, 'battery', hap.Characteristic.Name).value, 'Roadrunner Battery');
  assert.deepEqual(next.accessory.services.map(service => service.getServiceId()), ids);
  next.controller.stop();
});

test('upgrade repairs legacy Doors prefixes and preserves cached service renames before optional data returns', async () => {
  const accessory = new PlatformAccessory('Bluebird Doors Doors', hap.uuid.generate(`homebridge-nissan-connect:${vin}`));
  accessory.context = { vin, vehicleName: 'Bluebird Doors Doors', configuredName: 'Bluebird' };
  const lock = accessory.addService(hap.Service.LockMechanism, 'Bluebird Doors Doors Doors', 'nissan:lock');
  lock.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
  lock.updateCharacteristic(hap.Characteristic.ConfiguredName, lock.displayName);
  const door = accessory.addService(hap.Service.ContactSensor, 'Bluebird Doors Doors front left Door', 'nissan:front_left-ajar');
  door.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
  door.updateCharacteristic(hap.Characteristic.ConfiguredName, 'Driver Entry');
  const charge = accessory.addService(hap.Service.Outlet, 'Bluebird Doors Doors Charging', 'nissan:charge');
  charge.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
  charge.updateCharacteristic(hap.Characteristic.ConfiguredName, charge.displayName);
  const doorId = door.getServiceId();
  const ctx = setup({}, { name: 'Bluebird' }, accessory);
  assert.equal(ctx.controller.name, 'Bluebird');
  assert.equal(char(ctx, 'lock', hap.Characteristic.Name).value, 'Bluebird');
  assert.equal(char(ctx, 'charge', hap.Characteristic.Name).value, 'Bluebird Charging');
  assert.equal(await char(ctx, 'front_left-ajar', hap.Characteristic.ConfiguredName).handleGetRequest(), 'Driver Entry');
  await char(ctx, 'front_left-ajar', hap.Characteristic.ConfiguredName).handleSetRequest('My Door');
  await ctx.controller.refresh();
  assert.equal(char(ctx, 'front_left-ajar', hap.Characteristic.Name).value, 'My Door');
  assert.equal(ctx.accessory.services.find(service => service.subtype === 'nissan:front_left-ajar').getServiceId(), doorId);
  assert.ok(ctx.accessory.services.every(service => !service.displayName.includes('Doors Doors')));
  ctx.controller.stop();
});

test('explicit vehicle names are preserved and resetting a service to its default resumes automatic naming', async () => {
  const ctx = setup({}, { name: 'Garage Doors Doors' });
  await ctx.controller.refresh();
  assert.equal(ctx.controller.name, 'Garage Doors Doors');
  const configured = char(ctx, 'charge', hap.Characteristic.ConfiguredName);
  await configured.handleSetRequest('My Charger');
  await assert.rejects(configured.handleSetRequest('   '));
  assert.equal(await configured.handleGetRequest(), 'My Charger');
  await configured.handleSetRequest('Garage Doors Doors Charging');
  ctx.controller.rename('Roadrunner');
  await ctx.controller.refresh();
  assert.equal(await configured.handleGetRequest(), 'Roadrunner Charging');
  ctx.controller.stop();
});

test('battery proxies keep genuine battery telemetry and expose a read-only percentage light', async () => {
  const ctx = setup();
  const data = snapshot(); data.status.battery.level = 73; ctx.setData(data);
  await ctx.controller.refresh();
  assert.equal(await char(ctx, 'battery', hap.Characteristic.BatteryLevel).handleGetRequest(), 73);
  const brightness = char(ctx, 'battery-level', hap.Characteristic.Brightness);
  const power = char(ctx, 'battery-level', hap.Characteristic.On);
  assert.equal(await brightness.handleGetRequest(), 73);
  assert.equal(await power.handleGetRequest(), true);
  for (const characteristic of [brightness, power]) assert.deepEqual(characteristic.props.perms, ['pr', 'ev']);
  await assert.rejects(brightness.handleSetRequest(20));
  await assert.rejects(power.handleSetRequest(false));
  assert.equal(await brightness.handleGetRequest(), 73);
  assert.equal(await char(ctx, 'battery-threshold-control', hap.Characteristic.On).handleGetRequest(), false);
  assert.equal(await char(ctx, 'battery-threshold-control', hap.Characteristic.Brightness).handleGetRequest(), 80);
  assert.equal(await char(ctx, 'battery-threshold-reached', hap.Characteristic.ContactSensorState).handleGetRequest(), 0);
  for (const key of ['battery-level', 'battery-threshold-control', 'battery-threshold-reached']) {
    const service = ctx.accessory.services.find(s => s.subtype === `nissan:${key}`);
    assert.ok(ctx.controller.primary.linkedServices.includes(service));
  }
  assert.ok(ctx.calls.every(call => call.method === 'snapshot'));
  ctx.controller.stop();
});

test('threshold brightness and power update the contact immediately without issuing car commands', async () => {
  const ctx = setup({ readOnly: true });
  const data = snapshot(); data.status.battery.level = 79; ctx.setData(data);
  await ctx.controller.refresh();
  const threshold = char(ctx, 'battery-threshold-control', hap.Characteristic.Brightness);
  const enabled = char(ctx, 'battery-threshold-control', hap.Characteristic.On);
  const sensor = char(ctx, 'battery-threshold-reached', hap.Characteristic.ContactSensorState);
  await threshold.handleSetRequest(80);
  await enabled.handleSetRequest(true);
  assert.equal(await sensor.handleGetRequest(), 0);
  data.status.battery.level = 81; await ctx.controller.refresh();
  assert.equal(await sensor.handleGetRequest(), 1); // Skipping over exactly 80 must still trip.
  await enabled.handleSetRequest(false);
  assert.equal(await sensor.handleGetRequest(), 0);
  await threshold.handleSetRequest(70);
  assert.equal(await enabled.handleGetRequest(), false);
  assert.equal(await sensor.handleGetRequest(), 0);
  await enabled.handleSetRequest(true);
  assert.equal(await sensor.handleGetRequest(), 1);
  await threshold.handleSetRequest(90);
  assert.equal(await sensor.handleGetRequest(), 0);
  data.status.battery.level = 90; await ctx.controller.refresh();
  assert.equal(await sensor.handleGetRequest(), 1);
  data.status.battery.level = 89; await ctx.controller.refresh();
  assert.equal(await sensor.handleGetRequest(), 0);
  assert.equal(await char(ctx, 'battery-level', hap.Characteristic.Brightness).handleGetRequest(), 89);
  assert.ok(ctx.calls.every(call => call.method === 'snapshot'));
  ctx.controller.stop();
});

test('threshold setting, enabled state and proxy names persist through restart without trusting cached battery data', async () => {
  const ctx = setup(); await ctx.controller.refresh();
  await char(ctx, 'battery-threshold-control', hap.Characteristic.Brightness).handleSetRequest(85);
  await char(ctx, 'battery-threshold-control', hap.Characteristic.On).handleSetRequest(true);
  await char(ctx, 'battery-threshold-control', hap.Characteristic.ConfiguredName).handleSetRequest('Charge Target');
  const ids = ctx.accessory.services.map(s => s.getServiceId()); ctx.controller.stop();
  const restored = PlatformAccessory.deserialize(PlatformAccessory.serialize(ctx.accessory));
  const next = setup({}, {}, restored);
  assert.equal(await char(next, 'battery-threshold-control', hap.Characteristic.Brightness).handleGetRequest(), 85);
  assert.equal(await char(next, 'battery-threshold-control', hap.Characteristic.On).handleGetRequest(), true);
  await assert.rejects(char(next, 'battery-level', hap.Characteristic.Brightness).handleGetRequest());
  await assert.rejects(char(next, 'battery-threshold-reached', hap.Characteristic.ContactSensorState).handleGetRequest());
  assert.equal(await char(next, 'battery-threshold-reached', hap.Characteristic.StatusFault).handleGetRequest(), 1);
  await next.controller.refresh(); next.controller.rename('Roadrunner');
  assert.equal(await char(next, 'battery-threshold-reached', hap.Characteristic.ContactSensorState).handleGetRequest(), 1);
  assert.equal(await char(next, 'battery-threshold-control', hap.Characteristic.ConfiguredName).handleGetRequest(), 'Charge Target');
  assert.deepEqual(next.accessory.services.map(s => s.getServiceId()), ids);
  next.controller.stop();
});

test('disabled threshold stays closed offline while enabled sensors require a fresh valid battery percentage', async () => {
  const ctx = setup();
  const enabled = char(ctx, 'battery-threshold-control', hap.Characteristic.On);
  const sensor = char(ctx, 'battery-threshold-reached', hap.Characteristic.ContactSensorState);
  const fault = char(ctx, 'battery-threshold-reached', hap.Characteristic.StatusFault);
  assert.equal(await sensor.handleGetRequest(), 0);
  await enabled.handleSetRequest(true);
  await assert.rejects(sensor.handleGetRequest());
  await ctx.controller.refresh(); assert.equal(await sensor.handleGetRequest(), 1);
  ctx.controller.lastRead = 0;
  await assert.rejects(sensor.handleGetRequest()); assert.equal(await fault.handleGetRequest(), 1);
  await enabled.handleSetRequest(false);
  assert.equal(await sensor.handleGetRequest(), 0); assert.equal(await fault.handleGetRequest(), 0);
  await enabled.handleSetRequest(true);
  for (const value of [null, undefined, NaN, -1, 101, '92', 80.5]) {
    ctx.controller.lastRead = Date.now(); ctx.controller.data.status.battery.level = value;
    await assert.rejects(sensor.handleGetRequest());
    await assert.rejects(char(ctx, 'battery-level', hap.Characteristic.Brightness).handleGetRequest());
  }
  ctx.setRequest(async () => { throw new Error('offline'); });
  await ctx.controller.refresh(); await assert.rejects(sensor.handleGetRequest());
  await enabled.handleSetRequest(false); assert.equal(await sensor.handleGetRequest(), 0);
  ctx.controller.stop();
});

test('battery thresholds support 0 and 100 percent and reject invalid settings without changing stored values', async () => {
  const ctx = setup(); const data = snapshot(); data.status.battery.level = 0; ctx.setData(data);
  await ctx.controller.refresh();
  const threshold = char(ctx, 'battery-threshold-control', hap.Characteristic.Brightness);
  const enabled = char(ctx, 'battery-threshold-control', hap.Characteristic.On);
  const sensor = char(ctx, 'battery-threshold-reached', hap.Characteristic.ContactSensorState);
  await threshold.handleSetRequest(0); await enabled.handleSetRequest(true);
  assert.equal(await sensor.handleGetRequest(), 1);
  assert.equal(await char(ctx, 'battery-level', hap.Characteristic.On).handleGetRequest(), false);
  assert.equal(await char(ctx, 'battery-level', hap.Characteristic.Brightness).handleGetRequest(), 0);
  await threshold.handleSetRequest(100); assert.equal(await sensor.handleGetRequest(), 0);
  data.status.battery.level = 100; await ctx.controller.refresh(); assert.equal(await sensor.handleGetRequest(), 1);
  for (const value of [-1, 101, 80.5, NaN, '80', null]) await assert.rejects(threshold.handleSetRequest(value));
  await assert.rejects(enabled.handleSetRequest('yes'));
  assert.equal(await threshold.handleGetRequest(), 100); assert.equal(await enabled.handleGetRequest(), true);
  ctx.controller.stop();
});

test('battery threshold changes publish contact transitions for Home automations', async () => {
  const ctx = setup(); const data = snapshot(); data.status.battery.level = 79; ctx.setData(data);
  await ctx.controller.refresh();
  const sensor = char(ctx, 'battery-threshold-reached', hap.Characteristic.ContactSensorState);
  const transitions = [];
  sensor.on('change', event => { if (event.oldValue !== event.newValue && typeof event.newValue === 'number') transitions.push(event.newValue); });
  const enabled = char(ctx, 'battery-threshold-control', hap.Characteristic.On);
  const threshold = char(ctx, 'battery-threshold-control', hap.Characteristic.Brightness);
  await enabled.handleSetRequest(true);
  assert.equal(sensor.value, 0);
  data.status.battery.level = 81; await ctx.controller.refresh();
  assert.equal(sensor.value, 1);
  await ctx.controller.refresh();
  await enabled.handleSetRequest(false); assert.equal(sensor.value, 0);
  await enabled.handleSetRequest(true); assert.equal(sensor.value, 1);
  await threshold.handleSetRequest(90); assert.equal(sensor.value, 0);
  assert.deepEqual(transitions, [1, 0, 1, 0]);
  ctx.controller.stop();
  const restored = PlatformAccessory.deserialize(PlatformAccessory.serialize(ctx.accessory));
  const next = setup({}, {}, restored);
  await char(next, 'battery-threshold-control', hap.Characteristic.On).handleSetRequest(false);
  const disabled = PlatformAccessory.deserialize(PlatformAccessory.serialize(next.accessory)); next.controller.stop();
  const last = setup({}, {}, disabled);
  assert.equal(await char(last, 'battery-threshold-control', hap.Characteristic.On).handleGetRequest(), false);
  assert.equal(await char(last, 'battery-threshold-control', hap.Characteristic.Brightness).handleGetRequest(), 90);
  assert.equal(await char(last, 'battery-threshold-reached', hap.Characteristic.ContactSensorState).handleGetRequest(), 0);
  last.controller.stop();
});
