'use strict';
const path = require('node:path');
const { Adapter, safeError, vehicleLabels } = require('./adapter');
function failure(error) {
  if (error?.status === 401) return 'Nissan rejected this sign-in. Check your MyNISSAN credentials.';
  if (error?.status === 403) return 'Nissan denied access. Confirm your account works in MyNISSAN; additional verification may be required.';
  if (error?.code === 'ENOENT') return 'No saved sign-in was found. Sign in below.';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'Check that the Homebridge account can read and write the authentication file.';
  return 'Nissan could not complete the request. Check your connection and MyNISSAN account, then try again.';
}
class AuthUi {
  constructor(storagePath, { timeout = 90000, adapterFactory = file => new Adapter(file) } = {}) {
    this.storagePath = storagePath; this.timeout = timeout; this.adapterFactory = adapterFactory;
    this.adapters = new Set(); this.busy = false;
  }
  settings(config = {}) {
    const authFile = config.authFile || path.join(this.storagePath, 'nissan-connect', 'auth.json');
    if (typeof authFile !== 'string' || !path.isAbsolute(authFile) || authFile.includes('\0')) throw new Error('Set an absolute authentication file path.');
    return { authFile };
  }
  async request(action, payload = {}) {
    if (!['status', 'login', 'check'].includes(action)) throw new Error('Unknown sign-in action.');
    if (this.busy) throw new Error('A sign-in request is already running. Wait for it to finish.');
    const settings = this.settings(payload.config);
    if (action === 'login' && (typeof payload.email !== 'string' || !payload.email.trim() || payload.email.length > 320 || typeof payload.password !== 'string' || !payload.password || payload.password.length > 4096)) throw new Error('Enter your MyNISSAN email and password.');
    const adapter = this.adapterFactory(settings.authFile);
    this.busy = true;
    this.adapters.add(adapter);
    let timer;
    try {
      const work = action === 'login' ? adapter.authenticate(payload.email, payload.password) : action === 'status' ? adapter.status() : adapter.dispatch('vehicles').then(vehicles => ({ connected: true, verified: true, vehicles: vehicleLabels(vehicles) }));
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { adapter.close(); reject(new Error('The sign-in request timed out. Check connection status before trying again.')); }, this.timeout); });
      // Sanitize upstream errors, which may contain account details or tokens.
      const result = await Promise.race([work.catch(error => { throw new Error(failure(safeError(error))); }), timeout]);
      return { ...result, runtimeReady: true, settings };
    } finally { if (action === 'login') delete payload.password; clearTimeout(timer); adapter.close(); this.adapters.delete(adapter); this.busy = false; }
  }
  stop() { for (const adapter of this.adapters) adapter.close(); this.adapters.clear(); }
}
module.exports = { AuthUi, failure };
