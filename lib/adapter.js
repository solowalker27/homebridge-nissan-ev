'use strict';
// Native Node adapter for the auto-generated TypeScript translation of pynissan.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const lockfile = require('proper-lockfile');
const sdk = require('@solowalker27/nissan-connect-sdk');
const { errorDetails } = require('./logging');

const plain = value => value == null ? value : JSON.parse(JSON.stringify(value));
const safeError = errorDetails;
async function privateRead(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
      throw new Error('Authentication file must be owned by Homebridge with owner-only permissions.');
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
async function privateWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.nissan-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
async function withAuthLock(file, fn) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Different suffix avoids collision with the old Python flock's regular file.
  const release = await lockfile.lock(`${file}.node-session`, {
    realpath: false, stale: 120000, update: 20000,
    retries: { retries: 300, factor: 1, minTimeout: 50, maxTimeout: 50 },
  });
  try { return await fn(); } finally { await release(); }
}
function vehicleLabels(vehicles) {
  return vehicles.filter(v => (v.model || '').toLowerCase().includes('ariya'))
    .map(v => ({ model: v.model, year: v.year, vinSuffix: v.vin.slice(-4) }));
}
class Adapter {
  constructor(file, { clientFactory, diagnostic } = {}) {
    this.file = file;
    this.diagnostic = diagnostic;
    this.clientFactory = clientFactory || (options => this.nativeClient(options));
    this.clients = new Set();
    this.closed = false;
  }
  ensureOpen() { if (this.closed) throw new Error('Nissan session is closed'); }
  nativeClient(options) {
    if (!this.diagnostic) return new sdk.NissanClient(options);
    const session = new sdk.FetchSession(async (url, request) => {
      const endpoint = new URL(url);
      let operation = endpoint.pathname.endsWith('/token') ? 'OAuth token exchange' : 'GraphQL';
      try {
        const name = JSON.parse(request.body).operationName;
        if (typeof name === 'string' && /^[A-Za-z]{1,80}$/.test(name)) operation = name;
      } catch { /* Never log request bodies, headers or OAuth form data. */ }
      const detail = { endpoint: `${endpoint.origin}${endpoint.pathname}`, operation };
      const started = Date.now();
      this.diagnostic('HTTP request started', detail);
      try {
        const response = await fetch(url, request);
        this.diagnostic('HTTP response headers received', { ...detail, status: response.status, elapsedMs: Date.now() - started });
        return response;
      } catch (error) {
        this.diagnostic('HTTP request failed', { ...detail, elapsedMs: Date.now() - started, ...safeError(error) });
        throw error;
      }
    });
    let client;
    try { client = new sdk.NissanClient(session, options); }
    catch (error) { session.close(); throw error; }
    const close = client.close.bind(client);
    client.close = () => { close(); session.close(); };
    return client;
  }
  async useClient(options, fn) {
    this.ensureOpen();
    const client = this.clientFactory(options);
    this.clients.add(client);
    this.diagnostic?.('Nissan client opened', { readOnly: options.read_only });
    try { return await fn(client); }
    finally { client.close?.(); this.clients.delete(client); this.diagnostic?.('Nissan client closed', {}); }
  }
  async status() {
    return withAuthLock(this.file, async () => {
      this.ensureOpen();
      let auth;
      try { auth = await privateRead(this.file); }
      catch (error) { if (error.code === 'ENOENT') return { connected: false, verified: false }; throw error; }
      const connected = Boolean(auth.tokens?.access_token && auth.tokens?.refresh_token && auth.device_id);
      return { connected, verified: false, authenticatedAt: auth.authenticated_at };
    });
  }
  async authenticate(email, password) {
    return withAuthLock(this.file, () => this.useClient({ country: sdk.Country.US, read_only: true }, async client => {
      await client.async_authenticate(email.trim(), password);
      const vehicles = await client.async_get_vehicles();
      this.ensureOpen();
      await privateWrite(this.file, { tokens: plain(client.tokens), device_id: client.oauth_device_id, authenticated_at: new Date().toISOString() });
      return { connected: true, verified: true, vehicles: vehicleLabels(vehicles) };
    }));
  }
  async dispatch(method, args = {}) {
    const waitingAt = Date.now();
    return withAuthLock(this.file, async () => {
      this.ensureOpen();
      this.diagnostic?.('Authentication file lock acquired', { method, waitedMs: Date.now() - waitingAt });
      const auth = await privateRead(this.file);
      this.diagnostic?.('Saved session loaded', { method, accessTokenPresent: !!auth.tokens?.access_token, refreshTokenPresent: !!auth.tokens?.refresh_token, deviceIdentityPresent: !!auth.device_id, requestProofPresent: !!auth.request_proof });
      const options = {
        country: sdk.Country.US, read_only: method !== 'command',
        tokens: new sdk.Tokens(auth.tokens), oauth_device_id: auth.device_id,
        request_proof: auth.request_proof ? new sdk.RequestProof(auth.request_proof) : null,
        token_listener: async tokens => {
          this.ensureOpen(); auth.tokens = plain(tokens); await privateWrite(this.file, auth);
          this.diagnostic?.('Renewed tokens saved', { method });
        },
      };
      return this.useClient(options, async client => {
        if (method === 'vehicles') return plain(await client.async_get_vehicles());
        const { vin } = args;
        if (method === 'snapshot') {
          const result = { status: plain(await client.async_get_vehicle_status(vin, { temperature_unit: sdk.TemperatureUnit.CELSIUS })), errors: {} };
          const reads = {
            capabilities: () => client.async_get_vehicle_capabilities(vin, sdk.TemperatureUnit.CELSIUS),
            defaults: () => client.async_get_climate_defaults(vin, { temperature_unit: sdk.TemperatureUnit.CELSIUS }),
            charge_config: () => client.async_get_charge_config(vin),
            v2l: () => client.async_get_v2l_status(vin),
            charge_schedules: () => client.async_get_charge_schedules(vin),
            climate_schedules: () => client.async_get_climate_schedules(vin),
            maintenance: () => client.async_get_maintenance_timeline(vin),
          };
          if (args.location) reads.location = () => client.async_get_vehicle_location(vin);
          for (const [name, read] of Object.entries(reads)) {
            this.ensureOpen();
            try { result[name] = plain(await read()); }
            catch (error) { result.errors[name] = safeError(error); }
          }
          result.fetched_at = new Date().toISOString();
          return result;
        }
        if (method === 'diagnostics') {
          const result = { errors: {} };
          for (const [section, read] of Object.entries({
            remote_history: () => client.async_get_remote_service_history(vin, { page_number: 1, items_per_page: 10 }),
            notifications: () => client.async_get_notification_preferences(vin),
            reminders: () => client.async_get_reminder_notifications_after_leaving_vehicle(vin),
          })) {
            this.ensureOpen();
            try { result[section] = plain(await read()); }
            catch (error) { result.errors[section] = safeError(error); }
          }
          return result;
        }
        if (method === 'command') return this.command(client, vin, args.action, args.params || {});
        if (method === 'command_status') {
          const request = new sdk.ServiceRequest(args.request.id, sdk.ServiceRequestKind(args.request.kind));
          const result = await client.async_check_service_request(vin, request);
          return { terminal: result.is_terminal, success: result.is_success, status: plain(result.status),
            status_details: result.status_details, activation_date_time: plain(result.activation_date_time),
            status_change_date_time: plain(result.status_change_date_time), location: plain(result.location) };
        }
        throw new Error('Unsupported Nissan request');
      });
    });
  }
  async command(client, vin, action, params) {
    const simple = {
      lock: 'lock_doors', unlock: 'unlock_doors', flash: 'flash_lights', horn: 'flash_lights_and_horn',
      locate: 'locate_vehicle', refresh: 'refresh_vehicle_status', wake: 'wake_up_vehicle',
      refresh_battery: 'refresh_battery_status', refresh_climate: 'refresh_climate_status',
      start_charge: 'start_charge', stop_charge: 'stop_charge', stop_climate: 'stop_climate',
      cancel_delayed_climate: 'cancel_delayed_climate',
    };
    let result;
    if (Object.hasOwn(simple, action)) result = await client[`async_${simple[action]}`](vin);
    else if (['start_climate', 'adjust_climate', 'climate_defaults'].includes(action)) {
      validateTemperature(params.temperature);
      const raw = params.parameters || {};
      const seats = Object.fromEntries(Object.entries(raw.seats || {}).filter(([,v]) => v != null).map(([k,v]) => [k,sdk.SeatClimateOption(v)]));
      const parameters = Object.keys(raw).length ? new sdk.ClimateParameters({
        seats: Object.keys(seats).length ? new sdk.SeatClimateSettings(seats) : null,
        steering_wheel_heater: raw.steering_wheel_heater ?? null,
        defrost_and_deicer: raw.defrost_and_deicer ?? null,
      }) : null;
      const climate = new sdk.ClimateSettings(params.temperature, sdk.TemperatureUnit.CELSIUS, parameters);
      const method = { start_climate: 'async_start_climate', adjust_climate: 'async_adjust_climate', climate_defaults: 'async_set_climate_defaults' }[action];
      result = await client[method](vin, climate);
    } else if (['charge_limit', 'charge_notification', 'v2l_minimum'].includes(action)) {
      if (!Number.isInteger(params.percent) || params.percent < 1 || params.percent > 100) throw new Error('Invalid percentage');
      const method = { charge_limit: 'async_set_charge_limit', charge_notification: 'async_set_charge_notification_threshold', v2l_minimum: 'async_set_v2l_minimum_battery_charge_level' }[action];
      result = await client[method](vin, params.percent);
    } else if (['charge_schedule', 'climate_schedule'].includes(action)) {
      if (typeof params.enabled !== 'boolean' || typeof params.id !== 'string') throw new Error('Invalid schedule toggle');
      result = await client[action === 'charge_schedule' ? 'async_toggle_charge_schedule' : 'async_toggle_climate_schedule'](vin, params.id, { enabled: params.enabled });
    } else if (['edit_charge_schedule', 'edit_climate_schedule', 'delayed_climate'].includes(action)) {
      const kind = action === 'edit_charge_schedule' ? 'charge' : 'climate';
      const operation = params.operation || 'create';
      if (!['create', 'update', 'delete'].includes(operation)) throw new Error('Invalid schedule operation');
      if (action !== 'delayed_climate' && operation === 'delete') result = await client[`async_delete_${kind}_schedule`](vin, params.id);
      else {
        const start = sdk.dateTime(params.start);
        if (start.utcoffset() == null) throw new Error('Schedule needs an explicit UTC offset');
        const days = (params.days || []).map(day => sdk.WeekDay(day));
        if (days.includes(sdk.WeekDay.UNKNOWN_VALUE)) throw new Error('Invalid weekday');
        let climate, schedule;
        if (kind === 'charge') schedule = new sdk.ChargeScheduleInput(start, params.duration, days);
        else { validateTemperature(params.temperature); climate = new sdk.ClimateSettings(params.temperature, sdk.TemperatureUnit.CELSIUS); schedule = new sdk.ClimateScheduleInput(start, days, climate); }
        if (action === 'delayed_climate') result = await client.async_set_delayed_climate(vin, start, climate);
        else if (operation === 'create') result = await client[`async_create_${kind}_schedule`](vin, schedule);
        else result = await client[`async_update_${kind}_schedule`](vin, params.id, schedule);
      }
    } else throw new Error('Unsupported vehicle command');
    if (typeof result === 'boolean') { if (!result) throw new Error('Nissan rejected command'); return { complete: true }; }
    if (!(result instanceof sdk.ServiceRequest)) throw new Error('Unexpected command response');
    return { complete: false, request: { id: result.id, kind: result.kind.value },
      ...(result.climate_defaults_success != null ? { defaultsSaved: result.climate_defaults_success } : {}),
      ...(result.climate_defaults_error_message ? { defaultsReasonProvided: true } : {}) };
  }
  close() { this.closed = true; for (const client of this.clients) client.close?.(); }
}
function validateTemperature(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 16 || value > 30) throw new Error('Invalid target temperature');
}
module.exports = { Adapter, plain, safeError, privateRead, privateWrite, withAuthLock, vehicleLabels };
