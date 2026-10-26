'use strict';
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

function failure(error) {
  const type = error?.type;
  if (type === 'AuthBusyError') return 'The plugin is using this session. Wait a moment, then try again.';
  if (error?.status === 401) return 'Nissan rejected this sign-in. Check your MyNISSAN credentials.';
  if (error?.status === 403) return 'Nissan denied access. Confirm your account works in MyNISSAN; additional verification may be required.';
  if (type === 'FileNotFoundError') return 'No saved sign-in was found. Sign in below.';
  if (['PermissionError', 'ValueError'].includes(type)) return 'Check the authentication file permissions and settings. The file must be readable and writable only by the Homebridge account.';
  return 'Nissan could not complete the request. Check your connection and MyNISSAN account, then try again.';
}

class AuthUi {
  constructor(storagePath, { spawnProcess = spawn, exists = existsSync, timeout = 90000 } = {}) {
    this.storagePath = storagePath;
    this.spawnProcess = spawnProcess;
    this.exists = exists;
    this.timeout = timeout;
    this.children = new Set();
    this.busy = false;
  }

  settings(config = {}) {
    const data = path.join(this.storagePath, 'nissan-connect');
    const bundledPython = path.join(data, 'venv', 'bin', 'python');
    const pythonPath = config.pythonPath || (this.exists(bundledPython) ? bundledPython : 'python3');
    const authFile = config.authFile || path.join(data, 'auth.json');
    if (typeof pythonPath !== 'string' || !pythonPath || pythonPath.includes('\0') ||
        typeof authFile !== 'string' || !path.isAbsolute(authFile) || authFile.includes('\0')) {
      throw new Error('Set a valid Python executable and an absolute authentication file path.');
    }
    return { pythonPath, authFile };
  }

  async request(action, payload = {}) {
    if (!['status', 'login', 'check'].includes(action)) throw new Error('Unknown sign-in action.');
    if (this.busy) throw new Error('A sign-in request is already running. Wait for it to finish.');
    const settings = this.settings(payload.config);
    const input = { action };
    if (action === 'login') {
      if (typeof payload.email !== 'string' || !payload.email.trim() || payload.email.length > 320 ||
          typeof payload.password !== 'string' || !payload.password || payload.password.length > 4096) {
        throw new Error('Enter your MyNISSAN email and password.');
      }
      input.email = payload.email.trim();
      input.password = payload.password;
    }
    this.busy = true;
    try {
      const result = await this.run(settings, input);
      return { ...result, runtimeReady: true, settings };
    } finally {
      delete input.password;
      this.busy = false;
    }
  }

  run(settings, input) {
    return new Promise((resolve, reject) => {
      let child;
      let output = '';
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (error) reject(new Error(error));
        else resolve(value);
      };
      const runtimeError = 'Python is not ready. Install Python 3.12+ and the plugin requirements inside the Homebridge host, then check Python executable in settings.';
      try {
        child = this.spawnProcess(settings.pythonPath, [
          '-u', path.join(__dirname, '../python/nissan_bridge.py'), '--ui', '--auth-file', settings.authFile,
        ], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      } catch { finish(runtimeError); return; }
      this.children.add(child);
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish('The sign-in request timed out. Check connection status before trying again.');
      }, this.timeout);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.length > 65536) {
          child.kill('SIGKILL');
          finish('The sign-in helper returned an invalid response.');
        }
      });
      // Upstream diagnostics can contain credentials or tokens. Never relay stderr.
      child.stderr.on('data', () => {});
      child.on('error', () => finish(runtimeError));
      child.stdin.on('error', () => finish(runtimeError));
      child.on('close', () => {
        if (settled) return;
        let response;
        try { response = JSON.parse(output); } catch { finish(runtimeError); return; }
        if (response.error) finish(failure(response.error));
        else if (response.result && typeof response.result.connected === 'boolean') finish(null, response.result);
        else finish('The sign-in helper returned an invalid response.');
      });
      // Credentials travel through the private pipe, never process arguments or config.
      child.stdin.end(JSON.stringify(input) + '\n');
    });
  }

  stop() {
    for (const child of this.children) child.kill('SIGKILL');
    this.children.clear();
  }
}
module.exports = { AuthUi, failure };
