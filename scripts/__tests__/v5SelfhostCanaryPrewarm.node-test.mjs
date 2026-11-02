import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = process.env.V5_PREWARM_SOURCE_ROOT || root;
const deploy = readFileSync(join(sourceRoot, 'scripts/deploy-v5-selfhost.sh'), 'utf8');
// Old-source diagnostics still exercise the old gate/supervisor. Supply only
// the new fixture's selector dependency if that historical tree predates it.
const sourceModelPolicy = join(sourceRoot, 'scripts/lib/v5-selfhost-model-policy.sh');
const modelPolicyLib = existsSync(sourceModelPolicy) ? sourceModelPolicy : join(root, 'scripts/lib/v5-selfhost-model-policy.sh');
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
  "const { spawn, spawnSync } = require('node:child_process');",
  "const { join } = require('node:path');",
  "const dir = process.env.FIXTURE;",
  "const event = (s) => appendFileSync(join(dir, 'events'), s + '\\n');",
  "const file = process.argv[2] || '';",
  // The real generation selector validates JSON through `command node -e`.
  // Delegate that to the actual runtime; do not count validation as a paid gate.
  "if (file.startsWith('-')) { const result = spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit' }); process.exit(result.status ?? 1); }",
  "appendFileSync(join(dir, 'selected.jsonl'), JSON.stringify({ entry: file, models: process.env.V5_CONTRACT_MODELS ?? null, policy: process.env.V5_SELFHOST_MODEL_POLICY_FILE ?? null }) + '\\n');",
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

function fixture(t, mode = 'block', generation = 'current') {
  const dir = mkdtempSync(join(tmpdir(), 'oc-prewarm-test-'));
  for (const sub of ['bin', 'tmp', 'summary']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, 'password'), 'synthetic-only\n');
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
  const candidate = join(dir, 'release');
  const sha = 'a'.repeat(40);
  mkdirSync(candidate);
  if (generation === 'current') {
    for (const relative of ['deploy/v5-selfhost/model-availability.json', 'scripts/lib/selfhost-model-policy.mjs', 'packages/commercial/src/billing/modelAvailability.ts']) {
      const target = join(candidate, relative);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, readFileSync(join(root, relative)));
    }
    writeFileSync(join(candidate, '.complete'), JSON.stringify({ sourceCommit: sha, modelAvailabilityPolicyGeneration: 1 }));
  } else {
    mkdirSync(join(candidate, 'scripts'));
    const digest = createHash('sha256');
    for (const name of ['v5-user-contract-prewarm.mjs', 'v5-user-contract-smoke.mjs']) {
      const contents = `// private legacy lifecycle fixture: ${name}\n`;
      writeFileSync(join(candidate, 'scripts', name), contents);
      digest.update(contents);
    }
    writeFileSync(join(candidate, '.complete'), JSON.stringify({ sourceCommit: sha, artifactSha256: digest.digest('hex') }));
  }
  // The fake node never loads the real browser, login or model code.
  writeFileSync(join(dir, 'bin/node'), `#!${process.execPath}\n${fakeNode}`, { mode: 0o755 });
  const source = [
    'set -Eeuo pipefail',
    `MODE=deploy; DRY=0; SCRIPT_DIR=${q(join(sourceRoot, 'scripts'))}`,
    'USER_CONTRACT_PREWARM_PID=""',
    `source ${q(join(sourceRoot, 'scripts/lib/v5-selfhost-train-summary.sh'))}`,
    `source ${q(modelPolicyLib)}`,
    optionalFn('user_contract_node'),
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
    `CUTOVER_ROLLBACK=${generation === 'current' ? 0 : 1}; ROLLBACK_MASTER=${q(candidate)}; ROLLBACK_SHA=${q(sha)}`,
    // Only the filesystem/ownership effect is adapted for this private non-root
    // fixture. The real selector still checks recovery context and source SHA;
    // this adapter also rejects changed child bytes or the wrong pinned target.
    `assert_master_release_static_gate() {
      [[ "$1" == ${q(candidate)} && "$2" == ${q(sha)} ]] || return 78
      python3 - "$1" "$2" <<'FIXTURE_SEAL'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
marker = json.loads((root / '.complete').read_text())
digest = hashlib.sha256()
for name in ['v5-user-contract-prewarm.mjs', 'v5-user-contract-smoke.mjs']:
    digest.update((root / 'scripts' / name).read_bytes())
assert marker['sourceCommit'] == sys.argv[2]
assert marker['artifactSha256'] == digest.hexdigest()
FIXTURE_SEAL
    }`,
    trapLines,
    'tsum_init',
    `user_contract_gate ${q(candidate)} || exit $?`,
    'printf "gate-done\\n" >>"$FIXTURE/events"',
    'tsum_mark G',
  ].join('\n');
  let output = '';
  const p = spawn('/bin/bash', ['-c', source], {
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      TMPDIR: join(dir, 'tmp'), FIXTURE: dir, MODE_TEST: mode,
      V5_CONTRACT_MODELS: undefined,
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
  return { dir, candidate, p, done, output: () => output };
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
function selections(f) { return readFileSync(join(f.dir, 'selected.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)); }
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
function assertDrained(f) {
  assert.ok(gone(pid(f, 'node')), 'prewarm Node must be reaped before deploy exits');
  assert.ok(gone(pid(f, 'chrome')), 'detached Chrome must be reaped before deploy exits');
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

test('verified legacy recovery keeps the canonical supervisor and complete gate order', { timeout: 15_000 }, async (t) => {
  const f = fixture(t, 'success', 'legacy');
  assert.deepEqual(await bounded(f), { code: 0, signal: null }, f.output());
  assert.match(events(f), /prewarm-start\nprewarm-done\nv5-user-contract-smoke.mjs\nv5-go-cache-contract.mjs\nv5-stop-before-start-contract.mjs\ngate-done\nlease:0/);
  const selected = selections(f);
  assert.deepEqual(selected.slice(0, 2).map((row) => row.entry), [
    join(f.candidate, 'scripts/v5-user-contract-prewarm.mjs'),
    join(f.candidate, 'scripts/v5-user-contract-smoke.mjs'),
  ]);
  for (const row of selected.slice(0, 2)) assert.equal(row.models, 'gpt-6-luna,deepseek-v4-flash');
  assert.deepEqual(selected.slice(2).map((row) => row.entry), [
    join(sourceRoot, 'scripts/v5-go-cache-contract.mjs'),
    join(sourceRoot, 'scripts/v5-stop-before-start-contract.mjs'),
  ]);
  for (const row of selected.slice(2)) assert.equal(row.models, null, 'legacy C3 override must not leak into G1/S1');
  assert.equal(summary(f).result, 'success');
});

test('legacy prewarm failure stops every paid gate', { timeout: 15_000 }, async (t) => {
  const f = fixture(t, 'fail', 'legacy');
  assert.deepEqual(await bounded(f), { code: 1, signal: null });
  failed(f, 1);
  assert.equal(selections(f)[0].entry, join(f.candidate, 'scripts/v5-user-contract-prewarm.mjs'));
});

test('legacy prewarm SIGKILL fails and drains the detached Chrome before exit', { timeout: 20_000 }, async (t) => {
  const f = fixture(t, 'block', 'legacy');
  await ready(f);
  process.kill(pid(f, 'node'), 'SIGKILL');
  assert.deepEqual(await bounded(f), { code: 137, signal: null });
  failed(f, 137);
  assertDrained(f);
  assert.deepEqual(selections(f).map((row) => row.entry), [join(f.candidate, 'scripts/v5-user-contract-prewarm.mjs')]);
});

test('SIGKILL of prewarm Node fails and reaps a detached TERM-resistant Chrome', { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  await ready(f);
  process.kill(pid(f, 'node'), 'SIGKILL');
  assert.deepEqual(await bounded(f), { code: 137, signal: null });
  failed(f, 137);
  assertDrained(f);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
  test(`${signal} of deploy records failure only after the prewarm tree is reaped`, { timeout: 20_000 }, async (t) => {
    const f = fixture(t);
    await ready(f);
    f.p.kill(signal);
    setTimeout(() => { try { f.p.kill('SIGTERM'); } catch {} }, 100).unref();
    assert.deepEqual(await bounded(f), { code, signal: null });
    assertDrained(f);
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
