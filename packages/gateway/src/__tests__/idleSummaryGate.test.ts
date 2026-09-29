import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { BOX_NATIVE_CONTEXT_MODEL, BOX_NATIVE_CONTEXT_OWNER } from '@openclaude/protocol'
import {
  assembleIdleArtifact,
  idleHistoryStillBlocked,
  readIdleCandidate,
  readIdleNative,
  readIdleOp,
  readPendingIdle,
  writeIdleNative,
} from '../boxIdleCompact.js'
import { SessionManager } from '../sessionManager.js'

const finish = (SessionManager.prototype as unknown as {
  finishIdleUnderLock: (
    this: { _idleRunning?: boolean },
    session: object,
    source: { sessionId: string; turnKey: string },
    recoveryDir?: string,
  ) => Promise<void>
}).finishIdleUnderLock

const revision = 'ab'.repeat(32)
const sourceTurn = 'cd'.repeat(32)
const sessionKey = 'summary-gate'
const sessionId = 'native-session'
const idleTurn = createHash('sha256').update(`${sessionKey}:${revision}`).digest('hex')

test('a prepared summary waits for its own committed capsule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-summary-gate-'))
  let idleReady = false
  let submits = 0
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { oc_turn_key?: string }
      res.setHeader('content-type', 'application/json')
      if (body.oc_turn_key === sourceTurn) {
        res.end(JSON.stringify({
          status: 'terminal', sessionId, turnKey: sourceTurn, requestId: 'biz',
          revision, compactRequired: true, capsuleSha256: 'ee'.repeat(32),
          summaryText: 'source business, not the idle summary',
        }))
        return
      }
      if (body.oc_turn_key === idleTurn && idleReady) {
        res.end(JSON.stringify({
          status: 'terminal', sessionId, turnKey: idleTurn, requestId: 'sum',
          revision: 'ff'.repeat(32), compactRequired: false, capsuleSha256: '11'.repeat(32),
          summaryText: 'kept goal',
        }))
        return
      }
      if (body.oc_turn_key === idleTurn) {
        res.end(JSON.stringify({ status: 'pending', reason: 'unsettled' }))
        return
      }
      res.statusCode = 404
      res.end('missing')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${address.port}/`
  const previous = {
    base: process.env.ANTHROPIC_BASE_URL,
    internal: process.env.OPENCLAUDE_V3_MASTER_BASE_URL,
    token: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
  }
  process.env.ANTHROPIC_BASE_URL = base
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = base
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.test-token'
  after(async () => {
    process.env.ANTHROPIC_BASE_URL = previous.base
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = previous.internal
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = previous.token
    server.close()
    await rm(dir, { recursive: true, force: true })
  })

  const session = {
    sessionKey,
    model: BOX_NATIVE_CONTEXT_MODEL,
    _boxContextOwner: BOX_NATIVE_CONTEXT_OWNER,
    runner: {
      submitTurn: () => ({
        summary: (async () => {
          submits += 1
          const native = readIdleNative(dir, sessionId, revision)
          if (!native?.summaryText) {
            writeIdleNative(dir, {
              v: 1, opId: idleTurn, revision, sessionId,
              summaryText: 'kept goal', modelCalls: 1, modelStarted: true,
              frozenTail: [], attachments: [],
            })
            return {}
          }
          const artifact = assembleIdleArtifact({
            opId: idleTurn, summaryText: native.summaryText,
            tail: native.frozenTail, attachments: native.attachments,
          })
          writeIdleNative(dir, { ...native, applied: true, artifact })
          return { nativeIdleReceipt: { opId: idleTurn, digest: artifact.digest } }
        })(),
      }),
    },
  }
  const source = { sessionId, turnKey: sourceTurn }
  await finish.call({}, session, source, dir)
  assert.equal(submits, 1)
  assert.equal(readIdleNative(dir, sessionId, revision)?.applied, undefined)
  assert.equal(readIdleOp(dir, sessionKey, revision)?.summaryText, undefined)
  assert.equal(readIdleOp(dir, sessionKey, revision)?.artifact, undefined)
  assert.equal(idleHistoryStillBlocked({
    candidate: readIdleCandidate(dir, sessionKey),
    pending: readPendingIdle(dir, sessionKey),
    recovered: readIdleOp(dir, sessionKey, revision),
  }), true)

  idleReady = true
  await finish.call({}, session, source, dir)
  assert.equal(submits, 2)
  assert.equal(readIdleNative(dir, sessionId, revision)?.applied, true)
  assert.equal(readIdleOp(dir, sessionKey, revision)?.summaryText, 'kept goal')
  assert.equal(readIdleCandidate(dir, sessionKey), undefined)
  assert.equal(readPendingIdle(dir, sessionKey), undefined)
})

test('a summary error does not dispatch again or clear the candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-summary-error-'))
  let submits = 0
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { oc_turn_key?: string }
      res.setHeader('content-type', 'application/json')
      if (body.oc_turn_key === sourceTurn) {
        res.end(JSON.stringify({
          status: 'terminal', sessionId, turnKey: sourceTurn, requestId: 'biz',
          revision, compactRequired: true, capsuleSha256: 'ee'.repeat(32),
        }))
        return
      }
      res.end(JSON.stringify({ status: 'pending', reason: 'unsettled' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${address.port}/`
  const previous = {
    base: process.env.ANTHROPIC_BASE_URL,
    internal: process.env.OPENCLAUDE_V3_MASTER_BASE_URL,
    token: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
  }
  process.env.ANTHROPIC_BASE_URL = base
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = base
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.test-token'
  after(async () => {
    process.env.ANTHROPIC_BASE_URL = previous.base
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = previous.internal
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = previous.token
    server.close()
    await rm(dir, { recursive: true, force: true })
  })
  const session = {
    sessionKey: 'summary-error',
    model: BOX_NATIVE_CONTEXT_MODEL,
    _boxContextOwner: BOX_NATIVE_CONTEXT_OWNER,
    runner: {
      submitTurn: () => ({
        summary: (async () => {
          submits += 1
          writeIdleNative(dir, {
            v: 1, opId: createHash('sha256').update(`summary-error:${revision}`).digest('hex'),
            revision, sessionId, modelCalls: 0, modelStarted: true,
            frozenTail: [], attachments: [],
          })
          return { nativeCompactionSummary: 'Failed to authenticate. API Error: 403' }
        })(),
      }),
    },
  }
  await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
  await finish.call({}, session, { sessionId, turnKey: sourceTurn }, dir)
  assert.equal(submits, 1)
  const native = readIdleNative(dir, sessionId, revision)
  assert.equal(native?.summaryText, undefined)
  assert.equal(native?.modelStarted, true)
  assert.equal(native?.applied, undefined)
  assert.ok(readIdleCandidate(dir, 'summary-error'))
})
