'use strict';
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

class PythonBridge {
  constructor(config, log, spawnProcess = spawn) {
    this.config = config;
    this.log = log;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.queue = [];
    this.active = null;
    this.spawnProcess = spawnProcess;
  }

  start() {
    if (this.child) return;
    if (this.closed) throw new Error('Bridge is shut down');
    const child = this.spawnProcess(this.config.pythonPath || 'python3', [
      '-u', path.join(__dirname, '../python/nissan_bridge.py'), '--auth-file', this.config.authFile,
    ], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      this.active = null;
      if (message.error) {
        const error = new Error(`Nissan ${message.error.type || 'error'}${message.error.status ? ` (HTTP ${message.error.status})` : ''}`);
        error.status = message.error.status;
        request.reject(error);
      } else request.resolve(message.result);
      this.drain();
    });
    // Never forward raw stderr, which may contain external-library diagnostics.
    child.stderr.on('data', () => {});
    const fail = () => {
      if (this.child !== child) return;
      this.child = null;
      lines.close();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Nissan adapter stopped. Check Python, dependencies, and auth file permissions.'));
      }
      this.pending.clear();
      this.active = null;
      for (const request of this.queue.splice(0)) request.reject(new Error('Nissan adapter stopped; queued request cancelled.'));
    };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
  }

  request(method, args = {}) {
    try { this.start(); } catch (error) { return Promise.reject(error); }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.queue.push({ id, method, args, resolve, reject });
      this.drain();
    });
  }

  drain() {
    if (this.active || !this.child || this.closed) return;
    const request = this.queue.shift();
    if (!request) return;
    this.active = request;
    request.timer = setTimeout(() => {
      // Terminate the worker before a queued operation can execute after timeout.
      // A request already accepted by Nissan can still finish remotely; never replay it.
      this.child?.kill('SIGKILL');
    }, request.method === 'snapshot' ? 300000 : 45000);
    this.pending.set(request.id, request);
    this.child.stdin.write(JSON.stringify({ id: request.id, method: request.method, args: request.args }) + '\n');
  }

  stop() {
    this.closed = true;
    this.child?.kill();
    for (const request of this.queue.splice(0)) request.reject(new Error('Bridge is shut down'));
  }
}
module.exports = { PythonBridge };
