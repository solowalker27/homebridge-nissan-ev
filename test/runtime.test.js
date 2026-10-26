'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { RuntimeManager, ASSETS } = require('../lib/runtime');

async function fixture(t, options = {}) {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'nissan-runtime-test-'));
  const progress = [];
  const runtime = new RuntimeManager(storage, { platform: 'linux', arch: 'arm64', onProgress: p => progress.push(p.message), ...options });
  t.after(async () => { runtime.stop(); await fs.rm(storage, { recursive: true, force: true }); });
  return { runtime, storage, progress };
}

test('automatic setup replaces an old system Python and installs all requirements in private storage', async t => {
  const { runtime, storage, progress } = await fixture(t);
  let pythonCreated = false; let ready = false; let downloads = 0;
  const commands = [];
  runtime.probe = async python => python === 'python3' ? { ready: false, pythonSupported: false, pythonVersion: '3.11.2' } : { ready, pythonSupported: pythonCreated };
  runtime.downloadUv = async (asset, hash) => {
    downloads++;
    assert.equal(asset, ASSETS['linux-arm64'][0]); assert.equal(hash.length, 64);
  };
  runtime.execute = async (command, args, options = {}) => {
    commands.push({ command, args, options });
    if (args[0] === '--version') return { code: 1 };
    assert.ok(command.startsWith(storage));
    assert.ok(options.env.UV_PYTHON_INSTALL_DIR.startsWith(storage));
    if (args[0] === 'venv') { pythonCreated = true; assert.ok(args.includes('3.13')); }
    if (args[0] === 'pip') { ready = true; assert.ok(args.at(-1).endsWith('requirements.txt')); }
    return { code: 0 };
  };
  const first = runtime.ensure('python3');
  assert.equal(runtime.ensure('python3'), first);
  assert.equal(await first, runtime.pythonPath);
  assert.equal(downloads, 1);
  assert.equal(commands.filter(c => c.args[0] === 'pip').length, 1);
  assert.ok(progress.some(p => p.includes('private Python')));
  const previous = commands.length;
  await runtime.ensure('python3');
  assert.equal(commands.length, previous);
});

test('a healthy configured runtime needs no downloads or installation', async t => {
  const { runtime } = await fixture(t);
  runtime.probe = async python => ({ ready: python === '/custom/python' });
  runtime.downloadUv = () => assert.fail('Unexpected download');
  assert.equal(await runtime.ensure('/custom/python'), '/custom/python');
});

test('two setup processes share a lock and install only once', async t => {
  const first = await fixture(t);
  let ready = false; let installs = 0; let releaseInstall;
  const installGate = new Promise(resolve => { releaseInstall = resolve; });
  let waiting = false;
  const progress = p => {
    if (p.message.includes('Another Homebridge')) { waiting = true; releaseInstall(); }
  };
  first.runtime.onProgress = progress;
  const second = new RuntimeManager(first.storage, { platform: 'linux', arch: 'arm64', onProgress: progress });
  t.after(() => second.stop());
  for (const runtime of [first.runtime, second]) {
    runtime.probe = async () => ({ ready, pythonSupported: true });
    runtime.downloadUv = async () => {};
    runtime.execute = async (_command, args) => {
      if (args[0] === 'pip') { installs++; await installGate; ready = true; }
      return { code: 0 };
    };
  }
  await Promise.all([first.runtime.ensure(), second.ensure()]);
  assert.equal(waiting, true);
  assert.equal(installs, 1);
});

test('download integrity is checked before extracting or executing a helper', async t => {
  const bytes = Buffer.from('tampered download');
  const { runtime } = await fixture(t, { fetchResource: async () => ({ ok: true, body: [bytes] }) });
  await fs.mkdir(runtime.data, { recursive: true });
  runtime.execute = () => assert.fail('Unverified content must never be executed');
  await assert.rejects(runtime.downloadUv('uv-example', '0'.repeat(64), runtime.data), /integrity check/);
});

test('failed setup releases its lock and can be retried', async t => {
  const { runtime } = await fixture(t);
  let ready = false; let attempts = 0;
  runtime.probe = async () => ({ ready, pythonSupported: true });
  runtime.execute = async (_command, args) => {
    if (args[0] === '--version') return { code: 1 };
    if (args[0] === 'pip') ready = true;
    return { code: 0 };
  };
  runtime.downloadUv = async () => { if (++attempts === 1) throw new Error('Network unavailable'); };
  await assert.rejects(runtime.ensure(), /Network unavailable/);
  assert.equal(await runtime.ensure(), runtime.pythonPath);
  assert.equal(attempts, 2);
});

test('unsupported platforms fail clearly before any download', async t => {
  const { runtime } = await fixture(t, { platform: 'win32', arch: 'x64' });
  runtime.probe = async () => ({ ready: false });
  runtime.downloadUv = () => assert.fail('Unexpected download');
  await assert.rejects(runtime.ensure(), /64-bit Linux and macOS/);
});

test('closing setup aborts its download and releases the setup lock', async t => {
  let reachedDownload;
  const started = new Promise(resolve => { reachedDownload = resolve; });
  const { runtime } = await fixture(t, { fetchResource: (_url, { signal }) => new Promise((_resolve, reject) => {
    reachedDownload();
    signal.addEventListener('abort', () => reject(new Error('Cancelled download')), { once: true });
  }) });
  runtime.probe = async () => ({ ready: false });
  runtime.execute = async () => ({ code: 1 });
  const setup = runtime.ensure();
  const rejection = assert.rejects(setup);
  await started;
  runtime.stop();
  await rejection;
  assert.equal(await require('proper-lockfile').check(runtime.data, { realpath: false }), false);
  await assert.rejects(runtime.ensure(), /Setup was closed/);
});
