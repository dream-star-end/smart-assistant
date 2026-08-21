/**
 * Live-frame hello catch-up + persist-path lease touch (no Postgres).
 *
 * 跑法: npx tsx --test src/__tests__/liveTurnFrames.catchup.test.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Pool } from 'pg'

import {
  HELLO_LIVE_CATCHUP_MAX_BYTES,
  liveCatchupSendDecision,
  readOpenDispatchLiveFramePayloadsAfterSeq,
} from '../db/liveTurnFrames.js'

type CatchupQuery = Pick<Pool, 'query'>

describe('readOpenDispatchLiveFramePayloadsAfterSeq', () => {
  test('queries only this uid+session open dispatch after the client cursor', async () => {
    let sql = ''
    let params: unknown[] = []
    const q = {
      async query(text: string, p: unknown[]) {
        sql = text
        params = p
        return {
          rows: [{ payload: Buffer.from('{"type":"outbound.message","frameSeq":4}', 'utf8') }],
          rowCount: 1,
        }
      },
    } as unknown as CatchupQuery
    const out = await readOpenDispatchLiveFramePayloadsAfterSeq(q, {
      uid: 3n,
      sessionId: 'sess-a',
      afterFrameSeq: 2,
      limit: 50,
    })
    assert.match(sql, /d\.user_id = \$1/)
    assert.match(sql, /s\.session_id = \$2/)
    assert.match(sql, /s\.user_id = \$3/)
    assert.match(sql, /terminal_at IS NULL/)
    assert.match(sql, /status IN \('accepted', 'admitted'\)/)
    assert.match(sql, /f\.frame_seq > \$4/)
    assert.equal(sql.includes('legacy:'), false)
    assert.deepEqual(params.slice(0, 5), ['3', 'sess-a', 'c:3', 2, 50])
    assert.deepEqual(out, ['{"type":"outbound.message","frameSeq":4}'])
  })

  test('caps catch-up by cumulative payload bytes, not only row count', async () => {
    let sql = ''
    let params: unknown[] = []
    const q = {
      async query(text: string, p: unknown[]) {
        sql = text
        params = p
        return { rows: [], rowCount: 0 }
      },
    } as unknown as CatchupQuery
    await readOpenDispatchLiveFramePayloadsAfterSeq(q, {
      uid: 3n,
      sessionId: 'sess-a',
      afterFrameSeq: 0,
      maxBytes: 4096,
    })
    assert.match(sql, /octet_length\(f\.payload\)/)
    assert.match(sql, /cum_bytes/)
    assert.match(sql, /p\.cum_bytes - p\.nbytes < \$6/)
    assert.equal(params[3], 0)
    assert.equal(params[4], 500)
    assert.equal(params[5], 4096)
  })

  test('missing cursor starts from the stream head', async () => {
    let params: unknown[] = []
    const q = {
      async query(_text: string, p: unknown[]) {
        params = p
        return { rows: [], rowCount: 0 }
      },
    } as unknown as CatchupQuery
    await readOpenDispatchLiveFramePayloadsAfterSeq(q, {
      uid: 3n,
      sessionId: 'sess-a',
      afterFrameSeq: 0,
    })
    assert.equal(params[3], 0)
    assert.equal(params[4], 500)
    assert.equal(params[5], HELLO_LIVE_CATCHUP_MAX_BYTES)
  })
})

describe('liveCatchupSendDecision', () => {
  test('reuses the 4 MiB bufferedAmount gate and isolates backpressure to this reconnect', () => {
    assert.equal(liveCatchupSendDecision(1, 0, 16, HELLO_LIVE_CATCHUP_MAX_BYTES), 'send')
    assert.equal(
      liveCatchupSendDecision(1, HELLO_LIVE_CATCHUP_MAX_BYTES, 1, HELLO_LIVE_CATCHUP_MAX_BYTES),
      'backpressure',
    )
    assert.equal(liveCatchupSendDecision(1, 0, 448 * 1024 * 1024, 4 * 1024 * 1024), 'backpressure')
    assert.equal(liveCatchupSendDecision(1, Number.NaN, 448 * 1024 * 1024, 64), 'backpressure')
    assert.equal(liveCatchupSendDecision(3, 0, 16, HELLO_LIVE_CATCHUP_MAX_BYTES), 'stop')
  })
})

describe('persistGatewayLiveFrame live-lease touch', () => {
  test('source renews the open dispatch lease in the persist transaction', async () => {
    const srcPath = fileURLToPath(new URL('../db/liveTurnFrames.ts', import.meta.url))
    const src = await readFile(srcPath, 'utf8')
    assert.match(src, /touchDispatchLeaseOnLiveFrame/)
    assert.match(src, /leaseTtlMs: DISPATCH_LEASE_TTL_MS/)
  })
})
