import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '../..')
// Exercise the real entrypoints without waiting 180s or overloading the host. Only the
// proof child is replaced; approval still opens its real, private temporary SQLite ledger.
function run(kind: 'executor' | 'approval', scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-fencing-diagnostics-'))
  const preload = join(dir, 'fault.mjs')
  writeFileSync(preload, `
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
const scenario = ${JSON.stringify(scenario)};
const originalSync = cp.spawnSync, originalSpawn = cp.spawn;
cp.spawnSync = (file, args, options) => {
  if (!args?.includes('--test')) return originalSync(file, args, options);
  console.error('injected-budget=' + options.timeout);
  return scenario === 'timeout'
    ? { error: Object.assign(new Error('proof deadline'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null }
    : { signal: null, status: 7 };
};
const originalTimer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 30000 ? 10 : ms, ...args);
cp.spawn = (file, args, options) => {
  if (!args?.at(-1)?.endsWith('/executor.mjs')) return originalSpawn(file, args, options);
  console.error('injected-stderr=' + options.stdio[2]);
  const child = new EventEmitter(); child.exitCode = null;
  let exited = false;
  const exit = (code, signal = null) => {
    if (exited) return;
    exited = true; child.exitCode = code; child.emit('exit', code, signal);
  };
  child.kill = signal => { queueMicrotask(() => exit(null, signal)); return true; };
  child.send = message => {
    if (message.type === 'go') {
      if (scenario === 'after-ready') queueMicrotask(() => exit(0));
      return;
    }
    queueMicrotask(() => {
      if (scenario === 'spawn-error') child.emit('error', Object.assign(new Error('fixture spawn failed'), { code: 'ENOENT' }));
      else if (scenario === 'nonzero') exit(17);
      else if (scenario === 'early-zero') exit(0);
      else child.emit('message', { type: 'ready' });
    });
  };
  return child;
};
syncBuiltinESMExports();
`)
  try {
    return spawnSync(process.execPath, ['--import', preload, '--import', 'tsx',
      join(root, `scripts/check-v5-system-${kind}-proofs.ts`)], {
      cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TMPDIR: dir },
      encoding: 'utf8', timeout: 20_000,
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

function details(kind: string, result: ReturnType<typeof run>) {
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /PASS/)
  const line = result.stderr.split('\n').find(s => s.startsWith(`[system-${kind}-proofs] FAIL `))
  assert.ok(line, result.stderr)
  return JSON.parse(line.slice(line.indexOf('{')))
}

for (const scenario of ['timeout', 'nonzero']) {
  test(`executor ${scenario} remains fatal with bounded budget and exit diagnostics`, () => {
    const result = run('executor', scenario)
    const info = details('executor', result)
    assert.match(result.stderr, /injected-budget=180000/)
    assert.equal(info.timeoutMs, 180_000)
    assert.ok(Number.isFinite(info.elapsedMs) && info.elapsedMs >= 0)
    assert.equal(info.status, scenario === 'timeout' ? null : 7)
    assert.equal(info.signal, scenario === 'timeout' ? 'SIGTERM' : null)
    assert.equal(info.code, scenario === 'timeout' ? 'ETIMEDOUT' : null)
  })
}

for (const scenario of ['nonzero', 'spawn-error', 'early-zero', 'after-ready', 'deadline']) {
  test(`approval ${scenario} fails closed with the worker lifecycle cause`, () => {
    const result = run('approval', scenario)
    const info = details('approval', result)
    assert.match(result.stderr, /injected-stderr=inherit/)
    assert.equal(info.mode, 'race')
    assert.equal(info.owner, 'proof-a')
    assert.equal(info.phase, ['after-ready', 'deadline'].includes(scenario) ? 'ready' : 'starting')
    assert.equal(info.status, scenario === 'nonzero' ? 17 : ['early-zero', 'after-ready'].includes(scenario) ? 0 : null)
    assert.equal(info.signal, scenario === 'deadline' ? 'SIGTERM' : null)
    assert.equal(info.code, scenario === 'spawn-error' ? 'ENOENT' : null)
    assert.equal(info.timedOut, scenario === 'deadline')
  })
}
