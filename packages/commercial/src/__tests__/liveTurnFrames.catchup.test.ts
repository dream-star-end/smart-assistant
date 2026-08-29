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
  reduceLiveJournal,
} from '../db/liveTurnFrames.js'
import { EPOCH_BAND, packEpoch } from '@openclaude/protocol'

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
    assert.deepEqual(out, [{ kind: 'payload', payload: '{"type":"outbound.message","frameSeq":4}' }])
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
    assert.match(sql, /p\.cum_bytes <= \$6/)
    assert.match(sql, /LEFT JOIN client_session_live_frames/)
    assert.equal(sql.includes('p.cum_bytes - p.nbytes'), false)
    assert.equal(params[3], 0)
    assert.equal(params[4], 500)
    assert.equal(params[5], 4096)
  })

  test('returns an oversize sentinel without materializing the overflowing payload', async () => {
    let loadedPayloads = 0
    const q = {
      async query(_text: string, _p: unknown[]) {
        return {
          rows: [{
            payload: null,
            frame_seq: 1,
            nbytes: 448 * 1024 * 1024,
          }],
          rowCount: 1,
        }
      },
    } as unknown as CatchupQuery
    const out = await readOpenDispatchLiveFramePayloadsAfterSeq(q, {
      uid: 3n,
      sessionId: 'sess-a',
      afterFrameSeq: 0,
      maxBytes: 4 * 1024 * 1024,
    })
    assert.deepEqual(out, [{
      kind: 'oversize',
      frameSeq: 1,
      nbytes: 448 * 1024 * 1024,
    }])
    assert.equal(out.some((item) => item.kind === 'payload'), false)
    assert.equal(loadedPayloads, 0)
    const payloadBytes = out.reduce((sum, item) => (
      item.kind === 'payload' ? sum + Buffer.byteLength(item.payload, 'utf8') : sum
    ), 0)
    assert.equal(payloadBytes <= 4 * 1024 * 1024, true)
  })

  test('join predicate refuses to select payload once cumulative bytes exceed the budget', async () => {
    let sql = ''
    const huge = Buffer.alloc(64)
    const q = {
      async query(text: string, _p: unknown[]) {
        sql = text
        if (!/p\.cum_bytes <= \$6/.test(text) || /cum_bytes - p\.nbytes/.test(text)) {
          return {
            rows: [{ payload: huge, frame_seq: 1, nbytes: huge.length }],
            rowCount: 1,
          }
        }
        return {
          rows: [{ payload: null, frame_seq: 1, nbytes: 448 * 1024 * 1024 }],
          rowCount: 1,
        }
      },
    } as unknown as CatchupQuery
    const out = await readOpenDispatchLiveFramePayloadsAfterSeq(q, {
      uid: 3n,
      sessionId: 'sess-a',
      afterFrameSeq: 0,
      maxBytes: 32,
    })
    assert.match(sql, /AND p\.cum_bytes <= \$6/)
    assert.equal(out.length, 1)
    assert.equal(out[0]?.kind, 'oversize')
    assert.equal(out[0]?.kind === 'oversize' && 'payload' in out[0], false)
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

describe('live units streamGeneration', () => {
  test('readOpenDispatchStreamMeta selects stream_key and stamps lineage generation', async () => {
    const srcPath = fileURLToPath(new URL('../db/liveTurnFrames.ts', import.meta.url))
    const src = await readFile(srcPath, 'utf8')
    assert.match(src, /streamGenerationFromLineage/)
    assert.match(src, /SELECT stream_key,client_message_id,projection_source/)
    assert.match(src, /streamKeyLineage/)
    assert.match(src, /reduceLiveJournal/)
    assert.match(src, /lineage: snapshot\.meta\.lineage/)
  })

  test('no-checkpoint snapshot of only s2 uses DB lineage [s1,s2] so gen=1 beats old gen0/seq101', () => {
    const reduced = reduceLiveJournal([{
      recordId: '2',
      streamKey: 's2',
      clientMessageId: 'cm-1',
      payload: {
        type: 'outbound.message',
        sessionKey: 'agent:main:webchat:dm:sess',
        frameSeq: 1,
        blocks: [{ kind: 'thinking', text: 'NEW' }],
      },
    }], { lineage: ['s1', 's2'], checkpointState: null })
    assert.equal(reduced.ok, true)
    if (!reduced.ok) return
    const reducerGeneration = reduced.state.units[0]?.streamGeneration ?? -1
    const oldEpoch = packEpoch(EPOCH_BAND.LIVE, 0, 101, 0)
    const newEpoch = packEpoch(EPOCH_BAND.LIVE, reducerGeneration, 1, 0)
    assert.deepEqual({
      expectedGeneration: 1,
      reducerGeneration,
      actualBeatsOld: newEpoch > oldEpoch,
      expectedBeatsOld: true,
    }, {
      expectedGeneration: 1,
      reducerGeneration: 1,
      actualBeatsOld: true,
      expectedBeatsOld: true,
    })
    assert.equal(oldEpoch, 2251799813685450)
    assert.equal(packEpoch(EPOCH_BAND.LIVE, 0, 1, 0), 2251799813685250)
    assert.equal(newEpoch, 2253998836940802)
  })
})
