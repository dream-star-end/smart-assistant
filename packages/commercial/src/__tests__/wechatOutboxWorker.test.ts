import assert from 'node:assert/strict'
/**
 * outboxWorker 单测 — dep 全部 mock,聚焦 drainOne 分流 + tick loop 控制 + housekeeping。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wechatOutboxWorker.test.ts
 */
import { afterEach, describe, test } from 'node:test'
import type { Pool } from 'pg'
import {
  type DrainOutcome,
  type GetBindingFn,
  OutboxWorker,
  computeTransientNextAttemptAt,
  type SendMediaFn,
  type SendResult,
  type SendTextFn,
  drainOne,
  runHousekeeping,
  stableIlinkClientId,
} from '../wechat/outboxWorker.js'
import type { OutboxRow } from '../wechat/types.js'

interface CapturedQuery {
  sql: string
  params: ReadonlyArray<unknown>
}

function makeFakePool(
  responder: (
    sql: string,
    params: ReadonlyArray<unknown>,
  ) => {
    rows: Record<string, unknown>[]
    rowCount: number | null
  },
): { pool: Pool; captured: CapturedQuery[] } {
  const captured: CapturedQuery[] = []
  const fakeClient = {
    query: async (sql: string, params: ReadonlyArray<unknown> = []) => {
      captured.push({ sql, params })
      return responder(sql, params)
    },
    release: () => {},
  }
  const pool = {
    query: async (sql: string, params: ReadonlyArray<unknown> = []) => {
      captured.push({ sql, params })
      return responder(sql, params)
    },
    connect: async () => fakeClient,
  } as unknown as Pool
  return { pool, captured }
}

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1,
    outboundId: 'ob-1',
    // PG-side raw digit form;outboxWorker drainOne 跨入 sqlite 时会 prepend `c:`
    // (见 outboxWorker.ts 头注释及 userIds.ts 约定)。
    bindingUserId: '1',
    senderId: 's1',
    sessionId: 'wsess-0123456789abcdef',
    payload: [{ type: 'text', text: 'hi' }],
    status: 'sending',
    attempts: 0,
    lastError: null,
    lockedAt: 1000,
    sentAt: null,
    nextAttemptAt: null,
    createdAt: 500,
    updatedAt: 1000,
    ...overrides,
  }
}

const now = () => 5000

describe('outboxWorker.drainOne', () => {
  test('getBinding 收到 sqlite-side canonical 形式(`c:` + row.bindingUserId),不是 raw digit', async () => {
    // 回归测试:生产 row 1(boss 1193355375@qq.com → c:1)首条 outbox row 因为这层
    // 翻译漏掉而 binding_gone 10×。see commit message + 'binding_gone' incident notes。
    const { pool } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const getBindingCalls: string[] = []
    const getBinding: GetBindingFn = async (uid) => {
      getBindingCalls.push(uid)
      return { botToken: 'tok', contextTokens: { s1: 'ctx-s1' } }
    }
    const sendText: SendTextFn = async () => ({ ok: true })
    const outcome = await drainOne(makeRow({ bindingUserId: '1' }), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.deepEqual(outcome, { kind: 'sent', outboxId: 1 })
    assert.deepEqual(getBindingCalls, ['c:1'], 'getBinding 必须收到 prefix 过的形式')
  })

  test("happy: binding found, ctx token found, sendText ok → markSent → outcome 'sent'", async () => {
    const { pool, captured } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const sendCalls: Parameters<SendTextFn>[0][] = []
    const sendText: SendTextFn = async (p) => {
      sendCalls.push(p)
      return { ok: true }
    }
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx-s1' },
    })
    const outcome = await drainOne(makeRow(), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.deepEqual(outcome, { kind: 'sent', outboxId: 1 })
    assert.equal(sendCalls.length, 1)
    assert.equal(sendCalls[0]!.botToken, 'tok')
    assert.equal(sendCalls[0]!.contextToken, 'ctx-s1')
    assert.equal(sendCalls[0]!.text, 'hi')
    // markSent UPDATE happened
    assert.ok(
      captured.some((c) => /UPDATE wechat_outbox SET[\s\S]+status\s*=\s*'sent'/.test(c.sql)),
    )
  })

  test('sendText receives stable iLink client_id derived from outbound id and part index', async () => {
    const { pool } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const sendCalls: Parameters<SendTextFn>[0][] = []
    const sendText: SendTextFn = async (p) => {
      sendCalls.push(p)
      return { ok: true }
    }
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx-s1' },
    })
    const row = makeRow({
      outboundId: 'outbound:retry-key-1',
      payload: [
        { type: 'text', text: 'part-1' },
        { type: 'text', text: 'part-2' },
      ],
    })

    await drainOne(row, { pool, sendText, getBinding, now, maxAttempts: 10 })
    await drainOne(row, { pool, sendText, getBinding, now, maxAttempts: 10 })

    const expected0 = stableIlinkClientId('outbound:retry-key-1', 0)
    const expected1 = stableIlinkClientId('outbound:retry-key-1', 1)
    assert.notEqual(expected0, expected1)
    assert.deepEqual(
      sendCalls.map((c) => c.clientId),
      [expected0, expected1, expected0, expected1],
    )
  })

  test('pacing: 3 text parts → delay called between successful sends only', async () => {
    const { pool } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const sendCalls: string[] = []
    const delays: number[] = []
    const sendText: SendTextFn = async (p) => {
      sendCalls.push(p.text)
      return { ok: true }
    }
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx-s1' },
    })
    const outcome = await drainOne(
      makeRow({
        payload: [
          { type: 'text', text: 'part-1' },
          { type: 'text', text: 'part-2' },
          { type: 'text', text: 'part-3' },
        ],
      }),
      {
        pool,
        sendText,
        getBinding,
        now,
        maxAttempts: 10,
        interPartDelayMs: 1000,
        delay: async (ms) => {
          delays.push(ms)
        },
      },
    )
    assert.deepEqual(outcome, { kind: 'sent', outboxId: 1 })
    assert.deepEqual(sendCalls, ['part-1', 'part-2', 'part-3'])
    assert.deepEqual(delays, [1000, 1000])
  })

  test('pacing: failed first send returns immediately and does not delay', async () => {
    const { pool } = makeFakePool((sql) => {
      if (/UPDATE wechat_outbox SET[\s\S]+attempts\s*=\s*attempts \+ 1/.test(sql)) {
        return { rows: [{ attempts: 1, status: 'queued' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const delays: number[] = []
    const sendText: SendTextFn = async () => ({ ok: false, errMessage: 'ret=-2' })
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx-s1' },
    })
    const outcome = await drainOne(
      makeRow({
        payload: [
          { type: 'text', text: 'part-1' },
          { type: 'text', text: 'part-2' },
        ],
      }),
      {
        pool,
        sendText,
        getBinding,
        now,
        maxAttempts: 10,
        transientBackoffBaseMs: 5000,
        transientBackoffMaxMs: 60000,
        interPartDelayMs: 1000,
        delay: async (ms) => {
          delays.push(ms)
        },
      },
    )
    assert.deepEqual(outcome, {
      kind: 'failed_transient',
      outboxId: 1,
      attempts: 1,
      errMessage: 'ret=-2',
    })
    assert.deepEqual(delays, [])
  })

  test('transient failure sets next_attempt_at backoff before retry', async () => {
    let markFailedParams: ReadonlyArray<unknown> | null = null
    const { pool } = makeFakePool((sql, params) => {
      if (/UPDATE wechat_outbox SET[\s\S]+attempts\s*=\s*attempts \+ 1/.test(sql)) {
        markFailedParams = params
        return { rows: [{ attempts: 2, status: 'queued' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const sendText: SendTextFn = async () => ({ ok: false, errMessage: 'ret=-2' })
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx-s1' },
    })
    const outcome = await drainOne(makeRow({ attempts: 1 }), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
      transientBackoffBaseMs: 5000,
      transientBackoffMaxMs: 60000,
    })
    assert.equal(outcome.kind, 'failed_transient')
    assert.ok(markFailedParams)
    assert.equal(markFailedParams![3], 15_000, 'attempt #2 backs off by 10s from now=5000')
  })

  test('binding gone → forceFail to terminal failed_permanent (no retry)', async () => {
    const { pool, captured } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const getBinding: GetBindingFn = async () => null
    const sendText: SendTextFn = async () => ({ ok: true }) // should never run
    const outcome = await drainOne(makeRow(), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.deepEqual(outcome, { kind: 'failed_permanent', outboxId: 1, reason: 'binding_gone' })
    // Explicitly undeliverable rows remain retained, without pinning a cap.
    const forceFailQ = captured.find((c) =>
      /UPDATE wechat_outbox SET[\s\S]+status\s*=\s*'failed'/.test(c.sql),
    )!
    assert.match(forceFailQ.sql, /attempts\s*=\s*attempts \+ 1/)
    assert.equal(forceFailQ.params[0], 'binding_gone')
  })

  test('no context_token for sender → forceFail terminal', async () => {
    const { pool } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const getBinding: GetBindingFn = async () => ({ botToken: 'tok', contextTokens: {} }) // s1 not present
    const sendText: SendTextFn = async () => {
      throw new Error('should not be called')
    }
    const outcome = await drainOne(makeRow(), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.deepEqual(outcome, {
      kind: 'failed_permanent',
      outboxId: 1,
      reason: 'no_context_token',
    })
  })

  test('sendText permanent error → forceFail terminal', async () => {
    const { pool, captured } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const sendText: SendTextFn = async () => ({
      ok: false,
      errMessage: 'token expired',
      permanent: true,
    })
    const outcome = await drainOne(makeRow(), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.deepEqual(outcome, {
      kind: 'failed_permanent',
      outboxId: 1,
      reason: 'token expired',
    })
    // forceFail retains the exact row and increments diagnostics only.
    const failQ = captured.find((c) => /status\s*=\s*'failed'/.test(c.sql))!
    assert.match(failQ.sql, /attempts\s*=\s*attempts \+ 1/)
  })

  test('sendText transient error → queued retry with incremented attempts', async () => {
    const { pool } = makeFakePool((sql) => {
      if (/UPDATE wechat_outbox SET[\s\S]+attempts\s*=\s*attempts \+ 1/.test(sql)) {
        return { rows: [{ attempts: 3, status: 'queued' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const sendText: SendTextFn = async () => ({ ok: false, errMessage: 'timeout' })
    const outcome = await drainOne(makeRow({ attempts: 2 }), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.deepEqual(outcome, {
      kind: 'failed_transient',
      outboxId: 1,
      attempts: 3,
      errMessage: 'timeout',
    })
  })

  test('sendText transient error above legacy attempts cap still retries', async () => {
    const { pool } = makeFakePool((sql) => {
      if (/UPDATE wechat_outbox SET[\s\S]+attempts\s*=\s*attempts \+ 1/.test(sql)) {
        return { rows: [{ attempts: 10, status: 'queued' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const sendText: SendTextFn = async () => ({ ok: false, errMessage: '5xx' })
    const outcome = await drainOne(makeRow({ attempts: 9 }), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.deepEqual(outcome, {
      kind: 'failed_transient',
      outboxId: 1,
      attempts: 10,
      errMessage: '5xx',
    })
  })

  test('multi-part: 2nd part fails → markFailed whole row (P1 simple retry, accepts part 1 duplication on next pick)', async () => {
    const { pool } = makeFakePool(() => ({
      rows: [{ attempts: 1, status: 'queued' }],
      rowCount: 1,
    }))
    const sendCalls: string[] = []
    const sendText: SendTextFn = async ({ text }) => {
      sendCalls.push(text)
      if (text === 'part2') return { ok: false, errMessage: 'boom' }
      return { ok: true }
    }
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const outcome = await drainOne(
      makeRow({
        payload: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2' },
          { type: 'text', text: 'part3' }, // 不应被调用
        ],
      }),
      { pool, sendText, getBinding, now, maxAttempts: 10 },
    )
    assert.equal(outcome.kind, 'failed_transient')
    assert.deepEqual(sendCalls, ['part1', 'part2']) // 第3条不发
  })

  test('multi-part: all parts ok → markSent (single mark, not per-part)', async () => {
    const { pool, captured } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const sendText: SendTextFn = async () => ({ ok: true })
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const outcome = await drainOne(
      makeRow({
        payload: [
          { type: 'text', text: 'p1' },
          { type: 'text', text: 'p2' },
        ],
      }),
      { pool, sendText, getBinding, now, maxAttempts: 10 },
    )
    assert.deepEqual(outcome, { kind: 'sent', outboxId: 1 })
    const markSentQs = captured.filter((c) => /status\s*=\s*'sent'/.test(c.sql))
    assert.equal(markSentQs.length, 1)
  })

  test('media part: resolves current-user file and sends via sendMedia', async () => {
    const { pool, captured } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const sendText: SendTextFn = async () => {
      throw new Error('should not send text')
    }
    const sendMediaCalls: Parameters<SendMediaFn>[0][] = []
    const sendMedia: SendMediaFn = async (params) => {
      sendMediaCalls.push(params)
      return { ok: true }
    }
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const outcome = await drainOne(
      makeRow({
        payload: [
          {
            type: 'image',
            containerPath: '/home/agent/.openclaude/generated/result.png',
            filename: 'result.png',
          },
        ],
      }),
      {
        pool,
        sendText,
        sendMedia,
        resolveMediaPart: async ({ bindingUserId, part }) => {
          assert.equal(bindingUserId, '1')
          assert.equal(part.filename, 'result.png')
          return {
            kind: 'image',
            filename: 'result.png',
            mimeType: 'image/png',
            content: Buffer.from('png'),
          }
        },
        getBinding,
        now,
        maxAttempts: 10,
      },
    )
    assert.deepEqual(outcome, { kind: 'sent', outboxId: 1 })
    assert.equal(sendMediaCalls.length, 1)
    assert.equal(sendMediaCalls[0]!.botToken, 'tok')
    assert.equal(sendMediaCalls[0]!.contextToken, 'ctx')
    assert.equal(sendMediaCalls[0]!.media.kind, 'image')
    assert.equal(sendMediaCalls[0]!.clientId, stableIlinkClientId('ob-1', 0))
    assert.equal(sendMediaCalls[0]!.captionClientId, stableIlinkClientId('ob-1', 0, 'cap'))
    const markSentQs = captured.filter((c) => /status\s*=\s*'sent'/.test(c.sql))
    assert.equal(markSentQs.length, 1)
  })

  test('media part: resolver error marks row failed instead of crashing tick', async () => {
    const { pool } = makeFakePool((sql) => {
      if (/UPDATE wechat_outbox SET[\s\S]+attempts\s*=\s*attempts \+ 1/.test(sql)) {
        return { rows: [{ attempts: 1, status: 'queued' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const sendText: SendTextFn = async () => {
      throw new Error('should not send text')
    }
    const sendMedia: SendMediaFn = async () => {
      throw new Error('should not send media after resolve failure')
    }
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const outcome = await drainOne(
      makeRow({
        payload: [
          {
            type: 'file',
            containerPath: '/home/agent/.openclaude/uploads/missing.pdf',
            filename: 'missing.pdf',
          },
        ],
      }),
      {
        pool,
        sendText,
        sendMedia,
        resolveMediaPart: async () => {
          throw new Error('remote host media not found')
        },
        getBinding,
        now,
        maxAttempts: 10,
      },
    )
    assert.deepEqual(outcome, {
      kind: 'failed_transient',
      outboxId: 1,
      attempts: 1,
      errMessage: 'remote host media not found',
    })
  })

  test('markSent drift (rowCount=0) → outcome=noop', async () => {
    const { pool } = makeFakePool(() => ({ rows: [], rowCount: 0 }))
    const sendText: SendTextFn = async () => ({ ok: true })
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const outcome = await drainOne(makeRow(), { pool, sendText, getBinding, now, maxAttempts: 10 })
    assert.equal(outcome.kind, 'noop')
    assert.match(outcome.kind === 'noop' ? outcome.reason : '', /markSent_drift/)
  })

  // Codex slice 3 r1 WARN: payload invariant — payload 是 JSONB,无 schema 约束。
  // 若整行没有可发送的 text part(空 / 全非 text),不能静默 markSent,要 forceFail invalid_payload。
  test('empty payload → forceFail invalid_payload (no markSent)', async () => {
    const { pool, captured } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const sendText: SendTextFn = async () => {
      throw new Error('should never be called')
    }
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const outcome = await drainOne(makeRow({ payload: [] }), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.equal(outcome.kind, 'failed_permanent')
    assert.equal(outcome.kind === 'failed_permanent' ? outcome.reason : '', 'invalid_payload')
    // 必须走 forceFail(SET status='failed'),不能 markSent
    const sentMarks = captured.filter((c) => /SET[\s\S]+status\s*=\s*'sent'/.test(c.sql))
    assert.equal(sentMarks.length, 0, 'must NOT mark empty payload as sent')
    const failMarks = captured.filter((c) => /SET[\s\S]+status\s*=\s*'failed'/.test(c.sql))
    assert.equal(failMarks.length, 1)
  })

  test('payload with only non-text parts → forceFail invalid_payload', async () => {
    const { pool, captured } = makeFakePool(() => ({ rows: [], rowCount: 1 }))
    const sendText: SendTextFn = async () => {
      throw new Error('should never be called')
    }
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    // 模拟 DB 里塞了未来扩展类型(对 IlinkPart 类型断言绕过)
    const badPart = { type: 'image', url: 'http://x' } as unknown as { type: 'text'; text: string }
    const outcome = await drainOne(makeRow({ payload: [badPart, badPart] }), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.equal(outcome.kind, 'failed_permanent')
    assert.equal(outcome.kind === 'failed_permanent' ? outcome.reason : '', 'invalid_payload')
    const sentMarks = captured.filter((c) => /SET[\s\S]+status\s*=\s*'sent'/.test(c.sql))
    assert.equal(sentMarks.length, 0)
  })

  test('invalid_payload + row drifted (forceFail rowCount=0) → noop with reason', async () => {
    const { pool } = makeFakePool(() => ({ rows: [], rowCount: 0 })) // 任何 UPDATE 都 drift
    const sendText: SendTextFn = async () => ({ ok: true })
    const getBinding: GetBindingFn = async () => ({
      botToken: 'tok',
      contextTokens: { s1: 'ctx' },
    })
    const outcome = await drainOne(makeRow({ payload: [] }), {
      pool,
      sendText,
      getBinding,
      now,
      maxAttempts: 10,
    })
    assert.equal(outcome.kind, 'noop')
    assert.match(outcome.kind === 'noop' ? outcome.reason : '', /invalid_payload_but_row_drifted/)
  })
})

// ─── tick loop / start-stop ──────────────────────────────────────────────

describe('OutboxWorker.tick & lifecycle', () => {
  let activeWorker: OutboxWorker | null = null
  afterEach(async () => {
    if (activeWorker) {
      await activeWorker.stop()
      activeWorker = null
    }
  })

  function buildPool(rowsFn: () => Record<string, unknown>[] | null): { pool: Pool } {
    const responder = (
      sql: string,
    ): { rows: Record<string, unknown>[]; rowCount: number | null } => {
      if (/WITH picked AS/.test(sql)) {
        const rows = rowsFn()
        return rows === null ? { rows: [], rowCount: 0 } : { rows, rowCount: rows.length }
      }
      return { rows: [], rowCount: 1 }
    }
    const pool = {
      query: async (sql: string) => responder(sql),
      connect: async () => ({
        query: async (sql: string) => responder(sql),
        release: () => {},
      }),
    } as unknown as Pool
    return { pool }
  }

  test('tick drains until pickOne returns null (no rows = idle)', async () => {
    let calls = 0
    const queue: Record<string, unknown>[][] = [
      [
        {
          id: 1,
          outbound_id: 'x',
          binding_user_id: 'u1',
          sender_id: 's1',
          session_id: 'wsess-0123456789abcdef',
          payload: [{ type: 'text', text: 'a' }],
          status: 'sending',
          attempts: 0,
          last_error: null,
          locked_at: 1,
          sent_at: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
      [
        {
          id: 2,
          outbound_id: 'y',
          binding_user_id: 'u1',
          sender_id: 's1',
          session_id: 'wsess-0123456789abcdef',
          payload: [{ type: 'text', text: 'b' }],
          status: 'sending',
          attempts: 0,
          last_error: null,
          locked_at: 1,
          sent_at: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    ]
    const { pool } = buildPool(() => {
      calls++
      return queue.shift() ?? []
    })
    const sendCalls: string[] = []
    activeWorker = new OutboxWorker({
      pool,
      sendText: async ({ text }) => {
        sendCalls.push(text)
        return { ok: true }
      },
      getBinding: async () => ({ botToken: 'tok', contextTokens: { s1: 'ctx' } }),
      now,
      maxPerTick: 10,
      interRowDelayMs: 0,
    })
    await activeWorker.tick()
    // 2 picks succeeded + 1 empty pick to break the loop
    assert.equal(calls, 3)
    assert.deepEqual(sendCalls, ['a', 'b'])
  })

  test('tick paces successful single-part rows so live outbox rows are not burst-sent', async () => {
    const queue: Record<string, unknown>[][] = [
      [
        {
          id: 1,
          outbound_id: 'x',
          binding_user_id: 'u1',
          sender_id: 's1',
          session_id: 'wsess-0123456789abcdef',
          payload: [{ type: 'text', text: 'a' }],
          status: 'sending',
          attempts: 0,
          last_error: null,
          locked_at: 1,
          sent_at: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
      [
        {
          id: 2,
          outbound_id: 'y',
          binding_user_id: 'u1',
          sender_id: 's1',
          session_id: 'wsess-0123456789abcdef',
          payload: [{ type: 'text', text: 'b' }],
          status: 'sending',
          attempts: 0,
          last_error: null,
          locked_at: 1,
          sent_at: null,
          created_at: 2,
          updated_at: 2,
        },
      ],
    ]
    const { pool } = buildPool(() => queue.shift() ?? [])
    const sendCalls: string[] = []
    const delays: number[] = []
    activeWorker = new OutboxWorker({
      pool,
      sendText: async ({ text }) => {
        sendCalls.push(text)
        return { ok: true }
      },
      getBinding: async () => ({ botToken: 'tok', contextTokens: { s1: 'ctx' } }),
      now,
      maxPerTick: 10,
      interRowDelayMs: 750,
      delay: async (ms) => {
        delays.push(ms)
      },
    })
    await activeWorker.tick()
    assert.deepEqual(sendCalls, ['a', 'b'])
    assert.deepEqual(delays, [750])
  })

  test('tick stops after transient failure instead of immediately retrying the same queued row', async () => {
    let picks = 0
    const { pool } = makeFakePool((sql) => {
      if (/WITH picked AS/.test(sql)) {
        picks++
        return {
          rows: [
            {
              id: 1,
              outbound_id: 'x',
              binding_user_id: 'u1',
              sender_id: 's1',
              session_id: 'wsess-0123456789abcdef',
              payload: [{ type: 'text', text: 'a' }],
              status: 'sending',
              attempts: 0,
              last_error: null,
              locked_at: 1,
              sent_at: null,
              created_at: 1,
              updated_at: 1,
            },
          ],
          rowCount: 1,
        }
      }
      if (/UPDATE wechat_outbox SET[\s\S]+attempts\s*=\s*attempts \+ 1/.test(sql)) {
        return { rows: [{ attempts: 1, status: 'queued' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    let sends = 0
    activeWorker = new OutboxWorker({
      pool,
      sendText: async () => {
        sends++
        return { ok: false, errMessage: 'iLink business error: ret=-2' }
      },
      getBinding: async () => ({ botToken: 'tok', contextTokens: { s1: 'ctx' } }),
      now,
      maxPerTick: 10,
      interRowDelayMs: 0,
    })
    await activeWorker.tick()
    assert.equal(picks, 1)
    assert.equal(sends, 1)
  })

  test('tick stops at maxPerTick yield (防 event loop block)', async () => {
    let picks = 0
    const { pool } = buildPool(() => {
      picks++
      return [
        {
          id: picks,
          outbound_id: `ob-${picks}`,
          binding_user_id: 'u1',
          sender_id: 's1',
          session_id: 'wsess-0123456789abcdef',
          payload: [{ type: 'text', text: 'x' }],
          status: 'sending',
          attempts: 0,
          last_error: null,
          locked_at: 1,
          sent_at: null,
          created_at: picks,
          updated_at: picks,
        },
      ]
    })
    activeWorker = new OutboxWorker({
      pool,
      sendText: async () => ({ ok: true }),
      getBinding: async () => ({ botToken: 'tok', contextTokens: { s1: 'ctx' } }),
      now,
      maxPerTick: 3,
      interRowDelayMs: 0,
    })
    await activeWorker.tick()
    assert.equal(picks, 3, 'tick exits after maxPerTick drains')
  })

  test('drainOne exception is swallowed (worker.tick stays alive)', async () => {
    let firstCall = true
    const { pool } = buildPool(() => {
      if (firstCall) {
        firstCall = false
        return [
          {
            id: 1,
            outbound_id: 'x',
            binding_user_id: 'u1',
            sender_id: 's1',
            session_id: 'wsess-0123456789abcdef',
            payload: [{ type: 'text', text: 'boom' }],
            status: 'sending',
            attempts: 0,
            last_error: null,
            locked_at: 1,
            sent_at: null,
            created_at: 1,
            updated_at: 1,
          },
        ]
      }
      return [] // 第二次 pick 返回空,正常退出 loop
    })
    const errors: string[] = []
    activeWorker = new OutboxWorker({
      pool,
      sendText: async () => {
        throw new Error('network down')
      },
      getBinding: async () => ({ botToken: 'tok', contextTokens: { s1: 'ctx' } }),
      now,
      maxPerTick: 5,
      interRowDelayMs: 0,
      log: (level, msg) => {
        if (level === 'error') errors.push(msg)
      },
    })
    await activeWorker.tick() // 不抛
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /drainOne crashed/)
    assert.match(errors[0]!, /network down/)
  })

  test('start/stop: start then immediate stop should not leak timer', async () => {
    const { pool } = buildPool(() => [])
    activeWorker = new OutboxWorker({
      pool,
      sendText: async () => ({ ok: true }),
      getBinding: async () => null,
      now,
      pollIntervalMs: 999_999, // 故意大,确保我们不真等到下次 tick
      interRowDelayMs: 0,
    })
    activeWorker.start()
    await activeWorker.stop()
    // 再 start/stop 不抛
    activeWorker.start()
    await activeWorker.stop()
  })
})

describe('outboxWorker.computeTransientNextAttemptAt', () => {
  test('uses exponential backoff with max cap', () => {
    assert.equal(computeTransientNextAttemptAt(1000, 1, { baseMs: 5000, maxMs: 60000 }), 6000)
    assert.equal(computeTransientNextAttemptAt(1000, 2, { baseMs: 5000, maxMs: 60000 }), 11000)
    assert.equal(computeTransientNextAttemptAt(1000, 10, { baseMs: 5000, maxMs: 60000 }), 61000)
  })
})

describe('outboxWorker.runHousekeeping', () => {
  test('releases stale sending but never ages or purges paid output', async () => {
    const sqls: string[] = []
    const { pool } = makeFakePool((sql) => {
      sqls.push(sql.replace(/\s+/g, ' ').trim().slice(0, 100))
      if (/UPDATE wechat_outbox/.test(sql)) {
        if (/status\s*=\s*'queued'/.test(sql)) return { rows: [], rowCount: 1 } // release stale
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const result = await runHousekeeping(pool, 1_000_000)
    assert.deepEqual(result, { staleReleased: 1, aged: 0, purgedSent: 0, purgedFailed: 0 })
    assert.match(sqls[0]!, /status\s*=\s*'queued'/)
    assert.equal(sqls.length, 1)
  })
})

describe('DrainOutcome type completeness', () => {
  // 类型层 sanity:all DrainOutcome branches are covered above.
  test('kinds covered by tests above', () => {
    const kinds: DrainOutcome['kind'][] = [
      'sent',
      'failed_permanent',
      'failed_transient',
      'noop',
    ]
    // 编译器/纯运行时 sanity
    assert.equal(kinds.length, 4)
  })
})
