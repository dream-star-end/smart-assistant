import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReceiptCandidateLifecycle, type ReceiptCandidateScope } from '../receiptCandidateLifecycle.js'
import { withReceiptWriteBarrier } from '../receiptWriteBarrier.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-candidates-'))
  const store = new ReceiptCandidateLifecycle(join(dir, 'control'))
  const scope: ReceiptCandidateScope = { partition: 'a'.repeat(64), userId: 'u1', agentId: 'main', sessionKey: 'session',
    owner: { adapterInstanceId: 'adapter', parentOwnerEpoch: 'epoch', turnKey: 'turn', nativeSessionId: 'native', consumerToolUseId: 'a' } }
  return { dir, store, scope, data: join(store.root, 'data', scope.partition) }
}
test('registered no-job namespaces retire data and reject every late writer or re-registration', async () => {
  const f = fixture()
  const report = await f.store.register(f.scope, 'a', () => {})
  assert.ok(existsSync(report))
  await f.store.withActive(f.scope.partition, ns => writeFileSync(join(ns, 'cache', 'candidate'), 'candidate-only'))
  assert.equal(await f.store.retire(f.scope.partition, () => true), true)
  assert.equal(existsSync(f.data), false)
  assert.deepEqual(JSON.parse(readFileSync(join(f.store.root, 'namespaces', f.scope.partition + '.json'), 'utf8')),
    { v: 1, partition: f.scope.partition, state: 'retired' })
  await assert.rejects(f.store.withActive(f.scope.partition, () => assert.fail('late publication')), /unavailable/)
  await assert.rejects(f.store.register(f.scope, 'a', () => {}), /retired/)
  assert.equal(await new ReceiptCandidateLifecycle(f.store.root).retire(f.scope.partition, () => false), true)
  assert.equal(existsSync(f.data), false)
})
test('distinct real consumers in one parent partition retain the original owner and both reports', async () => {
  const f = fixture(), first = await f.store.register(f.scope, 'a', () => {})
  const second = await f.store.register({ ...f.scope, owner: { ...f.scope.owner, consumerToolUseId: 'b' } }, 'b', () => {})
  assert.notEqual(first, second); assert.ok(existsSync(first)); assert.ok(existsSync(second))
  const m = JSON.parse(readFileSync(join(f.store.root, 'namespaces', f.scope.partition + '.json'), 'utf8'))
  assert.equal(m.scope.owner.consumerToolUseId, 'a')
  await assert.rejects(f.store.register({ ...f.scope, userId: 'other' }, 'c', () => {}), /conflict/)
})
test('unknown owner and corrupt manifests retain data; absent control roots cannot be recreated by writers', async () => {
  const f = fixture()
  await assert.rejects(f.store.withActive(f.scope.partition, () => assert.fail('missing registry')), /ENOENT/)
  assert.equal(existsSync(f.store.root), false)
  await f.store.register(f.scope, 'a', () => {})
  assert.equal(await f.store.retire(f.scope.partition, () => false), false)
  assert.ok(existsSync(f.data))
  writeFileSync(join(f.store.root, 'namespaces', f.scope.partition + '.json'), '{bad')
  await assert.rejects(f.store.retire(f.scope.partition, () => true))
  assert.ok(existsSync(f.data))
})
test('real flock serializes publication and retirement; post-wait validation prevents stale registration', async () => {
  const f = fixture(); await f.store.register(f.scope, 'a', () => {})
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  const holder = withReceiptWriteBarrier(join(f.store.root, 'barrier.lock'), async () => { entered(); await gate })
  await ready
  let admitted = false, called = false
  const registration = f.store.register({ ...f.scope, partition: 'b'.repeat(64) }, 'b', () => {
    called = true; if (!admitted) throw new Error('owner revoked while awaiting barrier')
  })
  assert.equal(called, false)
  release(); await holder
  await assert.rejects(registration, /owner revoked/)
  assert.equal(called, true)
  assert.deepEqual(f.store.list(), [f.scope.partition])
})
test('retired cleanup is restart-idempotent and never follows unknown data symlinks', async () => {
  const f = fixture(); await f.store.register(f.scope, 'a', () => {})
  const victim = join(f.dir, 'external'); writeFileSync(victim, 'KEEP')
  symlinkSync(victim, join(f.data, 'cache', 'unknown-link'))
  await assert.rejects(f.store.retire(f.scope.partition, () => true), /unknown/)
  assert.equal(readFileSync(victim, 'utf8'), 'KEEP')
  assert.equal(JSON.parse(readFileSync(join(f.store.root, 'namespaces', f.scope.partition + '.json'), 'utf8')).state, 'retired')
  await assert.rejects(new ReceiptCandidateLifecycle(f.store.root).retire(f.scope.partition, () => false), /unknown/)
  assert.ok(readdirSync(join(f.data, 'cache')).includes('unknown-link'))
})

test('failed retirement directory fsync retains data until a fresh instance proves durability', async () => {
  const f = fixture(); await f.store.register(f.scope, 'a', () => {})
  const original = fs.fsyncSync
  let failed = false
  fs.fsyncSync = fd => {
    if (!failed && fs.readlinkSync(`/proc/self/fd/${fd}`) === join(f.store.root, 'namespaces')) {
      failed = true; throw new Error('injected namespace fsync failure')
    }
    original(fd)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.store.retire(f.scope.partition, () => true), /injected namespace fsync/)
    assert.equal(failed, true); assert.equal(existsSync(f.data), true)
  } finally { fs.fsyncSync = original; syncBuiltinESMExports() }
  assert.equal(await new ReceiptCandidateLifecycle(f.store.root).retire(f.scope.partition, () => false), true)
  assert.equal(existsSync(f.data), false)
})

for (const finish of ['publish', 'kill'] as const) test(`actual second-process writer ${finish} holds retirement until its real lifetime ends`, async () => {
  const f = fixture(); await f.store.register(f.scope, 'a', () => {})
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const child = spawn(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'),
    fileURLToPath(new URL('./fixtures/receiptCandidateWriter.fixture.ts', import.meta.url)), f.store.root, f.scope.partition],
  { env: { PATH: process.env.PATH!, HOME: f.dir }, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', error = '', ready!: () => void
  const locked = new Promise<void>(r => { ready = r })
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('WRITER_LOCKED')) ready() })
  child.stderr.on('data', chunk => { error += chunk })
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([locked, closed.then(() => { throw new Error(`writer exited before lock: ${error}`) }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('writer startup deadline')), 10000) })])
    clearTimeout(timer)
    if (finish === 'kill') child.kill('SIGSTOP')
    await assert.rejects(withReceiptWriteBarrier(join(f.store.root, 'barrier.lock'), async () => assert.fail('writer lock stolen'), { timeoutMs: 30 }), /flock/)
    const retiring = f.store.retire(f.scope.partition, () => true)
    if (finish === 'kill') child.kill('SIGKILL')
    else child.stdin.end('publish')
    const exit = await closed
    assert.equal(exit, finish === 'kill' ? null : 0, error)
    assert.equal(await retiring, true)
    assert.equal(output.includes('WRITER_PUBLISHED'), finish === 'publish')
    assert.equal(existsSync(f.data), false)
  } finally { clearTimeout(timer); child.kill('SIGKILL'); await closed }
})
