'use strict';
const { createHash } = require('node:crypto');

const PRIVATE = /^(?:vin|.*(?:token|password|secret|attestation)|device_id|oauth_device_id|request_proof|headers|authorization|email|phone|plate|nickname|user_id|image_url|.*(?:request_id|service_request_id)|id)$/i;
const CLOCK = /(?:last_updated|last_update|fetched_at|timestamp|status_change_date_time|activation_date_time)/i;
const ROOTS = ['status', 'defaults', 'capabilities', 'charge_config', 'v2l', 'charge_schedules', 'climate_schedules', 'maintenance', 'location'];
const REASONS = [
  [/Nissan rejected command/i, 'COMMAND_REJECTED'],
  [/timed?[_ -]?out|timeout/i, 'TIMED_OUT'],
  [/vehicle[_ -]?(?:unreachable|not[_ -]?connected)|not[_ -]?reachable/i, 'VEHICLE_UNREACHABLE'],
  [/ignition[_ -]?on|engine[_ -]?running|vehicle[_ -]?in[_ -]?use/i, 'VEHICLE_IN_USE'],
  [/door[s]?[_ -]?open/i, 'DOORS_OPEN'],
  [/not[_ -]?plugged|cable[_ -]?(?:disconnected|not[_ -]?connected)/i, 'CABLE_DISCONNECTED'],
  [/low[_ -]?battery|battery[_ -]?low/i, 'LOW_BATTERY'],
  [/subscription|entitlement/i, 'SUBSCRIPTION_OR_ENTITLEMENT'],
  [/attestation|device[_ -]?verif|request[_ -]?proof/i, 'DEVICE_VERIFICATION'],
  [/rate[_ -]?limit|too[_ -]?many[_ -]?requests/i, 'RATE_LIMITED'],
  [/permission|forbidden|not[_ -]?authori[sz]ed/i, 'ACCESS_DENIED'],
  [/unsupported|not[_ -]?supported/i, 'UNSUPPORTED_OPERATION'],
];
function reasonCode(value) {
  if (typeof value !== 'string') return undefined;
  if (REASONS.some(([, code]) => code === value)) return value;
  return REASONS.find(([pattern]) => pattern.test(value))?.[1];
}
function token(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_ -]{0,79}$/.test(value) ? value : undefined;
}
function iso(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d(?:T[\d:.]+(?:Z|[+-]\d\d:\d\d))?$/.test(value) ? value : undefined;
}
function errorDetails(error) {
  const type = error?.type || error?.constructor?.name;
  const result = { type: /^[A-Za-z]{1,64}$/.test(type || '') ? type : 'Error' };
  if (Number.isInteger(error?.status)) result.status = error.status;
  const code = error?.code || error?.cause?.code;
  if (['ENOENT', 'EACCES', 'EPERM', 'ELOCKED', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) result.code = code;
  const reason = reasonCode(error?.reason) || reasonCode(error?.message) || (Array.isArray(error?.messages) && error.messages.map(reasonCode).find(Boolean));
  if (reason) result.reason = reason;
  return result;
}
function errorText(error) {
  const detail = errorDetails(error);
  return [detail.type, detail.status && `HTTP ${detail.status}`, detail.code, detail.reason].filter(Boolean).join('; ');
}
function clean(value) {
  // Diagnostic callers provide structured summaries, never raw requests/responses.
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (PRIVATE.test(key)) return '[redacted]';
    if (typeof item === 'string') return item.replace(/[\r\n\t]/g, ' ').slice(0, 256);
    return item;
  }));
}
function debug(config, log, event, detail = {}) {
  // Homebridge's log.debug can be globally suppressed. This setting works without -D.
  if (config.debugLogging === true) log.info?.(`[Debug] ${event} ${JSON.stringify(clean(detail))}`);
}
function entries(value, path, output = new Map()) {
  if (value && typeof value === 'object') {
    const children = Object.entries(value).filter(([key]) => !PRIVATE.test(key) && !CLOCK.test(key));
    if (!children.length) output.set(path, null);
    for (const [key, child] of children) entries(child, `${path}.${key}`, output);
  } else output.set(path, value ?? null);
  return output;
}
function shown(path, value) {
  if (value === undefined) return 'not reported';
  if (value === null) return 'unavailable';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (iso(value)) return value;
  if (/(?:state|status|lock|ajar|window|unit|mode|type|heater|seat|source|kind)$|\.seats\.[^.]+$/.test(path) && token(value)) return value;
  return '[text withheld]';
}
function expectedChange(command, path, value, data) {
  if (!command || command.status !== 'succeeded') return false;
  const { action, params = {} } = command;
  if (['lock', 'unlock'].includes(action) && /^status\.doors\.(?:overall_lock|[^.]+\.lock)$/.test(path)) {
    return action === 'lock' ? ['LOCKED', 'LOCK', 'SECURED', true].includes(value) : ['UNLOCKED', 'UNLOCK', 'UNSECURED', false].includes(value);
  }
  if (['start_charge', 'stop_charge'].includes(action)) return path === 'status.battery.is_charging' && value === (action === 'start_charge');
  if (['start_climate', 'stop_climate'].includes(action) && path === 'status.climate.state') {
    return action === 'stop_climate' ? ['OFF', 'STOPPED', 'INACTIVE'].includes(value) : ['ON', 'ACTIVE', 'HEAT', 'HEATING', 'COOL', 'COOLING', 'RUNNING'].includes(value);
  }
  if (['start_climate', 'adjust_climate', 'climate_defaults'].includes(action)) {
    if (path === 'defaults.climate.value') return value === params.temperature;
    if (path.startsWith('defaults.parameters.')) return path.slice('defaults.parameters.'.length).split('.').reduce((item, key) => item?.[key], params.parameters) === value;
  }
  if (['charge_schedule', 'climate_schedule', 'edit_charge_schedule', 'edit_climate_schedule'].includes(action)) {
    const match = /^(charge_schedules|climate_schedules\.schedules)\.(\d+)\./.exec(path);
    const schedules = match?.[1] === 'charge_schedules' ? data?.charge_schedules : data?.climate_schedules?.schedules;
    return !!params.id && match && schedules?.[Number(match[2])]?.id === params.id;
  }
  if (['delayed_climate', 'cancel_delayed_climate'].includes(action)) return path.startsWith('climate_schedules.delayed_schedule');
  const settings = { charge_limit: 'charge_config.charge_limit_percent', charge_notification: 'charge_config.notification_threshold_percent', v2l_minimum: 'v2l.minimum_charge_limit_percent' };
  return settings[action] === path && value === params.percent;
}
class VehicleLog {
  constructor(config, log, name) {
    this.config = config; this.log = log; this.name = name;
    this.baselines = new Map(); this.faults = new Map(); this.diagnosticBaseline = new Map(); this.initialized = false;
  }
  info(message) { this.log.info?.(`${String(this.name()).replace(/[\r\n\t]/g, ' ')}: ${message}`); }
  debug(event, detail) { debug(this.config, this.log, `${String(this.name()).replace(/[\r\n\t]/g, ' ')}: ${event}`, detail); }
  snapshot(data, origin = {}) {
    const first = !this.initialized;
    let changes = 0;
    for (const root of ROOTS) {
      const failure = data.errors?.[root];
      const previousFault = this.faults.get(root);
      if (failure) {
        const signature = JSON.stringify(errorDetails(failure));
        if (previousFault !== signature) this.log.warn?.(`${this.name()}: ${root} read unavailable (${errorText(failure)}); other status remains usable.`);
        this.faults.set(root, signature);
        continue; // A failed optional query is not evidence of a vehicle state change.
      }
      if (!Object.hasOwn(data, root)) continue;
      if (previousFault) { this.info(`${root} read recovered.`); this.faults.delete(root); }
      const next = root === 'location'
        ? new Map([['location', data.location == null ? null : createHash('sha256').update(JSON.stringify([...entries(data.location, 'location')].sort(([left], [right]) => left.localeCompare(right)))).digest('hex')]])
        : entries(data[root], root);
      const previous = this.baselines.get(root);
      if (!first) for (const path of new Set([...(previous?.keys() || []), ...next.keys()])) {
        const before = previous?.get(path); const after = next.get(path);
        if (Object.is(before, after)) continue;
        const command = origin.command;
        const source = expectedChange(command, path, after, data)
          ? `plugin action ${command.label} ${command.action} follow-up; observed change, causality not guaranteed`
          : `poll detected; cause unknown${command ? `; during follow-up for ${command.label} ${command.action}` : ''}`;
        const change = root === 'location' ? 'location changed (coordinates/address withheld)' : `${path}: ${shown(path, before)} -> ${shown(path, after)}`;
        this.info(`State change [${source}]: ${change}.`);
        changes++;
      }
      this.baselines.set(root, next);
    }
    this.initialized = true;
    if (first) this.info(`Initial state baseline established; battery ${shown('level', data.status?.battery?.level)}%, doors ${shown('lock', data.status?.doors?.overall_lock)}, charging ${shown('charging', data.status?.battery?.is_charging)}. Future changes will be logged.`);
    this.debug('Snapshot received', { origin: origin.command ? 'command follow-up' : 'poll', changes, fetchedAt: iso(data.fetched_at), failedSections: Object.keys(data.errors || {}), vehicleTimes: this.observationTimes(data.status) });
  }
  observationTimes(status) {
    return Object.fromEntries(Object.entries(status || {}).filter(([, value]) => value && typeof value === 'object' && iso(value.last_updated_at)).map(([key, value]) => [key, value.last_updated_at]));
  }
  diagnostics(data, commands = []) {
    if (this.config.debugLogging !== true || !data) return;
    this.debug('Nissan diagnostic reads completed', { historyReported: data.remote_history != null, historyEntries: data.remote_history?.history?.length || 0, notificationsReported: data.notifications != null, remindersReported: data.reminders != null });
    for (const [section, error] of Object.entries(data.errors || {})) this.debug('Optional diagnostic read unavailable', { section, ...errorDetails(error) });
    for (const item of data.remote_history?.history || []) {
      if (!item) continue;
      const own = commands.find(command => command.requestId && command.requestId === item.service_request_id);
      const summary = { service: token(item.service_type) || 'unknown', status: token(item.status) || 'unknown', changedAt: iso(item.status_change_date_time), correlation: own ? `${own.label} ${own.action}` : 'not matched to a command from this plugin session; caller identity not provided by Nissan' };
      const key = `history:${item.service_request_id || JSON.stringify(summary)}`;
      const signature = JSON.stringify(summary);
      if (this.diagnosticBaseline.get(key) !== signature) this.debug('Nissan remote-service history', summary);
      this.diagnosticBaseline.set(key, signature);
    }
    const preferences = Array.isArray(data.notifications) ? data.notifications.map(item => item && ({
      category: token(item.notification_category) || 'unknown',
      channels: (item.notification_type || []).filter(Boolean).map(channel => ({ destination: token(channel.destination) || 'unknown', enabled: typeof channel.opt_in === 'boolean' ? channel.opt_in : null })),
    })) : null;
    const reminders = data.reminders && Object.fromEntries(Object.entries(data.reminders).filter(([, value]) => typeof value === 'boolean'));
    for (const [section, value] of [['Notification preferences', preferences], ['Leaving-vehicle notification reminders', reminders]]) {
      if (!Object.hasOwn(data, section === 'Notification preferences' ? 'notifications' : 'reminders')) continue;
      const signature = JSON.stringify(value);
      if (this.diagnosticBaseline.get(section) !== signature) this.debug(section, { value, note: 'settings reported by Nissan; this is not a live push-notification feed' });
      this.diagnosticBaseline.set(section, signature);
    }
    // Bound memory even when Nissan returns many different historical requests.
    while (this.diagnosticBaseline.size > 100) this.diagnosticBaseline.delete(this.diagnosticBaseline.keys().next().value);
  }
}
module.exports = { debug, VehicleLog, errorDetails, errorText, reasonCode, token, iso, shown };
