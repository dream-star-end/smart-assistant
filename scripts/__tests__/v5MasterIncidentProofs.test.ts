import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildWorkerEnv,
  groupProofsByFile,
  MASTER_INCIDENT_PROOFS,
  resolvePersistentGateDbRegistry,
  terminateProcessTree,
} from '../check-v5-master-incident-proofs.js'

test('groupProofsByFile deduplicates repeated files and promotes mixed db flags to true', () => {
  const groups = groupProofsByFile([
    { incident: 'INC-A', slug: 'a', file: 'same.test.ts', db: false, cases: ['c1'] },
    { incident: 'INC-B', slug: 'b', file: 'other.test.ts', db: false, cases: ['c2'] },
    { incident: 'INC-C', slug: 'c', file: 'same.test.ts', db: true, cases: ['c3'] },
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.file, 'same.test.ts')
  assert.equal(groups[0]!.db, true)
  assert.deepEqual(groups[0]!.entries.map((e) => e.index), [0, 2])
  assert.equal(groups[1]!.file, 'other.test.ts')
  assert.equal(groups[1]!.db, false)
})

test('MASTER_INCIDENT_PROOFS grouping preserves every proof entry without loss', () => {
  const groups = groupProofsByFile(MASTER_INCIDENT_PROOFS)
  assert.ok(groups.length < MASTER_INCIDENT_PROOFS.length, 'duplicate file entries should collapse')
  const seen = groups.flatMap((g) => g.entries.map((e) => e.index)).sort((a, b) => a - b)
  assert.deepEqual(seen, MASTER_INCIDENT_PROOFS.map((_, i) => i))
})

test('buildWorkerEnv strips all PG/DSN/loader overrides and isolates DB vs no-DB workers', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    DATABASE_URL: 'postgres://prod:secret@127.0.0.1:5432/prod',
    TEST_DATABASE_URL: 'postgres://test:test@127.0.0.1:55432/openclaude_test',
    NATIVE_FINANCE_TEST_DATABASE_URL: 'postgres://test:test@127.0.0.1:55432/other_test',
    OCV5_289_JOURNAL_TEST_DATABASE_URL: 'postgres://test:test@127.0.0.1:55432/journal_test',
    OC_V5_PROOF_TEST_DATABASE_URL: 'postgres://test:test@127.0.0.1:55432/proof_test',
    PGHOST: '127.0.0.1',
    PGPORT: '55432',
    PGUSER: 'postgres',
    PGPASSWORD: 'secret',
    PGDATABASE: 'openclaude_test',
    PGSERVICE: 'prod',
    PGOPTIONS: '-c statement_timeout=1000',
    PGSSLMODE: 'require',
    NODE_OPTIONS: '--require /tmp/evil.cjs',
    NODE_PATH: '/tmp/evil-node-modules',
  }

  const slotDsn = 'postgres://test:test@127.0.0.1:55432/ocv5_gate_123_abcdef012345_test'
  const dbEnv = buildWorkerEnv(baseEnv, { db: true, dsn: slotDsn, tmpdir: '/tmp/w1' })
  assert.equal(dbEnv.TEST_DATABASE_URL, slotDsn)
  assert.equal(dbEnv.TMPDIR, '/tmp/w1')
  assert.equal(dbEnv.PATH, '/usr/bin:/bin')
  for (const key of [
    'DATABASE_URL',
    'NATIVE_FINANCE_TEST_DATABASE_URL',
    'OCV5_289_JOURNAL_TEST_DATABASE_URL',
    'OC_V5_PROOF_TEST_DATABASE_URL',
    'PGHOST',
    'PGPORT',
    'PGUSER',
    'PGPASSWORD',
    'PGDATABASE',
    'PGSERVICE',
    'PGOPTIONS',
    'PGSSLMODE',
    'NODE_OPTIONS',
    'NODE_PATH',
  ]) {
    assert.equal(dbEnv[key], undefined, `DB worker env must strip ${key}`)
  }

  const noDbEnv = buildWorkerEnv(baseEnv, { db: false, tmpdir: '/tmp/w2' })
  assert.equal(noDbEnv.TEST_DATABASE_URL, undefined, 'no-DB worker must not inherit TEST_DATABASE_URL')
  assert.equal(noDbEnv.DATABASE_URL, undefined)
  assert.equal(noDbEnv.TMPDIR, '/tmp/w2')
})

test('resolvePersistentGateDbRegistry rejects privateTmp paths and requires persistent path for non-root', () => {
  const prev = process.env.OC_V5_GATE_DB_REGISTRY
  try {
    process.env.OC_V5_GATE_DB_REGISTRY = '/tmp/oc-master-proofs-tmp-abc/reg'
    assert.equal(resolvePersistentGateDbRegistry('/tmp/oc-master-proofs-tmp-abc'), null)

    process.env.OC_V5_GATE_DB_REGISTRY = '/var/tmp/oc-persistent-gate-reg'
    assert.equal(
      resolvePersistentGateDbRegistry('/tmp/oc-master-proofs-tmp-abc'),
      '/var/tmp/oc-persistent-gate-reg',
    )

    delete process.env.OC_V5_GATE_DB_REGISTRY
    const fallback = resolvePersistentGateDbRegistry('/tmp/oc-master-proofs-tmp-abc')
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      assert.equal(fallback, '/var/lib/openclaude-v5-commercial/gate-test-dbs')
    } else {
      assert.equal(fallback, null)
    }
  } finally {
    if (prev === undefined) delete process.env.OC_V5_GATE_DB_REGISTRY
    else process.env.OC_V5_GATE_DB_REGISTRY = prev
  }
})

test('terminateProcessTree reaps parent and grandchild descendants without detached PGID', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oc-tree-reap-'))
  const marker = join(scratch, 'grandchild-survived.txt')
  const ready = join(scratch, 'ready.txt')
  try {
    // Non-detached child (same PGID as parent, matching runProofFile) spawns a grandchild
    // that would write marker after 600ms if not reaped.
    const parentScript = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 600);`,
      )}], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(ready)}, String(child.pid));
      setInterval(() => {}, 1000);
    `
    const proc = spawn(process.execPath, ['-e', parentScript], {
      stdio: 'ignore',
    })
    assert.ok(typeof proc.pid === 'number' && proc.pid > 0)

    const waitReadyDeadline = Date.now() + 3_000
    while (!existsSync(ready) && Date.now() < waitReadyDeadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.equal(existsSync(ready), true, 'grandchild should have spawned')

    await terminateProcessTree(proc.pid, 500)

    // Wait past the grandchild's 600ms timer to prove it was reaped and never writes marker.
    await new Promise((r) => setTimeout(r, 800))
    assert.equal(existsSync(marker), false, 'reaped grandchild must never write marker')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('outer PGID SIGKILL kills runner and non-detached workers atomically (supervisor lease-loss contract)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oc-pgid-hardstop-'))
  const ready = join(scratch, 'worker-ready.txt')
  const marker = join(scratch, 'worker-survived.txt')
  const stubBin = join(scratch, 'bin')
  mkdirSync(stubBin, { recursive: true })
  const stubNpx = join(stubBin, 'npx')
  writeFileSync(
    stubNpx,
    `#!/usr/bin/env bash
printf '%s\\n' "$$" > "${ready}"
sleep 0.6
printf 'survived\\n' > "${marker}"
`,
    'utf8',
  )
  chmodSync(stubNpx, 0o755)

  try {
    // Launch real check-v5-master-incident-proofs.ts as its own outer PGID (matching
    // deploy-v5.sh's mutation lane supervisor). Workers MUST stay in this PGID so
    // `kill -KILL -$outerPgid` terminates them immediately even though runner cannot run finally.
    const runner = spawn(
      process.execPath,
      ['--import', 'tsx', join(process.cwd(), 'scripts/check-v5-master-incident-proofs.ts')],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PATH: `${stubBin}:${process.env.PATH ?? ''}`,
          TEST_DATABASE_URL: 'postgres://test:test@127.0.0.1:55432/openclaude_test',
          OC_V5_MASTER_PROOF_DB_CONCURRENCY: '1',
          OC_V5_MASTER_PROOF_CONCURRENCY: '2',
        },
      },
    )
    assert.ok(typeof runner.pid === 'number' && runner.pid > 0)
    const deadline = Date.now() + 10_000
    while (!existsSync(ready) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(existsSync(ready), true, 'stub npx worker should start')

    // Hard-stop outer PGID exactly like deploy-v5.sh lease-loss supervisor.
    try { process.kill(-runner.pid, 'SIGKILL') } catch {}

    await new Promise((r) => setTimeout(r, 900))
    assert.equal(existsSync(marker), false, 'worker must die with outer PGID SIGKILL and never write marker')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('partial ephemeral DB allocation rollback drop failure fails loud instead of falling back to PASS', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oc-db-rollback-fail-'))
  const helperDir = join(scratch, 'scripts/lib')
  const regDir = join(scratch, 'reg')
  mkdirSync(helperDir, { recursive: true })
  mkdirSync(regDir, { recursive: true })
  const stateFile = join(scratch, 'count.txt')
  writeFileSync(stateFile, '0', 'utf8')
  // Fake gateTestDb.mjs: sweep ok, 1st create ok, 2nd create fails, rollback drop fails.
  writeFileSync(
    join(helperDir, 'gateTestDb.mjs'),
    `
import { readFileSync, writeFileSync } from 'node:fs';
const cmd = process.argv[2];
if (cmd === 'sweep') process.exit(0);
if (cmd === 'create') {
  const n = Number(readFileSync(${JSON.stringify(stateFile)}, 'utf8').trim()) + 1;
  writeFileSync(${JSON.stringify(stateFile)}, String(n), 'utf8');
  if (n === 1) {
    process.stdout.write('postgres://test:test@127.0.0.1:55432/ocv5_gate_999_abcdef012345_test\\n');
    process.exit(0);
  }
  process.stderr.write('simulated create failure on slot 2\\n');
  process.exit(1);
}
if (cmd === 'drop') {
  process.stderr.write('simulated drop failure on rollback\\n');
  process.exit(1);
}
process.exit(1);
`,
    'utf8',
  )

  try {
    const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveProc) => {
      const tsxLoader = join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')
      const child = spawn(
        process.execPath,
        ['--import', tsxLoader, join(process.cwd(), 'scripts/check-v5-master-incident-proofs.ts')],
        {
          cwd: scratch,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            TEST_DATABASE_URL: 'postgres://test:test@127.0.0.1:55432/openclaude_test',
            OC_V5_GATE_DB_REGISTRY: regDir,
            OC_V5_MASTER_PROOF_DB_CONCURRENCY: '2',
          },
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += String(c) })
      child.stderr.on('data', (c) => { stderr += String(c) })
      child.on('close', (code) => resolveProc({ code, stdout, stderr }))
    })
    assert.notEqual(res.code, 0, 'rollback drop failure must exit non-zero')
    assert.ok(!res.stdout.includes('PASS 48 cases'), 'must never print PASS when rollback drop failed')
    assert.match(res.stderr, /rollback drop failed/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
