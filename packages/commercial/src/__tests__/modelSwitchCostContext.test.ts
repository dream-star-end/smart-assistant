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
      if (sql.includes('model-switch-failed-start')) return { rows: [] }
      if (sql.includes('model-switch-history-shape'))
        return { rows: [{ peak_tokens: '200460', has_unknown: false, has_shrunk: false }] }
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

test('native shrink/compact and incomplete historical counters use B without hydrating history', async () => {
  for (const shape of [
    { peak_tokens: '900000', has_unknown: false, has_shrunk: false },
    { peak_tokens: '200460', has_unknown: false, has_shrunk: true },
    { peak_tokens: '200460', has_unknown: true, has_shrunk: false },
  ]) {
    const old = db([tape('2', 'cheap')])
    const pool = {
      query: async (sql: string, params: unknown[]) =>
        sql.includes('model-switch-history-shape') ? { rows: [shape] } : old.query(sql, params),
    } as unknown as Pool
    const context = await readSwitchContext(pool, '765', 'own', 'm-compact-guard', {
      targetModel: 'gpt-6-astra',
    })
    assert.equal(context.source, 'unknown')
    assert.equal(context.tokens, null)
  }
})

test('same model only takes the fast path for the same agent routing', async () => {
  const context = await readSwitchContext(
    db([tape('2', 'cheap')]),
    '765',
    'own',
    'm-other-agent-context',
    { targetModel: 'cheap', targetAgent: 'other-agent' },
  )
  assert.equal(context.source, 'last-call')
  assert.equal(context.sourceAgent, 'main')
})

// A first turn that crashed at zero tokens is the one case where the session has
// no executed source but the reader still sees a tape. The failed attempt may
// name its own route; it must never become a numeric context or an empty session.
const crashedFirstTurn = {
  tape_id: '9',
  tape_sha256: '9',
  agent_id: 'main',
  status: 'crashed',
  usage: {
    model: 'cheap',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  finalized_at: 'now',
  created_at: '9',
  client_message_id: 'msg-1',
}
const failedDb = (failedRows: unknown[]) =>
  ({
    query: async (sql: string) => {
      if (sql.includes('model-switch-failed-start')) return { rows: failedRows }
      if (sql.includes('FROM client_sessions cs'))
        return {
          rows: [
            {
              history_revision: '3',
              timeline_generation: '1',
              has_content: true,
              deleted_at: null,
              archived: false,
            },
          ],
        }
      if (sql.includes('FROM client_session_turn_tapes')) return { rows: [crashedFirstTurn] }
      return { rows: [] }
    },
  }) as unknown as Pool
const failedRow = {
  dispatch_id: 'd-1',
  tape_sha256: '9',
  model: 'cheap',
  agent_id: 'main',
  messages: JSON.stringify([
    { role: 'user', id: 'msg-1' },
    { id: 'anchor', role: 'assistant', _source: 'server', _turnTapeId: '9', _turnTapeSha256: '9', _turnTapeComplete: true },
    { role: 'user', id: 'req-next' },
  ]),
}

test('a zero-token first-turn crash continues on the same model without a switch', async () => {
  const ctx = await readSwitchContext(failedDb([failedRow]), '765', 'own', 'req-next', {
    targetModel: 'cheap',
    targetAgent: 'main',
  })
  assert.equal(ctx.source, 'unchanged')
  assert.equal(ctx.sourceModel, 'cheap')
  assert.equal(ctx.sourceAgent, 'main')
  assert.equal(ctx.tokens, null)
})

test('the same failed first turn is still risk when the model really changes', async () => {
  const ctx = await readSwitchContext(failedDb([failedRow]), '765', 'own', 'req-next', {
    targetModel: 'expensive',
    targetAgent: 'main',
  })
  assert.equal(ctx.source, 'unknown')
  assert.equal(ctx.sourceModel, null)
  assert.equal(ctx.tokens, null)
})

test('without the authoritative crashed dispatch the failed first turn stays undecided', async () => {
  for (const rows of [[], [{ ...failedRow, dispatch_id: 'd-1', model: null }]]) {
    const ctx = await readSwitchContext(failedDb(rows), '765', 'own', 'req-next', {
      targetModel: 'cheap',
      targetAgent: 'main',
    })
    assert.equal(ctx.source, 'unknown')
    assert.equal(ctx.sourceModel, null)
  }
})

test('a changed failed-attempt identity changes the fingerprint a quote was signed over', async () => {
  const first = await readSwitchContext(failedDb([failedRow]), '765', 'own', 'req-next', {
    targetModel: 'cheap',
    targetAgent: 'main',
  })
  const second = await readSwitchContext(
    failedDb([{ ...failedRow, dispatch_id: 'd-2' }]),
    '765',
    'own',
    'req-next',
    { targetModel: 'cheap', targetAgent: 'main' },
  )
  assert.notEqual(first.fingerprint, second.fingerprint)
})
