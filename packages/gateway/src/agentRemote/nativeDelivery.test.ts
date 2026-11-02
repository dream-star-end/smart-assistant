/** Control metadata/CAS tests use synthetic Writer proofs. Actual streaming
 * filesystem readback remains runtime work; these do not certify disk IO. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import type { NativeFrame, NativeScope } from '@openclaude/protocol/agentRemoteNative'
import {
  type NativeDeliveryPreparation,
  nativeDeliveryPreparationHash,
  nativeMessageProjectionsHash,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
import Database from 'better-sqlite3'
import { SqliteAgentRemoteStore } from './durableStore.js'
import { createInterruptedWal } from './fixtures/interruptedWal.js'
import { fixture, receipt, syntheticDelivery } from './fixtures/nativeFixture.js'
import {
  nativeJournalEventHash,
  nativeReceiptHash,
  verifyNativeJournalRecord,
} from './nativeJournal.js'
import { NativeJournalService } from './nativeService.js'

async function seed(t: test.TestContext) {
  const f = await fixture(t)
  const row = f.record()
  receipt(row)
  await f.store.transact('u1', (state) => {
    state.nativeJournal.push(row)
  })
  const scope: NativeScope = {
    binding: f.binding,
    nativeSessionId: row.request.nativeSessionId,
    environmentIncarnation: 'boot1',
    lease: f.lease,
    connectionId: 'writer1',
    challenge: 'a'.repeat(64),
  }
  return {
    f,
    row,
    scope,
    native: new NativeJournalService(f.store, f.now),
    ...syntheticDelivery(row),
  }
}
function rehash(value: NativeDeliveryPreparation, payloadHash: string) {
  value.preparationHash = nativeDeliveryPreparationHash(payloadHash, value)
  return value
}
function ack(scope: NativeScope, row: Awaited<ReturnType<typeof seed>>['row']): NativeFrame {
  return {
    nativeProtocolVersion: 1,
    scope,
    sender: 'worker',
    operationId: row.request.operationId,
    sequence: 1,
    body: row.deliveryAck!,
  }
}
test('prepared delivery survives control restart; proof commits its original ACK atomically and repeats do not replace the head', async (t) => {
  const { f, row, scope, native, preparation, proof } = await seed(t)
  const hash = row.request.body.payloadHash
  const prepared = await native.prepareDelivery('u1', scope, 'op1', hash, preparation)
  assert.equal(prepared.deliveryAck, undefined)
  assert.equal(prepared.state, 'dispatched')
  assert.deepEqual(await native.prepareDelivery('u1', scope, 'op1', hash, preparation), prepared)
  f.store.close()
  const reopened = new SqliteAgentRemoteStore(f.path)
  try {
    const service = new NativeJournalService(reopened, f.now)
    const loaded = await service.query('u1', scope, 'op1', hash)
    assert.deepEqual(loaded.deliveryPreparation, preparation)
    const committed = await service.commitDelivery(
      'u1',
      scope,
      'op1',
      hash,
      preparation.preparationHash,
      proof,
    )
    assert.equal(committed.state, 'completed')
    assert.deepEqual(committed.deliveryAck, committed.deliveryCommit!.ack)
    const laterProof = structuredClone(proof)
    laterProof.main.headUuid = '00000000-0000-4000-8000-000000000099'
    laterProof.main.prefixHash = 'f'.repeat(64)
    assert.deepEqual(
      await service.commitDelivery(
        'u1',
        scope,
        'op1',
        hash,
        preparation.preparationHash,
        laterProof,
      ),
      committed,
    )
    assert.deepEqual(await service.acknowledge('u1', scope, ack(scope, committed)), committed)
  } finally {
    reopened.close()
  }
})
test('wrong receipt/source/manifest and changed preparation cannot create or alter delivery authority', async (t) => {
  const { f, row, scope, native, preparation } = await seed(t)
  const hash = row.request.body.payloadHash
  for (const mutate of [
    (p: NativeDeliveryPreparation) => {
      p.receiptHash = '0'.repeat(64)
    },
    (p: NativeDeliveryPreparation) => {
      if (p.source.kind === 'execution') p.source.ledgerId = 'other'
    },
    (p: NativeDeliveryPreparation) => {
      if (p.source.kind === 'execution') p.source.sealedEventHash = 'f'.repeat(64)
    },
    (p: NativeDeliveryPreparation) => {
      p.artifactCount = 1
    },
  ]) {
    const bad = structuredClone(preparation)
    mutate(bad)
    rehash(bad, hash)
    await assert.rejects(native.prepareDelivery('u1', scope, 'op1', hash, bad))
  }
  await native.prepareDelivery('u1', scope, 'op1', hash, preparation)
  const changed = structuredClone(preparation)
  changed.messages[0]!.projectionHash = 'f'.repeat(64)
  rehash(changed, hash)
  await assert.rejects(
    native.prepareDelivery('u1', scope, 'op1', hash, changed),
    /native-delivery-prepare-conflict/,
  )
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.nativeJournal[0]!.deliveryPreparation = changed
    }),
    /stored-native-evidence-mutation/,
  )
})
test('proof requires exact target groups, scope, artifact manifest and actual-main prefix agreement', async (t) => {
  const { row, scope, native, preparation, proof } = await seed(t)
  const hash = row.request.body.payloadHash
  await native.prepareDelivery('u1', scope, 'op1', hash, preparation)
  for (const mutate of [
    (p: typeof proof) => {
      p.nativeSessionId = '00000000-0000-4000-8000-000000000099'
    },
    (p: typeof proof) => {
      p.artifactManifestHash = 'f'.repeat(64)
    },
    (p: typeof proof) => {
      p.files[0]!.projectionsHash = 'f'.repeat(64)
    },
    (p: typeof proof) => {
      p.main.prefixHash = 'f'.repeat(64)
    },
    (p: typeof proof) => {
      p.files.push({ ...p.files[0]! })
    },
  ]) {
    const bad = structuredClone(proof)
    mutate(bad)
    await assert.rejects(
      native.commitDelivery('u1', scope, 'op1', hash, preparation.preparationHash, bad),
    )
  }
  assert.equal((await native.query('u1', scope, 'op1', hash)).deliveryAck, undefined)
})
test('sidechain proof preserves the distinct actual main head', async (t) => {
  const { row, scope, native, preparation, proof } = await seed(t)
  const hash = row.request.body.payloadHash
  const target = { kind: 'sidechain' as const, agentId: 'a0123456789abcdef' }
  preparation.messages[0]!.target = target
  rehash(preparation, hash)
  proof.preparationHash = preparation.preparationHash
  proof.files = [
    {
      target,
      headBytes: 250,
      prefixHash: 'd'.repeat(64),
      projectionsHash: nativeMessageProjectionsHash(preparation.messages),
    },
  ]
  await native.prepareDelivery('u1', scope, 'op1', hash, preparation)
  const committed = await native.commitDelivery(
    'u1',
    scope,
    'op1',
    hash,
    preparation.preparationHash,
    proof,
  )
  assert.equal(committed.deliveryAck!.nativeHeadHash, proof.main.prefixHash)
  assert.notEqual(committed.deliveryAck!.nativeHeadHash, proof.files[0]!.prefixHash)
})
test('source blob references must match sealed Host envelope declarations rather than Worker-supplied paths', async (t) => {
  const { f, row, scope } = await seed(t)
  const blob = { resourceId: 'blob1', sizeBytes: 9 * 1024 * 1024, sha256: 'd'.repeat(64) }
  const last = row.events.at(-1)!
  assert.equal(last.body.kind, 'native.receipt')
  if (last.body.kind !== 'native.receipt') throw Error('fixture')
  last.body.message = { nativeDelivery: { version: 1, blobs: [blob] } }
  const { sha256: _previous, ...event } = last
  last.sha256 = nativeJournalEventHash(row.request.body.payloadHash, event)
  row.receipt = {
    body: { ...last.body, status: 'completed' },
    sha256: nativeReceiptHash(row.request.body.payloadHash, last.body),
  }
  // Replace the uncommitted test seed before service admission; no real bytes are implied.
  const path = f.path
  f.store.close()
  // Use a fresh operation store to avoid bypassing immutable runtime evidence.
  const freshPath = `${path}.blob`
  const store = new SqliteAgentRemoteStore(freshPath)
  try {
    await store.transact('u1', (state) => {
      state.workers = [{ ...f.worker, expiresAtMs: 301000 }]
      state.environments = [f.environment]
      state.sessions = [
        {
          binding: f.binding,
          epochWatermark: 1,
          nativeSessionId: row.request.nativeSessionId,
          nativeDeliveryWatermark: 0,
          nativeCheckpointWatermark: 0,
          nativeWriterGeneration: 0,
          nativeSealedWriterGeneration: 0,
          nativeRecoveryGeneration: 0,
          lease: { ...f.lease, expiresAtMs: 2000, active: true },
        },
      ]
      state.nativeJournal = [row]
    })
    const service = new NativeJournalService(store, f.now)
    const { preparation } = syntheticDelivery(row)
    await assert.rejects(
      service.prepareDelivery('u1', scope, 'op1', row.request.body.payloadHash, preparation),
      /native-delivery-source-blobs/,
    )
    if (preparation.source.kind !== 'execution') throw Error('fixture')
    preparation.source.blobs = [blob]
    rehash(preparation, row.request.body.payloadHash)
    assert.equal(
      (await service.prepareDelivery('u1', scope, 'op1', row.request.body.payloadHash, preparation))
        .deliveryPreparation!.source.kind,
      'execution',
    )
  } finally {
    store.close()
  }
})
test('format v2 is rejected before WAL or database mutation because old writers do not enforce commit gates', async (t) => {
  const { f } = await seed(t)
  f.store.close()
  const db = new Database(f.path)
  db.pragma('journal_mode = DELETE')
  db.pragma('user_version = 2')
  db.close()
  const before = readFileSync(f.path)
  assert.throws(() => new SqliteAgentRemoteStore(f.path), /state-format-version/)
  assert.equal(existsSync(`${f.path}-wal`), false)
  assert.deepEqual(readFileSync(f.path), before)
})
test('execution evidence cannot consume the reserved delivery/ACK capacity', async (t) => {
  const f = await fixture(t)
  const row = f.record()
  row.dispatch = { hostInstanceId: 'h1', ledgerId: 'l1', grantId: 'g1' }
  row.state = 'dispatched'
  const text = 'x'.repeat(7 * 1024 * 1024)
  for (let i = 0; i < 7; i++) {
    const event = {
      sequence: i + 1,
      sender: 'execution' as const,
      producerInstanceId: 'h1',
      ledgerId: 'l1',
      epoch: 1,
      body: { kind: 'native.progress' as const, message: { text } },
    }
    row.events.push({
      ...event,
      sha256: nativeJournalEventHash(row.request.body.payloadHash, event),
    })
  }
  assert.throws(() => verifyNativeJournalRecord(row), /native-ordinary-event-capacity/)
  await assert.rejects(
    f.store.transact('u1', (state) => {
      state.nativeJournal.push(row)
    }),
    /native-ordinary-event-capacity/,
  )
  assert.equal((await f.store.transact('u1', (state) => state.nativeJournal)).length, 0)
})

test('stored preparation enforces sealed source and artifacts even if inserted without the service', async (t) => {
  const { f, row, preparation } = await seed(t)
  for (const mutate of [
    (p: NativeDeliveryPreparation) => {
      if (p.source.kind === 'execution') p.source.ledgerId = 'foreign'
    },
    (p: NativeDeliveryPreparation) => {
      p.artifactManifestHash = 'f'.repeat(64)
    },
    (p: NativeDeliveryPreparation) => {
      if (p.source.kind === 'execution')
        p.source.blobs = [{ resourceId: 'invented', sizeBytes: 1, sha256: 'f'.repeat(64) }]
    },
  ]) {
    const bad = structuredClone(preparation)
    mutate(bad)
    rehash(bad, row.request.body.payloadHash)
    await assert.rejects(
      f.store.transact('u1', (state) => {
        state.nativeJournal[0]!.deliveryPreparation = bad
      }),
      /native-delivery-(source|artifact)/,
    )
  }
  assert.equal(
    (await f.store.transact('u1', (state) => state.nativeJournal[0]!)).deliveryPreparation,
    undefined,
  )
})

test('old control format with crash WAL rejects without checkpointing or deleting evidence', async (t) => {
  const { f } = await seed(t)
  const filename = `${f.root}/old-control.sqlite`
  createInterruptedWal(filename, 1095912753, 2)
  const db = readFileSync(filename)
  const wal = readFileSync(`${filename}-wal`)
  assert.ok(wal.length > 0)
  assert.throws(() => new SqliteAgentRemoteStore(filename), /state-format-version/)
  assert.deepEqual(readFileSync(filename), db)
  assert.deepEqual(readFileSync(`${filename}-wal`), wal)
})

test('a fully filtered native result commits no projections using the real Writer main boundary', async (t) => {
  const { row, scope, native, preparation, proof } = await seed(t)
  preparation.messages = []
  rehash(preparation, row.request.body.payloadHash)
  proof.preparationHash = preparation.preparationHash
  proof.files = []
  await native.prepareDelivery('u1', scope, 'op1', row.request.body.payloadHash, preparation)
  const committed = await native.commitDelivery(
    'u1',
    scope,
    'op1',
    row.request.body.payloadHash,
    preparation.preparationHash,
    proof,
  )
  assert.equal(committed.state, 'completed')
  assert.deepEqual(committed.deliveryCommit!.proof.files, [])
  assert.equal(committed.deliveryAck!.nativeHeadRevision, proof.main.headUuid)
})
test('fork copies may share a UUID across distinct prepared files without merging their proofs', async (t) => {
  const { row, scope, native, preparation, proof } = await seed(t)
  const side = {
    ...preparation.messages[0]!,
    target: { kind: 'sidechain' as const, agentId: 'a0123456789abcdef' },
  }
  preparation.messages.push(side)
  rehash(preparation, row.request.body.payloadHash)
  proof.preparationHash = preparation.preparationHash
  proof.files.push({
    target: side.target,
    headBytes: 200,
    prefixHash: 'd'.repeat(64),
    projectionsHash: nativeMessageProjectionsHash([side]),
  })
  await native.prepareDelivery('u1', scope, 'op1', row.request.body.payloadHash, preparation)
  const committed = await native.commitDelivery(
    'u1',
    scope,
    'op1',
    row.request.body.payloadHash,
    preparation.preparationHash,
    proof,
  )
  assert.equal(committed.deliveryCommit!.proof.files.length, 2)
})
