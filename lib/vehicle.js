'use strict';
const { active, locked, opened, celsius, flatten, chargeSettingEvidence, maintenanceStatus, serviceEvidence, maintenanceEvidence } = require('./state');

class VehicleAccessory {
  constructor(platform, accessory, vehicle, settings = {}) {
    this.platform = platform;
    this.api = platform.api;
    this.hap = this.api.hap;
    this.S = this.hap.Service;
    this.C = this.hap.Characteristic;
    this.accessory = accessory;
    this.vehicle = vehicle;
    this.settings = settings;
    this.bindings = new Map();
    this.services = new Map();
    this.data = null;
    this.online = false;
    this.lastRead = 0;
    this.commandState = 'Idle';
    this.busy = false;
    this.stopped = false;
    this.customPaths = new Map();
    this.telemetryGroups = new Map();
    this.targetTemperature = accessory.context.targetTemperature ?? 22;
    accessory.context.vin = vehicle.vin;
    const configured = settings.name;
    if (configured && configured !== accessory.context.configuredName) {
      accessory.context.vehicleName = configured;
      accessory.context.configuredName = configured;
    }
    this.name = accessory.context.vehicleName || configured || vehicle.nickname || 'Ariya';
    accessory.displayName = this.name;
    accessory.getService(this.S.AccessoryInformation)
      .setCharacteristic(this.C.Manufacturer, 'Nissan')
      .setCharacteristic(this.C.Model, `${vehicle.year || ''} ${vehicle.model || 'ARIYA'}`.trim())
      .setCharacteristic(this.C.SerialNumber, vehicle.vin)
      .setCharacteristic(this.C.FirmwareRevision, require('../package.json').version);
    this.buildCore();
    for (const spec of accessory.context.telemetry || []) this.telemetry(spec.path, spec.format);
    // Restored optional services must not serve cached values before a new snapshot arrives.
    for (const service of accessory.services) {
      if (!service.subtype?.startsWith('nissan:') || this.services.has(service.subtype)) continue;
      for (const char of service.characteristics) {
        if ([this.C.Name.UUID, this.C.ConfiguredName.UUID].includes(char.UUID)) continue;
        char.onGet(() => { throw this.unavailable(); });
        if (char.props.perms.includes('pw')) char.onSet(() => { throw this.unavailable(); });
      }
    }
  }

  unavailable() { return new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }
  value(value) {
    const stale = Date.now() - this.lastRead > Math.max(120, Number(this.platform.config.staleAfter) || 900) * 1000;
    if (!this.online || stale || value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value))) throw this.unavailable();
    return value;
  }
  enabled(feature) { return !(this.settings.disabledFeatures || []).includes(feature); }

  service(Type, key, label) {
    const subtype = `nissan:${key}`;
    let service = this.accessory.getServiceById(Type, subtype);
    if (!service) service = this.accessory.addService(Type, `${this.name} ${label}`, subtype);
    service.displayName = `${this.name} ${label}`;
    service.setCharacteristic(this.C.Name, service.displayName);
    if (!service.testCharacteristic(this.C.ConfiguredName)) service.addOptionalCharacteristic(this.C.ConfiguredName);
    const configured = service.getCharacteristic(this.C.ConfiguredName);
    configured.updateValue(service.displayName);
    // Home normally stores user-facing names itself; ConfiguredName also supports other controllers.
    configured.onSet(value => {
      service.displayName = String(value).trim().slice(0, 64) || service.displayName;
      this.api.updatePlatformAccessories([this.accessory]);
    });
    this.services.set(subtype, { service, label });
    if (this.primary && service !== this.primary) this.primary.addLinkedService(service);
    return service;
  }

  bind(service, Type, getter, setter, { local = false, props } = {}) {
    const char = service.getCharacteristic(Type);
    if (props) {
      if (typeof char.value === 'number' && props.minValue !== undefined && char.value < props.minValue) char.updateValue(props.minValue);
      char.setProps(props);
    }
    const read = () => local ? getter() : this.value(getter());
    char.onGet(read);
    if (setter) char.onSet(setter);
    this.bindings.set(`${service.subtype}:${char.UUID}`, { char, read });
    return char;
  }

  custom(service, key, label, format = 'string', setter) {
    // UUID namespaces are immutable even when the npm package name changes.
    const uuid = this.hap.uuid.generate(`homebridge-nissan-connect:characteristic:${key}`);
    let char = service.characteristics.find(c => c.UUID === uuid);
    if (!char) {
      char = new this.C(label, uuid, { format, perms: setter ? ['pr', 'pw', 'ev'] : ['pr', 'ev'], ...(format === 'string' ? { maxLen: 256 } : {}) });
      service.addCharacteristic(char);
    }
    return char;
  }

  bindCustom(service, key, label, getter, { format = 'string', setter, local = false } = {}) {
    const char = this.custom(service, key, label, format, setter);
    const read = () => local ? getter() : this.value(getter());
    char.onGet(read);
    if (setter) char.onSet(setter);
    this.bindings.set(`${service.subtype}:${char.UUID}`, { char, read });
    return char;
  }

  buildCore() {
    const { S, C } = this;
    const lock = this.service(S.LockMechanism, 'lock', 'Doors');
    this.primary = lock;
    lock.setPrimaryService();
    lock.getCharacteristic(C.ConfiguredName).onSet(value => this.rename(value));
    this.bind(lock, C.LockCurrentState, () => {
      const state = locked(this.data?.status.doors?.overall_lock);
      return state === undefined ? C.LockCurrentState.UNKNOWN : state ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED;
    });
    this.bind(lock, C.LockTargetState, () => {
      const state = locked(this.data?.status.doors?.overall_lock);
      return state === undefined ? undefined : Number(state);
    }, value => this.enqueue(value === C.LockTargetState.SECURED ? 'lock' : 'unlock', {}, 'lock'));

    const battery = this.service(S.Battery, 'battery', 'Battery');
    this.bind(battery, C.BatteryLevel, () => this.data?.status.battery?.level);
    this.bind(battery, C.ChargingState, () => {
      const b = this.data?.status.battery;
      return typeof b?.is_charging === 'boolean' ? (b.is_charging ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING) : undefined;
    });
    this.bind(battery, C.StatusLowBattery, () => {
      const level = this.data?.status.battery?.level;
      return typeof level === 'number' ? Number(level <= (this.platform.config.lowBatteryThreshold ?? 20)) : undefined;
    });
    const charge = this.service(S.Outlet, 'charge', 'Charging');
    this.bind(charge, C.On, () => this.data?.status.battery?.is_charging,
      value => this.enqueue(value ? 'start_charge' : 'stop_charge', {}, 'charge'));
    this.bind(charge, C.OutletInUse, () => this.data?.status.battery?.is_charging);
    this.contact('plug', 'Charge Cable', () => {
      const plugged = this.data?.status.battery?.is_plugged_in;
      return typeof plugged === 'boolean' ? !plugged : undefined;
    });

    const climate = this.service(S.Thermostat, 'climate', 'Climate');
    this.bind(climate, C.CurrentTemperature, () => celsius(this.data?.status.climate?.temperature), undefined, { props: { minValue: -40, maxValue: 100 } });
    this.bind(climate, C.TargetTemperature, () => this.targetTemperature, value => {
      if (typeof value !== 'number' || value < 16 || value > 30) throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      // Off: change the next-start setpoint locally. On: adjust running climate.
      const running = active(this.data?.status.climate?.state);
      this.value(running);
      if (running) this.enqueue('adjust_climate', this.climateParams(value), 'climate');
      this.targetTemperature = value;
      this.accessory.context.targetTemperature = value;
      this.api.updatePlatformAccessories([this.accessory]);
    }, { local: true, props: { minValue: 16, maxValue: 30, minStep: 0.5 } });
    this.bind(climate, C.TargetHeatingCoolingState, () => {
      const running = active(this.data?.status.climate?.state);
      return running === undefined ? undefined : running ? C.TargetHeatingCoolingState.AUTO : C.TargetHeatingCoolingState.OFF;
    }, value => this.enqueue(value === C.TargetHeatingCoolingState.OFF ? 'stop_climate' : 'start_climate', this.climateParams(), 'climate'),
    { props: { validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.AUTO] } });
    this.bind(climate, C.CurrentHeatingCoolingState, () => {
      const state = String(this.data?.status.climate?.state ?? '').toUpperCase();
      if (['OFF', 'STOPPED', 'INACTIVE'].includes(state)) return C.CurrentHeatingCoolingState.OFF;
      if (['HEAT', 'HEATING'].includes(state)) return C.CurrentHeatingCoolingState.HEAT;
      if (['COOL', 'COOLING'].includes(state)) return C.CurrentHeatingCoolingState.COOL;
      // Nissan's ON alone does not identify heat versus cool. Do not invent one.
      return undefined;
    });
    this.bind(climate, C.TemperatureDisplayUnits, () => this.accessory.context.temperatureUnits ?? C.TemperatureDisplayUnits.CELSIUS, value => {
      this.accessory.context.temperatureUnits = value;
      this.api.updatePlatformAccessories([this.accessory]);
    }, { local: true });
    const fan = this.service(S.Fanv2, 'climate-power', 'Climate Power');
    this.bind(fan, C.Active, () => {
      const state = active(this.data?.status.climate?.state);
      return state === undefined ? undefined : Number(state);
    }, value => this.enqueue(value ? 'start_climate' : 'stop_climate', this.climateParams(), 'climate'));
    climate.addLinkedService(fan);

    for (const [action, label, Type, feature] of [
      ['flash', 'Flash Lights', S.Lightbulb, 'lights'], ['horn', 'Horn and Lights', S.Switch, 'horn'],
      ['refresh', 'Refresh Vehicle', S.Switch, 'refresh'], ['refresh_battery', 'Refresh Battery', S.Switch, 'refresh'],
      ['refresh_climate', 'Refresh Climate', S.Switch, 'refresh'], ['wake', 'Wake Vehicle', S.Switch, 'wake'],
      ['locate', 'Locate Vehicle', S.Switch, 'location'],
    ]) {
      if (action === 'locate' && !this.platform.config.includeLocation) continue;
      this.momentary(Type, action, label, feature);
    }

    const telemetryUUID = this.hap.uuid.generate('homebridge-nissan-connect:telemetry');
    this.details = this.accessory.services.find(s => s.UUID === telemetryUUID);
    if (!this.details) {
      this.details = new S(`${this.name} Vehicle Data`, telemetryUUID, 'nissan:telemetry');
      this.accessory.addService(this.details);
    }
    this.services.set('nissan:telemetry', { service: this.details, label: 'Vehicle Data' });
    this.primary.addLinkedService(this.details);
    this.bindCustom(this.details, 'vehicle-name', 'Vehicle Name', () => this.name, { local: true, setter: value => this.rename(value) });
    this.bindCustom(this.details, 'command-state', 'Last Command', () => this.commandState, { local: true });
    this.bindCustom(this.details, 'busy', 'Command In Progress', () => this.busy, { format: 'bool', local: true });
    this.bindCustom(this.details, 'fetched-at', 'API Read Time', () => this.data?.fetched_at);
    this.bindCustom(this.details, 'read-errors', 'Unavailable Data Sections', () => Object.keys(this.data?.errors || {}).join(', ') || 'None', { local: true });
    this.bindCustom(this.details, 'source', 'Data Source', () => 'Nissan cached telemetry; API read time is not vehicle observation time', { local: true });
    this.bindCustom(this.details, 'charge-limit-evidence', 'Charge Limit Availability', () => chargeSettingEvidence(this.data, 'charge_limit_percent'));
    this.bindCustom(this.details, 'charge-notification-evidence', 'Charge Notification Availability', () => chargeSettingEvidence(this.data, 'notification_threshold_percent'));
    for (const [type, label] of [
      ['REMOTE_DOOR_LOCK', 'Door Lock'], ['REMOTE_DOOR_UNLOCK', 'Door Unlock'],
      ['REMOTE_CHARGING', 'Remote Charging'], ['REMOTE_CLIMATE_CONTROL', 'Remote Climate'],
      ['REMOTE_BATTERY_STATUS', 'Battery Status'], ['MAINTENANCE_ALERT', 'Maintenance Alerts'],
      ['REMOTE_HORN_LIGHTS', 'Horn and Lights'], ['PARKED_CAR_FINDER', 'Parked Car Finder'],
    ]) {
      this.bindCustom(this.details, `eligibility-${type}`, `${label} Eligibility`, () => serviceEvidence(this.data, type));
    }
    const maintenanceUUID = this.hap.uuid.generate('homebridge-nissan-connect:maintenance');
    let maintenance = this.accessory.services.find(s => s.UUID === maintenanceUUID);
    if (!maintenance) {
      maintenance = new S(`${this.name} Maintenance`, maintenanceUUID, 'nissan:maintenance');
      this.accessory.addService(maintenance);
    }
    this.services.set('nissan:maintenance', { service: maintenance, label: 'Maintenance' });
    this.primary.addLinkedService(maintenance);
    this.bindCustom(maintenance, 'maintenance-evidence', 'Maintenance Availability', () => maintenanceEvidence(this.data));
    this.bindCustom(maintenance, 'maintenance-status', 'Next Service Status', () => maintenanceStatus(this.data?.maintenance));
    this.bindCustom(maintenance, 'maintenance-date', 'Next Service Date', () => this.data?.maintenance?.next_service_date);
    this.bindCustom(maintenance, 'maintenance-odometer', 'Next Service Odometer', () => this.data?.maintenance?.next_service_mileage, { format: 'float' });
    this.bindCustom(maintenance, 'maintenance-remaining', 'Distance Until Service', () => this.data?.maintenance?.remaining_service_mileage, { format: 'float' });
    this.bindCustom(maintenance, 'maintenance-unit', 'Service Distance Unit', () => this.data?.maintenance?.mileage_unit);
    this.bindCustom(maintenance, 'maintenance-months', 'Months Until Service (Nissan)', () => this.data?.maintenance?.remaining_service_months, { format: 'float' });
    this.bindCustom(this.details, 'command-fault', 'Command Failed or Unconfirmed', () => !!this.commandFault, { local: true, format: 'bool' });
    for (const [action, label] of [['edit_charge_schedule', 'Edit Charge Schedule'], ['edit_climate_schedule', 'Edit Climate Schedule'], ['delayed_climate', 'Schedule Delayed Climate']]) {
      this.bindCustom(this.details, action, label, () => '', { local: true, setter: value => {
        let params;
        try {
          params = JSON.parse(String(value));
          if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error();
          const operation = params.operation || 'create';
          if (!['create', 'update', 'delete'].includes(operation)) throw new Error();
          if (['update', 'delete'].includes(operation) && typeof params.id !== 'string') throw new Error();
          if (operation !== 'delete') {
            if (typeof params.start !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(params.start) || !Number.isFinite(Date.parse(params.start))) throw new Error();
            if (action === 'edit_charge_schedule' && !/^PT(?=\d)(?:\d+H)?(?:\d+M)?$/.test(params.duration || '')) throw new Error();
            if (action !== 'edit_charge_schedule' && (typeof params.temperature !== 'number' || params.temperature < 16 || params.temperature > 30)) throw new Error();
            if (action !== 'delayed_climate' && (!Array.isArray(params.days) || !params.days.length || params.days.some(day => !['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].includes(day)))) throw new Error();
          }
        } catch { throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST); }
        this.enqueue(action, params, 'schedules');
      } });
    }
  }

  contact(key, label, getter) {
    const service = this.service(this.S.ContactSensor, key, label);
    this.bind(service, this.C.ContactSensorState, () => {
      const value = getter();
      return value === undefined ? undefined : Number(value);
    });
    this.bind(service, this.C.StatusFault, () => this.online && !this.commandFault ? 0 : 1, undefined, { local: true });
  }

  momentary(Type, action, label, feature) {
    const service = this.service(Type, action, label);
    this.bind(service, this.C.On, () => this.busy && this.pendingAction === action,
      value => { if (value) this.enqueue(action, {}, feature); }, { local: true });
  }

  climateParams(temperature = this.targetTemperature, parameters) {
    return { temperature, parameters: parameters ?? this.data?.defaults?.parameters ?? undefined };
  }

  rename(value) {
    const name = String(value).trim();
    if (!name || name.length > 64) throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    this.name = name;
    this.accessory.context.vehicleName = name;
    this.accessory.displayName = name;
    for (const { service, label } of this.services.values()) {
      service.displayName = `${name} ${label}`;
      service.updateCharacteristic(this.C.Name, service.displayName);
      if (service.testCharacteristic(this.C.ConfiguredName)) service.updateCharacteristic(this.C.ConfiguredName, service.displayName);
    }
    this.api.updatePlatformAccessories([this.accessory]);
    this.publish();
  }

  telemetry(path, format = 'string') {
    if (this.customPaths.has(path)) return;
    // Store deterministic allocations, so adding data never changes existing IIDs.
    const saved = this.accessory.context.telemetry || [];
    let group = saved.find(spec => spec.path === path)?.group;
    if (group == null) {
      group = 0;
      while ([...this.telemetryGroups.values()].filter(g => g === group).length >= 80) group++;
    }
    this.telemetryGroups.set(path, group);
    const groupId = `nissan:telemetry-${group}`;
    let service = this.accessory.services.find(s => s.subtype === groupId);
    if (!service) {
      service = new this.S(`${this.name} Data ${group + 1}`, this.hap.uuid.generate(`homebridge-nissan-connect:telemetry:${group}`), groupId);
      this.accessory.addService(service);
    }
    this.services.set(groupId, { service, label: `Data ${group + 1}` });
    this.primary.addLinkedService(service);
    const label = path.replaceAll('_', ' ').replaceAll('.', ' / ');
    this.bindCustom(service, `telemetry:${path}`, label, () => {
      const value = this.flat?.[path];
      if (value === undefined) return undefined;
      return format === 'string' ? String(value).slice(0, 256) : value;
    }, { format });
    this.customPaths.set(path, format);
  }

  buildOptional() {
    const doors = this.data?.status.doors;
    for (const position of ['front_left', 'front_right', 'rear_left', 'rear_right']) {
      for (const field of ['ajar', 'window']) {
        if (doors?.[position]?.[field] == null) continue;
        this.contact(`${position}-${field}`, `${position.replaceAll('_', ' ')} ${field === 'ajar' ? 'Door' : 'Window'}`,
          () => opened(this.data?.status.doors?.[position]?.[field]));
      }
    }
    for (const [key, label] of [['engine_hood_ajar', 'Hood'], ['hatch_ajar', 'Hatch'], ['sunroof_ajar', 'Sunroof']]) {
      if (doors?.[key] != null) this.contact(key, label, () => opened(this.data?.status.doors?.[key]));
    }
    for (const kind of ['charge', 'climate']) {
      const schedules = kind === 'charge' ? this.data?.charge_schedules : this.data?.climate_schedules?.schedules;
      if (Array.isArray(schedules)) {
        const current = new Set(schedules.map(s => `nissan:${kind}-schedule-${s.id}`));
        for (const service of [...this.accessory.services]) {
          if (!service.subtype?.startsWith(`nissan:${kind}-schedule-`) || current.has(service.subtype)) continue;
          this.primary.removeLinkedService(service);
          this.accessory.removeService(service);
          this.services.delete(service.subtype);
          for (const key of this.bindings.keys()) if (key.startsWith(`${service.subtype}:`)) this.bindings.delete(key);
        }
      }
      for (const schedule of schedules || []) {
        const service = this.service(this.S.Switch, `${kind}-schedule-${schedule.id}`, `${kind} Schedule ${schedule.id}`);
        this.bind(service, this.C.On, () => {
          const latest = kind === 'charge' ? this.data?.charge_schedules : this.data?.climate_schedules?.schedules;
          return active(latest?.find(s => s.id === schedule.id)?.state);
        }, value => this.enqueue(`${kind}_schedule`, { id: schedule.id, enabled: value }, 'schedules'));
      }
    }
    for (const [field, key, label] of [['charge_limit_percent', 'charge_limit', 'Charge Limit Percent'], ['notification_threshold_percent', 'charge_notification', 'Charge Notification Percent']]) {
      if (this.data?.charge_config?.[field] == null) {
        // A successful null response retracts a previously advertised control.
        // A failed query keeps its identity but makes reads/writes unavailable.
        if (Object.hasOwn(this.data, 'charge_config') && !this.data.errors?.charge_config) {
          const uuid = this.hap.uuid.generate(`homebridge-nissan-connect:characteristic:${key}`);
          const previous = this.details.characteristics.find(c => c.UUID === uuid);
          if (previous) this.details.removeCharacteristic(previous);
          this.bindings.delete(`${this.details.subtype}:${uuid}`);
        }
        continue;
      }
      const char = this.bindCustom(this.details, key, label, () => this.data?.charge_config?.[field], {
        format: 'uint8', setter: percent => {
          this.value(this.data?.charge_config?.[field]);
          this.enqueue(key, { percent }, 'chargeSettings');
        },
      });
      char.setProps({ minValue: 1, maxValue: 100, minStep: 1 });
    }
    const parameters = this.data?.defaults?.parameters;
    for (const field of ['steering_wheel_heater', 'defrost_and_deicer']) {
      if (parameters?.[field] == null) continue;
      const service = this.service(this.S.Switch, field, `${field.replaceAll('_', ' ')} Setting`);
      this.bind(service, this.C.On, () => this.data?.defaults?.parameters?.[field], value => {
        const updated = { ...this.data?.defaults?.parameters, [field]: value };
        const running = this.value(active(this.data?.status.climate?.state));
        this.enqueue(running ? 'adjust_climate' : 'climate_defaults', this.climateParams(this.targetTemperature, updated), 'climate');
      });
    }
    for (const [seat, mode] of Object.entries(parameters?.seats || {})) {
      if (mode == null) continue;
      const seatKey = { front_driver: 'driver_seat', front_passenger: 'assistant_seat', rear_left: 'second_left_seat', rear_right: 'second_right_seat', rear_center: 'second_centre_seat', third_left: 'third_left_seat', third_right: 'third_right_seat' }[seat];
      const capability = this.data?.capabilities?.accessories_details?.seat_heater;
      if (capability?.enabled === false) continue;
      const supportsCooling = mode === 'COOL' || String(capability?.accessories?.[seatKey] || '').toUpperCase().includes('COOL');
      for (const target of supportsCooling ? ['HEAT', 'COOL'] : ['HEAT']) {
        const service = this.service(this.S.Switch, `seat-${seat}-${target}`, `${seat.replaceAll('_', ' ')} Seat ${target} Setting`);
        this.bind(service, this.C.On, () => {
          const current = this.data?.defaults?.parameters?.seats?.[seat];
          return ['HEAT', 'COOL', 'OFF'].includes(current) ? current === target : undefined;
        }, value => {
          const current = this.data?.defaults?.parameters;
          const updated = { ...current, seats: { ...current?.seats, [seat]: value ? target : 'OFF' } };
          const running = this.value(active(this.data?.status.climate?.state));
          this.enqueue(running ? 'adjust_climate' : 'climate_defaults', this.climateParams(this.targetTemperature, updated), 'climate');
        });
      }
    }
    if (this.data?.climate_schedules?.delayed_schedule?.start_date_time) this.momentary(this.S.Switch, 'cancel_delayed_climate', 'Cancel Delayed Climate', 'schedules');
    if (this.data.v2l?.minimum_charge_limit_percent != null) {
      const char = this.bindCustom(this.details, 'v2l-minimum', 'V2L Minimum Battery Percent', () => this.data?.v2l?.minimum_charge_limit_percent, {
        format: 'uint8', setter: percent => this.enqueue('v2l_minimum', { percent }, 'chargeSettings'),
      });
      char.setProps({ minValue: 1, maxValue: 100, minStep: 1 });
    }
    this.flat = flatten({ status: this.data.status, location: this.data.location, v2l: this.data.v2l, maintenance: this.data.maintenance,
      capabilities: this.data.capabilities, charge_config: this.data.charge_config,
      defaults: this.data.defaults, charge_schedules: this.data.charge_schedules,
      climate_schedules: this.data.climate_schedules });
    for (const [path, value] of Object.entries(this.flat)) this.telemetry(path, typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'float' : 'string');
    this.accessory.context.telemetry = [...this.customPaths].map(([path, format]) => ({ path, format, group: this.telemetryGroups.get(path) }));
    this.api.updatePlatformAccessories([this.accessory]);
  }

  publish() {
    for (const { char, read } of this.bindings.values()) {
      try { char.updateValue(read()); } catch { char.updateValue(this.unavailable()); }
    }
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        this.data = await this.platform.bridge.request('snapshot', { vin: this.vehicle.vin, location: !!this.platform.config.includeLocation });
        this.online = true;
        this.lastRead = Date.now();
        if (this.accessory.context.targetTemperature == null) {
          this.targetTemperature = celsius(this.data.defaults?.climate) ?? 22;
        }
        this.buildOptional();
        this.publish();
      } catch (error) {
        this.online = false;
        this.publish();
        this.platform.log.warn(`${this.name}: status unavailable (${error.message}).`);
      } finally { this.refreshPromise = null; }
    })();
    return this.refreshPromise;
  }

  enqueue(action, params, feature) {
    if (this.stopped || !this.enabled(feature) || this.platform.config.readOnly) throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    if (this.busy) throw new this.hap.HapStatusError(this.hap.HAPStatus.RESOURCE_BUSY);
    this.busy = true;
    this.pendingAction = action;
    this.commandFault = false;
    this.commandState = `${action}: queued`;
    this.publish();
    // HomeKit writes acknowledge queueing; remote completion is tracked independently.
    // Keeping this asynchronous avoids HomeKit's short write timeout, and never
    // changes observed lock/charge/climate state to an unconfirmed target.
    this.commandPromise = this.execute(action, params).finally(() => {
      this.busy = false;
      this.pendingAction = null;
      this.publish();
    });
    // HAP caches the submitted value after onSet returns; restore observed state.
    setImmediate(() => { if (!this.stopped) this.publish(); });
  }

  async execute(action, params) {
    try {
      if (this.refreshPromise) await this.refreshPromise;
      if (this.stopped) return;
      const submitted = await this.platform.bridge.request('command', { vin: this.vehicle.vin, action, params });
      this.commandState = `${action}: submitted`;
      this.publish();
      if (!submitted.complete) {
        const deadline = Date.now() + 240000;
        while (!this.stopped) {
          if (Date.now() >= deadline) throw new Error('completion unknown (timeout)');
          await new Promise(resolve => { this.pollResolve = resolve; this.commandTimer = setTimeout(resolve, 3000); });
          if (this.stopped) return;
          const result = await this.platform.bridge.request('command_status', { vin: this.vehicle.vin, request: submitted.request });
          if (result.terminal) {
            if (!result.success) throw new Error('Nissan reported command failure');
            break;
          }
        }
      }
      if (this.stopped) return;
      this.commandState = `${action}: succeeded`;
      this.platform.log.info(`${this.name}: ${action} succeeded.`);
      await this.refresh();
    } catch (error) {
      this.commandFault = true;
      this.commandState = `${action}: failed or unconfirmed`;
      this.platform.log.warn(`${this.name}: ${action} failed or unconfirmed (${error.message}). Not retried.`);
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.commandTimer);
    this.pollResolve?.();
  }
}
module.exports = { VehicleAccessory };
