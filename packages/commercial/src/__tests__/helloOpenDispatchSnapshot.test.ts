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
