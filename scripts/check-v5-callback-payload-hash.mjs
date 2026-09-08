#!/usr/bin/env node
// OCV5-187 deploy proof: admitted callback bytes, signature and receipt agree.
// Real isolated bridge -> WS regressions on the pinned candidate, not a live
// production/browser/upstream-model probe. Keep their unit registration too.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const title = 'OCV5-187 deploy proof: admitted callback bytes, signature and receipt agree';
const expected = [
  'OCV5-187 cron-origin paper intent: original text, signed hash and accepted receipt agree',
  'OCV5-187 cron-origin technical callback false positive: original text, signed hash and accepted receipt agree',
  'OCV5-187 cron-origin ordinary callback: original text, signed hash and accepted receipt agree',
  'OCV5-187 browser paper hint stays before admission even with forged cron-origin fields',
];

async function verifyEvents() {
  const passed = [];
  const failures = [];
  let summary;
  const stream = run({
    files: [join(root, 'packages/commercial/src/__tests__/modelAuthorityBridge.test.ts')],
    execArgv: ['--import', 'tsx'],
    testNamePatterns: ['OCV5-187'],
    concurrency: false,
    forceExit: true,
    timeout: 30_000,
  });
  for await (const event of stream) {
    const data = event.data;
    if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      process.stderr.write(data.message);
    } else if (event.type === 'test:fail') {
      failures.push(data.name);
      console.error(data.details?.error ?? data);
    } else if (event.type === 'test:pass' && data.details?.type !== 'suite') {
      assert.ok(!data.skip && !data.todo, 'proof cannot skip/todo: ' + data.name);
      passed.push(data.name);
    } else if (event.type === 'test:summary' && data.file === undefined) {
      assert.equal(summary, undefined, 'duplicate final summary');
      summary = data;
    }
  }
  assert.deepEqual(failures, [], 'WS behavior failed');
  assert.deepEqual(passed.sort(), [...expected].sort(), 'exactly four named proof cases must run once');
  assert.ok(summary?.success, 'complete successful test summary required');
  for (const [key, value] of Object.entries({ tests: 4, passed: 4, failed: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    assert.equal(summary.counts[key], value, 'proof summary ' + key);
  }
  console.log(title + ' PASS cases=4');
}

async function supervise() {
  // Absolute workspace links in a reused donor must not execute old product code.
  for (const name of ['commercial', 'gateway', 'protocol', 'storage']) {
    assert.equal(await realpath(join(root, 'node_modules/@openclaude', name)),
      await realpath(join(root, 'packages', name)), 'workspace escaped candidate: ' + name);
  }
  const home = await mkdtemp(join(tmpdir(), 'oc-callback-hash-'));
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  let child;
  let escalation;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // test-mutex owns its command's separate process group and TERM/KILL cleanup.
    child.kill('SIGTERM');
    escalation ??= setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already reaped */ }
    }, 5_000);
  };
  const timer = setTimeout(stop, 1_920_000); // mutex wait <=1800s + execution <=90s
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    child = spawn('bash', [join(root, 'scripts/test-mutex.sh'), 'commercial',
      `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --worker`], {
      cwd: root, detached: true, stdio: 'inherit',
      // Do not inherit production DB/PG*, Redis, model keys, proxies, runtime
      // flags or NODE_OPTIONS/NODE_PATH. The CCB fixture can query global billing.
      env: { PATH: process.env.PATH, HOME: home, OPENCLAUDE_HOME: home,
        NODE_ENV: 'test', OC_TEST_MUTEX_TIMEOUT: '90' },
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal) reject(new Error('proof process signal: ' + signal));
        else resolve(code);
      });
    });
    assert.equal(interrupted, false, 'proof interrupted/timed out');
    assert.equal(code, 0, 'proof process failed');
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await rm(home, { recursive: true, force: false });
  }
}

try {
  if (process.argv[2] === '--worker') await verifyEvents();
  else await supervise();
} catch (error) {
  console.error(title + ' FAIL', error);
  process.exitCode = 1;
}
