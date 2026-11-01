import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgentRemoteCommand, AgentRemoteEvent } from '@openclaude/protocol/agentRemote'
import { agentRemotePayloadHash } from '@openclaude/protocol/agentRemote'
import Database from 'better-sqlite3'
import { SqliteAgentRemoteStore } from './durableStore.js'
import { NativeStateRepository } from './nativeState.js'
import { createAgentRemoteService } from './service.js'

const childPath = fileURLToPath(new URL('./fixtures/stateChild.ts', import.meta.url))
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentremote-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const database = join(root, 'authority.sqlite')
  const store = new SqliteAgentRemoteStore(database)
  t.after(() => store.close())
  let now = 1000
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => store,
    clock: () => now,
  })!
  await service.registerWorker(
    'u1',
    {
      protocolVersion: 1,
      principalId: 'u1',
      workerId: 'w1',
      workerInstanceId: 'wi1',
      engines: ['ccb'],
    },
    300000,
  )
  await service.registerEnvironment('u1', {
    protocolVersion: 1,
    principalId: 'u1',
    environmentId: 'e1',
    generation: 1,
    kind: 'container',
    containerId: 'fixture',
    containerIncarnation: 'boot1',
    runtimeRevision: 'fixture-v1',
    workspaceRoot: '/workspace',
    capabilities: [
      'file.read',
      'file.write',
      'process.exec',
      'process.status',
      'process.logs',
      'process.stop',
    ],
  })
  const binding = await service.bind('u1', { sessionId: 's1', workerId: 'w1', environmentId: 'e1' })
  const lease = await service.claim('u1', binding, 1000)
  const make = (
    operationId = 'op1',
    command: AgentRemoteCommand = {
      kind: 'process.exec',
      command: 'synthetic',
      cwd: '/workspace',
      timeoutMs: 500,
    },
  ) => {
    const semantic = {
      protocolVersion: 1 as const,
      binding,
      operationId,
      deadlineAtMs: 10000,
      command,
    }
    return {
      ...structuredClone(semantic),
      lease: { ...lease },
      payloadHash: agentRemotePayloadHash(semantic),
    }
  }
  return {
    root,
    database,
    store,
    service,
    binding,
    lease,
    make,
    setNow: (value: number) => {
      now = value
    },
  }
}
async function child(config: unknown, path: string, mode: string) {
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', childPath, mode, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  process.stdout.on('data', (b) => {
    out += b
  })
  process.stderr.on('data', (b) => {
    err += b
  })
  const [code, signal] = await once(process, 'close')
  return { code, signal, out, err }
}

test('SQLite survives close/reopen with epoch, dedup, events, UTF8 cursor and terminal job dependencies', async (t) => {
  const f = await fixture(t)
  const request = f.make()
  await f.service.accept('u1', request)
  await f.service.authorizeStart('u1', f.binding, 'op1', f.lease)
  const event = (sequence: number, body: AgentRemoteEvent['body']): AgentRemoteEvent => ({
    protocolVersion: 1,
    binding: f.binding,
    lease: f.lease,
    operationId: 'op1',
    payloadHash: request.payloadHash,
    sequence,
    body,
  })
  await f.service.observe(
    'u1',
    event(1, { type: 'started', job: { jobId: 'job1', sourceOperationId: 'op1' } }),
  )
  await f.service.observe(
    'u1',
    event(2, { type: 'output', stream: 'stdout', offsetBytes: 0, text: '中文🌏' }),
  )
  await f.service.observe(
    'u1',
    event(3, { type: 'receipt', receipt: { status: 'completed', exitCode: 7 } }),
  )
  f.store.close()
  const reopened = new SqliteAgentRemoteStore(f.database)
  t.after(() => reopened.close())
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => reopened,
    clock: () => 1100,
  })!
  const record = await service.query('u1', f.binding, 'op1')
  assert.equal(record.state, 'completed')
  assert.equal(record.cursor.stdout, 10)
  assert.deepEqual(await service.accept('u1', request), record)
  const job = { jobId: 'job1', sourceOperationId: 'op1' }
  for (const command of [
    { kind: 'process.status', ...job },
    { kind: 'process.logs', ...job, stream: 'stdout', offsetBytes: 0, limitBytes: 10 },
    { kind: 'process.stop', ...job, scope: 'leader' },
  ] as AgentRemoteCommand[]) {
    assert.equal((await service.accept('u1', f.make(command.kind, command))).state, 'accepted')
  }
  assert.equal(
    (await reopened.retentionCandidates('u1', 1100 + 31 * 86400000)).candidates.length,
    0,
  )
  await service.release('u1', f.binding, f.lease)
  const next = await service.claim('u1', f.binding, 1000)
  assert.equal(next.epoch, f.lease.epoch + 1)
  await assert.rejects(service.renew('u1', f.binding, f.lease, 1000), /stale-lease/)
  await assert.rejects(service.query('u2', f.binding, 'op1'), /principal-mismatch/)
})

test('committed dispatch survives actual SIGKILL, becomes unknown and cannot be replayed', async (t) => {
  const f = await fixture(t)
  await f.service.accept('u1', f.make())
  const path = join(f.root, 'dispatch.json')
  writeFileSync(
    path,
    JSON.stringify({
      database: f.database,
      binding: f.binding,
      lease: f.lease,
      operationId: 'op1',
      now: 1100,
    }),
  )
  const worker = spawn(process.execPath, ['--import', 'tsx', childPath, 'dispatch', path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    worker.kill('SIGKILL')
  })
  let err = ''
  worker.stderr.on('data', (b) => {
    err += b
  })
  const first = await Promise.race([
    once(worker.stdout, 'data').then(([b]) => String(b)),
    once(worker, 'exit').then(() => {
      throw new Error(err)
    }),
  ])
  assert.match(first, /committed/)
  const exited = once(worker, 'exit')
  worker.kill('SIGKILL')
  await exited
  f.store.close()
  const reopened = new SqliteAgentRemoteStore(f.database)
  t.after(() => reopened.close())
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => reopened,
    clock: () => 2500,
  })!
  const next = await service.claim('u1', f.binding, 1000)
  assert.equal((await service.recover('u1', f.binding, 'op1', next)).state, 'unknown')
  await assert.rejects(
    service.authorizeStart('u1', f.binding, 'op1', next),
    /already-dispatched|stale-operation-claim/,
  )
  assert.equal((await service.query('u1', f.binding, 'op1')).events.length, 0)
})

test('separate OS processes have one lease CAS winner', async (t) => {
  const f = await fixture(t)
  await f.service.release('u1', f.binding, f.lease)
  const config = { database: f.database, binding: f.binding, now: 1100 }
  const results = await Promise.all([
    child(config, join(f.root, 'claim-a.json'), 'claim'),
    child(config, join(f.root, 'claim-b.json'), 'claim'),
  ])
  assert.equal(results.filter((r) => r.code === 0).length, 1)
  assert.match(results.find((r) => r.code !== 0)!.err, /lease-busy/)
})

test('queued cancel and expiry persist true unexecuted receipts; dispatched work rejects queued cancellation', async (t) => {
  const f = await fixture(t)
  await f.service.accept('u1', f.make('cancel'))
  const cancelled = await f.service.cancelQueued('u1', f.binding, 'cancel')
  assert.deepEqual(cancelled.receipt, { status: 'cancelled', stopScope: 'not-started' })
  assert.equal(cancelled.events.length, 0)
  assert.deepEqual(await f.service.cancelQueued('u1', f.binding, 'cancel'), cancelled)
  await assert.rejects(
    f.service.authorizeStart('u1', f.binding, 'cancel', f.lease),
    /already-dispatched/,
  )
  await f.service.accept('u1', f.make('expire'))
  f.setNow(10000)
  const expired = await f.service.expireQueued('u1', f.binding, 'expire')
  assert.deepEqual(expired.receipt, { status: 'failed', code: 'deadline-before-dispatch' })
  f.setNow(1500)
  await f.service.accept('u1', f.make('dispatch'))
  await f.service.authorizeStart('u1', f.binding, 'dispatch', f.lease)
  await assert.rejects(f.service.cancelQueued('u1', f.binding, 'dispatch'), /not-queued/)
  f.store.close()
  const reopened = new SqliteAgentRemoteStore(f.database)
  t.after(() => reopened.close())
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => reopened,
    clock: () => 1500,
  })!
  assert.equal((await service.query('u1', f.binding, 'cancel')).state, 'cancelled')
  assert.equal((await service.query('u1', f.binding, 'expire')).state, 'failed')
})

test('failed/async transactions roll back; detached snapshots and set-once terminals survive restart', async (t) => {
  const f = await fixture(t)
  await f.service.accept('u1', f.make())
  await f.service.cancelQueued('u1', f.binding, 'op1')
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.workers = []
      throw new Error('rollback')
    }),
    /rollback/,
  )
  await assert.rejects(
    f.store.transact('u1', async (state) => {
      state.workers = []
    }),
    /async-transaction-callback/,
  )
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.journal[0]!.cancelRequested = false
    }),
    /stored-terminal-mutation/,
  )
  const snapshot = await f.store.transact('u1', (state) => state)
  snapshot.workers.length = 0
  assert.equal(await f.store.transact('u1', (state) => state.workers.length), 1)
  const candidates = await f.store.retentionCandidates('u1', 1000 + 31 * 86400000)
  assert.equal(candidates.candidates.length, 1)
  assert.equal((await f.service.query('u1', f.binding, 'op1')).state, 'cancelled')
})

test('corrupt hashes/versions, symlink files and public state directories fail closed', async (t) => {
  const f = await fixture(t)
  f.store.close()
  const raw = new Database(f.database)
  raw.prepare("UPDATE agent_remote_principals SET payload='{}' WHERE principal_id='u1'").run()
  raw.close()
  const store = new SqliteAgentRemoteStore(f.database)
  t.after(() => store.close())
  await assert.rejects(
    store.transact('u1', () => null),
    /state-corrupt/,
  )
  assert.equal(readFileSync(f.database).subarray(0, 16).toString(), 'SQLite format 3\0')
  symlinkSync(f.database, join(f.root, 'alias.sqlite'))
  assert.throws(
    () => new SqliteAgentRemoteStore(join(f.root, 'alias.sqlite')),
    /state-file-private/,
  )
  const foreignPath = join(f.root, 'foreign.sqlite')
  writeFileSync(foreignPath, '', { mode: 0o600 })
  const foreign = new Database(foreignPath)
  foreign.exec('CREATE TABLE unrelated (id INTEGER)')
  foreign.close()
  assert.throws(() => new SqliteAgentRemoteStore(foreignPath), /state-existing-database/)
  const unchanged = new Database(foreignPath)
  assert.equal(unchanged.pragma('journal_mode', { simple: true }), 'delete')
  unchanged.close()
  const versionedForeign = new Database(foreignPath)
  versionedForeign.pragma('user_version=1')
  versionedForeign.close()
  assert.throws(() => new SqliteAgentRemoteStore(foreignPath), /state-application-id/)
  const stillUnchanged = new Database(foreignPath)
  assert.equal(stillUnchanged.pragma('journal_mode', { simple: true }), 'delete')
  stillUnchanged.close()

  const versionPath = join(f.root, 'future.sqlite')
  writeFileSync(versionPath, '', { mode: 0o600 })
  const future = new Database(versionPath)
  future.pragma('user_version=99')
  future.close()
  assert.throws(() => new SqliteAgentRemoteStore(versionPath), /state-format-version/)
  chmodSync(f.root, 0o755)
  assert.throws(
    () => new SqliteAgentRemoteStore(join(f.root, 'new.sqlite')),
    /state-directory-private/,
  )
})

test('native checkpoint pointer commits after sealed files, rejects inflight work and pins retention across restart', async (t) => {
  const f = await fixture(t)
  const options = { nativeRoot: join(f.root, 'native'), stateRoot: join(f.root, 'snapshots') }
  const repo = new NativeStateRepository(options)
  const nativeSessionId = '00000000-0000-4000-8000-000000000001'
  const identity = {
    principalId: 'u1',
    sessionId: 's1',
    nativeSessionId,
    engine: 'ccb' as const,
    engineVersion: '2.8.4',
    cwd: '/workspace',
    environmentId: 'e1',
    environmentGeneration: 1,
  }
  const transcriptRelativePath = `projects/-workspace/${nativeSessionId}.jsonl`
  const transcript = join(options.nativeRoot, transcriptRelativePath)
  mkdirSync(dirname(transcript), { recursive: true, mode: 0o700 })
  writeFileSync(transcript, `${JSON.stringify({ uuid: 'head1', sessionId: nativeSessionId })}\n`)
  const config = {
    options,
    identity,
    transcript,
    request: {
      identity,
      bindingRevision: f.binding.bindingRevision,
      authority: { dispatchId: 'd1', turnKey: 'turn1', tapeCursor: 1, nativeHeadUuid: 'head1' },
      transcriptRelativePath,
      createdAtMs: 1000,
    },
    service: { database: f.database, binding: f.binding, lease: f.lease, now: 1100 },
  }
  const configPath = join(f.root, 'checkpoint.json')
  writeFileSync(configPath, JSON.stringify(config))
  async function snapshot() {
    const command = repo.stateTaskCommand(identity, process.execPath, [
      '--import',
      'tsx',
      childPath,
      'checkpoint',
      configPath,
    ])
    const worker = spawn(command.executable, command.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let error = ''
    worker.stderr.on('data', (b) => {
      error += b
    })
    const [code] = await once(worker, 'close')
    return { code, error }
  }
  await f.service.accept('u1', f.make())
  const inflight = await snapshot()
  assert.match(inflight.error, /checkpoint-inflight/)
  assert.equal(await f.service.nativeCheckpoint('u1', f.binding, identity), undefined)
  await f.service.cancelQueued('u1', f.binding, 'op1')
  const sealed = await snapshot()
  assert.equal(sealed.code, 0, sealed.error)
  const manifest = await f.service.nativeCheckpoint('u1', f.binding, identity)
  assert.ok(manifest)
  repo.read(manifest.checkpointId, identity)
  f.store.close()
  const reopened = new SqliteAgentRemoteStore(f.database)
  t.after(() => reopened.close())
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => reopened,
    clock: () => 1200,
  })!
  assert.deepEqual(await service.nativeCheckpoint('u1', f.binding, identity), manifest)
  assert.equal(
    (await reopened.retentionCandidates('u1', 1000 + 31 * 86400000)).candidates.length,
    0,
  )
})
