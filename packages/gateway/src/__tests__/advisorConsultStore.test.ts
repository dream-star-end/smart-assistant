import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  AdvisorConsultStore,
  hashEvidence,
  mintConsultId,
  type AdvisorConsultRecord,
} from '../advisorConsultStore.js'

function sample(dir: string, over: Partial<AdvisorConsultRecord> = {}): AdvisorConsultRecord {
  const snapshotJson = JSON.stringify({ tools: [{ name: 'Read', result: 'x' }] })
  return {
    consultId: mintConsultId(),
    invocationId: 'inv-1',
    userId: '3',
    sessionKey: 'agent:main:webchat:dm:s1',
    clientSessionId: 's1',
    originTurnKey: 'tk-1',
    originTurnIndex: 1,
    configVersion: 'v1:advisor:gpt-6-astra',
    evidenceVersion: hashEvidence(snapshotJson),
    advisorModel: 'gpt-6-astra',
    question: 'why is the test red?',
    concern: 'assertion mismatch',
    snapshotJson,
    jobId: null,
    billingRequestId: null,
    state: 'accepted',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  }
}

describe('advisorConsultStore', () => {
  it('inserts snapshot in the same row and reuses the same invocation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-advc-'))
    const store = new AdvisorConsultStore(join(dir, 'advisor-consults.db'))
    const first = store.insertNew(sample(dir))
    assert.equal(first.reused, false)
    assert.match(first.record.snapshotJson, /assertion mismatch|Read/)
    const second = store.insertNew(
      sample(dir, { consultId: mintConsultId(), question: 'why is the test red?' }),
    )
    assert.equal(second.reused, true)
    assert.equal(second.record.consultId, first.record.consultId)
    assert.equal(second.record.question, first.record.question)
    store.close()
  })

  it('persists billingRequestId before spawned state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-advc-'))
    const store = new AdvisorConsultStore(join(dir, 'advisor-consults.db'))
    const { record } = store.insertNew(sample(dir, { invocationId: 'inv-2' }))
    const attempted = store.update(record.consultId, { state: 'admission_attempt' })
    assert.equal(attempted.state, 'admission_attempt')
    const admitted = store.update(record.consultId, {
      state: 'admitted',
      billingRequestId: 'a'.repeat(32),
    })
    assert.equal(admitted.billingRequestId?.length, 32)
    const spawned = store.update(record.consultId, { state: 'spawned', jobId: 'dlgjob-x' })
    assert.equal(spawned.state, 'spawned')
    assert.equal(store.findByInvocation({
      userId: '3',
      originTurnKey: 'tk-1',
      invocationId: 'inv-2',
    })?.billingRequestId, 'a'.repeat(32))
    store.close()
  })

  it('records admit-before-spawn order and refuses to spawn without requestId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-advc-'))
    const store = new AdvisorConsultStore(join(dir, 'advisor-consults.db'))
    const { record } = store.insertNew(sample(dir, { invocationId: 'inv-order' }))
    const order: string[] = []
    order.push(record.state)
    store.update(record.consultId, { state: 'admission_attempt' })
    order.push('admission_attempt')
    const admitted = store.update(record.consultId, {
      state: 'admitted',
      billingRequestId: 'b'.repeat(32),
    })
    order.push(`admitted:${admitted.billingRequestId?.length}`)
    assert.equal(admitted.state, 'admitted')
    assert.ok(admitted.billingRequestId)
    const spawned = store.update(record.consultId, { state: 'spawned', jobId: 'dlgjob-1' })
    order.push(spawned.state)
    assert.deepEqual(order, ['accepted', 'admission_attempt', 'admitted:32', 'spawned'])
    assert.throws(() => store.update(mintConsultId(), { state: 'failed' }), /not found/)
    store.close()
  })
})
