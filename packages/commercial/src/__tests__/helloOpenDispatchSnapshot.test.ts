import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'
import { sendHelloSessionSnapshots } from '../ws/helloOpenDispatchSnapshot.js'

test('hello snapshot read failure warns safely and continues to the next session', async () => {
  let connections = 0
  let releases = 0
  const error = Object.assign(new Error('postgres://secret:password@database/private'), { code: '08006' })
  const pool = {
    async connect() {
      if (++connections === 1) throw error
      return { query: async () => ({ rows: [] }), release: () => { releases++ } }
    },
  } as unknown as Pool
  const warnings: unknown[] = []
  await sendHelloSessionSnapshots(pool, { readyState: WebSocket.OPEN, bufferedAmount: 0, send() {} },
    '3', [{ peerId: 'failed-session' }, { peerId: 'next-session' }], {
      info() {}, warn: (message, fields) => warnings.push({ message, fields }),
    }, 'conn-123')
  assert.deepEqual(warnings, [{
    message: 'hello_session_snapshot_failed',
    fields: { uid: '3', sessionId: 'failed-session', connId: 'conn-123', errorName: 'Error', errorCode: '08006' },
  }])
  assert.equal(connections, 2)
  assert.equal(releases, 1)
  assert.doesNotMatch(JSON.stringify(warnings), /postgres|secret|password/)
})

test('hello snapshot logging omits unsafe error names and codes', async () => {
  const warnings: unknown[] = []
  const pool = { connect: async () => { throw { name: 'postgres://secret', code: 'postgres://password' } } } as unknown as Pool
  await sendHelloSessionSnapshots(pool, { readyState: WebSocket.OPEN, bufferedAmount: 0, send() {} },
    '3', [{ peerId: 'session' }], { info() {}, warn: (_message, fields) => warnings.push(fields) }, 'conn')
  assert.deepEqual(warnings, [{ uid: '3', sessionId: 'session', connId: 'conn', errorName: 'Error' }])
})

test('INC-20261115-CONTAINER-SWAP-FRAMESEQ: extends snapshot budget to 64 for positive-cursor sessions while keeping 8 for zero-cursor idle sessions', async () => {
  const pool = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes('session-snapshot-owner')) return { rows: [{ as_of: '1000' }] }
          if (sql.includes('session-snapshot-container-cursor')) return { rows: [{ agent_container_id: '7246' }] }
          return { rows: [] }
        },
        release() {},
      }
    },
  } as unknown as Pool
  const sentPositive: Array<{ peer: { id: string }; snapshot: { gap?: { reason: string } | null } }> = []
  const positivePeers = Array.from({ length: 10 }, (_, i) => ({
    peerId: `s${i + 1}`, lastFrameSeq: 500, inFlight: false,
  }))
  await sendHelloSessionSnapshots(
    pool,
    { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => { sentPositive.push(JSON.parse(String(raw))) } },
    '3', positivePeers, null, 'conn-pos', 7247,
  )
  assert.equal(sentPositive.length, 10)
  for (const frame of sentPositive) assert.deepEqual(frame.snapshot.gap, { reason: 'cursor_reset' })

  const sentZero: Array<{ peer: { id: string } }> = []
  const zeroPeers = Array.from({ length: 10 }, (_, i) => ({
    peerId: `z${i + 1}`, lastFrameSeq: 0, inFlight: false,
  }))
  await sendHelloSessionSnapshots(
    pool,
    { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => { sentZero.push(JSON.parse(String(raw))) } },
    '3', zeroPeers, null, 'conn-zero', 7247,
  )
  assert.equal(sentZero.length, 8)

  const sentMixed: Array<{ peer: { id: string } }> = []
  const mixedPeers = [
    ...Array.from({ length: 9 }, (_, i) => ({ peerId: `zero-${i + 1}`, lastFrameSeq: 0, inFlight: false })),
    { peerId: 'pos-1', lastFrameSeq: 500, inFlight: false },
    { peerId: 'inflight-1', lastFrameSeq: 0, inFlight: true, inFlightClientMessageId: 'm-run-1' },
  ]
  await sendHelloSessionSnapshots(
    pool,
    { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => { sentMixed.push(JSON.parse(String(raw))) } },
    '3', mixedPeers, null, 'conn-mix', 7247,
  )
  assert.deepEqual(sentMixed.map((f) => f.peer.id), [
    'inflight-1', 'pos-1', 'zero-1', 'zero-2', 'zero-3', 'zero-4', 'zero-5', 'zero-6',
  ])

  const sentMulti: Array<{ peer: { id: string }; snapshot: { gap: unknown } }> = []
  const multiPeers = [
    ...Array.from({ length: 8 }, (_, i) => ({ peerId: `z-other-${i + 1}`, lastFrameSeq: 0, inFlight: false })),
    { peerId: 'multi-1', agentId: 'explorer', lastFrameSeq: 0, inFlight: false },
    { peerId: 'multi-1', agentId: 'main', lastFrameSeq: 500, inFlight: false },
  ]
  await sendHelloSessionSnapshots(
    pool,
    { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => { sentMulti.push(JSON.parse(String(raw))) } },
    '3', multiPeers, null, 'conn-multi', 7247,
  )
  const multiFrame = sentMulti.find((f) => f.peer.id === 'multi-1')
  assert.ok(multiFrame)
  assert.deepEqual(multiFrame.snapshot.gap, { reason: 'cursor_reset' })
})
