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

function collectProofEvents(stream) {
  const passed = [];
  const failures = [];
  const counts = new Map();
  let filteredSkips = 0;
  let leaves = 0;
  let suites = 0;
  let topResults = 0;
  let topPlan;
  let ended = false;
  const consume = (event) => {
    const data = event.data;
    if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      process.stderr.write(data.message);
    } else if (event.type === 'test:fail') {
      failures.push(data.name);
      console.error(data.details?.error ?? data);
    } else if (event.type === 'test:pass') {
      if (data.nesting === 0) topResults++;
      if (data.details?.type === 'suite') {
        suites++;
        assert.ok(!data.skip && !data.todo, 'proof suite cannot skip/todo: ' + data.name);
        return;
      }
      // Node20 omits details.type on leaves and emits excluded tests as skips.
      leaves++;
      assert.ok(!data.todo, 'proof cannot contain todo: ' + data.name);
      if (expected.includes(data.name)) {
        assert.ok(!data.skip, 'selected proof cannot skip: ' + data.name);
        passed.push(data.name);
      } else {
        assert.ok(!data.name.includes('OCV5-187'), 'unexpected selected proof: ' + data.name);
        assert.equal(data.skip, 'test name does not match pattern', 'unexpected executed/non-filtered test: ' + data.name);
        filteredSkips++;
      }
    } else if (event.type === 'test:plan' && data.nesting === 0) {
      assert.equal(topPlan, undefined, 'duplicate root plan');
      assert.ok(Number.isSafeInteger(data.count) && data.count > 0, 'invalid root plan');
      topPlan = data.count;
    } else if (event.type === 'test:diagnostic' && data.nesting === 0) {
      const match = /^(tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(data.message);
      if (!match) return;
      const [, key, raw] = match;
      assert.ok(!counts.has(key), 'duplicate runner count: ' + key);
      assert.ok(Number.isSafeInteger(Number(raw)), 'invalid runner count: ' + key);
      counts.set(key, Number(raw));
    }
  };
  // Consume the whole stream before judging it. forceExit/early iterator throws
  // can discard the actual loader/assertion diagnostic and leave only exit=1.
  return new Promise((resolve, reject) => {
    stream.on('data', (event) => {
      try { consume(event); } catch (error) {
        failures.push(error.message);
        console.error(error);
      }
    });
    stream.once('error', reject);
    stream.once('end', () => { ended = true; });
    stream.once('close', () => {
      try {
        assert.ok(ended, 'proof stream closed before natural end');
        assert.deepEqual(failures, [], 'WS behavior/event validation failed');
        assert.deepEqual(passed.sort(), [...expected].sort(), 'exactly four named proof cases must run once');
        assert.equal(topPlan, topResults, 'complete root plan must match final root results');
        assert.ok(topPlan > 0, 'root plan required');
        assert.equal(leaves, expected.length + filteredSkips, 'leaf accounting mismatch');
        for (const [key, value] of Object.entries({ tests: leaves, suites, pass: 4, fail: 0,
          cancelled: 0, skipped: filteredSkips, todo: 0 })) {
          assert.equal(counts.get(key), value, 'runner count ' + key);
        }
        resolve({ runnerTests: leaves, filteredSkips });
      } catch (error) { reject(error); }
    });
  });
}

async function verifyEvents() {
  const result = await collectProofEvents(run({
    files: [join(root, 'packages/commercial/src/__tests__/modelAuthorityBridge.test.ts')],
    testNamePatterns: ['OCV5-187'],
    concurrency: false,
    forceExit: false,
    timeout: 30_000,
  }));
  console.log(title + ` PASS selected=4 selectedSkip=0 runnerTests=${result.runnerTests}`
    + ` filteredSkips=${result.filteredSkips} node=${process.version}`);
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
      // The mutex's fd-9 exec redirects its stderr to /dev/null. Keep worker
      // loader/assertion diagnostics on the inherited stdout pipe instead.
      `${quote(process.execPath)} --import tsx ${quote(fileURLToPath(import.meta.url))} --worker 2>&1`], {
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
