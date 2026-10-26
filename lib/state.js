'use strict';
function binary(value, yes, no) {
  if (typeof value === 'boolean') return value;
  const word = String(value ?? '').toUpperCase();
  if (yes.includes(word)) return true;
  if (no.includes(word)) return false;
  return undefined;
}
const active = value => binary(value, ['ON', 'ACTIVE', 'ENABLED', 'HEAT', 'COOL', 'HEATING', 'COOLING', 'RUNNING'], ['OFF', 'INACTIVE', 'DISABLED', 'STOPPED']);
const locked = value => binary(value, ['LOCKED', 'LOCK', 'SECURED'], ['UNLOCKED', 'UNLOCK', 'UNSECURED']);
const opened = value => binary(value, ['OPEN', 'OPENED', 'AJAR'], ['CLOSED', 'CLOSE']);
function celsius(reading) {
  if (!reading || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) return undefined;
  if (['FAHRENHEIT', 'F'].includes(reading.unit)) return (reading.value - 32) * 5 / 9;
  if (['CELSIUS', 'C'].includes(reading.unit)) return reading.value;
  return undefined;
}
function flatten(value, prefix = '', output = {}) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['vin', 'image_url', 'plate', 'user_id', 'nickname'].includes(key)) continue;
      flatten(child, prefix ? `${prefix}.${key}` : key, output);
    }
  } else output[prefix] = value;
  return output;
}
function chargeSettingEvidence(snapshot, field) {
  if (!snapshot || !Object.hasOwn(snapshot, 'charge_config') && !snapshot.errors?.charge_config) return 'Not checked';
  if (snapshot.errors?.charge_config) return 'Unknown: charge configuration query failed';
  const percent = snapshot.charge_config?.[field];
  if (typeof percent === 'number' && Number.isFinite(percent)) return `Reported: ${percent}%; changing it is not yet verified`;
  return 'Not reported for this vehicle/account';
}

function serviceEvidence(snapshot, type) {
  if (!snapshot) return 'Not checked';
  if (snapshot.errors?.capabilities) return 'Unknown: capabilities query failed';
  const service = snapshot.capabilities?.services?.find(item => item?.type === type);
  if (!service) return 'Not reported for this vehicle/account';
  const flag = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
  return `Enabled: ${flag(service.enabled)}; subscribed: ${flag(service.subscribed)}; operation not verified`;
}

function maintenanceEvidence(snapshot) {
  if (!snapshot || !Object.hasOwn(snapshot, 'maintenance') && !snapshot.errors?.maintenance) return 'Not checked';
  if (snapshot.errors?.maintenance) return 'Unknown: maintenance query failed';
  return snapshot.maintenance ? 'Timeline reported by Nissan' : 'Nissan returned no maintenance timeline';
}

function maintenanceStatus(timeline, now = new Date()) {
  if (!timeline) return undefined;
  const mileageDue = typeof timeline.remaining_service_mileage === 'number' && timeline.remaining_service_mileage <= 0;
  // Compare date-only values in the Homebridge host's configured timezone.
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hasDate = typeof timeline.next_service_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(timeline.next_service_date);
  const dateDue = hasDate && timeline.next_service_date <= today;
  if (mileageDue && dateDue) return 'Due by date and mileage';
  if (mileageDue) return 'Due by mileage';
  if (dateDue) return 'Due by date';
  if (hasDate || typeof timeline.remaining_service_mileage === 'number') return 'Upcoming';
  return undefined;
}
module.exports = { active, locked, opened, celsius, flatten, chargeSettingEvidence, maintenanceStatus, serviceEvidence, maintenanceEvidence };
