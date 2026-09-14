import { installDelegateSandbox } from '../../packages/gateway/src/__tests__/helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()

/** Real original SQLite factory + Python kernel; Docker metadata is an explicit seam. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DelegateDurableDb } from '../../packages/gateway/src/delegateDurable.js'
import { DelegateJobStore } from '../../packages/gateway/src/delegateJobs.js'

const adapter = fileURLToPath(new URL('./fixtures/delegateInventory.fixture.py', import.meta.url))
const kernel = fileURLToPath(new URL('../delegate-consumer-compat.py', import.meta.url))
const target = '/home/agent/.openclaude'

function fixture(t: TestContext) {
  const root = join(sandbox.root, 'volume'); mkdirSync(root)
  const master = join(sandbox.root, 'master.db')
  const volumes = [{ Name: 'oc-v5-data-u3', Mountpoint: root, Driver: 'local', Scope: 'local', Options: null }]
  const container = { Id: 'a'.repeat(64), Name: '/oc-v5-u3', Image: 'sha256:' + 'b'.repeat(64),
    Config: { User: '1000:1000', Labels: { 'com.openclaude.v3.managed': '1',
      'com.openclaude.v3.uid': '3', 'com.openclaude.runtime_channel': 'v5' }, Env: ['HOME=/home/agent'] },
    HostConfig: { RestartPolicy: { Name: 'no' } },
    Mounts: [{ Type: 'volume', Name: volumes[0]!.Name, Source: root, Destination: target, RW: true }],
    State: { Status: 'exited', Pid: 0, StartedAt: '2026-01-01T00:00:00Z' } }
  const metadata = join(sandbox.root, 'legacy.json')
  writeFileSync(metadata, JSON.stringify({ capabilities: [] }))
  function database(path: string, enabled: boolean) {
    const db = new DelegateDurableDb(path)
    const store = new DelegateJobStore({ durable: db, sm: true, failureInbox: enabled })
    assert.equal(db.minimumConsumer, enabled ? 2 : 1)
    assert.equal(db.loadAll().length, 0)
    t.after(() => store.close())
    return db
  }
  function inspect(containers: unknown[]) {
    const result = spawnSync('python3', [adapter], { encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ volumes, containers, masters: [master] }),
      env: { PATH: process.env.PATH, HOME: sandbox.root, PYTHONDONTWRITEBYTECODE: '1' } })
    assert.equal(result.error, undefined); assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '')
    return JSON.parse(result.stdout) as { databases: { path: string; absent: boolean }[]; writers: unknown[] }
  }
  function classify(proof: ReturnType<typeof inspect>) {
    const result = spawnSync('python3', [kernel, ...proof.databases.flatMap(d => ['--database', d.path]),
      '--runtime-manifest', metadata, '--master-metadata', metadata], {
      encoding: 'utf8', timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: sandbox.root, PYTHONDONTWRITEBYTECODE: '1' } })
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.stderr, '')
    assert.ok(!result.stdout.includes(sandbox.root), 'kernel never publishes private database paths')
    return { code: result.status, verdict: JSON.parse(result.stdout) as { required: number } }
  }
  return { root, master, container, database, inspect, classify }
}

test('offline sealed original volume refuses legacy while bootstrap-only inventory remains compatible', t => {
  const f = fixture(t)
  const path = join(f.root, 'delegate-jobs.db'), db = f.database(path, false)
  const before = f.inspect([])
  assert.equal(before.writers.length, 0)
  assert.deepEqual(before.databases.map(d => d.path).sort(), [path, f.master].sort())
  assert.equal(f.classify(before).code, 0)
  // Actual original enrollment seals this DB, not a handwritten PRAGMA/profile row.
  const enrolling = new DelegateJobStore({ durable: db, sm: true, failureInbox: true })
  assert.equal(enrolling.acceptsNewFailureSources, true)
  const after = f.inspect([])
  assert.equal(f.classify(after).code, 1)
  assert.equal(f.classify(after).verdict.required, 2)
  assert.equal(db.loadAll().length, 0, 'inventory does not create or rewrite jobs')
})

test('retained stopped container override on a distinct persistent bind participates in compatibility', t => {
  const f = fixture(t), custom = join(sandbox.root, 'custom'); mkdirSync(custom)
  f.database(join(f.root, 'delegate-jobs.db'), false)
  const db = f.database(join(custom, 'jobs.db'), true)
  f.container.Config.Env.push('OPENCLAUDE_DELEGATE_JOBS_DB=/custom/jobs.db')
  f.container.Mounts.push({ Type: 'bind', Name: '', Source: custom, Destination: '/custom', RW: true })
  const proof = f.inspect([f.container])
  assert.equal(proof.writers.length, 1)
  assert.equal(proof.databases.length, 3)
  assert.ok(proof.databases.some(d => d.path === join(custom, 'jobs.db') && !d.absent))
  assert.equal(f.classify(proof).code, 1)
  assert.equal(db.minimumConsumer, 2)
})

test('explicit master database cannot be omitted even when every container and volume is bootstrap-only', t => {
  const f = fixture(t)
  f.database(join(f.root, 'delegate-jobs.db'), false)
  const db = f.database(f.master, true)
  const proof = f.inspect([f.container])
  assert.equal(f.classify(proof).code, 1)
  assert.equal(db.minimumConsumer, 2)
})
