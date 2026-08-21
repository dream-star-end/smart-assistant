/**
 * Live-frame hello catch-up + persist-path lease touch (no Postgres).
 *
 * 跑法: npx tsx --test src/__tests__/liveTurnFrames.catchup.test.ts
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readOpenDispatchLiveFramePayloadsAfterSeq } from '../db/liveTurnFrames.js'

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
    }
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

  test('missing cursor starts from the stream head', async () => {
    let params: unknown[] = []
    const q = {
      async query(_text: string, p: unknown[]) {
        params = p
        return { rows: [], rowCount: 0 }
      },
    }
    await readOpenDispatchLiveFramePayloadsAfterSeq(q, {
      uid: 3n,
      sessionId: 'sess-a',
      afterFrameSeq: 0,
    })
    assert.equal(params[3], 0)
    assert.equal(params[4], 500)
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
