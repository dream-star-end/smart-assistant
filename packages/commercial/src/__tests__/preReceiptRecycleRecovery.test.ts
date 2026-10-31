import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'

import {
  RECYCLE_READMIT_FAILURE_TEXT,
  RECYCLE_READMIT_NOTICE_SQL,
  RECYCLE_READMIT_NOTICE_TEXT,
  RECYCLE_READMIT_WINDOW_MS,
  isPreReceiptRecycleReplayCode,
  markPreReceiptRecycleReplaySent,
  pausePreReceiptRecycleReplay,
  preReceiptRecycleRoot,
  recycleReadmitGreyLineVisible,
  recycleReplayDecision,
  recycleReplayFrameFromJob,
  schedulePreReceiptRecycleReplay,
} from '../dispatch/preReceiptRecycleRecovery.js'

const DISPATCH_ID = '69fa5bdf-1111-4111-8111-111111111111'
const CMID = 'cmid-round-3'

type DispatchRow = {
  dispatchId: string
  userId: string
  sessionId: string
  clientMessageId: string
  status: string
  acceptedAt: string | null
  leaseEpoch: number
  ownerId: string | null
  billingRequestId: string
}

type JobRow = {
  jobId: string
  userId: string
  sessionId: string
  root: string
  status: string
  leaseOwner: string | null
  leaseEpoch: number
  dispatchId: string | null
  request: Record<string, unknown>
  errorCode: string
  tape: string
  sourceClientMessageId: string
}

class Mem {
  dispatches: DispatchRow[] = []
  jobs: JobRow[] = []
  stops = new Set<string>()
  sql: string[] = []
  nextJob = 1

  seedDispatch(overrides: Partial<DispatchRow> = {}): DispatchRow {
    const row: DispatchRow = {
      dispatchId: DISPATCH_ID,
      userId: '1619',
      sessionId: 'sess-1',
      clientMessageId: CMID,
      status: 'admitted',
      acceptedAt: null,
      leaseEpoch: 3,
      ownerId: 'bridge-old',
      billingRequestId: 'bill-once',
      ...overrides,
    }
    this.dispatches.push(row)
    return row
  }

  async connect(): Promise<{ query: Mem['query']; release: () => void }> {
    return {
      query: (sql, params) => this.query(sql, params),
      release: () => {},
    }
  }

  async query(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowCount: number; rows: Array<Record<string, unknown>> }> {
    this.sql.push(sql)
    const text = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return { rowCount: 0, rows: [] }
    }
    if (text.includes('from turn_dispatches') && text.includes('for update')) {
      const row = this.dispatches.find(
        (item) =>
          item.dispatchId === params[0] &&
          item.userId === params[1] &&
          item.sessionId === params[2] &&
          item.clientMessageId === params[3],
      )
      return row
        ? {
            rowCount: 1,
            rows: [
              {
                status: row.status,
                accepted_at: row.acceptedAt,
                lease_epoch: String(row.leaseEpoch),
              },
            ],
          }
        : { rowCount: 0, rows: [] }
    }
    if (text.includes('from turn_recovery_jobs') && text.includes('for update')) {
      const row = this.jobs.find(
        (item) =>
          item.userId === params[0] && item.sessionId === params[1] && item.root === params[2],
      )
      return row ? { rowCount: 1, rows: [{ status: row.status }] } : { rowCount: 0, rows: [] }
    }
    if (text.includes('from turn_control_requests')) {
      const key = `${params[0]}:${params[1]}:${params[2]}`
      return this.stops.has(key)
        ? { rowCount: 1, rows: [{ '?column?': 1 }] }
        : { rowCount: 0, rows: [] }
    }
    if (text.includes('update turn_dispatches') && text.includes('owner_id = null')) {
      const row = this.dispatches.find(
        (item) =>
          item.dispatchId === params[0] &&
          item.status === 'admitted' &&
          item.acceptedAt == null &&
          item.leaseEpoch === params[1],
      )
      if (!row) return { rowCount: 0, rows: [] }
      row.ownerId = null
      return { rowCount: 1, rows: [] }
    }
    if (text.includes('insert into turn_recovery_jobs')) {
      const root = String(params[2])
      if (
        this.jobs.some(
          (item) => item.userId === params[0] && item.sessionId === params[1] && item.root === root,
        )
      ) {
        return { rowCount: 0, rows: [] }
      }
      const request = JSON.parse(String(params[6])) as Record<string, unknown>
      this.jobs.push({
        jobId: `job-${this.nextJob++}`,
        userId: String(params[0]),
        sessionId: String(params[1]),
        root,
        status: 'queued',
        leaseOwner: null,
        leaseEpoch: 0,
        dispatchId: null,
        request,
        errorCode: String(params[5]),
        tape: String(params[7]),
        sourceClientMessageId: String(params[3]),
      })
      return { rowCount: 1, rows: [] }
    }
    if (text.includes("status = 'sent'")) {
      const row = this.jobs.find(
        (item) =>
          item.jobId === params[0] &&
          item.status === 'leased' &&
          item.leaseOwner === params[1] &&
          item.leaseEpoch === params[2] &&
          item.dispatchId == null,
      )
      if (!row) return { rowCount: 0, rows: [] }
      row.status = 'sent'
      row.leaseOwner = null
      return { rowCount: 1, rows: [] }
    }
    if (text.includes("status = 'paused'")) {
      const row = this.jobs.find(
        (item) =>
          item.jobId === params[0] &&
          item.status === 'leased' &&
          item.leaseOwner === params[1] &&
          item.leaseEpoch === params[2] &&
          item.dispatchId == null,
      )
      if (!row) return { rowCount: 0, rows: [] }
      row.status = 'paused'
      row.leaseOwner = null
      return { rowCount: 1, rows: [] }
    }
    throw new Error(`unhandled SQL: ${text.slice(0, 180)}`)
  }
}

function input(nowMs = 1_000) {
  return {
    userId: 1619n,
    sessionId: 'sess-1',
    clientMessageId: CMID,
    dispatchId: DISPATCH_ID,
    leaseEpoch: 3,
    failureCode: 'bridge_closed_during_admission',
    frame: {
      type: 'inbound.message',
      clientMessageId: CMID,
      content: { text: '第三轮' },
    },
    nowMs,
  }
}

describe('pre-receipt recycle replay', () => {
  test('admission then recycle before delivery schedules one same-dispatch replay and writes no billing row', async () => {
    const mem = new Mem()
    mem.seedDispatch()
    const result = await schedulePreReceiptRecycleReplay(mem as unknown as Pool, input())
    assert.equal(result, 'scheduled')
    assert.equal(mem.jobs.length, 1)
    const job = mem.jobs[0]!
    assert.equal(job.root, preReceiptRecycleRoot(CMID))
    assert.equal(job.sourceClientMessageId, CMID)
    assert.equal(job.dispatchId, null)
    assert.equal(job.status, 'queued')
    assert.equal(job.request._recycleSameDispatch, true)
    assert.equal(job.request._recycleDeadlineAt, 1_000 + RECYCLE_READMIT_WINDOW_MS)
    assert.equal(job.request._recycleDispatchId, DISPATCH_ID)
    const frame = recycleReplayFrameFromJob(job.request)
    assert.equal((frame?.content as { text: string }).text, '第三轮')
    assert.equal(frame?.clientMessageId, CMID)
    assert.equal(
      job.tape,
      createHash('sha256').update(`pre-receipt:${DISPATCH_ID}`, 'utf8').digest('hex'),
    )
    const dispatch = mem.dispatches[0]!
    assert.equal(dispatch.status, 'admitted')
    assert.equal(dispatch.ownerId, null)
    assert.equal(dispatch.billingRequestId, 'bill-once')
    assert.equal(dispatch.acceptedAt, null)
    const joined = mem.sql.join('\n')
    assert.equal(joined.includes('usage_records'), false)
    assert.equal(joined.includes('billing_request_id'), false)
  })

  test('a sent replay is not scheduled again', async () => {
    const mem = new Mem()
    mem.seedDispatch()
    assert.equal(
      await schedulePreReceiptRecycleReplay(mem as unknown as Pool, input()),
      'scheduled',
    )
    mem.jobs[0]!.status = 'sent'
    assert.equal(
      await schedulePreReceiptRecycleReplay(mem as unknown as Pool, input()),
      'exhausted',
    )
    assert.equal(mem.jobs.length, 1)
  })

  test('a queued replay stays pending and does not insert another job', async () => {
    const mem = new Mem()
    const dispatch = mem.seedDispatch()
    assert.equal(
      await schedulePreReceiptRecycleReplay(mem as unknown as Pool, input()),
      'scheduled',
    )
    dispatch.ownerId = 'bridge-new'
    assert.equal(await schedulePreReceiptRecycleReplay(mem as unknown as Pool, input()), 'pending')
    assert.equal(mem.jobs.length, 1)
    assert.equal(dispatch.ownerId, 'bridge-new')
  })

  test('a container receipt is not replayed', async () => {
    const mem = new Mem()
    mem.seedDispatch({ acceptedAt: '2026-10-31T02:58:48Z' })
    assert.equal(
      await schedulePreReceiptRecycleReplay(mem as unknown as Pool, input()),
      'not_pre_receipt',
    )
    assert.equal(mem.jobs.length, 0)
    assert.equal(mem.dispatches[0]!.ownerId, 'bridge-old')
  })

  test('a user stop declines the replay and keeps the lease', async () => {
    const mem = new Mem()
    mem.seedDispatch()
    mem.stops.add(`1619:sess-1:${CMID}`)
    assert.equal(await schedulePreReceiptRecycleReplay(mem as unknown as Pool, input()), 'declined')
    assert.equal(mem.jobs.length, 0)
    assert.equal(mem.dispatches[0]!.ownerId, 'bridge-old')
  })

  test('mark sent then pause only match the leased pre-receipt job', async () => {
    const mem = new Mem()
    mem.jobs.push({
      jobId: 'job-1',
      userId: '1619',
      sessionId: 'sess-1',
      root: preReceiptRecycleRoot(CMID),
      status: 'leased',
      leaseOwner: 'bridge-new',
      leaseEpoch: 4,
      dispatchId: null,
      request: {},
      errorCode: 'bridge_closed_during_admission',
      tape: 'ab',
      sourceClientMessageId: CMID,
    })
    assert.equal(
      await markPreReceiptRecycleReplaySent(mem as unknown as Pool, {
        jobId: 'job-1',
        leaseOwner: 'bridge-new',
        leaseEpoch: 4,
      }),
      true,
    )
    assert.equal(mem.jobs[0]!.status, 'sent')
    mem.jobs[0]!.status = 'leased'
    mem.jobs[0]!.leaseOwner = 'bridge-new'
    assert.equal(
      await pausePreReceiptRecycleReplay(
        mem as unknown as Pool,
        {
          jobId: 'job-1',
          leaseOwner: 'bridge-new',
          leaseEpoch: 4,
        },
        'recycle_readmit_expired',
      ),
      true,
    )
    assert.equal(mem.jobs[0]!.status, 'paused')
  })

  test('replay waits for an open link and expires at 60s', () => {
    assert.equal(recycleReplayDecision({ nowMs: 10, deadlineAt: 70, linkOpen: false }), 'release')
    assert.equal(recycleReplayDecision({ nowMs: 70, deadlineAt: 70, linkOpen: true }), 'replay')
    assert.equal(recycleReplayDecision({ nowMs: 71, deadlineAt: 70, linkOpen: true }), 'expire')
    assert.equal(isPreReceiptRecycleReplayCode('bridge_closed_during_admission', true), true)
    assert.equal(isPreReceiptRecycleReplayCode('bridge_closed_during_admission', false), false)
    assert.equal(isPreReceiptRecycleReplayCode('container_forward_rejected', false), true)
    assert.equal(
      isPreReceiptRecycleReplayCode('bridge_cleaned_before_physical_forward', true),
      true,
    )
    assert.equal(
      isPreReceiptRecycleReplayCode('bridge_cleaned_before_physical_forward', false),
      false,
    )
    assert.equal(isPreReceiptRecycleReplayCode('dispatch_enrichment_timeout', true), false)
  })

  test('grey line only after the same dispatch was actually accepted', () => {
    assert.equal(RECYCLE_READMIT_NOTICE_TEXT, '执行环境已更新，本轮已继续')
    assert.equal(RECYCLE_READMIT_FAILURE_TEXT.includes('联系管理员'), false)
    assert.equal(
      recycleReadmitGreyLineVisible({
        sameDispatch: true,
        jobStatus: 'sent',
        acceptedAt: new Date(),
        dispatchStatus: 'accepted',
        outcome: null,
      }),
      true,
    )
    assert.equal(
      recycleReadmitGreyLineVisible({
        sameDispatch: true,
        jobStatus: 'completed',
        acceptedAt: new Date(),
        dispatchStatus: 'terminal',
        outcome: 'completed',
      }),
      true,
    )
    assert.equal(
      recycleReadmitGreyLineVisible({
        sameDispatch: true,
        jobStatus: 'sent',
        acceptedAt: null,
        dispatchStatus: 'terminal',
        outcome: 'executed_error',
      }),
      false,
    )
    assert.equal(
      recycleReadmitGreyLineVisible({
        sameDispatch: true,
        jobStatus: 'paused',
        acceptedAt: new Date(),
        dispatchStatus: 'accepted',
        outcome: null,
      }),
      false,
    )
    assert.equal(RECYCLE_READMIT_NOTICE_SQL.includes('usage_records'), false)
    assert.equal(RECYCLE_READMIT_NOTICE_SQL.includes('accepted_at'), true)
  })
})
