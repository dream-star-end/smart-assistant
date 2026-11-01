/** Uses synthetic control projections, real SQLite and actual locked immutable
 * checkpoint/restore files. It tests delivery freshness, not model-write freshness. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentRemoteContentHash } from '@openclaude/protocol/agentRemote'
import type { NativeScope } from '@openclaude/protocol/agentRemoteNative'
import type {
  NativeCheckpoint,
  NativeCheckpointCapture,
  NativeCheckpointIdentity,
} from '@openclaude/protocol/agentRemoteState'
import Database from 'better-sqlite3'
import { SqliteAgentRemoteStore } from './durableStore.js'
import { createInterruptedWal } from './fixtures/interruptedWal.js'
import {
  type NativeFixture,
  deliver,
  fixture,
  receipt,
  syntheticDelivery,
  uuid,
} from './fixtures/nativeFixture.js'
import { NativeJournalService } from './nativeService.js'
import { NativeStateRepository } from './nativeState.js'
import { createAgentRemoteService } from './service.js'

const childPath = fileURLToPath(new URL('./fixtures/stateChild.ts', import.meta.url))
function files(f: NativeFixture) {
  const options = { nativeRoot: join(f.root, 'native'), stateRoot: join(f.root, 'snapshots') }
  const repo = new NativeStateRepository(options)
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
  const transcriptRelativePath = `projects/-workspace/${uuid}.jsonl`
  const transcript = join(options.nativeRoot, transcriptRelativePath)
  mkdirSync(dirname(transcript), { recursive: true, mode: 0o700 })
  const line = (head: string) =>
    `${JSON.stringify({ type: 'user', uuid: head, sessionId: uuid, message: { role: 'user', content: `synthetic-${head}` } })}\n`
  writeFileSync(transcript, line('head0'), { mode: 0o600 })
  let sequence = 0
  const request = (head: string) => ({
    identity,
    bindingRevision: f.binding.bindingRevision,
    checkpointCaptureId: 'placeholder',
    nativeDeliveryWatermark: 0,
    authority: { dispatchId: 'd1', turnKey: 't1', tapeCursor: 1, nativeHeadUuid: head },
    transcriptRelativePath,
    createdAtMs: 1000,
  })
  async function run(mode: string, config: Record<string, unknown>) {
    const configFile = join(f.root, `checkpoint-config-${sequence++}.json`)
    writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 })
    const command = repo.stateTaskCommand(identity, process.execPath, [
      '--import',
      'tsx',
      childPath,
      mode,
      configFile,
    ])
    const child = spawn(command.executable, command.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    const deadline = setTimeout(() => child.kill('SIGKILL'), 20000)
    let out = ''
    let err = ''
    child.stdout.on('data', (bytes) => {
      out += bytes.toString()
    })
    child.stderr.on('data', (bytes) => {
      err += bytes.toString()
    })
    try {
      const [code, signal] = await closed
      return { code, signal, out, err }
    } finally {
      clearTimeout(deadline)
    }
  }
  const checkpoint = async (head: string, capture?: NativeCheckpointCapture) => {
    const pointer = join(f.root, 'current.json')
    const result = await run('checkpoint', {
      options,
      identity,
      request: request(head),
      transcript,
      pointer,
      service: {
        database: f.path,
        binding: f.binding,
        lease: f.lease,
        now: f.now(),
        ...(capture ? { capture } : {}),
      },
    })
    return {
      ...result,
      checkpoint:
        result.code === 0
          ? (JSON.parse(readFileSync(pointer, 'utf8')) as NativeCheckpoint)
          : undefined,
    }
  }
  const restore = async (checkpoint: NativeCheckpoint) => {
    const nativeRoot = join(f.root, 'fresh-native')
    const result = await run('restore', {
      options: { ...options, nativeRoot },
      identity,
      checkpointId: checkpoint.checkpointId,
    })
    return {
      ...result,
      text: result.code === 0 ? readFileSync(join(nativeRoot, transcriptRelativePath), 'utf8') : '',
    }
  }
  return { repo, identity, transcript, line, checkpoint, restore }
}
async function commit(f: NativeFixture, operationId = 'op1') {
  const row = f.record(operationId)
  receipt(row)
  await f.store.transact('u1', (state) => {
    state.nativeJournal.push(row)
  })
  const scope: NativeScope = {
    binding: f.binding,
    nativeSessionId: uuid,
    environmentIncarnation: 'boot1',
    lease: f.lease,
    connectionId: 'writer',
    challenge: 'a'.repeat(64),
  }
  const native = new NativeJournalService(f.store, f.now)
  const { preparation, proof } = syntheticDelivery(row)
  await native.prepareDelivery('u1', scope, operationId, row.request.body.payloadHash, preparation)
  const result = await native.commitDelivery(
    'u1',
    scope,
    operationId,
    row.request.body.payloadHash,
    preparation.preparationHash,
    proof,
  )
  return { row, scope, native, preparation, proof, result }
}
test('committed delivery survives active-only selection; C0 cannot authorize migration or restore before a fresh C1', async (t) => {
  const f = await fixture(t)
  const disk = files(f)
  const c0 = await disk.checkpoint('head0')
  assert.equal(c0.code, 0, c0.err)
  const delivered = await commit(f)
  appendFileSync(disk.transcript, disk.line(delivered.proof.main.headUuid))
  const state = await f.store.transact('u1', (value) => value, 'active')
  assert.equal(state.nativeJournal.length, 0)
  assert.equal(state.sessions[0]!.nativeDeliveryWatermark, 1)
  assert.equal(state.sessions[0]!.nativeCheckpointWatermark, 0)
  await assert.rejects(
    f.service.registerWorker('u1', { ...f.worker, workerInstanceId: 'wi2' }, 300000),
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
    f.service.nativeCheckpoint('u1', f.binding, disk.identity),
    /native-checkpoint-stale/,
  )
  await f.service.registerWorker('u1', f.worker, 300000)
  await f.service.renew('u1', f.binding, f.lease, 1000)
  await delivered.native.query('u1', delivered.scope, 'op1', delivered.row.request.body.payloadHash)
  await delivered.native.commitDelivery(
    'u1',
    delivered.scope,
    'op1',
    delivered.row.request.body.payloadHash,
    delivered.preparation.preparationHash,
    delivered.proof,
  )
  assert.equal(
    await f.store.transact('u1', (s) => s.sessions[0]!.nativeDeliveryWatermark, 'active'),
    1,
  )
  const otherNative = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  await assert.rejects(
    f.service.captureNativeCheckpoint('u1', f.binding, f.lease, {
      ...disk.identity,
      nativeSessionId: otherNative,
    }),
    /native-session-mismatch/,
  )
  await assert.rejects(
    f.service.pinNativeSession('u1', f.binding, f.lease, otherNative),
    /native-session-mismatch/,
  )
  await assert.rejects(
    f.store.transact(
      'u1',
      (state) => {
        state.sessions[0]!.nativeSessionId = otherNative
      },
      'active',
    ),
    /stored-native-session-mismatch|stored-native-session-identity/,
  )
  const capture = await f.service.captureNativeCheckpoint('u1', f.binding, f.lease, disk.identity)
  await assert.rejects(
    f.service.publishNativeCheckpoint('u1', f.binding, f.lease, c0.checkpoint!),
    /checkpoint-capture-stale/,
  )
  const c1 = await disk.checkpoint(delivered.proof.main.headUuid, capture)
  assert.equal(c1.code, 0, c1.err)
  assert.equal(c1.checkpoint!.nativeDeliveryWatermark, 1)
  assert.equal(c1.checkpoint!.checkpointCaptureId, capture.captureId)
  assert.deepEqual(
    await f.service.publishNativeCheckpoint('u1', f.binding, f.lease, c1.checkpoint!),
    c1.checkpoint,
  )
  const restored = await disk.restore(c1.checkpoint!)
  assert.equal(restored.code, 0, restored.err)
  assert.ok(restored.text.includes(delivered.proof.main.headUuid))
  await f.service.registerWorker('u1', { ...f.worker, workerInstanceId: 'wi2' }, 300000)
  const rebound = await f.service.bind('u1', {
    sessionId: 's1',
    workerId: 'w1',
    environmentId: 'e1',
  })
  assert.equal(rebound.bindingRevision, 2)
  assert.equal(
    (await f.service.nativeCheckpoint('u1', rebound, disk.identity))!.checkpointId,
    c1.checkpoint!.checkpointId,
  )
})
test('copy captured before another delivery cannot publish that later version; failed publication keeps C0', async (t) => {
  const f = await fixture(t)
  const disk = files(f)
  const c0 = await disk.checkpoint('head0')
  assert.equal(c0.code, 0, c0.err)
  const capture = await f.service.captureNativeCheckpoint('u1', f.binding, f.lease, disk.identity)
  const delivered = await commit(f)
  appendFileSync(disk.transcript, disk.line(delivered.proof.main.headUuid))
  const stale = await disk.checkpoint(delivered.proof.main.headUuid, capture)
  assert.equal(stale.code, 1)
  assert.match(stale.err, /checkpoint-capture-stale/)
  assert.equal(
    await f.store.transact('u1', (s) => s.sessions[0]!.nativeCheckpoint!.checkpointId, 'active'),
    c0.checkpoint!.checkpointId,
  )
  await assert.rejects(
    f.store.transact('u1', (s) => {
      s.sessions[0]!.nativeDeliveryWatermark = 0
    }),
    /stored-native-watermark-transition/,
  )
  await assert.rejects(
    f.store.transact('u1', (s) => {
      s.sessions[0]!.nativeCheckpointWatermark = 1
    }),
    /stored-native-checkpoint-watermark/,
  )
})

test('native delivery version and UUID pin survive reopen even when terminal rows are omitted', async (t) => {
  const f = await fixture(t)
  const forged = f.record()
  receipt(forged)
  deliver(forged)
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.nativeJournal.push(forged)
    }),
    /stored-native-watermark-transition/,
  )
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.sessions[0]!.nativeDeliveryWatermark++
    }),
    /stored-native-watermark-transition/,
  )
  await commit(f)
  f.store.close()
  const reopened = new SqliteAgentRemoteStore(f.path)
  t.after(() => reopened.close())
  const snapshot = await reopened.transact('u1', (state) => state, 'active')
  assert.equal(snapshot.nativeJournal.length, 0)
  assert.equal(snapshot.sessions[0]!.nativeDeliveryWatermark, 1)
  assert.equal(snapshot.sessions[0]!.nativeCheckpointWatermark, 0)
  assert.equal(snapshot.sessions[0]!.nativeSessionId, uuid)
  await assert.rejects(
    reopened.transact(
      'u1',
      (state) => {
        Reflect.deleteProperty(state.sessions[0]!, 'nativeSessionId')
      },
      'active',
    ),
    /stored-native-session-identity/,
  )
  const service = createAgentRemoteService({
    env: { OC_AGENT_REMOTE_ENABLED: '1' },
    createStore: () => reopened,
    clock: f.now,
  })!
  await assert.rejects(
    service.registerWorker('u1', { ...f.worker, workerInstanceId: 'wi2' }, 300000),
    /native-checkpoint-stale/,
  )
})
test('old v3 WAL format is rejected without changing database or pending WAL bytes', async (t) => {
  const f = await fixture(t)
  const path = join(f.root, 'old-v3.sqlite')
  createInterruptedWal(path, 0x41524d31, 3)
  const databaseBytes = readFileSync(path)
  const walBytes = readFileSync(`${path}-wal`)
  assert.throws(() => new SqliteAgentRemoteStore(path), /state-format-version/)
  assert.deepEqual(readFileSync(path), databaseBytes)
  assert.deepEqual(readFileSync(`${path}-wal`), walBytes)
})
test('format v4 missing version metadata is rejected rather than interpreted as a clean zero boundary', async (t) => {
  const f = await fixture(t)
  f.store.close()
  const raw = new Database(f.path)
  const stored = raw
    .prepare('SELECT payload FROM agent_remote_principals WHERE principal_id=?')
    .get('u1') as { payload: string }
  const metadata = JSON.parse(stored.payload)
  Reflect.deleteProperty(metadata.sessions[0], 'nativeDeliveryWatermark')
  Reflect.deleteProperty(metadata.sessions[0], 'nativeCheckpointWatermark')
  const payload = JSON.stringify(metadata)
  raw
    .prepare('UPDATE agent_remote_principals SET payload=?,payload_sha256=? WHERE principal_id=?')
    .run(payload, agentRemoteContentHash(payload), 'u1')
  raw.close()
  const reopened = new SqliteAgentRemoteStore(f.path)
  t.after(() => reopened.close())
  await assert.rejects(
    reopened.transact('u1', (state) => state, 'active'),
    /bad-shape/,
  )
})
