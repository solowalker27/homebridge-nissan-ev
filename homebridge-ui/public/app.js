'use strict';
(async () => {
  const ui = window.homebridge;
  const form = document.getElementById('nissan-signin');
  const email = document.getElementById('nissan-email');
  const password = document.getElementById('nissan-password');
  const connect = document.getElementById('nissan-connect');
  const check = document.getElementById('nissan-check');
  const status = document.getElementById('nissan-status');
  let busy = false;
  function message(title, detail = '', state = '') {
    document.getElementById('nissan-status-title').textContent = title;
    document.getElementById('nissan-status-detail').textContent = detail;
    status.dataset.state = state;
  }
  async function config() {
    const blocks = await ui.getPluginConfig();
    return blocks[0] || { platform: 'NissanConnect', name: 'Nissan EV', readOnly: true };
  }
  async function retainSettings(settings) {
    const blocks = await ui.getPluginConfig();
    blocks[0] = { ...(blocks[0] || { platform: 'NissanConnect', name: 'Nissan EV', readOnly: true }), ...settings };
    await ui.updatePluginConfig(blocks);
  }
  function showResult(result) {
    if (result.verified) {
      const vehicles = (result.vehicles || []).map(v => `${v.year || ''} ${v.model || 'Ariya'} - VIN ending ${v.vinSuffix}`).join('; ');
      message('Connected to Nissan', vehicles || 'Signed in successfully. No Ariya was found on this account.', 'connected');
      connect.textContent = 'Sign in again';
    } else if (result.connected) {
      message('Saved sign-in found', 'Use Check connection to verify that Nissan still accepts this session.');
      connect.textContent = 'Sign in again';
    } else message('Sign in to connect your Ariya');
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    connect.disabled = check.disabled = true;
    ui.disableSaveButton();
    ui.hideSchemaForm();
    message(action === 'login' ? 'Signing in...' : 'Checking connection...');
    let payload;
    try {
      payload = { config: await config() };
      if (action === 'login') {
        payload.email = email.value.trim();
        payload.password = password.value;
      }
      const request = ui.request(`/auth/${action}`, payload);
      password.value = '';
      const result = await request;
      await retainSettings(result.settings);
      showResult(result);
    } catch (error) {
      password.value = '';
      message('Connection needs attention', error.message || 'Unable to connect. Check the runtime and connection settings below.', 'error');
    } finally {
      if (payload) delete payload.password;
      busy = false;
      connect.disabled = check.disabled = false;
      ui.enableSaveButton();
      ui.showSchemaForm();
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void run('login'); });
  check.addEventListener('click', () => { void run('check'); });
  try {
    await run('status');
    ui.showSchemaForm();
  } catch {
    message('Settings could not load', 'Close and reopen the plugin settings.', 'error');
  }
})();
