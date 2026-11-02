/** Synthetic protocol/control fixtures; no runtime/OS proof is inferred from fake ports.
 * The final file test separately exercises actual UUID flock, files and SQLite. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentRemoteContentHash, agentRemotePayloadHash } from '@openclaude/protocol/agentRemote'
import type { NativeScope } from '@openclaude/protocol/agentRemoteNative'
import {
  type NativeCheckpoint,
  type NativeCheckpointCapture,
  type NativeCheckpointIdentity,
  nativeCheckpointId,
} from '@openclaude/protocol/agentRemoteState'
import { SqliteAgentRemoteStore } from './durableStore.js'
import {
  type NativeFixture,
  fixture,
  receipt,
  syntheticDelivery,
  uuid,
} from './fixtures/nativeFixture.js'
import { type NativeHandoffPort, NativeRecoveryService } from './nativeRecovery.js'
import { NativeJournalService } from './nativeService.js'
import { NativeStateRepository } from './nativeState.js'

const peer = { workerInstanceId: 'wi2', connectionId: 'c2', challenge: '2'.repeat(64) }
const identity: NativeCheckpointIdentity = {
  principalId: 'u1',
  sessionId: 's1',
  nativeSessionId: uuid,
  engine: 'ccb',
  engineVersion: '2.8.4',
  cwd: '/workspace',
  environmentId: 'e1',
  environmentGeneration: 1,
}
const relativePath = `projects/-workspace/${uuid}.jsonl`
const scope = (f: NativeFixture): NativeScope => ({
  binding: f.binding,
  lease: f.lease,
  nativeSessionId: uuid,
  environmentIncarnation: 'boot1',
  connectionId: 'c1',
  challenge: '1'.repeat(64),
})
const metadata = (f: NativeFixture) => f.store.transact('u1', (s) => s.sessions[0]!, 'active')
function syntheticCheckpoint(capture: NativeCheckpointCapture): NativeCheckpoint {
  const semantic = {
    schemaVersion: 3 as const,
    ...capture.identity,
    bindingRevision: capture.bindingRevision,
    checkpointCaptureId: capture.captureId,
    nativeDeliveryWatermark: capture.nativeDeliveryWatermark,
    nativeWriterGeneration: capture.nativeWriterGeneration,
    createdAtMs: capture.createdAtMs,
    authority: { dispatchId: 'd1', turnKey: 't1', tapeCursor: 1, nativeHeadUuid: 'head1' },
    transcriptRelativePath: relativePath,
    files: [{ relativePath, sizeBytes: 0, sha256: agentRemoteContentHash('') }],
  }
  return { ...semantic, checkpointId: nativeCheckpointId(semantic) }
}
const syntheticPort: NativeHandoffPort = {
  async withFreshCheckpoint(_target, capture, commit) {
    return commit(syntheticCheckpoint(await capture({ assertHeld: () => true })))
  },
}
async function recovery(f: NativeFixture, port?: NativeHandoffPort) {
  f.setNow(2001)
  const service = new NativeRecoveryService(f.store, peer, f.now, port)
  const permit = await service.claim('u1', f.binding, identity, 0, 'recovery1', 1000)
  return { service, permit, token: permit.token }
}

test('writer lifecycle covers model-only writes; normal checkpoint cannot seal or permit migration', async (t) => {
  const f = await fixture(t)
  assert.equal(await f.service.beginNativeWriter('u1', f.binding, f.lease, uuid, 'writer1'), 1)
  assert.equal(await f.service.beginNativeWriter('u1', f.binding, f.lease, uuid, 'writer1'), 1)
  await assert.rejects(
    f.service.beginNativeWriter('u1', f.binding, f.lease, uuid, 'writer2'),
    /native-writer-not-sealed/,
  )
  const capture = await f.service.captureNativeCheckpoint('u1', f.binding, f.lease, identity)
  await f.service.publishNativeCheckpoint('u1', f.binding, f.lease, syntheticCheckpoint(capture))
  const state = await metadata(f)
  assert.equal(state.nativeDeliveryWatermark, state.nativeCheckpointWatermark)
  assert.equal(state.nativeWriterGeneration, 1)
  assert.equal(state.nativeSealedWriterGeneration, 0)
  await assert.rejects(
    f.service.registerWorker('u1', { ...f.worker, workerInstanceId: 'wi2' }, 1000),
    /native-checkpoint-stale/,
  )
  await assert.rejects(
    f.service.registerEnvironment('u1', { ...f.environment, generation: 2 }),
    /native-checkpoint-stale/,
  )
  await f.service.registerWorker(
    'u1',
    { ...f.worker, workerId: 'w2', workerInstanceId: 'wi2' },
    300000,
  )
  await assert.rejects(
    f.service.bind('u1', { sessionId: 's1', workerId: 'w2', environmentId: 'e1' }),
    /native-checkpoint-stale/,
  )
  await assert.rejects(
    f.service.nativeCheckpoint('u1', f.binding, identity),
    /native-checkpoint-stale/,
  )
  await f.service.renew('u1', f.binding, f.lease, 1000)
  await assert.rejects(
    f.store.transact('u1', (s) => {
      s.sessions[0]!.nativeSealedWriterGeneration = 1
    }),
    /stored-native-writer-seal/,
  )
})

test('pending permit survives reopen and expiry; blocks equal-path execution/registry except identical worker TTL', async (t) => {
  const f = await fixture(t)
  const early = new NativeRecoveryService(f.store, peer, f.now)
  await assert.rejects(early.claim('u1', f.binding, identity, 0, 'r0', 1000), /lease-busy/)
  const { service, permit, token } = await recovery(f)
  assert.deepEqual(await service.claim('u1', f.binding, identity, 0, 'recovery1', 2000), permit)
  await assert.rejects(
    service.claim('u1', f.binding, identity, 1, 'another', 1000),
    /native-recovery-busy/,
  )
  await f.service.registerWorker('u1', f.worker, 300000)
  await assert.rejects(
    f.service.registerWorker('u1', { ...f.worker, engines: ['codex'] }, 300000),
    /native-recovery-pending/,
  )
  await assert.rejects(
    f.service.registerEnvironment('u1', f.environment),
    /native-recovery-pending/,
  )
  await assert.rejects(
    f.service.bind('u1', { sessionId: 's1', workerId: 'w1', environmentId: 'e1' }),
    /native-recovery-pending/,
  )
  await assert.rejects(f.service.claim('u1', f.binding, 1000), /native-recovery-pending/)
  await assert.rejects(
    f.service.captureNativeCheckpoint('u1', f.binding, f.lease, identity),
    /native-recovery-pending/,
  )
  await assert.rejects(
    f.service.nativeCheckpoint('u1', f.binding, identity),
    /native-recovery-pending/,
  )
  await assert.rejects(
    f.service.beginNativeWriter('u1', f.binding, f.lease, uuid, 'writer'),
    /native-recovery-pending/,
  )
  await assert.rejects(service.finish('u1', token), /native-handoff-port-required/)
  f.store.close()
  const reopened = new SqliteAgentRemoteStore(f.path)
  t.after(() => reopened.close())
  f.setNow(3002)
  const other = new NativeRecoveryService(
    reopened,
    { ...peer, connectionId: 'c3', challenge: '3'.repeat(64) },
    f.now,
  )
  await assert.rejects(other.finish('u1', token), /native-recovery-owner/)
  const old = new NativeRecoveryService(reopened, peer, f.now)
  await assert.rejects(old.finish('u1', token), /native-recovery-expired/)
  const next = await other.claim('u1', f.binding, identity, 1, 'recovery2', 1000)
  assert.equal(next.token.generation, 2)
  await assert.rejects(old.finish('u1', token), /native-recovery-stale/)
  assert.equal((await reopened.transact('u1', (s) => s.sessions[0]!, 'active')).epochWatermark, 1)
})

test('recovery replays original ledger evidence and delivers original ACK without acquiring execution epoch', async (t) => {
  const f = await fixture(t)
  const row = f.record()
  receipt(row)
  const event = row.events[0]!
  const withoutReceipt = structuredClone(row)
  withoutReceipt.events = []
  Reflect.deleteProperty(withoutReceipt, 'receipt')
  await f.store.transact('u1', (s) => {
    s.nativeJournal.push(withoutReceipt)
  })
  const { service, token } = await recovery(f, syntheticPort)
  const params = [
    'u1',
    token,
    f.binding,
    uuid,
    row.request.operationId,
    row.request.body.payloadHash,
  ] as const
  const normal = new NativeJournalService(f.store, f.now)
  await assert.rejects(
    normal.query('u1', scope(f), row.request.operationId, row.request.body.payloadHash),
    /native-recovery-pending/,
  )
  await assert.rejects(
    service.observe(...params, { hostInstanceId: 'forged', ledgerId: 'l1' }, event),
    /native-evidence-producer/,
  )
  const restored = await service.observe(...params, { hostInstanceId: 'h1', ledgerId: 'l1' }, event)
  assert.deepEqual(restored.claim, f.lease)
  assert.deepEqual(restored.dispatch, row.dispatch)
  assert.deepEqual(restored.request, row.request)
  const { preparation, proof } = syntheticDelivery(restored)
  await service.prepareDelivery(...params, preparation)
  const committed = await service.commitDelivery(...params, preparation.preparationHash, proof)
  const repeated = await service.commitDelivery(...params, preparation.preparationHash, {
    ...proof,
    main: { ...proof.main, headUuid: '98765432-1234-1234-1234-123456789abc' },
  })
  assert.deepEqual(repeated.deliveryCommit, committed.deliveryCommit)
  assert.equal((await metadata(f)).nativeDeliveryWatermark, 1)
  const finished = await service.finish('u1', token)
  assert.deepEqual(await service.finish('u1', token), finished)
  const state = await metadata(f)
  assert.equal(state.nativeCheckpointWatermark, 1)
  assert.equal(state.nativeRecovery!.phase, 'completed')
  assert.deepEqual((await service.query(...params)).deliveryCommit, committed.deliveryCommit)
  assert.equal(state.epochWatermark, 1)
  assert.deepEqual(state.binding, f.binding)
  await f.service.registerWorker('u1', { ...f.worker, workerInstanceId: 'wi2' }, 300000)
  const nextBinding = await f.service.bind('u1', {
    sessionId: 's1',
    workerId: 'w1',
    environmentId: 'e1',
  })
  const lease = await f.service.claim('u1', nextBinding, 1000)
  assert.equal(lease.epoch, 2)
})

test('unresolved execution cannot finish, unstarted cancellation is not a grant, and callback scope is fenced', async (t) => {
  const f = await fixture(t)
  const row = f.record()
  await f.store.transact('u1', (s) => {
    s.nativeJournal.push(row)
  })
  const { service, token } = await recovery(f, syntheticPort)
  const params = [
    'u1',
    token,
    f.binding,
    uuid,
    row.request.operationId,
    row.request.body.payloadHash,
  ] as const
  await assert.rejects(service.finish('u1', token), /native-recovery-inflight/)
  const cancelled = await service.cancelUnstarted(...params)
  assert.equal(cancelled.dispatch, undefined)
  assert.deepEqual(cancelled.claim, row.claim)
  assert.equal(cancelled.receipt!.body.code, 'not-started')
  await assert.rejects(service.finish('u1', token), /native-recovery-inflight/)
  const { preparation, proof } = syntheticDelivery(cancelled)
  await service.prepareDelivery(...params, preparation)
  await service.commitDelivery(...params, preparation.preparationHash, proof)
  let escaped:
    | ((locked: { assertHeld: () => true }) => Promise<NativeCheckpointCapture>)
    | undefined
  const broken = new NativeRecoveryService(f.store, peer, f.now, {
    async withFreshCheckpoint(_target, capture) {
      escaped = capture
    },
  })
  await assert.rejects(broken.finish('u1', token), /native-handoff-not-committed/)
  await assert.rejects(escaped!({ assertHeld: () => true }), /native-handoff-capture-scope/)
  assert.equal((await metadata(f)).nativeRecovery!.phase, 'pending')
  const failed = new NativeRecoveryService(f.store, peer, f.now, {
    async withFreshCheckpoint(_target, capture, commit) {
      const ticket = await capture({ assertHeld: () => true })
      await assert.rejects(capture({ assertHeld: () => true }), /native-handoff-capture-scope/)
      const invalid = syntheticCheckpoint(ticket)
      invalid.nativeDeliveryWatermark++
      const { checkpointId: _id, ...semantic } = invalid
      invalid.checkpointId = nativeCheckpointId(semantic)
      return commit(invalid)
    },
  })
  await assert.rejects(failed.finish('u1', token), /native-handoff-capture-stale/)
  assert.equal((await metadata(f)).nativeCheckpoint, undefined)
  assert.equal((await metadata(f)).nativeRecovery!.phase, 'pending')
})

test('trusted handoff can seal a generation once; completed permit permits fresh generation and later checkpoints', async (t) => {
  const f = await fixture(t)
  await f.service.beginNativeWriter('u1', f.binding, f.lease, uuid, 'writer1')
  const { service, token } = await recovery(f, syntheticPort)
  await service.finish('u1', token)
  const state = await metadata(f)
  assert.equal(state.nativeSealedWriterGeneration, 1)
  assert.equal(state.nativeWriterGeneration, 1)
  const lease = await f.service.claim('u1', f.binding, 1000)
  await assert.rejects(
    f.service.beginNativeWriter('u1', f.binding, lease, uuid, 'writer1'),
    /native-writer-sealed/,
  )
  assert.equal(await f.service.beginNativeWriter('u1', f.binding, lease, uuid, 'writer2'), 2)
  const capture = await f.service.captureNativeCheckpoint('u1', f.binding, lease, identity)
  await f.service.publishNativeCheckpoint('u1', f.binding, lease, syntheticCheckpoint(capture))
  assert.equal((await metadata(f)).nativeSealedWriterGeneration, 1)
  assert.deepEqual(await service.finish('u1', token), {
    checkpointId: state.nativeRecovery!.checkpointId!,
  })
})

test('native admission rejects omitted writer bootstrap and old lease checkpoint cannot seal recovery', async (t) => {
  const f = await fixture(t)
  const s = scope(f)
  const native = new NativeJournalService(f.store, f.now)
  const row = f.record()
  await assert.rejects(
    native.admit('u1', s, {
      nativeProtocolVersion: 1,
      scope: s,
      sender: 'worker',
      operationId: 'op1',
      sequence: 1,
      body: row.request.body,
    }),
    /native-writer-not-active/,
  )
  await f.service.beginNativeWriter('u1', f.binding, f.lease, uuid, 'writer1')
  const captured = await f.service.captureNativeCheckpoint('u1', f.binding, f.lease, identity)
  const checkpoint = syntheticCheckpoint(captured)
  await f.service.publishNativeCheckpoint('u1', f.binding, f.lease, checkpoint)
  await recovery(f)
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.sessions[0]!.nativeRecovery!.phase = 'completed'
      state.sessions[0]!.nativeRecovery!.checkpointId = checkpoint.checkpointId
      state.sessions[0]!.nativeSealedWriterGeneration = 1
    }),
    /stored-native-recovery-transition/,
  )
})

test('late async store callbacks cannot publish after handoff port returns and drops its locks', async (t) => {
  for (const stage of ['capture', 'commit'] as const) {
    const f = await fixture(t)
    const { token } = await recovery(f)
    let delayed = false
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const delayedStore: import('./store.js').AgentRemoteStore = {
      durability: 'durable',
      async transact(principalId, change, journal) {
        if (delayed) await gate
        return f.store.transact(principalId, change, journal)
      },
    }
    let late: Promise<unknown> | undefined
    const service = new NativeRecoveryService(delayedStore, peer, f.now, {
      async withFreshCheckpoint(_target, capture, commit) {
        if (stage === 'capture') {
          delayed = true
          late = capture({ assertHeld: () => true })
        } else {
          const ticket = await capture({ assertHeld: () => true })
          delayed = true
          late = commit(syntheticCheckpoint(ticket))
        }
        void late.catch(() => {})
      },
    })
    await assert.rejects(service.finish('u1', token), /native-handoff-not-committed/)
    delayed = false
    release!()
    await assert.rejects(
      late!,
      stage === 'capture' ? /native-handoff-capture-scope/ : /native-handoff-commit-scope/,
    )
    assert.equal((await metadata(f)).nativeRecovery!.phase, 'pending')
    assert.equal((await metadata(f)).nativeCheckpoint, undefined)
  }
})

test('lock capability must synchronously return true and is rechecked in commit transaction', async (t) => {
  const f = await fixture(t)
  const { token } = await recovery(f)
  const asynchronous = new NativeRecoveryService(f.store, peer, f.now, {
    async withFreshCheckpoint(_target, capture) {
      return capture({ assertHeld: (() => Promise.resolve(true)) as unknown as () => true })
    },
  })
  await assert.rejects(asynchronous.finish('u1', token), /native-handoff-lock-required/)
  const revoked = new NativeRecoveryService(f.store, peer, f.now, {
    async withFreshCheckpoint(_target, capture, commit) {
      let held = true
      const ticket = await capture({
        assertHeld: () => {
          assert.ok(held, 'fixture-lock-released')
          return true
        },
      })
      held = false
      return commit(syntheticCheckpoint(ticket))
    },
  })
  await assert.rejects(revoked.finish('u1', token), /fixture-lock-released/)
  assert.equal((await metadata(f)).nativeRecovery!.phase, 'pending')
  assert.equal((await metadata(f)).nativeCheckpoint, undefined)
})

test('real writer lock blocks live writer; fresh locked snapshot survives control ACK loss and restores model-only append', async (t) => {
  const f = await fixture(t)
  await f.service.beginNativeWriter('u1', f.binding, f.lease, uuid, 'actual-writer1')
  const options = { nativeRoot: join(f.root, 'native'), stateRoot: join(f.root, 'snapshots') }
  const repo = new NativeStateRepository(options)
  const transcript = join(options.nativeRoot, relativePath)
  mkdirSync(dirname(transcript), { recursive: true, mode: 0o700 })
  const line = (head: string) =>
    `${JSON.stringify({
      type: 'assistant',
      uuid: head,
      sessionId: uuid,
      message: { role: 'assistant', content: `model-only-${head}` },
    })}\n`
  writeFileSync(transcript, line('head0'), { mode: 0o600 })
  const stateChild = fileURLToPath(new URL('./fixtures/stateChild.ts', import.meta.url))
  const snapshotChild = fileURLToPath(
    new URL('./fixtures/nativeRecoverySnapshot.ts', import.meta.url),
  )
  const writerConfig = join(f.root, 'writer-config.json')
  writeFileSync(writerConfig, JSON.stringify({ options, identity }), { mode: 0o600 })
  const writerCommand = repo.writerCommand(identity, process.execPath, [
    '--import',
    'tsx',
    stateChild,
    'writer',
    writerConfig,
  ])
  const writer = spawn(writerCommand.executable, writerCommand.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const writerClosed = once(writer, 'close')
  t.after(() => {
    if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL')
  })
  let writerErr = ''
  writer.stderr.on('data', (b) => {
    writerErr += b.toString()
  })
  const readyTimer = setTimeout(() => writer.kill('SIGKILL'), 20000)
  try {
    const ready = await Promise.race([
      once(writer.stdout, 'data').then(([b]) => b.toString()),
      writerClosed.then(() => {
        throw new Error(`writer-closed-before-lock:${writerErr}`)
      }),
    ])
    assert.match(ready, /"locked":true/)
  } finally {
    clearTimeout(readyTimer)
  }
  appendFileSync(transcript, line('head1'))
  const expected = readFileSync(transcript, 'utf8')
  const { token } = await recovery(f)
  let sequence = 0
  async function run(mode: 'snapshot' | 'restore', fault?: string, checkpointId?: string) {
    const configFile = join(f.root, `snapshot-${sequence++}.json`)
    const restoreOptions = { ...options, nativeRoot: join(f.root, 'fresh-native') }
    const config =
      mode === 'snapshot'
        ? {
            database: f.path,
            options,
            peer,
            token,
            now: f.now(),
            fault,
            request: {
              authority: {
                dispatchId: 'd1',
                turnKey: 't1',
                tapeCursor: 1,
                nativeHeadUuid: 'head1',
              },
              transcriptRelativePath: relativePath,
            },
          }
        : { options: restoreOptions, identity, checkpointId }
    writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 })
    const lockRepo = mode === 'snapshot' ? repo : new NativeStateRepository(restoreOptions)
    const args =
      mode === 'snapshot'
        ? ['--import', 'tsx', snapshotChild, configFile]
        : ['--import', 'tsx', stateChild, 'restore', configFile]
    const command = lockRepo.stateTaskCommand(identity, process.execPath, args)
    const child = spawn(command.executable, command.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    const deadline = setTimeout(() => child.kill('SIGKILL'), 20000)
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => {
      out += b.toString()
    })
    child.stderr.on('data', (b) => {
      err += b.toString()
    })
    try {
      const [code, signal] = await closed
      return { code, signal, out, err }
    } finally {
      clearTimeout(deadline)
    }
  }
  const whileAlive = await run('snapshot')
  assert.equal(whileAlive.code, 1)
  assert.equal((await metadata(f)).nativeRecovery!.phase, 'pending')
  writer.kill('SIGTERM')
  await writerClosed
  assert.ok(writer.signalCode || writer.exitCode !== null)
  const before = await run('snapshot', 'before-commit')
  assert.equal(before.code, 1)
  assert.match(before.err, /injected-before-control-commit/)
  assert.equal((await metadata(f)).nativeCheckpoint, undefined)
  const after = await run('snapshot', 'after-commit')
  assert.equal(after.signal, 'SIGKILL')
  const committed = await metadata(f)
  assert.equal(committed.nativeDeliveryWatermark, 0)
  assert.equal(committed.nativeCheckpointWatermark, 0)
  assert.equal(committed.nativeWriterGeneration, 1)
  assert.equal(committed.nativeSealedWriterGeneration, 1)
  assert.equal(committed.nativeRecovery!.phase, 'completed')
  const replay = await run('snapshot')
  assert.equal(replay.code, 0, replay.err)
  assert.equal(JSON.parse(replay.out).checkpointId, committed.nativeCheckpoint!.checkpointId)
  rmSync(options.nativeRoot, { recursive: true })
  const restored = await run('restore', undefined, committed.nativeCheckpoint!.checkpointId)
  assert.equal(restored.code, 0, restored.err)
  assert.equal(readFileSync(join(f.root, 'fresh-native', relativePath), 'utf8'), expected)
})

test('native-only recovery refuses legacy unresolved work without installing a pending gate', async (t) => {
  const f = await fixture(t)
  const semantic = {
    protocolVersion: 1 as const,
    binding: f.binding,
    operationId: 'legacy1',
    deadlineAtMs: 10000,
    command: {
      kind: 'file.read' as const,
      path: '/workspace/synthetic',
      offsetBytes: 0,
      limitBytes: 100,
    },
  }
  await f.service.accept('u1', {
    ...semantic,
    lease: f.lease,
    payloadHash: agentRemotePayloadHash(semantic),
  })
  await f.service.authorizeStart('u1', f.binding, 'legacy1', f.lease)
  f.setNow(2001)
  const service = new NativeRecoveryService(f.store, peer, f.now, syntheticPort)
  await assert.rejects(
    service.claim('u1', f.binding, identity, 0, 'legacy-blocked', 1000),
    /native-recovery-legacy-inflight/,
  )
  const state = await metadata(f)
  assert.equal(state.nativeRecoveryGeneration, 0)
  assert.equal(state.nativeRecovery, undefined)
  assert.equal(state.epochWatermark, 1)
  const nextLease = await f.service.claim('u1', f.binding, 1000)
  assert.equal(nextLease.epoch, 2)
})
