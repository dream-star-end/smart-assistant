import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = process.env.V5_PREWARM_SOURCE_ROOT || root;
const deploy = readFileSync(join(sourceRoot, 'scripts/deploy-v5-selfhost.sh'), 'utf8');
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const fn = (name) => {
  const found = deploy.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, 'm'));
  assert.ok(found, name);
  return found[0];
};
const optionalFn = (name) => deploy.includes(`${name}() {`) ? fn(name) : '';
const trapLines = deploy.split('\n').filter((line) => /^trap /.test(line)).join('\n');
const summaryName = 'tr-prewarm-regression.summary.json';
const fakeNode = [
  "const { appendFileSync, writeFileSync } = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "const { join } = require('node:path');",
  "const dir = process.env.FIXTURE;",
  "const event = (s) => appendFileSync(join(dir, 'events'), s + '\\n');",
  "const file = process.argv[2] || '';",
  "if (!file.split('/').pop().includes('prewarm')) { event(file.split('/').pop()); process.exit(0); }",
  "event('prewarm-start');",
  "writeFileSync(join(dir, 'node.pid'), String(process.pid));",
  "if (process.env.MODE_TEST === 'success') {",
  "  setTimeout(() => { event('prewarm-done'); process.exit(0); }, 150);",
  "} else if (process.env.MODE_TEST === 'fail') { process.exit(1); } else {",
  "  const chrome = \"const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000);\";",
  "  const child = spawn(process.execPath, ['-e', chrome, join(dir, 'chrome.pid')], { detached: true, stdio: 'ignore' });",
  "  child.unref();",
  "  process.on('SIGTERM', () => {});",
  "  setInterval(() => {}, 1000);",
  "}",
].join('\n');

function fixture(t, mode = 'block') {
  const dir = mkdtempSync(join(tmpdir(), 'oc-prewarm-test-'));
  for (const sub of ['bin', 'tmp', 'summary']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, 'password'), 'synthetic-only\n');
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
  // The fake node never loads the real browser, login or model code.
  writeFileSync(join(dir, 'bin/node'), `#!${process.execPath}\n${fakeNode}`, { mode: 0o755 });
  const source = [
    'set -Eeuo pipefail',
    `MODE=deploy; DRY=0; SCRIPT_DIR=${q(join(sourceRoot, 'scripts'))}`,
    'USER_CONTRACT_PREWARM_PID=""',
    `source ${q(join(sourceRoot, 'scripts/lib/v5-selfhost-train-summary.sh'))}`,
    optionalFn('user_contract_prewarm'),
    optionalFn('user_contract_prewarm_cleanup'),
    fn('cleanup_selfhost_deploy'),
    fn('user_contract_gate').replace('/etc/openclaude/selfhost-canary.password', join(dir, 'password')),
    'reap_master_build_jobs() { :; }',
    'release_policy_enabled() { return 1; }',
    'release_policy_abort_unexposed() { :; }',
    'master_gate_load_budget_stop() { :; }',
    'lease_train_on_exit() { printf "lease:%s\\n" "$1" >>"$FIXTURE/events"; }',
    'cleanup_master_staging() { :; }',
    'cleanup_cutover_unit_snap() { :; }',
    'p0web_cleanup_build() { :; }',
    'V5_PORT=1; LEASE_TRAIN_ID=tr-prewarm-regression',
    trapLines,
    'tsum_init',
    'user_contract_gate || exit $?',
    'printf "gate-done\\n" >>"$FIXTURE/events"',
    'tsum_mark G',
  ].join('\n');
  let output = '';
  const p = spawn('/bin/bash', ['-c', source], {
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      TMPDIR: join(dir, 'tmp'), FIXTURE: dir, MODE_TEST: mode,
      OC_V5_TRAIN_SUMMARY_DIR: join(dir, 'summary') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (b) => { output += b; });
  p.stderr.on('data', (b) => { output += b; });
  const done = new Promise((resolve) => p.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    // Only this fixture's synthetic PIDs are ever signalled.
    for (const name of ['node.pid', 'chrome.pid']) {
      const path = join(dir, name);
      if (existsSync(path)) {
        try { process.kill(Number(readFileSync(path, 'utf8')), 'SIGKILL'); } catch {}
      }
    }
    try { p.kill('SIGKILL'); } catch {}
    await done;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, p, done, output: () => output };
}

async function until(predicate, limit = 12_000) {
  const end = Date.now() + limit;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'timed out waiting for fixture condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function pid(f, name) { return Number(readFileSync(join(f.dir, `${name}.pid`), 'utf8')); }
function gone(value) {
  try { process.kill(value, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}
function summary(f) { return JSON.parse(readFileSync(join(f.dir, 'summary', summaryName), 'utf8')); }
function events(f) { return readFileSync(join(f.dir, 'events'), 'utf8'); }
async function bounded(f) {
  return Promise.race([f.done, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`deploy did not finish: ${f.output()}`)), 12_000);
    timer.unref();
  })]);
}
async function ready(f) {
  await until(() => { if (f.p.exitCode !== null) throw new Error(f.output()); return existsSync(join(f.dir, 'chrome.pid')); });
  assert.equal(summary(f).phases.at(-1).id, 'F.prewarm');
  assert.equal(summary(f).final, false);
}
async function drained(f) {
  await until(() => gone(pid(f, 'node')) && gone(pid(f, 'chrome')));
}
function failed(f, code) {
  assert.equal(summary(f).result, 'failed');
  assert.equal(summary(f).exitCode, code);
  assert.equal(summary(f).failedPhase, 'F.prewarm');
  assert.equal(summary(f).final, true);
  assert.doesNotMatch(events(f), /smoke|go-cache|stop-before-start|gate-done/);
  assert.match(events(f), new RegExp(`lease:${code}`));
}

test('successful prewarm is awaited before all three contract checks', { timeout: 15_000 }, async (t) => {
  const f = fixture(t, 'success');
  assert.deepEqual(await bounded(f), { code: 0, signal: null }, f.output());
  assert.match(events(f), /prewarm-start\nprewarm-done\nv5-user-contract-smoke.mjs\nv5-go-cache-contract.mjs\nv5-stop-before-start-contract.mjs\ngate-done\nlease:0/);
  assert.equal(summary(f).result, 'success');
});

test('prewarm exit 1 fails F.prewarm before any paid gate', { timeout: 15_000 }, async (t) => {
  const f = fixture(t, 'fail');
  assert.deepEqual(await bounded(f), { code: 1, signal: null });
  failed(f, 1);
});

test('SIGKILL of prewarm Node fails and reaps a detached TERM-resistant Chrome', { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  await ready(f);
  process.kill(pid(f, 'node'), 'SIGKILL');
  assert.deepEqual(await bounded(f), { code: 137, signal: null });
  failed(f, 137);
  await drained(f);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
  test(`${signal} of deploy records failure only after the prewarm tree is reaped`, { timeout: 20_000 }, async (t) => {
    const f = fixture(t);
    await ready(f);
    f.p.kill(signal);
    setTimeout(() => { try { f.p.kill('SIGTERM'); } catch {} }, 100).unref();
    assert.deepEqual(await bounded(f), { code, signal: null });
    await drained(f);
    failed(f, code);
  });
}

test('SIGKILL of deploy leaves an unfinished summary and the supervisor drains its tree', { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  await ready(f);
  f.p.kill('SIGKILL');
  assert.deepEqual(await bounded(f), { code: null, signal: 'SIGKILL' });
  await drained(f);
  assert.equal(summary(f).final, false);
  assert.equal(summary(f).result, 'running');
  assert.equal(summary(f).phases.at(-1).id, 'F.prewarm');
});

test('SIGKILL of the supervisor still fails the gate (cgroup cleanup remains a separate boundary)', { timeout: 15_000 }, async (t) => {
  const f = fixture(t);
  await ready(f);
  const childFile = `/proc/${f.p.pid}/task/${f.p.pid}/children`;
  const owned = readFileSync(childFile, 'utf8').trim().split(/\s+/).map(Number);
  assert.equal(owned.length, 1);
  assert.match(readFileSync(`/proc/${owned[0]}/comm`, 'utf8'), /python3/);
  process.kill(owned[0], 'SIGKILL');
  assert.deepEqual(await bounded(f), { code: 137, signal: null });
  failed(f, 137);
  // A SIGKILLed supervisor cannot run cleanup. The fixture's after hook owns
  // these synthetic processes; production needs cgroup-level final cleanup.
});
