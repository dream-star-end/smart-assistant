/**
 * OCV5-620: idle apply-stuck (prepared summary + artifact, no receipt) and
 * aged-out candidates must settle so submit is not pinned on IDLE_HISTORY_PENDING.
 * Does not weaken idleAbandonReason's "prepared summary never abandoned" rule.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { utimesSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import {
  IDLE_APPLY_STUCK_MS,
  IDLE_CANDIDATE_STUCK_MS,
  assembleIdleArtifact,
  idleAbandonReason,
  idleApplyStuckReason,
  idleCandidateAgedOut,
  idleHistoryStillBlocked,
  idleOpSettled,
  readIdleCandidate,
  readIdleOp,
  readPendingIdle,
  writeIdleCandidate,
  writeIdleOp,
  type IdleOp,
} from '../boxIdleCompact.js'
import { SessionManager } from '../sessionManager.js'

const finish = (SessionManager.prototype as unknown as {
  finishIdleUnderLock: (this: object, session: object, source: { sessionId: string; turnKey: string },
    recoveryDir?: string) => Promise<void>
}).finishIdleUnderLock

const revision = 'ab'.repeat(32)
const sourceTurn = 'cd'.repeat(32)
const sessionId = 'native-620'
const sessionKey = 'agent:main:webchat:dm:ocv5620'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'idle-620-'))
  dirs.push(dir)
  return dir
}
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })

function stuckOp(extra: Partial<IdleOp> = {}): IdleOp {
  const artifact = assembleIdleArtifact({
    opId: 'ff'.repeat(32),
    summaryText: 'prepared idle summary for apply-stuck',
    tail: [],
    attachments: [],
  })
  return {
    v: 1,
    sessionKey,
    sourceSessionId: sessionId,
    sourceTurnKey: sourceTurn,
    revision,
    idleTurnKey: 'ff'.repeat(32),
    frozenTail: [],
    attachments: [],
    summaryText: 'prepared idle summary for apply-stuck',
    artifact,
    ...extra,
  }
}

describe('OCV5-620 idle apply-stuck (pure)', () => {
  test('idleAbandonReason still refuses to abandon a prepared summary', () => {
    const now = 2_000_000
    assert.equal(
      idleAbandonReason(
        stuckOp(),
        { status: 'failed', sessionId, turnKey: 'x', requestIds: ['x'] },
        now,
      ),
      undefined,
      'prepared summary is never abandoned via idleAbandonReason',
    )
  })

  test('idleApplyStuckReason ages out summary+artifact without matching receipt', async () => {
    const dir = await tempDir()
    const op = stuckOp()
    writeIdleOp(dir, op)
    const path = join(dir, 'idle-ops', encodeURIComponent(sessionKey), `${revision}.json`)
    const old = (Date.now() - IDLE_APPLY_STUCK_MS - 1_000) / 1000
    utimesSync(path, old, old)
    assert.equal(idleApplyStuckReason(dir, op, Date.now()), 'idle_apply_stuck')
    assert.equal(
      idleApplyStuckReason(dir, stuckOp({ receiptDigest: op.artifact!.digest }), Date.now()),
      undefined,
      'matching receipt is settled, not stuck',
    )
    // Fresh mtime: not stuck yet
    writeIdleOp(dir, op)
    assert.equal(idleApplyStuckReason(dir, op, Date.now()), undefined)
  })

  test('settling apply-stuck unblocks idleHistoryStillBlocked', async () => {
    const dir = await tempDir()
    const op = stuckOp()
    writeIdleOp(dir, op)
    const path = join(dir, 'idle-ops', encodeURIComponent(sessionKey), `${revision}.json`)
    const old = (Date.now() - IDLE_APPLY_STUCK_MS - 1_000) / 1000
    utimesSync(path, old, old)
    assert.equal(idleApplyStuckReason(dir, op), 'idle_apply_stuck')
    const abandoned: IdleOp = { ...op, disposition: 'abandoned', abandonReason: 'idle_apply_stuck' }
    writeIdleOp(dir, abandoned)
    assert.equal(idleOpSettled(abandoned), true)
    assert.equal(
      idleHistoryStillBlocked({ candidate: undefined, pending: op, recovered: abandoned }),
      false,
    )
  })

  test('idleCandidateAgedOut respects createdAt + IDLE_CANDIDATE_STUCK_MS', () => {
    const now = 5_000_000
    assert.equal(idleCandidateAgedOut({ v: 1, sessionKey, sessionId, turnKey: sourceTurn }, now), false)
    assert.equal(
      idleCandidateAgedOut({
        v: 1, sessionKey, sessionId, turnKey: sourceTurn,
        createdAt: now - IDLE_CANDIDATE_STUCK_MS + 1,
      }, now),
      false,
    )
    assert.equal(
      idleCandidateAgedOut({
        v: 1, sessionKey, sessionId, turnKey: sourceTurn,
        createdAt: now - IDLE_CANDIDATE_STUCK_MS,
      }, now),
      true,
    )
  })

  test('writeIdleCandidate round-trips createdAt for age-out', async () => {
    const dir = await tempDir()
    const createdAt = Date.now() - IDLE_CANDIDATE_STUCK_MS - 1
    writeIdleCandidate(dir, { v: 1, sessionKey, sessionId, turnKey: sourceTurn, createdAt })
    const read = readIdleCandidate(dir, sessionKey)
    assert.equal(read?.createdAt, createdAt)
    assert.equal(idleCandidateAgedOut(read!, Date.now()), true)
  })
})

/** Local proof endpoint answering every lookup with the same body. */
async function pendingProofServer() {
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: 'pending', reason: 'unsettled' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const keys = ['ANTHROPIC_BASE_URL', 'OPENCLAUDE_V3_MASTER_BASE_URL', 'OPENCLAUDE_V3_CONTAINER_TOKEN',
    'OC_BOX_IDLE_PROOF_WAIT_MS'] as const
  const before = keys.map((key) => process.env[key])
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}/`
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = process.env.ANTHROPIC_BASE_URL
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.test-token'
  process.env.OC_BOX_IDLE_PROOF_WAIT_MS = '0'
  return async () => {
    keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i] })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('OCV5-620 finishIdleUnderLock with a source proof that stays pending', () => {
  test('a pending op still settles once apply-stuck after the candidate already aged out (Codex r1 P1)', async () => {
    const dir = await tempDir()
    const close = await pendingProofServer()
    try {
      const op = stuckOp()
      writeIdleOp(dir, op)
      const path = join(dir, 'idle-ops', encodeURIComponent(sessionKey), `${revision}.json`)
      const age = (ms: number) => { const t = (Date.now() - ms) / 1000; utimesSync(path, t, t) }
      age(IDLE_APPLY_STUCK_MS - 60_000)
      writeIdleCandidate(dir, { v: 1, sessionKey, sessionId, turnKey: sourceTurn,
        createdAt: Date.now() - IDLE_CANDIDATE_STUCK_MS - 60_000 })
      const session = { sessionKey, runner: new EventEmitter() }
      const source = { sessionId, turnKey: sourceTurn }

      await finish.call({}, session, source, dir)
      assert.equal(readIdleCandidate(dir, sessionKey), undefined, 'aged-out candidate cleared')
      assert.equal(idleOpSettled(readIdleOp(dir, sessionKey, revision)!), false, 'op not stuck yet')

      age(IDLE_APPLY_STUCK_MS + 60_000)
      await finish.call({}, session, source, dir)
      const settled = readIdleOp(dir, sessionKey, revision)!
      assert.equal(settled.disposition, 'abandoned')
      assert.equal(settled.abandonReason, 'idle_apply_stuck')
      assert.equal(readPendingIdle(dir, sessionKey), undefined)
    } finally {
      await close()
    }
  })
})
