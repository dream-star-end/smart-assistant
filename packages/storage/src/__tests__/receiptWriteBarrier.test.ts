import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { withReceiptWriteBarrier } from '../receiptWriteBarrier.js'

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-receipt-barrier-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'writer.lock')
}
function tryLock(path: string) {
  const out = spawnSync('/usr/bin/flock', ['-n', path, 'true'], { timeout: 3000, encoding: 'utf8' })
  assert.equal(out.error, undefined)
  assert.equal(out.signal, null)
  return out.status
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

test('helper exit does not release writer-owned lock; acquisition timeout is not a write TTL', async t => {
  const path = fixture(t)
  await withReceiptWriteBarrier(path, async () => {
    assert.equal(tryLock(path), 1)
    let competingWrites = 0
    await assert.rejects(withReceiptWriteBarrier(path, async () => { competingWrites++ }, { timeoutMs: 25 }), /flock failed|timed out/)
    assert.equal(competingWrites, 0)
    assert.equal(tryLock(path), 1, 'first writer retains lock after the second acquisition timed out')
  }, { timeoutMs: 1 })
  assert.equal(tryLock(path), 0)
})

test('abort after callback starts cannot unlock its unfinished writes', async t => {
  const path = fixture(t)
  const entered = deferred()
  const finish = deferred()
  const control = new AbortController()
  const writing = withReceiptWriteBarrier(path, async () => { entered.resolve(); await finish.promise }, { signal: control.signal })
  await entered.promise
  try {
    control.abort()
    assert.equal(tryLock(path), 1)
  } finally { finish.resolve(); await writing }
  assert.equal(tryLock(path), 0)
})

test('aborted contender never calls write or releases another writer lock', async t => {
  const path = fixture(t)
  await withReceiptWriteBarrier(path, async () => {
    const controller = new AbortController()
    let calls = 0
    const pending = withReceiptWriteBarrier(path, async () => { calls++ }, { signal: controller.signal })
    const aborted = assert.rejects(pending, /abort/i)
    // Ensure cancellation can arrive after asynchronous open/spawn as well.
    const timer = setTimeout(() => controller.abort(), 40)
    try { await aborted } finally { clearTimeout(timer) }
    assert.equal(calls, 0)
    assert.equal(tryLock(path), 1)
  })
  assert.equal(tryLock(path), 0)
})

test('throw releases the fd without deleting/replacing the inode', async t => {
  const path = fixture(t)
  let inode = 0
  await assert.rejects(withReceiptWriteBarrier(path, async () => {
    inode = statSync(path).ino
    throw new Error('write failed')
  }), /write failed/)
  assert.equal(statSync(path).ino, inode)
  assert.equal(tryLock(path), 0)
  await withReceiptWriteBarrier(path, async () => { assert.equal(statSync(path).ino, inode) })
})

test('symlink lock and invalid timeout fail closed before executing any write', async t => {
  const path = fixture(t)
  const target = path + '.target'
  writeFileSync(target, 'not a lock')
  symlinkSync(target, path)
  let calls = 0
  await assert.rejects(withReceiptWriteBarrier(path, async () => { calls++ }), /ELOOP/)
  await assert.rejects(withReceiptWriteBarrier(target, async () => { calls++ }, { timeoutMs: 0 }), /invalid.*timeout/)
  assert.equal(calls, 0)
})

test('killing the actual writer releases its kernel lock for a new writer', async t => {
  const path = fixture(t)
  const module = fileURLToPath(new URL('../receiptWriteBarrier.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { withReceiptWriteBarrier } from ${JSON.stringify(module)};
    await withReceiptWriteBarrier(${JSON.stringify(path)}, async () => {
      process.send('locked');
      await new Promise(resolve => process.once('message', resolve));
    });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += chunk })
  const exited = new Promise<void>((resolve) => { child.once('close', () => resolve()) })
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 8000)
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', message => message === 'locked' ? resolve() : reject(new Error('unexpected IPC')))
      child.once('error', reject)
      child.once('close', () => reject(new Error(stderr || 'writer died before lock acquisition')))
    })
    assert.equal(tryLock(path), 1)
    child.kill('SIGKILL')
    await exited
    assert.equal(tryLock(path), 0)
    assert.equal(await withReceiptWriteBarrier(path, async () => 'next writer'), 'next writer')
  } finally {
    clearTimeout(watchdog)
    child.kill('SIGKILL')
    await exited
  }
})
