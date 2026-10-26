'use strict';
const { AuthUi } = require('../lib/auth-ui');

// Dynamic import also supports the official UI helper's ESM builds.
async function main() {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');
  class NissanUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      const auth = new AuthUi(this.homebridgeStoragePath);
      for (const action of ['status', 'login', 'check']) {
        this.onRequest(`/auth/${action}`, async payload => {
          try { return await auth.request(action, payload); }
          catch (error) { throw new RequestError(error.message); }
        });
      }
      process.on('SIGTERM', () => { auth.stop(); process.exit(0); });
      this.ready();
    }
  }
  return new NissanUiServer();
}
main().catch(() => { console.error('Nissan settings could not start. Check the plugin installation.'); process.exit(1); });
