import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SystemActionStore } from '../../../storage/src/systemActions.js'
import { ensureSystemActionDirectory, loadOrCreateSystemActionKey } from '../system-assistant/privateState.js'
import { currentSystemActionExecutor, observeSystemActionExecutor, persistSystemActionExecutor, recoverStoppedSystemActionExecutors } from '../system-assistant/executorIdentity.js'
const root = () => mkdtempSync(join(tmpdir(), 'oc-system-private-proof-'))
test('a durable private key is reused and its public filesystem metadata is restrictive', () => {
  const directory = root()
  const a = loadOrCreateSystemActionKey(directory)
  const b = loadOrCreateSystemActionKey(directory)
  try {
    assert.equal(a.length, 32); assert.ok(a.equals(b), 'reopening must not replace the stable key')
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.equal(statSync(join(directory, 'key.bin')).mode & 0o777, 0o600)
  } finally { a.fill(0); b.fill(0) }
})
test('missing key beside a ledger or its WAL never creates a replacement key', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const directory = root()
    writeFileSync(join(directory, `ledger.sqlite${suffix}`), 'synthetic existing ledger')
    assert.throws(() => loadOrCreateSystemActionKey(directory), /without its key/)
    assert.equal(existsSync(join(directory, 'key.bin')), false)
  }
})
test('corrupted key bytes fail closed without overwriting the existing file', () => {
  const directory = root()
  loadOrCreateSystemActionKey(directory).fill(0)
  const path = join(directory, 'key.bin')
  const corrupted = readFileSync(path)
  const before = corrupted.at(12); assert.ok(before !== undefined)
  corrupted[12] = before ^ 1
  writeFileSync(path, corrupted)
  assert.throws(() => loadOrCreateSystemActionKey(directory), /Corrupt/)
  assert.ok(readFileSync(path).equals(corrupted), 'a damaged key must remain untouched for recovery')
  corrupted.fill(0)
})
test('unsafe directories and key symlinks cannot become secret providers', () => {
  const directory = root(); chmodSync(directory, 0o755)
  assert.throws(() => ensureSystemActionDirectory(directory), /Unsafe/)
  const other = root()
  const external = join(other, 'synthetic-external')
  writeFileSync(external, 'unrelated fixture')
  const state = root(); symlinkSync(external, join(state, 'key.bin'))
  assert.throws(() => loadOrCreateSystemActionKey(state))
  assert.equal(readFileSync(external, 'utf8'), 'unrelated fixture')
})
test('two independent starters publish one complete key atomically', { timeout: 30_000 }, async t => {
  const directory = root()
  const worker = join(directory, 'key-starter.mjs')
  const source = new URL('../system-assistant/privateState.ts', import.meta.url).href
  writeFileSync(worker, `import { createHash } from 'node:crypto';
    import { loadOrCreateSystemActionKey } from ${JSON.stringify(source)};
    process.once('message', root => {
      try { const key=loadOrCreateSystemActionKey(root);const digest=createHash('sha256').update(key).digest('hex');key.fill(0);process.send({digest}); }
      catch { process.send({error:true});process.exitCode=1; }
      process.disconnect();
    });process.send({ready:true});`)
  function start() {
    const child = spawn(process.execPath, ['--import', 'tsx', worker], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let ready!: () => void
    let failedToStart!: (error: Error) => void
    const readiness = new Promise<void>((resolve, reject) => { ready = resolve; failedToStart = reject })
    const result = new Promise<string>((resolve, reject) => {
      let digest: string | null = null
      child.on('message', raw => {
        const data = raw as { digest?: string; error?: boolean; ready?: boolean }
        if (data.ready) { ready(); return }
        if (!data.error && data.digest && /^[a-f0-9]{64}$/.test(data.digest)) digest = data.digest
      })
      child.once('error', () => { const error = new Error('synthetic key starter failed'); failedToStart(error); reject(error) })
      child.once('exit', code => {
        if (code === 0 && digest) resolve(digest)
        else { const error = new Error('synthetic key starter failed'); failedToStart(error); reject(error) }
      })
    })
    return { child, readiness, result, begin: () => child.send(directory) }
  }
  const starters = [start(), start()]
  t.after(() => { for (const { child } of starters) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') })
  const [results] = await Promise.all([
    Promise.all(starters.map(s => s.result)),
    Promise.all(starters.map(s => s.readiness)).then(() => { for (const starter of starters) starter.begin() }),
  ])
  assert.ok(results[0] === results[1], 'both processes must use the same stable key')
})
test('the current process has a durable verified incarnation and is observed live', () => {
  const directory = root()
  const identity = currentSystemActionExecutor()
  assert.equal(identity.pid, process.pid)
  assert.equal(observeSystemActionExecutor(identity), 'live')
  persistSystemActionExecutor(directory, identity)
  assert.equal(statSync(join(directory, 'executors', `${identity.id}.json`)).mode & 0o777, 0o600)
  assert.throws(() => persistSystemActionExecutor(directory, identity))
})
test('only a proven lost incarnation is recovered; live, unknown and current owners retain their fence', () => {
  const directory = root()
  const key = randomBytes(32)
  const ledger = new SystemActionStore({ dbPath: join(directory, 'ledger.sqlite'), key })
  key.fill(0)
  const self = currentSystemActionExecutor()
  const identities = [self, ...Array.from({ length: 3 }, () => ({ ...self, id: randomUUID() }))]
  const proposals = identities.map((identity, i) => {
    persistSystemActionExecutor(directory, identity)
    const p = ledger.prepare({ userId: '765', sessionId: 'synthetic-session', agentId: 'main', operationId: 'fixture.write', operationVersion: 1, operationTitle: '隔离状态', executor: 'master', resourceKey: `synthetic-resource-${i}`, idempotencyKey: `synthetic-request-${i}`, args: {}, preview: {
      title: '隔离状态', description: '只验证独立账本。', scope: '测试', before: [], after: [], consequences: [], price: { kind: 'none', label: '无费用' }, destructive: false,
    } })
    const d = ledger.detail('765', p.id)
    ledger.confirm('765', p.id, { previewHash: d.previewHash, deviceId: 'synthetic-device', nonce: ledger.issueChallenge('765', p.id, 'synthetic-device', d.previewHash) }, identity.id)
    return p
  })
  try {
    const outcome = recoverStoppedSystemActionExecutors(directory, self.id, id => ledger.markExecutorLost(id), identity => identity.id === identities[1]!.id ? 'gone' : identity.id === identities[2]!.id ? 'live' : 'unknown')
    assert.equal(outcome.recovered, 1); assert.equal(outcome.unresolved, 2)
    assert.deepEqual(proposals.map(p => ledger.get('765', p.id).state), ['executing', 'unknown', 'executing', 'executing'])
    assert.throws(() => ledger.prepare({ userId: '765', sessionId: 'synthetic-session', agentId: 'main', operationId: 'fixture.write', operationVersion: 1, operationTitle: '隔离状态', executor: 'master', resourceKey: 'synthetic-resource-1', idempotencyKey: 'new-key-cannot-retry', args: {}, preview: { title: '隔离状态', description: '', scope: '测试', before: [], after: [], consequences: [], price: { kind: 'none', label: '无费用' }, destructive: false } }))
  } finally { ledger.close() }
})
test('malformed identity metadata cannot select an arbitrary executor to mark lost', () => {
  const directory = root()
  const self = currentSystemActionExecutor()
  persistSystemActionExecutor(directory, self)
  const invalid = randomUUID()
  writeFileSync(join(directory, 'executors', `${invalid}.json`), JSON.stringify({ ...self, id: invalid, extra: true }), { mode: 0o600 })
  let marks = 0
  const outcome = recoverStoppedSystemActionExecutors(directory, self.id, () => { marks++; return 1 }, () => 'gone')
  assert.equal(marks, 0); assert.equal(outcome.unresolved, 1)
})

test('private directory creation never leaves an unsynced recursive parent chain', () => {
  const directory = root()
  const missing = join(directory, 'not-initialized')
  assert.throws(() => ensureSystemActionDirectory(join(missing, 'child')))
  assert.equal(existsSync(missing), false)
  ensureSystemActionDirectory(missing)
  ensureSystemActionDirectory(join(missing, 'child'))
  assert.equal(statSync(join(missing, 'child')).mode & 0o777, 0o700)
})
