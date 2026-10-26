'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const lockfile = require('proper-lockfile');
const { setTimeout: delay } = require('node:timers/promises');

const UV_VERSION = '0.13.5';
// SHA-256 digests from Astral's official release assets; verify before execution.
const ASSETS = {
  'darwin-arm64': ['uv-aarch64-apple-darwin', '743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73'],
  'darwin-x64': ['uv-x86_64-apple-darwin', 'b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66'],
  'linux-arm64': ['uv-aarch64-unknown-linux-musl', '7906c79adb21c81abd559841ba76bb1d9af9d791acac7a041b2972e03ae16538'],
  'linux-x64': ['uv-x86_64-unknown-linux-musl', '57ef9d9ccb01fb1bd998df995b0dd221b52f7d7841fbea93f2d4463bf61fb7a9'],
};

class RuntimeManager {
  constructor(storagePath, { onProgress = () => {}, spawnProcess = spawn, fetchResource = fetch,
    platform = process.platform, arch = process.arch } = {}) {
    this.data = path.join(storagePath, 'nissan-connect');
    this.pythonPath = path.join(this.data, 'venv', 'bin', 'python');
    this.onProgress = onProgress;
    this.spawnProcess = spawnProcess;
    this.fetchResource = fetchResource;
    this.platform = platform;
    this.arch = arch;
    this.children = new Set();
    this.closed = false;
    this.download = null;
    this.pending = null;
    this.lifecycle = new AbortController();
  }

  progress(message) {
    if (!this.closed) this.onProgress({ message });
  }

  execute(command, args, { timeout = 300000, env = process.env } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Setup was closed. Reopen settings to continue.')); return; }
      let child;
      let stdout = '';
      let finished = false;
      let timer;
      const finish = (error, code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (error) reject(error);
        else resolve({ code, stdout });
      };
      try { child = this.spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env }); }
      catch { finish(new Error('Could not start the connection runtime.')); return; }
      this.children.add(child);
      timer = setTimeout(() => {
        finish(new Error('Connection setup timed out. Check the Homebridge host internet connection and retry.'));
        child.kill('SIGKILL');
      }, timeout);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 65536) {
          finish(new Error('Connection setup returned an invalid response.'));
          child.kill('SIGKILL');
        }
      });
      // Dependency installers may print host paths, proxy credentials, or diagnostics.
      child.stderr.on('data', () => {});
      child.on('error', () => finish(new Error('Could not start the connection runtime.')));
      child.on('close', code => finish(null, code));
    });
  }

  async probe(pythonPath) {
    if (!pythonPath || this.closed) return { ready: false, reason: 'not-installed' };
    try {
      const result = await this.execute(pythonPath, ['-I', path.join(__dirname, '../python/runtime_check.py')], { timeout: 15000 });
      if (result.code !== 0) return { ready: false, reason: 'dependencies' };
      return JSON.parse(result.stdout);
    } catch { return { ready: false, reason: 'not-installed' }; }
  }

  async downloadUv(asset, digest, tools) {
    const archive = path.join(this.data, `uv-${UV_VERSION}.tar.gz`);
    this.progress('Downloading the Nissan connection helper...');
    this.download = new AbortController();
    const deadline = setTimeout(() => this.download?.abort(), 120000);
    try {
      const response = await this.fetchResource(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}.tar.gz`, { signal: this.download.signal });
      if (!response.ok) throw new Error('download');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error('size');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      if (createHash('sha256').update(bytes).digest('hex') !== digest) {
        throw new Error('The connection helper download failed its integrity check. Retry setup.');
      }
      await fs.writeFile(archive, bytes, { mode: 0o600 });
      const extracted = await this.execute('tar', ['-xzf', archive, '--strip-components=1', '-C', tools], { timeout: 30000 });
      if (extracted.code !== 0) throw new Error('extract');
      await fs.chmod(path.join(tools, 'uv'), 0o700);
    } catch (error) {
      if (error.message?.includes('integrity check')) throw error;
      throw new Error('Could not download the connection helper. Allow the Homebridge host to reach GitHub, then retry setup.');
    } finally {
      clearTimeout(deadline);
      this.download = null;
      await fs.unlink(archive).catch(() => {});
    }
  }

  ensure(configuredPython) {
    if (this.pending) return this.pending;
    this.pending = this.prepare(configuredPython).finally(() => { this.pending = null; });
    return this.pending;
  }

  async prepare(configuredPython) {
    if (this.closed) throw new Error('Setup was closed. Reopen settings to continue.');
    this.progress('Checking the Nissan connection runtime...');
    if (configuredPython && configuredPython !== this.pythonPath && (await this.probe(configuredPython)).ready) return configuredPython;
    if ((await this.probe(this.pythonPath)).ready) return this.pythonPath;
    const asset = ASSETS[`${this.platform}-${this.arch}`];
    if (!asset) throw new Error('Automatic setup supports 64-bit Linux and macOS on Intel or ARM. This host is not supported.');
    await fs.mkdir(this.data, { recursive: true, mode: 0o700 });
    this.progress('Preparing the Nissan connection runtime...');
    let release;
    try {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (this.closed) throw new Error('Setup was closed. Reopen settings to continue.');
        try {
          release = await lockfile.lock(this.data, { realpath: false, stale: 120000, update: 15000, retries: 0 });
          break;
        } catch (error) {
          if (error.code !== 'ELOCKED') throw new Error('Homebridge cannot write its connection data directory. Check the host storage permissions.');
          if (attempt === 0) this.progress('Another Homebridge process is preparing the connection. Waiting for it to finish...');
          await delay(1000, undefined, { signal: this.lifecycle.signal });
        }
      }
      if (!release) throw new Error('Another connection setup is still running. Wait a moment and reopen settings.');
      if (this.closed) throw new Error('Setup was closed. Reopen settings to continue.');
      // Another Homebridge process may have completed setup while this one waited.
      if ((await this.probe(this.pythonPath)).ready) return this.pythonPath;
      const tools = path.join(this.data, 'tools', `uv-${UV_VERSION}`);
      await fs.mkdir(tools, { recursive: true, mode: 0o700 });
      const uv = path.join(tools, 'uv');
      let installed = false;
      try { installed = (await this.execute(uv, ['--version'], { timeout: 10000 })).code === 0; } catch {}
      if (!installed) await this.downloadUv(...asset, tools);
      const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(this.data, 'python'),
        UV_CACHE_DIR: path.join(this.data, 'cache'), UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_PROGRESS: '1' };
      const existing = await this.probe(this.pythonPath);
      if (!existing.pythonSupported) {
        this.progress('Installing a private Python runtime. This may take a few minutes...');
        const created = await this.execute(uv, ['venv', '--clear', '--python', '3.13', path.join(this.data, 'venv')], { env });
        if (created.code !== 0) throw new Error('Could not install the private Python runtime. Check Homebridge internet access and available disk space, then retry setup.');
      }
      this.progress('Installing the Nissan connection dependencies...');
      const installedDeps = await this.execute(uv, ['pip', 'install', '--python', this.pythonPath, '-r', path.join(__dirname, '../requirements.txt')], { env });
      if (installedDeps.code !== 0) throw new Error('Could not install Nissan dependencies. Allow the Homebridge host to reach PyPI and files.pythonhosted.org, then retry setup.');
      if (!(await this.probe(this.pythonPath)).ready) throw new Error('The Nissan connection runtime did not pass its dependency check. Retry setup.');
      this.progress('Nissan connection runtime is ready.');
      return this.pythonPath;
    } finally {
      if (release) await release();
    }
  }

  stop() {
    this.closed = true;
    this.lifecycle.abort();
    this.download?.abort();
    for (const child of this.children) child.kill('SIGKILL');
  }
}
module.exports = { RuntimeManager, UV_VERSION, ASSETS };
