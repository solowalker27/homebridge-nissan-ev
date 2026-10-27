'use strict';
(async () => {
  const ui = window.homebridge;
  const form = document.getElementById('nissan-signin');
  const email = document.getElementById('nissan-email');
  const password = document.getElementById('nissan-password');
  const passwordToggle = document.getElementById('nissan-password-toggle');
  const connect = document.getElementById('nissan-connect');
  const check = document.getElementById('nissan-check');
  const status = document.getElementById('nissan-status');
  let busy = false;
  function concealPassword() {
    password.type = 'password';
    passwordToggle.textContent = 'Show';
    passwordToggle.setAttribute('aria-label', 'Show password');
    passwordToggle.setAttribute('aria-pressed', 'false');
  }
  passwordToggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    passwordToggle.textContent = show ? 'Hide' : 'Show';
    passwordToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    passwordToggle.setAttribute('aria-pressed', String(show));
  });
  // Use the user-initiated paste event inside the plugin iframe. This also
  // handles WebKit's legacy text clipboard type without requesting clipboard access.
  password.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain') || event.clipboardData?.getData('text');
    if (!text) return; // Keep the browser's default behavior when clipboard data is unavailable.
    const start = password.selectionStart ?? password.value.length;
    const end = password.selectionEnd ?? start;
    const remaining = Math.max(0, password.maxLength - (password.value.length - (end - start)));
    password.setRangeText(text.slice(0, remaining), start, end, 'end');
    event.preventDefault();
    event.stopPropagation();
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
    delete blocks[0].pythonPath;
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
    // Capture credentials before an async settings read can race with paste/autofill.
    const credentials = action === 'login' ? { email: email.value.trim(), password: password.value } : null;
    if (credentials) {
      password.value = '';
      concealPassword();
    }
    busy = true;
    connect.disabled = check.disabled = true;
    ui.disableSaveButton();
    ui.hideSchemaForm();
    message(action === 'login' ? 'Signing in...' : 'Checking connection...');
    let payload;
    try {
      payload = { config: await config() };
      if (credentials) Object.assign(payload, credentials);
      const request = ui.request(`/auth/${action}`, payload);
      const result = await request;
      await retainSettings(result.settings);
      showResult(result);
    } catch (error) {
      message('Connection needs attention', error.message || 'Unable to connect. Check your connection and settings below.', 'error');
    } finally {
      if (payload) delete payload.password;
      if (credentials) delete credentials.password;
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
