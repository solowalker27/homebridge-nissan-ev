'use strict';
const path = require('node:path');
const { PythonBridge } = require('./bridge');
const { VehicleAccessory } = require('./vehicle');
const PLUGIN = 'homebridge-nissan-ev';
// Preserve accessory identity from the initial local builds after the package rename.
const ACCESSORY_NAMESPACE = 'homebridge-nissan-connect';
const PLATFORM = 'NissanConnect';

class NissanPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.vehicles = new Map();
    this.stopped = false;
    this.config.includeLocation ??= true;
    this.config.authFile ||= path.join(api.user.storagePath(), 'nissan-connect', 'auth.json');
    this.bridge = new PythonBridge(this.config, log);
    api.on('didFinishLaunching', () => this.tick());
    api.on('shutdown', () => {
      this.stopped = true;
      clearTimeout(this.timer);
      for (const vehicle of this.vehicles.values()) vehicle.stop();
      this.bridge.stop();
    });
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
    // Until discovery succeeds, do not serve values serialized by a previous run.
    const { Characteristic: C, HapStatusError, HAPStatus } = this.api.hap;
    for (const service of accessory.services) {
      if (!service.subtype?.startsWith('nissan:')) continue;
      for (const char of service.characteristics) {
        if ([C.Name.UUID, C.ConfiguredName.UUID].includes(char.UUID)) continue;
        char.onGet(() => { throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE); });
        if (char.props.perms.includes('pw')) char.onSet(() => { throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE); });
      }
    }
  }

  async discover() {
    const vehicles = await this.bridge.request('vehicles');
    const disabled = new Set((this.config.vehicles || []).filter(v => v.enabled === false).map(v => v.vin));
    for (const [uuid, accessory] of this.cached) {
      if (disabled.has(accessory.context.vin)) {
        this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
        this.cached.delete(uuid);
      }
    }
    for (const vehicle of vehicles) {
      if (!(vehicle.model || '').toLowerCase().includes('ariya')) continue;
      const settings = (this.config.vehicles || []).find(v => v.vin === vehicle.vin) || {};
      if (settings.enabled === false) continue;
      const uuid = this.api.hap.uuid.generate(`${ACCESSORY_NAMESPACE}:${vehicle.vin}`);
      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      accessory ||= new this.api.platformAccessory(settings.name || vehicle.nickname || 'Ariya', uuid);
      const controller = new VehicleAccessory(this, accessory, vehicle, settings);
      this.vehicles.set(vehicle.vin, controller);
      this.cached.set(uuid, accessory);
      if (isNew) this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
      else this.api.updatePlatformAccessories([accessory]);
    }
    // Deliberately retain cached accessories on transient discovery failures or missing vehicles.
    if (!this.vehicles.size) this.log.warn('No enabled Ariya found. Check account enrollment and vehicle configuration.');
  }

  async tick() {
    if (this.stopped) return;
    try {
      if (!this.vehicles.size) await this.discover();
      for (const controller of this.vehicles.values()) {
        if (this.stopped) break;
        if (!controller.busy) await controller.refresh();
      }
    } catch (error) {
      this.log.error(error.message);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => this.tick(), Math.max(60, Number(this.config.pollInterval) || 300) * 1000);
    }
  }
}
module.exports = { NissanPlatform, PLUGIN, PLATFORM };
