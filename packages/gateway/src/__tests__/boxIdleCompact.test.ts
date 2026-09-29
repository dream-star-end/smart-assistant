import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fetchBoxIdleProof } from '../engine/boxIdleProofClient.js'
import {
  advanceIdleOp,
  assembleIdleArtifact,
  IDLE_COMPACT_PROMPT,
  clearIdleCandidate,
  idleOpSettled,
  readIdleCandidate,
  readPendingIdle,
  writeIdleCandidate,
  startIdleOp,
  writeIdleOp,
} from '../boxIdleCompact.js'

const proof = {
  status: 'terminal' as const,
  sessionId: 'ccb-session',
  turnKey: 'ab'.repeat(32),
  requestId: 'leaf',
  revision: 'rev-1',
  compactRequired: true,
  capsuleSha256: 'c'.repeat(64),
  summaryText: 'kept goal',
}

describe('idle artifact recovery', () => {
  let dir = ''
  after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  test('same capsule and frozen tail rebuild one artifact without a model call', async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-art-'))
    const started = startIdleOp({
      dir, sessionKey: 's', sourceSessionId: proof.sessionId, sourceTurnKey: proof.turnKey,
      revision: proof.revision, idleTurnKey: 'ab'.repeat(32),
      frozenTail: [{ uuid: 'tail-1', parentUuid: null, text: 'kept tail' }],
      attachments: [{ uuid: 'att-1', text: 'hook-once' }],
    })
    const again = startIdleOp({
      dir, sessionKey: 's', sourceSessionId: proof.sessionId, sourceTurnKey: proof.turnKey,
      revision: proof.revision, idleTurnKey: 'cd'.repeat(32),
      frozenTail: [], attachments: [],
    })
    assert.equal(started.ownedDispatch, true)
    assert.equal(again.ownedDispatch, false)
    assert.equal(again.op.idleTurnKey, started.op.idleTurnKey)
    const ignored = advanceIdleOp({ op: started.op, proof, allowDispatch: false })
    assert.equal(ignored.callModel, false)
    assert.equal(ignored.op.summaryText, undefined)
    const stepped = advanceIdleOp({ op: started.op, proof, useProofSummary: true })
    assert.equal(stepped.callModel, false)
    assert.deepEqual(stepped.op.artifact?.messages[1]?.message, { role: 'user', content: 'kept goal' })
    const direct = assembleIdleArtifact({
      opId: started.op.idleTurnKey, summaryText: 'kept goal',
      tail: started.op.frozenTail, attachments: started.op.attachments,
    })
    assert.equal(stepped.op.artifact?.digest, direct.digest)
    const verified = advanceIdleOp({
      op: stepped.op,
      proof: { status: 'pending', reason: 'settled' },
      loadDigest: (artifact) => artifact.digest,
    })
    assert.equal(verified.callModel, false)
    assert.equal(verified.op.receiptDigest, direct.digest)
    const lostReceipt = advanceIdleOp({
      op: { ...stepped.op, receiptDigest: undefined },
      proof: { status: 'pending', reason: 'settled' },
      loadDigest: (artifact) => artifact.digest,
    })
    assert.equal(lostReceipt.op.receiptDigest, direct.digest)
    assert.equal(lostReceipt.callModel, false)
  })

  test('pending proof and a missing artifact do not call the model or count as applied', () => {
    const op = {
      v: 1 as const,
      sessionKey: 's',
      sourceSessionId: 'ccb-session',
      sourceTurnKey: proof.turnKey,
      revision: 'rev-1',
      idleTurnKey: 'turn-key-1',
      frozenTail: [],
      attachments: [],
    }
    const pending = advanceIdleOp({ op, proof: { status: 'pending', reason: 'unsettled' } })
    assert.equal(pending.callModel, false)
    assert.equal(pending.op.artifact, undefined)
    const stored = advanceIdleOp({
      op: { ...op, summaryText: 'kept goal' },
      proof: { status: 'pending', reason: 'unsettled' },
    })
    assert.equal(stored.callModel, false)
    assert.ok(stored.op.artifact)
    assert.throws(() => advanceIdleOp({
      op: stored.op,
      proof: { status: 'pending', reason: 'unsettled' },
      loadDigest: () => 'different',
    }))
    assert.equal(IDLE_COMPACT_PROMPT.startsWith('/compact '), true)
  })

  test('a second submit of the same op does not ask for another compact', async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-art-'))
    const started = startIdleOp({
      dir, sessionKey: 's2', sourceSessionId: proof.sessionId, sourceTurnKey: proof.turnKey,
      revision: proof.revision, idleTurnKey: 'ab'.repeat(32),
      frozenTail: [{ uuid: 'tail-1', parentUuid: null, text: 'kept tail' }], attachments: [],
    })
    const bare = { ...proof, summaryText: undefined }
    const first = advanceIdleOp({ op: started.op, proof: bare, allowDispatch: started.ownedDispatch })
    assert.equal(first.callModel, true)
    writeIdleOp(dir, first.op)
    const recovered = startIdleOp({
      dir, sessionKey: 's2', sourceSessionId: proof.sessionId, sourceTurnKey: proof.turnKey,
      revision: proof.revision, idleTurnKey: 'ff'.repeat(32),
      frozenTail: [], attachments: [],
    })
    const second = advanceIdleOp({ op: recovered.op, proof: bare, allowDispatch: recovered.ownedDispatch })
    assert.equal(recovered.ownedDispatch, false)
    assert.equal(second.callModel, false)
    const assembled = advanceIdleOp({
      op: { ...recovered.op, summaryText: 'kept goal' },
      proof: { status: 'pending', reason: 'unsettled' },
    })
    assert.equal(assembled.callModel, false)
    assert.ok(assembled.op.artifact)
    assert.equal(assembled.op.artifact?.messages.some((message) => message.text === 'kept tail'), true)
  })

  test('a new op with no artifact is still pending for the next user', async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-pending-'))
    const started = startIdleOp({
      dir, sessionKey: 'pending-session', sourceSessionId: proof.sessionId, sourceTurnKey: proof.turnKey,
      revision: proof.revision, idleTurnKey: 'ab'.repeat(32), frozenTail: [], attachments: [],
    })
    assert.equal(started.ownedDispatch, true)
    assert.equal(idleOpSettled(started.op), false)
    const pending = readPendingIdle(dir, 'pending-session')
    assert.equal(pending?.revision, proof.revision)
    assert.equal(pending?.artifact, undefined)
  })

  test('low inner leaf still dispatches so the outer transcript can compact', () => {
    const op = {
      v: 1 as const,
      sessionKey: 'outer',
      sourceSessionId: proof.sessionId,
      sourceTurnKey: proof.turnKey,
      revision: proof.revision,
      idleTurnKey: 'ab'.repeat(32),
      frozenTail: [],
      attachments: [],
    }
    const stepped = advanceIdleOp({
      op,
      proof: { ...proof, compactRequired: false, summaryText: undefined },
      allowDispatch: true,
    })
    assert.equal(stepped.callModel, true)
    assert.equal(stepped.op.summaryText, undefined)
  })

  test('a short native no-op is not a permanent pending op', async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-short-'))
    const started = startIdleOp({
      dir, sessionKey: 'short-session', sourceSessionId: proof.sessionId, sourceTurnKey: proof.turnKey,
      revision: proof.revision, idleTurnKey: 'ab'.repeat(32), frozenTail: [], attachments: [],
    })
    const skipped = { ...started.op, disposition: 'short' as const }
    writeIdleOp(dir, skipped)
    assert.equal(idleOpSettled(skipped), true)
    assert.equal(readPendingIdle(dir, 'short-session'), undefined)
  })

  test('a ready set can start idle and cannot be used as a summary', async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-set-'))
    const set = {
      status: 'terminal_set' as const,
      sessionId: proof.sessionId,
      turnKey: proof.turnKey,
      revision: 'ab'.repeat(32),
      requestIds: ['biz', 'sum'],
    }
    const started = startIdleOp({
      dir, sessionKey: 'set-session', sourceSessionId: proof.sessionId, sourceTurnKey: proof.turnKey,
      revision: set.revision, idleTurnKey: 'ab'.repeat(32), frozenTail: [], attachments: [],
    })
    const dispatched = advanceIdleOp({ op: started.op, proof: set, allowDispatch: true })
    assert.equal(dispatched.callModel, true)
    assert.equal(dispatched.op.summaryText, undefined)
    const rejected = advanceIdleOp({
      op: started.op, proof: set, useProofSummary: true, allowDispatch: true,
    })
    assert.equal(rejected.callModel, false)
    assert.equal(rejected.op.summaryText, undefined)
    const revision = 'cd'.repeat(32)
    const turn = 'a'.repeat(64)
    const env = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/',
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9/',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.test-token',
    } as NodeJS.ProcessEnv
    const accepted = await fetchBoxIdleProof({ sessionId: 'native-session', turnKey: turn }, {
      env,
      fetchImpl: async () => new Response(JSON.stringify({
        status: 'terminal_set', sessionId: 'native-session', turnKey: turn,
        revision, requestIds: ['biz', 'sum'],
      }), { status: 200 }),
    })
    assert.equal(accepted.status, 'terminal_set')
    if (accepted.status === 'terminal_set') assert.deepEqual(accepted.requestIds, ['biz', 'sum'])
    const leaked = await fetchBoxIdleProof({ sessionId: 'native-session', turnKey: turn }, {
      env,
      fetchImpl: async () => new Response(JSON.stringify({
        status: 'terminal_set', sessionId: 'native-session', turnKey: turn,
        revision, requestIds: ['biz', 'sum'], summaryText: 'nope',
      }), { status: 200 }),
    })
    assert.deepEqual(leaked, { status: 'pending', reason: 'body' })
  })

  test('a proof that is still pending keeps the source candidate', () => {
    const home = join(tmpdir(), `idle-candidate-${process.pid}`)
    writeIdleCandidate(home, {
      v: 1, sessionKey: 's', sessionId: 'native', turnKey: 'ab'.repeat(32),
    })
    assert.equal(readIdleCandidate(home, 's')?.sessionId, 'native')
    clearIdleCandidate(home, 's')
    assert.equal(readIdleCandidate(home, 's'), undefined)
  })
})
