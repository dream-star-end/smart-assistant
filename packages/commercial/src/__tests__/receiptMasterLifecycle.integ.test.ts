/**
 * Real master PG accepted CAS -> attested WS -> durable container inbox -> model callback.
 * Run through scripts/test-mutex.sh commercial. Selfhost's host-PG variant holds that same
 * original mutex over its host channel. Missing PG/Bun/CLI is a failure, never a skip.
 * Synthetic catalog/identity/child executor and loopback model; not billing acceptance.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { assertCommercialMutexOwner, holdCommercialMutex } from './fixtures/receiptMasterPgTransport.fixture.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deadline, rememberDescendants, terminateOwnedTree, trackOwnedTree } from './fixtures/receiptMasterProcess.fixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('receipt fixture cleanup kills only its recorded detached descendants and reports failure', { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
      {detached:true,stdio:['ignore','ignore','ignore','ipc']});
    grandchild.on('message',()=>process.send({ready:true,pid:grandchild.pid}));
    setInterval(()=>{},1000);
  `], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true });
  const tracked = trackOwnedTree(child);
  try {
    const ready = await deadline(new Promise<{pid: number}>(resolve => child.once('message', resolve)), 5000, 'cleanup probe did not start');
    rememberDescendants(child.pid!, tracked.known);
    assert.ok(tracked.known.has(ready.pid), 'actual detached descendant captured before parent dies');
    assert.equal(tracked.known.has(process.pid), false, 'test runner is never an owned descendant');
    await assert.rejects(terminateOwnedTree(child, tracked.known, 100), /test cleanup forced 2 owned processes/);
    await deadline(new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve());
    }), 5000, 'forced test process was not reaped');
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    tracked.stop();
    await terminateOwnedTree(child, tracked.known, 100);
  }
});

test('receipt commercial mutex requires actual original inode before ready, without PG', { timeout: 45_000 }, async () => {
  if (process.env.OC_RECEIPT_TEST_HOST_PG === '1') {
    const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
    const child = spawnSync('host', ['node -e ' + quote(`(${assertCommercialMutexOwner.toString()})(require);process.stdout.write('MUTEX_READY');`)],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout.includes('MUTEX_READY'), false, 'unlocked host never reaches ready');
    const release = await holdCommercialMutex();
    await release();
  } else {
    assertCommercialMutexOwner(createRequire(import.meta.url));
  }
  const fakeFs = {
    statSync: (path: string) => ({ dev: 1n, ino: path.includes('/fd/') ? 2n : 1n }),
    readFileSync: (path: string) => path.endsWith('/cmdline') ? 'bash\0scripts/test-mutex.sh\0commercial\0' :
      path.includes('/fdinfo/') ? 'lock: 1: FLOCK ADVISORY WRITE' : '1 (bash) S 1',
  };
  assert.throws(() => assertCommercialMutexOwner((() => fakeFs) as unknown as NodeRequire), /original inode kernel lock/);
});

async function run(command: string, args: string[], base: string, label: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const tracked = trackOwnedTree(child);
  writeFileSync(join(base, `${label}.pid`), String(child.pid));
  let out = '', err = '', result: { code: number | null; signal: string | null } | undefined;
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { result = { code, signal }; resolve(); });
  });
  try {
    await deadline(closed, label === 'master' ? 240_000 : 60_000, `${label} deadline; artifacts ${base}`);
    assert.equal(result?.code, 0, `${label}: ${JSON.stringify(result)}\n${out.slice(-2000)}\n${err.slice(-5000)}\nartifacts ${base}`);
    return out;
  } finally {
    writeFileSync(join(base, `${label}.stdout.log`), out);
    writeFileSync(join(base, `${label}.stderr.log`), err);
    writeFileSync(join(base, `${label}.exit.json`), JSON.stringify(result ?? { timedOut: true }));
    try { await terminateOwnedTree(child, tracked.known); } finally { tracked.stop(); }
  }
}

for (const mode of ['normal', 'ack-loss', 'ingested', 'accept-blocked'] as const) {
  test(`receipt master durable lifecycle ${mode}`, { timeout: 330_000 }, async () => {
    const base = mkdtempSync(join(process.env.OC_RECEIPT_TEST_ARTIFACTS ?? tmpdir(), 'receipt-master-'));
    mkdirSync(join(base, 'home')); mkdirSync(join(base, 'runtime'));
    // Never inherit production tokens, PG URLs, NODE_OPTIONS, proxies or an existing HOME.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: join(base, 'home'), OPENCLAUDE_HOME: join(base, 'runtime'),
      NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1', OC_RECEIPT_MASTER_PROBE_BASE: base,
      ...(process.env.OC_RECEIPT_TEST_HOST_PG === '1' ? { OC_RECEIPT_TEST_HOST_PG: '1' } : {}),
    };
    const output = await run(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'),
      join(fixtures, 'receiptMasterLifecycle.fixture.ts'), mode], base, 'master', env);
    assert.match(output, /D13_FULL_PASS/);
    const pg = readJson(join(base, 'pg-full-evidence.json'));
    assert.equal(pg.cleaned, true, JSON.stringify(pg));
    assert.equal(pg.failure, undefined); assert.equal(pg.cleanupFailure, undefined);
    assert.equal(pg.migrations.length, 29); assert.match(pg.schema, /^oc_receipt_d13_[a-f0-9]{16}$/);
    const dir = readFileSync(join(base, 'full-private.path'), 'utf8');
    assert.ok(dir.startsWith(base + '/full-private-'));
    const master = readJson(join(dir, 'master-evidence.json'));
    const container = readJson(join(dir, 'container', 'container-evidence.json'));
    assert.equal(master.success, true); assert.equal(master.failure, undefined);
    assert.equal(container.failure, undefined); assert.equal(container.executions, 1);
    assert.equal(container.mainRequests, mode === 'ingested' ? 2 : 3);
    assert.equal(container.callbackModels, mode === 'ingested' ? 0 : 1);
    assert.equal(master.dispatches.length, mode === 'ingested' ? 1 : 2);
    assert.ok(master.dispatches.every((r: {status: string; outcome: string}) => r.status === 'terminal' && r.outcome === 'completed'));
    const injections = master.injectResults ?? [];
    if (mode === 'ingested') assert.equal(injections.length, 0);
    else {
      assert.ok(injections.length >= 1);
      assert.equal(new Set(injections.map((v: {cmid: string}) => v.cmid)).size, 1, 'all retries retain original cmid');
      for (const result of injections) if (result.result.kind === 'injected') {
        assert.equal(result.rows.length, 1);
        assert.ok(['accepted', 'terminal'].includes(result.rows[0].status));
      }
    }
    if (mode === 'ack-loss') { assert.equal(master.lostAck, true); assert.ok(injections.length >= 2); }
    if (mode === 'accept-blocked') {
      assert.equal(master.lockInstalled, true); assert.equal(master.beforeAck.status, 'admitted');
      assert.equal(master.beforeAck.notified, false); assert.ok(injections.length >= 2);
    }
    const containerDir = join(dir, 'container');
    const restored = await run('bun', ['run', join(fixtures, 'receiptMasterRestore.fixture.ts'), containerDir, mode],
      base, 'restore', { ...env, OPENCLAUDE_HOME: containerDir, CLAUDE_CONFIG_DIR: join(containerDir, 'native') });
    const proof = JSON.parse(restored.trim().split('\n').pop()!);
    assert.equal(proof.passed, true); assert.equal(proof.creatorReceiptInputs, mode === 'ingested' ? 1 : 0);
    assert.equal(proof.callbackInputs, mode === 'ingested' ? 0 : 1); assert.equal(proof.finals, 1);
    console.log(JSON.stringify({ mode, base, models: container.mainRequests, executions: 1, ...proof }));
    // Retain private artifacts on both outcomes: failed cleanup must not erase the only evidence.
  });
}
