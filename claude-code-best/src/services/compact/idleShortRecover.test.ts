import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { BOX_NATIVE_CONTEXT_MODEL, BOX_NATIVE_CONTEXT_OWNER } from '../../../../packages/protocol/src/index.ts'
import {
  idleHistoryStillBlocked,
  nativeShortForOp,
  readIdleCandidate,
  readIdleNative,
  readIdleOp,
  readPendingIdle,
  writeIdleNative,
} from '../../../../packages/gateway/src/boxIdleCompact.ts'
import { SessionManager } from '../../../../packages/gateway/src/sessionManager.ts'
import { runIdleCompact } from './idleRecover.ts'

const finish = (SessionManager.prototype as unknown as {
  finishIdleUnderLock: (
    this: object,
    session: object,
    source: { sessionId: string; turnKey: string },
    recoveryDir?: string,
  ) => Promise<void>
}).finishIdleUnderLock

test('a native short that crashes before the gateway write is settled on the next entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idle-short-crash-'))
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { oc_turn_key?: string }
      seen.push(body.oc_turn_key ?? '')
      const sourceTurn = 'a'.repeat(64)
      if (body.oc_turn_key === sourceTurn) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          status: 'terminal', sessionId: 'native-session', turnKey: sourceTurn,
          requestId: 'req', revision: 'rev1', compactRequired: false, capsuleSha256: 'b'.repeat(64),
        }))
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
    meta: process.env.CLAUDE_CODE_EXTRA_METADATA,
  }
  process.env.ANTHROPIC_BASE_URL = base
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = base
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.test-token'
  after(async () => {
    process.env.ANTHROPIC_BASE_URL = previous.base
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = previous.internal
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = previous.token
    process.env.CLAUDE_CODE_EXTRA_METADATA = previous.meta
    server.close()
    await rm(dir, { recursive: true, force: true })
  })

  const source = { sessionId: 'native-session', turnKey: 'a'.repeat(64) }
  let submits = 0
  const session = {
    sessionKey: 'short-crash',
    model: BOX_NATIVE_CONTEXT_MODEL,
    _boxContextOwner: BOX_NATIVE_CONTEXT_OWNER,
    runner: {
      submitTurn: ({ turnKey }: { turnKey: string }) => ({
        summary: (async () => {
          submits += 1
          process.env.CLAUDE_CODE_EXTRA_METADATA = JSON.stringify({ oc_turn_key: turnKey })
          const nativeResult = await runIdleCompact({
            sessionId: source.sessionId,
            home: dir,
            messages: [{ type: 'user', uuid: 'u', message: { role: 'user', content: 'short' } }] as never,
            record: async () => {},
            flush: async () => {},
            load: async () => null,
          })
          assert.equal(nativeResult, 'short')
          throw new Error('crash after native short, before gateway summary')
        })(),
      }),
    },
  }
  await assert.rejects(finish.call({}, session, source, dir), /crash after native short/)
  assert.equal(submits, 1)
  assert.equal(readIdleNative(dir, source.sessionId, 'rev1')?.applied, true)
  assert.equal(readPendingIdle(dir, session.sessionKey)?.disposition, undefined)

  await finish.call({}, session, source, dir)
  const recovered = readIdleOp(dir, session.sessionKey, 'rev1')
  const pending = readPendingIdle(dir, session.sessionKey)
  const candidate = readIdleCandidate(dir, session.sessionKey)
  assert.equal(submits, 1)
  assert.equal(pending, undefined)
  assert.equal(recovered?.disposition, 'short')
  assert.equal(candidate, undefined)
  assert.equal(seen.every((turn) => turn === source.turnKey), true)
  assert.equal(idleHistoryStillBlocked({ candidate, pending, recovered }), false)

  const foreign = createHash('sha256').update('other-op').digest('hex')
  writeIdleNative(dir, {
    v: 1, opId: foreign, revision: 'rev-foreign', sessionId: source.sessionId,
    modelCalls: 0, applied: true, frozenTail: [], attachments: [],
  })
  assert.equal(nativeShortForOp(readIdleNative(dir, source.sessionId, 'rev-foreign'), {
    idleTurnKey: recovered!.idleTurnKey, revision: 'rev1', sourceSessionId: source.sessionId,
  }), false)
})
