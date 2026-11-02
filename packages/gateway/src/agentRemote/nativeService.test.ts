import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeFrame, NativeScope } from '@openclaude/protocol/agentRemoteNative'
import { nativeExecutionHash } from '@openclaude/protocol/agentRemoteNative'
import { fixture, syntheticDelivery, uuid } from './fixtures/nativeFixture.js'
import { type NativeJournalEvent, nativeJournalEventHash } from './nativeJournal.js'
import { NativeJournalService } from './nativeService.js'
const executor = { hostInstanceId: 'h1', ledgerId: 'l1', grantId: 'g1' }
type Fixture = Awaited<ReturnType<typeof fixture>>
function scope(f: Fixture): NativeScope {
  return {
    binding: f.binding,
    nativeSessionId: uuid,
    environmentIncarnation: 'boot1',
    lease: f.lease,
    connectionId: 'conn1',
    challenge: 'a'.repeat(64),
  }
}
function request(f: Fixture, s: NativeScope, operationId = 'op1'): NativeFrame {
  return {
    nativeProtocolVersion: 1,
    scope: s,
    sender: 'worker',
    operationId,
    sequence: 1,
    body: f.record(operationId).request.body,
  }
}
function evidence(
  payloadHash: string,
  sequence: number,
  body: NativeFrame['body'],
  epoch = 1,
): NativeJournalEvent {
  const event = {
    sequence,
    sender: 'execution' as const,
    producerInstanceId: executor.hostInstanceId,
    ledgerId: executor.ledgerId,
    epoch,
    body,
  }
  return { ...event, sha256: nativeJournalEventHash(payloadHash, event) }
}
function ack(
  s: NativeScope,
  receiptHash: string | Extract<NativeFrame['body'], { kind: 'native.delivery.ack' }>,
  operationId = 'op1',
): NativeFrame {
  return {
    nativeProtocolVersion: 1,
    scope: s,
    sender: 'worker',
    operationId,
    sequence: 1,
    body:
      typeof receiptHash === 'string'
        ? {
            kind: 'native.delivery.ack',
            receiptHash,
            nativeHeadRevision: 'head1',
            nativeHeadHash: 'b'.repeat(64),
            artifactManifestHash: 'c'.repeat(64),
          }
        : receiptHash,
  }
}
async function commitSynthetic(
  native: NativeJournalService,
  scope: NativeScope,
  row: import('./nativeJournal.js').NativeJournalRecord,
) {
  const { preparation, proof } = syntheticDelivery(row)
  await native.prepareDelivery(
    'u1',
    scope,
    row.request.operationId,
    row.request.body.payloadHash,
    preparation,
  )
  return native.commitDelivery(
    'u1',
    scope,
    row.request.operationId,
    row.request.body.payloadHash,
    preparation.preparationHash,
    proof,
  )
}
async function admitted(f: Fixture) {
  await f.service.beginNativeWriter('u1', f.binding, f.lease, uuid, 'writer-fixture')
  const s = scope(f)
  const native = new NativeJournalService(f.store, f.now)
  const row = await native.admit('u1', s, request(f, s))
  return { s, native, hash: row.request.body.payloadHash }
}
test('native admission dedups immutable semantics; forged transport/principal/deadline reject', async (t) => {
  const f = await fixture(t)
  const { s, native } = await admitted(f)
  const first = await native.admit('u1', s, request(f, s))
  assert.deepEqual(await native.admit('u1', s, request(f, s)), first)
  await assert.rejects(native.admit('u2', s, request(f, s)), /principal-mismatch/)
  await assert.rejects(
    native.admit('u1', s, { ...request(f, s), scope: { ...s, challenge: 'd'.repeat(64) } }),
    /native-scope-mismatch/,
  )
  const changed = request(f, s)
  assert.equal(changed.body.kind, 'native.execute')
  if (changed.body.kind !== 'native.execute') throw Error('fixture')
  changed.body.toolUse.input = { command: 'different' }
  const { payloadHash: _, ...body } = changed.body
  changed.body.payloadHash = nativeExecutionHash(s, 'op1', body)
  await assert.rejects(native.admit('u1', s, changed), /native-operation-conflict/)
  const expired = request(f, s, 'expired')
  if (expired.body.kind !== 'native.execute') throw Error('fixture')
  expired.body.deadlineAtMs = 1000
  const { payloadHash: __, ...semantic } = expired.body
  expired.body.payloadHash = nativeExecutionHash(s, 'expired', semantic)
  await assert.rejects(native.admit('u1', s, expired), /deadline-exceeded/)
})
test('each tool gets its own durable grant and effective input evidence; cancellation revokes further guards', async (t) => {
  const f = await fixture(t)
  const { s, native, hash } = await admitted(f)
  assert.equal((await native.query('u1', s, 'op1', hash)).state, 'accepted')
  await native.grant('u1', s, 'op1', hash, executor)
  const started = await native.started(
    'u1',
    s,
    'op1',
    hash,
    executor,
    { command: 'permission-modified' },
    2,
  )
  assert.equal(started.state, 'started')
  assert.deepEqual(
    (await native.started('u1', s, 'op1', hash, executor, { command: 'permission-modified' }, 2))
      .effectiveInput,
    started.effectiveInput,
  )
  await assert.rejects(
    native.started('u1', s, 'op1', hash, executor, { command: 'different' }, 2),
    /native-effective-input-conflict/,
  )
  await native.cancel('u1', s, 'op1', hash)
  await assert.rejects(native.grant('u1', s, 'op1', hash, executor), /native-not-startable/)
  await assert.rejects(
    native.started('u1', s, 'op1', hash, executor, { command: 'permission-modified' }, 2),
    /native-not-startable/,
  )
})
test('queued cancellation proves no grant; delivery remains separate and required', async (t) => {
  const f = await fixture(t)
  const { s, native, hash } = await admitted(f)
  const cancelled = await native.cancel('u1', s, 'op1', hash)
  assert.equal(cancelled.state, 'accepted')
  assert.equal(cancelled.dispatch, undefined)
  assert.equal(cancelled.receipt!.body.code, 'not-started')
  await assert.rejects(native.grant('u1', s, 'op1', hash, executor), /native-not-startable/)
  await assert.rejects(
    native.acknowledge('u1', s, ack(s, cancelled.receipt!.sha256)),
    /native-delivery-not-committed/,
  )
  const committed = await commitSynthetic(native, s, cancelled)
  assert.equal(
    (await native.acknowledge('u1', s, ack(s, committed.deliveryAck!))).state,
    'cancelled',
  )
})
test('final execution receipt seals its event prefix before Writer ACK; exact replay remains valid', async (t) => {
  const f = await fixture(t)
  const { s, native, hash } = await admitted(f)
  await native.grant('u1', s, 'op1', hash, executor)
  await native.started('u1', s, 'op1', hash, executor, { command: 'synthetic' }, 1)
  const event = evidence(hash, 1, {
    kind: 'native.receipt',
    payloadHash: hash,
    status: 'completed',
    message: { text: 'done' },
  })
  const received = await native.observe('u1', s, 'op1', hash, executor, event)
  assert.equal(received.state, 'started')
  assert.equal(received.deliveryAck, undefined)
  assert.deepEqual(await native.observe('u1', s, 'op1', hash, executor, event), received)
  for (const body of [
    { kind: 'native.progress' as const, message: { text: 'late' } },
    { kind: 'native.receipt' as const, payloadHash: hash, status: 'unknown' as const },
  ])
    await assert.rejects(
      native.observe('u1', s, 'op1', hash, executor, evidence(hash, 2, body)),
      /native-execution-already-finished/,
    )
  assert.equal((await native.cancel('u1', s, 'op1', hash)).cancelRequested, false)
  await assert.rejects(
    native.acknowledge('u1', s, ack(s, '0'.repeat(64))),
    /native-delivery-mismatch/,
  )
  await assert.rejects(
    native.acknowledge('u1', s, ack(s, received.receipt!.sha256)),
    /native-delivery-not-committed/,
  )
  const committed = await commitSynthetic(native, s, received)
  const completed = await native.acknowledge('u1', s, ack(s, committed.deliveryAck!))
  assert.equal(completed.state, 'completed')
  assert.deepEqual(await native.observe('u1', s, 'op1', hash, executor, event), completed)
})
test('same Worker new epoch does not replay old effects; old ledger receipt and committed delivery unblock new work', async (t) => {
  const f = await fixture(t)
  const { s, native, hash } = await admitted(f)
  await native.grant('u1', s, 'op1', hash, executor)
  await native.started('u1', s, 'op1', hash, executor, { command: 'synthetic' }, 1)
  f.setNow(2001)
  const lease = await f.service.claim('u1', f.binding, 1000)
  const renewed = { ...s, lease, connectionId: 'conn2', challenge: 'd'.repeat(64) }
  assert.equal((await native.recover('u1', renewed, 'op1', hash)).state, 'unknown')
  await assert.rejects(native.grant('u1', renewed, 'op1', hash, executor), /native-not-startable/)
  const second = await native.admit('u1', renewed, request(f, renewed, 'op2'))
  await assert.rejects(
    native.grant('u1', renewed, 'op2', second.request.body.payloadHash, {
      ...executor,
      grantId: 'g2',
    }),
    /native-old-execution-unresolved/,
  )
  const observed = await native.observe(
    'u1',
    renewed,
    'op1',
    hash,
    executor,
    evidence(hash, 1, { kind: 'native.receipt', payloadHash: hash, status: 'completed' }),
  )
  assert.equal(observed.claim.epoch, 1)
  const committed = await commitSynthetic(native, renewed, observed)
  await native.acknowledge('u1', renewed, ack(renewed, committed.deliveryAck!))
  assert.equal(
    (
      await native.grant('u1', renewed, 'op2', second.request.body.payloadHash, {
        ...executor,
        grantId: 'g2',
      })
    ).state,
    'dispatched',
  )
})
test('altered sequence, different ledger or producer cannot become trusted completion evidence', async (t) => {
  const f = await fixture(t)
  const { s, native, hash } = await admitted(f)
  await native.grant('u1', s, 'op1', hash, executor)
  const event = evidence(hash, 1, { kind: 'native.progress', message: { text: 'one' } })
  await native.observe('u1', s, 'op1', hash, executor, event)
  await assert.rejects(
    native.observe(
      'u1',
      s,
      'op1',
      hash,
      executor,
      evidence(hash, 1, { kind: 'native.progress', message: { text: 'changed' } }),
    ),
    /native-event-conflict/,
  )
  await assert.rejects(
    native.observe(
      'u1',
      s,
      'op1',
      hash,
      executor,
      evidence(hash, 3, { kind: 'native.progress', message: { text: 'gap' } }),
    ),
    /native-event-sequence/,
  )
  await assert.rejects(
    native.observe('u1', s, 'op1', hash, { ...executor, ledgerId: 'other' }, event),
    /native-evidence-producer/,
  )
})
