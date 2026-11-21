import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'
import { sendHelloSessionSnapshots } from '../ws/helloOpenDispatchSnapshot.js'

test('hello snapshot transient batch failure warns safely and delivers ALL peers including index 0 (B8)', async () => {
  let connections = 0
  let releases = 0
  const error = Object.assign(new Error('postgres://secret:password@database/private'), { code: '08006' })
  const pool = {
    async connect() {
      if (++connections === 1) throw error
      return {
        async query(sql: string) {
          if (sql.includes('session-snapshot-owner')) return { rows: [{ as_of: '1000' }] }
          return { rows: [] }
        },
        release: () => { releases++ },
      }
    },
  } as unknown as Pool
  const warnings: unknown[] = []
  const sent: Array<{ peer: { id: string } }> = []
  await sendHelloSessionSnapshots(pool, {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (raw) => { sent.push(JSON.parse(String(raw))) },
  }, '3', [{ peerId: 'peer-a' }, { peerId: 'peer-b' }], {
    info() {}, warn: (message, fields) => warnings.push({ message, fields }),
  }, 'conn-123')
  assert.deepEqual(warnings, [{
    message: 'hello_session_snapshot_failed',
    fields: { uid: '3', sessionId: 'peer-a', connId: 'conn-123', errorName: 'Error', errorCode: '08006' },
  }])
  assert.deepEqual(sent.map((f) => f.peer.id), ['peer-a', 'peer-b'], 'both peer-a and peer-b must be delivered exactly once')
  assert.equal(connections, 3)
  assert.equal(releases, 2)
  assert.doesNotMatch(JSON.stringify(warnings), /postgres|secret|password/)
})

test('mid-send WS error after batch read logs safely and NEVER re-delivers already-sent peers (B8)', async () => {
  let connects = 0
  const pool = {
    async connect() {
      connects += 1
      return {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes('session-snapshot-batch-owner')) {
            const ids = (params?.[1] as string[]) ?? []
            return { rows: ids.map((id) => ({ session_id: id, as_of: '1000' })) }
          }
          return { rows: [] }
        },
        release() {},
      }
    },
  } as unknown as Pool
  const sent: string[] = []
  const warnings: Array<{ sessionId: string }> = []
  await sendHelloSessionSnapshots(
    pool,
    {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send(raw: unknown) {
        const frame = JSON.parse(String(raw)) as { peer: { id: string } }
        if (frame.peer.id === 'peer-b') throw new Error('ws_write_error')
        sent.push(frame.peer.id)
      },
    },
    '3',
    [{ peerId: 'peer-a' }, { peerId: 'peer-b' }, { peerId: 'peer-c' }],
    { info() {}, warn: (_m, fields) => warnings.push({ sessionId: String(fields.sessionId) }) },
    'conn-send',
  )
  assert.equal(connects, 1, 'mid-send error must NOT fall back to DB re-reads')
  assert.deepEqual(sent, ['peer-a', 'peer-c'], 'peer-a must NOT be re-delivered; peer-c still delivered')
  assert.deepEqual(warnings, [{ sessionId: 'peer-b' }])
})

test('persistent DB failure stops fallback at consecutive-failure cap (3) without storming all peers (B8)', async () => {
  let connects = 0
  const pool = {
    async connect() {
      connects += 1
      throw Object.assign(new Error('db_down'), { code: '57P01' })
    },
  } as unknown as Pool
  const warnings: unknown[] = []
  const peers = Array.from({ length: 8 }, (_, i) => ({ peerId: `p-${i + 1}` }))
  await sendHelloSessionSnapshots(
    pool,
    { readyState: WebSocket.OPEN, bufferedAmount: 0, send() {} },
    '3',
    peers,
    { info() {}, warn: (_m, fields) => warnings.push(fields) },
    'conn-outage',
  )
  // 1 batch attempt + 3 fallback attempts = 4 total connects
  assert.equal(connects, 4)
  assert.equal(warnings.length, 4)
})

test('hello snapshot logging omits unsafe error names and codes', async () => {
  const warnings: unknown[] = []
  const pool = { connect: async () => { throw { name: 'postgres://secret', code: 'postgres://password' } } } as unknown as Pool
  await sendHelloSessionSnapshots(pool, { readyState: WebSocket.OPEN, bufferedAmount: 0, send() {} },
    '3', [{ peerId: 'session' }], { info() {}, warn: (_message, fields) => warnings.push(fields) }, 'conn')
  assert.deepEqual(warnings, [{ uid: '3', sessionId: 'session', connId: 'conn', errorName: 'Error' }])
})

test('INC-20261115-CONTAINER-SWAP-FRAMESEQ: extends snapshot budget to 64 for positive-cursor sessions while keeping 8 for zero-cursor idle sessions (batched in 1 tx)', async () => {
  let connectCount = 0
  const pool = {
    async connect() {
      connectCount++
      return {
        async query(sql: string, params?: unknown[]) {
          if (sql.includes('session-snapshot-batch-owner')) {
            const ids = (params?.[1] as string[]) ?? []
            return { rows: ids.map((id) => ({ session_id: id, as_of: '1000' })) }
          }
          if (sql.includes('session-snapshot-batch-container-cursor')) {
            const ids = (params?.[1] as string[]) ?? []
            return { rows: ids.map((id) => ({ session_id: id, agent_container_id: '7246' })) }
          }
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
  connectCount = 0
  await sendHelloSessionSnapshots(
    pool,
    { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => { sentPositive.push(JSON.parse(String(raw))) } },
    '3', positivePeers, null, 'conn-pos', 7247,
  )
  assert.equal(sentPositive.length, 10)
  assert.equal(connectCount, 1, '10 non-inFlight sessions must be batched into 1 REPEATABLE READ transaction')
  for (const frame of sentPositive) assert.deepEqual(frame.snapshot.gap, { reason: 'cursor_reset' })

  const sentZero: Array<{ peer: { id: string } }> = []
  const zeroPeers = Array.from({ length: 10 }, (_, i) => ({
    peerId: `z${i + 1}`, lastFrameSeq: 0, inFlight: false,
  }))
  connectCount = 0
  await sendHelloSessionSnapshots(
    pool,
    { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => { sentZero.push(JSON.parse(String(raw))) } },
    '3', zeroPeers, null, 'conn-zero', 7247,
  )
  assert.equal(sentZero.length, 8)
  assert.equal(connectCount, 1, '8 zero-cursor idle sessions must be batched into 1 transaction')

  const sentMixed: Array<{ peer: { id: string } }> = []
  const mixedPeers = [
    ...Array.from({ length: 9 }, (_, i) => ({ peerId: `zero-${i + 1}`, lastFrameSeq: 0, inFlight: false })),
    { peerId: 'pos-1', lastFrameSeq: 500, inFlight: false },
    { peerId: 'inflight-1', lastFrameSeq: 0, inFlight: true, inFlightClientMessageId: 'm-run-1' },
  ]
  connectCount = 0
  await sendHelloSessionSnapshots(
    pool,
    { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw) => { sentMixed.push(JSON.parse(String(raw))) } },
    '3', mixedPeers, null, 'conn-mix', 7247,
  )
  assert.deepEqual(sentMixed.map((f) => f.peer.id), [
    'inflight-1', 'pos-1', 'zero-1', 'zero-2', 'zero-3', 'zero-4', 'zero-5', 'zero-6',
  ])
  assert.equal(connectCount, 2, '1 dedicated tx for inFlight + 1 batched tx for remaining 7 idle/cursor sessions')

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
