import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { readSwitchContext } from '../billing/modelSwitchCostContext.js'
const tape = (id: string, model: string, status = 'completed', output = 7) => ({
  tape_id: id,
  tape_sha256: id,
  agent_id: 'main',
  status,
  usage: {
    model,
    inputTokens: status === 'completed' ? 200453 : 0,
    outputTokens: status === 'completed' ? output : 0,
  },
  finalized_at: 'now',
  created_at: id,
})
function db(
  tapes: ReturnType<typeof tape>[],
  payload: Buffer | null = Buffer.from(
    JSON.stringify({
      role: 'assistant',
      _callUsage: { callId: 'exact', usage: { inputTokens: 200453, outputTokens: 7 } },
    }),
  ),
) {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM client_sessions cs'))
        return {
          rows: [
            {
              history_revision: '7',
              timeline_generation: '2',
              has_content: true,
              deleted_at: null,
              archived: false,
            },
          ],
        }
      if (sql.includes('FROM client_session_turn_tapes')) return { rows: tapes }
      if (sql.includes('EXISTS(SELECT 1 FROM usage_records')) {
        assert.ok(sql.includes('u.model<>'))
        return { rows: [] }
      }
      if (sql.includes("status<>'terminal'")) return { rows: [] }
      if (sql.includes('WITH tail')) return { rows: [{ ordinal: 2, payload }] }
      throw Error('unexpected query')
    },
  } as unknown as Pool
}
test('only exact last-call counters give a numeric context; optional exact cache fields mean zero', async () => {
  const ctx = await readSwitchContext(db([tape('2', 'cheap')]), '765', 'own', 'm-test-1', {
    targetModel: 'expensive',
  })
  assert.equal(ctx.tokens, 200453)
  assert.equal(ctx.source, 'last-call')
})
test('oversized or partial last-call payload becomes B, never a zero estimate', async () => {
  for (const payload of [
    null,
    Buffer.from('{'),
    Buffer.from(JSON.stringify({ _callUsage: { callId: 'x', usage: { outputTokens: 7 } } })),
  ]) {
    const ctx = await readSwitchContext(
      db([tape('2', 'cheap')], payload),
      '765',
      'own',
      'm-test-1',
      { targetModel: 'expensive' },
    )
    assert.equal(ctx.tokens, null)
    assert.equal(ctx.source, 'unknown')
  }
})
test('failed zero-usage target is not treated as an executed same-model switch', async () => {
  const ctx = await readSwitchContext(
    db([tape('3', 'expensive', 'crashed'), tape('2', 'cheap')]),
    '765',
    'own',
    'm-test-1',
    { targetModel: 'expensive' },
  )
  assert.equal(ctx.sourceModel, 'cheap')
  assert.equal(ctx.source, 'unknown')
  assert.equal(ctx.tokens, null)
})
test('image feature does not become the chat source or an output prediction sample', async () => {
  const ctx = await readSwitchContext(
    db([tape('3', 'gpt-image-2', 'completed', 0), tape('2', 'cheap')]),
    '765',
    'own',
    'm-test-1',
    { targetModel: 'expensive' },
  )
  assert.equal(ctx.sourceModel, 'cheap')
  assert.deepEqual(ctx.outputs, [7])
  assert.equal(ctx.source, 'unknown')
})

test('missing latest call snapshot cannot borrow an earlier small call', async () => {
  const old = db([tape('2', 'cheap')])
  const pool = {
    query: async (sql: string, params: unknown[]) =>
      sql.includes('WITH tail')
        ? {
            rows: [
              {
                ordinal: 3,
                payload: Buffer.from(
                  JSON.stringify({ role: 'assistant', text: 'latest response with no counters' }),
                ),
              },
              {
                ordinal: 2,
                payload: Buffer.from(
                  JSON.stringify({
                    role: 'assistant',
                    _callUsage: {
                      callId: 'old-call',
                      usage: { inputTokens: 1000, outputTokens: 7 },
                    },
                  }),
                ),
              },
            ],
          }
        : old.query(sql, params),
  } as unknown as Pool
  const context = await readSwitchContext(pool, '765', 'own', 'm-cost-test', {
    targetModel: 'gpt-6-astra',
  })
  assert.equal(context.source, 'unknown')
  assert.equal(context.tokens, null)
})

test('late child and delegate continuation invalidate old small parent counts without replacing its model', async () => {
  for (const kind of ['child', 'continuation']) {
    const old = db([tape('2', 'cheap')])
    const pool = {
      query: async (sql: string, params: unknown[]) =>
        sql.includes('model-switch-latest-tape')
          ? {
              rows: [
                {
                  tape_id: `late-${kind}`,
                  tape_sha256: 'late',
                  parent_turn_key: kind === 'child' ? 'parent' : null,
                  continuation_of_turn_key: kind === 'continuation' ? 'parent' : null,
                },
              ],
            }
          : old.query(sql, params),
    } as unknown as Pool
    const context = await readSwitchContext(pool, '765', 'own', 'm-late-tape', {
      targetModel: 'gpt-6-astra',
    })
    assert.equal(context.sourceModel, 'cheap')
    assert.equal(context.source, 'unknown')
    assert.equal(context.tokens, null)
  }
})
