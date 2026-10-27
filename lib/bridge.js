'use strict';
const { Adapter, safeError } = require('./adapter');
class NissanBridge {
  constructor(config, log, adapterFactory = () => new Adapter(config.authFile)) {
    this.config = config; this.log = log; this.adapterFactory = adapterFactory; this.adapter = null;
    this.queue = []; this.active = null; this.closed = false;
  }
  request(method, args = {}) {
    if (this.closed) return Promise.reject(new Error('Nissan connection is shut down'));
    if (method === 'command' && this.config.readOnly) return Promise.reject(new Error('Remote commands are disabled'));
    return new Promise((resolve, reject) => { this.queue.push({ method, args, resolve, reject }); this.drain(); });
  }
  drain() {
    if (this.active || this.closed) return;
    const request = this.queue.shift();
    if (!request) return;
    this.active = request;
    this.adapter ||= this.adapterFactory();
    const adapter = this.adapter;
    const timer = setTimeout(() => {
      // An accepted remote request can still finish. Never replay a timed-out write.
      this.terminate('Nissan request timed out; check vehicle status before retrying.');
    }, request.method === 'snapshot' ? 300000 : 45000);
    Promise.resolve().then(() => adapter.dispatch(request.method, request.args)).then(result => {
      if (this.active === request && !this.closed) request.resolve(result);
    }, error => {
      if (this.active === request && !this.closed) {
        const safe = safeError(error);
        const failure = new Error(`Nissan ${safe.type}${safe.status ? ` (HTTP ${safe.status})` : ''}`);
        failure.status = safe.status;
        request.reject(failure);
      }
    }).finally(() => { clearTimeout(timer); if (this.active === request) this.active = null; this.drain(); });
  }
  stop(message = 'Nissan connection is shut down') {
    this.closed = true; this.terminate(message);
  }
  terminate(message) {
    this.adapter?.close(); this.adapter = null;
    if (this.active) this.active.reject(new Error(message));
    this.active = null;
    for (const request of this.queue.splice(0)) request.reject(new Error(message));
  }
}
module.exports = { NissanBridge };
