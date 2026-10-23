import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Pool } from 'pg'

import type { Logger } from '../logging/logger.js'
import {
  GAP_TTL_MS,
  type StudioEventFrame,
  startStudioEventPump,
  toFrame,
} from '../media-studio/orchestrator/push.js'

const silent = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id: String(id),
  project_id: '7',
  user_id: '765',
  status: 'composing',
  type: 'compose.started',
  ts: new Date('2026-10-24T01:02:03.000Z'),
  message: null,
  live: true,
  ...over,
})

/** A pool whose event table is `events`; the boot query sees `bootMax`. */
function fakePool(events: ReturnType<typeof row>[], bootMax: number) {
  const queries: unknown[][] = []
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push(params ?? [])
      if (sql.includes('MAX(id)')) return { rows: [{ id: String(bootMax) }] }
      if (sql.includes('ANY(')) {
        const ids = (params as [string[]])[0]
        return { rows: events.filter((e) => ids.includes(e.id)) }
      }
      const [cursor, limit] = params as [string, number]
      return {
        rows: events
          .filter((e) => Number(e.id) > Number(cursor))
          .sort((a, b) => Number(a.id) - Number(b.id))
          .slice(0, limit),
      }
    },
  }
  return { pool: pool as unknown as Pool, queries }
}

const until = async (ok: () => boolean) => {
  const started = Date.now()
  while (!ok()) {
    if (Date.now() - started > 2000) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('studio push (A2-1c-2)', () => {
  test('toFrame: a sys.studio_event with the project status and the event card', () => {
    assert.deepEqual(
      toFrame(row(12, { status: 'done', type: 'compose.done', message: '成片已生成' })),
      {
        type: 'sys.studio_event',
        projectId: '7',
        status: 'done',
        event: {
          id: '12',
          type: 'compose.done',
          ts: '2026-10-24T01:02:03.000Z',
          message: '成片已生成',
        },
      },
    )
  })

  test('the pump starts after the newest event at boot and delivers only newer ones, once, in order', async () => {
    const events = [row(1), row(2)]
    const { pool } = fakePool(events, 2)
    const sent: Array<{ uid: bigint; frame: StudioEventFrame }> = []
    const stop = startStudioEventPump({
      pool,
      send: (uid, frame) => sent.push({ uid, frame }),
      log: silent,
      everyMs: 10,
    })
    try {
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(sent.length, 0, 'history is not replayed')
      events.push(row(3), row(4, { user_id: '247' }))
      await until(() => sent.length === 2)
      await new Promise((r) => setTimeout(r, 40))
      assert.deepEqual(
        sent.map((s) => [s.uid, s.frame.event.id]),
        [
          [765n, '3'],
          [247n, '4'],
        ],
      )
    } finally {
      stop()
    }
  })

  test('a failing send does not stop the pump or redeliver; stop ends polling', async () => {
    const events: ReturnType<typeof row>[] = []
    const { pool, queries } = fakePool(events, 0)
    const sent: string[] = []
    const stop = startStudioEventPump({
      pool,
      send: (_uid, frame) => {
        sent.push(frame.event.id)
        if (frame.event.id === '1') throw new Error('socket gone')
      },
      log: silent,
      everyMs: 10,
    })
    await new Promise((r) => setTimeout(r, 30))
    events.push(row(1), row(2))
    await until(() => sent.length === 2)
    await new Promise((r) => setTimeout(r, 40))
    assert.deepEqual(sent, ['1', '2'])
    stop()
    const n = queries.length
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(queries.length, n, 'no queries after stop')
  })

  test('an event that commits after a higher id is still delivered (code r1 P1)', async () => {
    const events = [row(1)]
    const { pool } = fakePool(events, 1)
    const sent: string[] = []
    const stop = startStudioEventPump({
      pool,
      send: (_uid, frame) => sent.push(frame.event.id),
      log: silent,
      everyMs: 10,
    })
    try {
      await new Promise((r) => setTimeout(r, 30))
      // 2 is still in flight when 3 commits and is read.
      events.push(row(3))
      await until(() => sent.length === 1)
      events.push(row(2))
      await until(() => sent.length === 2)
      await new Promise((r) => setTimeout(r, 40))
      assert.deepEqual(sent, ['3', '2'], 'each once')
    } finally {
      stop()
    }
  })

  test('a gap that never fills expires; events of deleted projects are not sent', async () => {
    const events = [row(1)]
    const { pool, queries } = fakePool(events, 1)
    let clock = 0
    const sent: string[] = []
    const stop = startStudioEventPump({
      pool,
      send: (_uid, frame) => sent.push(frame.event.id),
      log: silent,
      everyMs: 10,
      now: () => clock,
    })
    try {
      await new Promise((r) => setTimeout(r, 30))
      events.push(row(3), row(4, { live: false }))
      await until(() => sent.length === 1)
      clock = GAP_TTL_MS + 1
      await new Promise((r) => setTimeout(r, 40))
      const n = queries.length
      await new Promise((r) => setTimeout(r, 40))
      const gapQueries = queries.slice(n).filter((q) => Array.isArray(q[0]))
      assert.equal(gapQueries.length, 0, 'the rolled-back id is no longer checked')
      assert.deepEqual(sent, ['3'])
    } finally {
      stop()
    }
  })
})
