/**
 * outboxStore 单测:用 fake Pool 捕获 SQL,锁 SQL 形态(WHERE 子句 / RETURNING / status 过滤)
 * + 验证 rowCount 翻译。真 PG 集成测试留 slice 4 broker.integ。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wechatOutboxStore.test.ts
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import type { Pool, PoolClient } from "pg"
import {
  enqueue,
  pickOne,
  markSent,
  markFailed,
  releaseStaleSending,
  dropAgedPending,
  purgeSentTombstones,
  purgeFailedAged,
  DEFAULT_MAX_ATTEMPTS,
  STALE_SENDING_MS,
  AGE_CUTOFF_MS,
  SENT_TOMBSTONE_MS,
  FAILED_RETENTION_MS,
} from "../wechat/outboxStore.js"
import type { OutboxStatus } from "../wechat/types.js"

interface CapturedQuery {
  sql: string
  params: ReadonlyArray<unknown>
}

interface FakeClient extends PoolClient {
  captured: CapturedQuery[]
}

/** Pool stub:支持 tx() 调用方,把 client.query 重定向到 inMemory 行为。 */
function makeFakePool(
  responses: Array<{ rows: Record<string, unknown>[]; rowCount: number | null }> | ((sql: string, params: ReadonlyArray<unknown>) => { rows: Record<string, unknown>[]; rowCount: number | null }),
): { pool: Pool; captured: CapturedQuery[] } {
  const captured: CapturedQuery[] = []
  let respIdx = 0
  const respond = (sql: string, params: ReadonlyArray<unknown>): { rows: Record<string, unknown>[]; rowCount: number | null } => {
    captured.push({ sql, params })
    if (typeof responses === "function") return responses(sql, params)
    if (sql.trim().toUpperCase() === "BEGIN" || sql.trim().toUpperCase() === "COMMIT" || sql.trim().toUpperCase() === "ROLLBACK") {
      return { rows: [], rowCount: 0 }
    }
    const r = responses[respIdx++]
    if (!r) throw new Error(`No fake response for query #${respIdx}: ${sql.slice(0, 80)}`)
    return r
  }
  const fakeClient: FakeClient = {
    captured,
    query: async (sql: string, params: ReadonlyArray<unknown> = []) => respond(sql, params),
    release: () => {},
  } as unknown as FakeClient
  const pool = {
    query: async (sql: string, params: ReadonlyArray<unknown> = []) => respond(sql, params),
    connect: async () => fakeClient,
  } as unknown as Pool
  return { pool, captured }
}

// ─── enqueue ──────────────────────────────────────────────────────────────

describe("outboxStore.enqueue", () => {
  const params = {
    outboundId: "ob-1",
    bindingUserId: "u1",
    senderId: "s1",
    sessionId: "wsess-0123456789abcdef",
    payload: [{ type: "text" as const, text: "hi" }],
    now: 1000,
  }

  test("brand-new outbound_id → INSERT ON CONFLICT DO NOTHING succeeds, outcome=queued, attempts=0", async () => {
    const { pool, captured } = makeFakePool([
      { rows: [{ id: 42 }], rowCount: 1 }, // INSERT ON CONFLICT DO NOTHING RETURNING id
    ])
    const result = await enqueue(pool, params, 10)
    assert.deepEqual(result, { outcome: "queued", outboxId: 42, attempts: 0 })
    // 单条 INSERT,无 pre-SELECT(对齐 Codex slice 3 r1 WARN 修法)
    const insert = captured.find((c) => /INSERT INTO wechat_outbox/.test(c.sql))!
    assert.match(insert.sql, /ON CONFLICT \(outbound_id\) DO NOTHING/)
    assert.match(insert.sql, /RETURNING id/)
    assert.match(insert.sql, /'queued'/)
    assert.match(insert.sql, /payload/)
  })

  test("existing row, status='sent' → already_sent (INSERT ON CONFLICT skips, SELECT FOR UPDATE reads tombstone)", async () => {
    const { pool, captured } = makeFakePool([
      { rows: [], rowCount: 0 }, // INSERT ON CONFLICT DO NOTHING — 0 rows = conflict
      { rows: [{ id: 7, status: "sent" as OutboxStatus, attempts: 3 }], rowCount: 1 }, // SELECT FOR UPDATE
    ])
    const result = await enqueue(pool, params, 10)
    assert.deepEqual(result, { outcome: "already_sent", outboxId: 7, attempts: 3 })
    // 确认 SELECT FOR UPDATE 在 INSERT 之后(锁现有行)
    assert.match(captured[1]!.sql, /INSERT INTO wechat_outbox/)
    assert.match(captured[2]!.sql, /SELECT id, status, attempts FROM wechat_outbox/)
    assert.match(captured[2]!.sql, /FOR UPDATE/)
  })

  test("existing row, status='queued' → pending", async () => {
    const { pool } = makeFakePool([
      { rows: [], rowCount: 0 }, // INSERT conflict
      { rows: [{ id: 8, status: "queued" as OutboxStatus, attempts: 0 }], rowCount: 1 },
    ])
    const result = await enqueue(pool, params, 10)
    assert.deepEqual(result, { outcome: "pending", outboxId: 8, attempts: 0 })
  })

  test("existing row, status='sending' → pending (worker is mid-flight)", async () => {
    const { pool } = makeFakePool([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 9, status: "sending" as OutboxStatus, attempts: 1 }], rowCount: 1 },
    ])
    const result = await enqueue(pool, params, 10)
    assert.deepEqual(result, { outcome: "pending", outboxId: 9, attempts: 1 })
  })

  test("existing row, status='failed' & attempts < maxAttempts → reset to queued, preserve attempts", async () => {
    const { pool, captured } = makeFakePool([
      { rows: [], rowCount: 0 }, // INSERT conflict
      { rows: [{ id: 5, status: "failed" as OutboxStatus, attempts: 3 }], rowCount: 1 }, // SELECT FOR UPDATE
      { rows: [], rowCount: 1 }, // UPDATE reset
    ])
    const result = await enqueue(pool, params, 10)
    assert.deepEqual(result, { outcome: "queued", outboxId: 5, attempts: 3 })
    // 验证 reset UPDATE 不清 attempts (SQL 不含 attempts = 0)
    const updateSql = captured.find(
      (c) => /UPDATE wechat_outbox/.test(c.sql) && /SET\s+status\s*=\s*'queued'/.test(c.sql),
    )!.sql
    assert.match(updateSql, /SET\s+status\s*=\s*'queued'/)
    assert.ok(!/attempts\s*=\s*0/i.test(updateSql), "must NOT reset attempts to 0")
  })

  test("existing row, status='failed' & attempts >= maxAttempts → already_failed (no revive)", async () => {
    const { pool, captured } = makeFakePool([
      { rows: [], rowCount: 0 }, // INSERT conflict
      { rows: [{ id: 6, status: "failed" as OutboxStatus, attempts: 10 }], rowCount: 1 },
    ])
    const result = await enqueue(pool, params, 10)
    assert.deepEqual(result, { outcome: "already_failed", outboxId: 6, attempts: 10 })
    // 关键:不应该有 status='queued' 的 UPDATE(单纯读后返回)
    const resetUpdates = captured.filter((c) =>
      /UPDATE wechat_outbox/.test(c.sql) && /SET\s+status\s*=\s*'queued'/.test(c.sql),
    )
    assert.equal(resetUpdates.length, 0, "already_failed must not reset to queued")
  })

  test("status='failed' & attempts === maxAttempts boundary still already_failed (>= not >)", async () => {
    const { pool } = makeFakePool([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 11, status: "failed" as OutboxStatus, attempts: 10 }], rowCount: 1 },
    ])
    const result = await enqueue(pool, params, 10)
    assert.equal(result.outcome, "already_failed")
  })

  test("INSERT payload serialized as JSONB ($5::jsonb cast)", async () => {
    const { pool, captured } = makeFakePool([
      { rows: [{ id: 1 }], rowCount: 1 },
    ])
    await enqueue(pool, params, 10)
    const insert = captured.find((c) => /INSERT INTO wechat_outbox/.test(c.sql))!
    assert.match(insert.sql, /\$5::jsonb/)
    // payload 应已 JSON.stringify
    assert.equal(insert.params[4], JSON.stringify(params.payload))
  })

  // Codex slice 3 r1 WARN: concurrent first-time enqueue idempotency
  test("concurrent first-time enqueue: INSERT ON CONFLICT DO NOTHING + post-SELECT 不抛 23505", async () => {
    // 模拟:两个 tx 几乎同时 INSERT 同 outboundId;A 先 commit 后 B 走 ON CONFLICT 返 0 rows,
    // 再 SELECT FOR UPDATE 读到 A 刚 commit 的行(此时 status='queued', attempts=0)。
    const { pool, captured } = makeFakePool([
      { rows: [], rowCount: 0 }, // INSERT ON CONFLICT — A 抢先,B 见冲突
      { rows: [{ id: 42, status: "queued" as OutboxStatus, attempts: 0 }], rowCount: 1 }, // SELECT FOR UPDATE 读 A 的行
    ])
    const result = await enqueue(pool, params, 10)
    // B 视角 = pending(状态机正确,A 的行已 queued 等 worker pick)
    assert.deepEqual(result, { outcome: "pending", outboxId: 42, attempts: 0 })
    // 不该抛 UNIQUE constraint 错误
    assert.ok(captured.length >= 2, "应至少执行 INSERT + SELECT 两条 SQL")
  })

  test("row vanished between INSERT ON CONFLICT and SELECT FOR UPDATE → throw(让上层 retry)", async () => {
    // 极罕见:purge daemon 在两条 SQL 间删除了该行。
    const { pool } = makeFakePool([
      { rows: [], rowCount: 0 }, // INSERT ON CONFLICT — 冲突
      { rows: [], rowCount: 0 }, // SELECT FOR UPDATE — 行被删
    ])
    await assert.rejects(
      () => enqueue(pool, params, 10),
      /row vanished/,
    )
  })
})

// ─── pickOne ──────────────────────────────────────────────────────────────

describe("outboxStore.pickOne", () => {
  test("uses CTE + FOR UPDATE SKIP LOCKED + transitions to sending", async () => {
    const { pool, captured } = makeFakePool([
      {
        rows: [
          {
            id: 100,
            outbound_id: "ob-100",
            binding_user_id: "u1",
            sender_id: "s1",
            session_id: "wsess-0123456789abcdef",
            payload: [{ type: "text", text: "hi" }],
            status: "sending" as OutboxStatus,
            attempts: 0,
            last_error: null,
            locked_at: 5000,
            sent_at: null,
            created_at: 1000,
            updated_at: 5000,
          },
        ],
        rowCount: 1,
      },
    ])
    const row = await pickOne(pool, 5000)
    assert.ok(row)
    assert.equal(row.id, 100)
    assert.equal(row.status, "sending")
    assert.equal(row.lockedAt, 5000)
    assert.equal(row.nextAttemptAt, null)
    // SQL contains the locking pattern
    const sql = captured[0]!.sql
    assert.match(sql, /FOR UPDATE SKIP LOCKED/)
    assert.match(sql, /status = 'queued'/)
    assert.match(sql, /next_attempt_at IS NULL OR w\.next_attempt_at <= \$1/)
    assert.match(sql, /NOT EXISTS/)
    assert.match(sql, /IS NOT DISTINCT FROM/)
    assert.match(sql, /older\.created_at < w\.created_at/)
    assert.match(sql, /ORDER BY w\.created_at ASC, w\.id ASC/)
    assert.match(sql, /UPDATE wechat_outbox SET/)
  })

  test("head-of-line SQL is NULL-safe and only blocks within the same conversation", async () => {
    const { pool, captured } = makeFakePool([{ rows: [], rowCount: 0 }])
    await pickOne(pool, 5000)
    const sql = captured[0]!.sql
    assert.match(sql, /older\.binding_user_id IS NOT DISTINCT FROM w\.binding_user_id/)
    assert.match(sql, /older\.sender_id\s+IS NOT DISTINCT FROM w\.sender_id/)
    assert.match(sql, /older\.session_id\s+IS NOT DISTINCT FROM w\.session_id/)
    assert.match(sql, /older\.status IN \('queued', 'sending'\)/)
    assert.match(sql, /older\.id < w\.id/)
  })

  test("empty queue → returns null", async () => {
    const { pool } = makeFakePool([{ rows: [], rowCount: 0 }])
    const row = await pickOne(pool, 5000)
    assert.equal(row, null)
  })

  test("JSONB payload parsed as native object (pg driver behavior)", async () => {
    const { pool } = makeFakePool([
      {
        rows: [
          {
            id: 1,
            outbound_id: "x",
            binding_user_id: "u",
            sender_id: "s",
            session_id: "wsess-0123456789abcdef",
            payload: [{ type: "text", text: "a" }],
            status: "sending" as OutboxStatus,
            attempts: 0,
            last_error: null,
            locked_at: 1,
            sent_at: null,
            created_at: 1,
            updated_at: 1,
          },
        ],
        rowCount: 1,
      },
    ])
    const row = await pickOne(pool, 5000)
    assert.deepEqual(row?.payload, [{ type: "text", text: "a" }])
  })
})

// ─── markSent / markFailed ────────────────────────────────────────────────

describe("outboxStore.markSent", () => {
  test("happy: UPDATE sets sent_at + status, returns true on rowCount=1", async () => {
    const { pool, captured } = makeFakePool([{ rows: [], rowCount: 1 }])
    const ok = await markSent(pool, 42, 9999)
    assert.equal(ok, true)
    const sql = captured[0]!.sql
    assert.match(sql, /SET[\s\S]+status\s*=\s*'sent'[\s\S]+sent_at\s*=\s*\$1/)
    assert.match(sql, /next_attempt_at\s*=\s*NULL/)
    assert.match(sql, /WHERE id = \$2 AND status = 'sending'/)
  })

  test("guard: status mismatch (already sent or stale) → returns false", async () => {
    const { pool } = makeFakePool([{ rows: [], rowCount: 0 }])
    const ok = await markSent(pool, 42, 9999)
    assert.equal(ok, false)
  })
})

describe("outboxStore.markFailed", () => {
  test("attempts + 1 < maxAttempts → release back to queued, returns permanent=false", async () => {
    const { pool, captured } = makeFakePool([
      { rows: [{ attempts: 1, status: "queued" }], rowCount: 1 },
    ])
    const result = await markFailed(pool, 42, "transient err", 9999, 10, 14_999)
    assert.deepEqual(result, { permanent: false, attempts: 1 })
    const sql = captured[0]!.sql
    assert.match(sql, /attempts\s*=\s*attempts \+ 1/)
    assert.match(sql, /WHEN attempts \+ 1 >= \$1 THEN 'failed' ELSE 'queued'/)
    assert.match(sql, /next_attempt_at\s*=\s*CASE WHEN attempts \+ 1 >= \$1 THEN NULL ELSE \$5 END/)
    assert.equal(captured[0]!.params[4], 14_999)
  })

  test("attempts + 1 >= maxAttempts → permanent failed, returns permanent=true", async () => {
    const { pool } = makeFakePool([
      { rows: [{ attempts: 10, status: "failed" }], rowCount: 1 },
    ])
    const result = await markFailed(pool, 42, "exhausted", 9999, 10)
    assert.deepEqual(result, { permanent: true, attempts: 10 })
  })

  test("err message truncated to 1000 chars (matches DB CHECK)", async () => {
    const longErr = "x".repeat(2000)
    const { pool, captured } = makeFakePool([
      { rows: [{ attempts: 1, status: "queued" }], rowCount: 1 },
    ])
    await markFailed(pool, 42, longErr, 9999, 10)
    const errParam = captured[0]!.params[1] as string
    assert.equal(errParam.length, 1000)
  })

  test("status mismatch → returns null (broker.ts must handle)", async () => {
    const { pool } = makeFakePool([{ rows: [], rowCount: 0 }])
    const result = await markFailed(pool, 42, "x", 9999, 10)
    assert.equal(result, null)
  })
})

// ─── releaseStaleSending / dropAgedPending / purge* ──────────────────────

describe("outboxStore.releaseStaleSending", () => {
  test("uses STALE_SENDING_MS by default, filters status='sending' + locked_at NOT NULL", async () => {
    const { pool, captured } = makeFakePool([{ rows: [], rowCount: 3 }])
    const n = await releaseStaleSending(pool, 1_000_000)
    assert.equal(n, 3)
    const sql = captured[0]!.sql
    assert.match(sql, /SET[\s\S]+status\s*=\s*'queued'/)
    assert.match(sql, /WHERE status = 'sending'[\s\S]+locked_at IS NOT NULL[\s\S]+locked_at < \$2/)
    assert.equal(captured[0]!.params[1], 1_000_000 - STALE_SENDING_MS)
  })

  // Codex slice 3 r1 NIT: 严格 < cutoff(== 不释放),防 SQL 被改成 <= 的回退。
  test("SQL uses strict `<` cutoff (locked_at == cutoff 不释放,锁 SQL 形态)", async () => {
    const { pool, captured } = makeFakePool([{ rows: [], rowCount: 0 }])
    await releaseStaleSending(pool, 1_000_000)
    const sql = captured[0]!.sql
    // 必须是 locked_at < $2,不可改为 <=(会引入边界 race)
    assert.match(sql, /locked_at\s*<\s*\$2/)
    assert.ok(!/locked_at\s*<=\s*\$/.test(sql), "must use strict `<`, not `<=`")
  })
})

describe("outboxStore.dropAgedPending", () => {
  test("rotates queued/sending → failed with attempts = maxAttempts (no-revive)", async () => {
    const { pool, captured } = makeFakePool([{ rows: [], rowCount: 5 }])
    const n = await dropAgedPending(pool, 1_000_000, undefined, 10)
    assert.equal(n, 5)
    const sql = captured[0]!.sql
    assert.match(sql, /SET[\s\S]+status\s*=\s*'failed'[\s\S]+attempts\s*=\s*\$1/)
    assert.match(sql, /WHERE status IN \('queued', 'sending'\)/)
    assert.match(sql, /AND created_at < \$3/)
    assert.equal(captured[0]!.params[0], 10) // maxAttempts
    assert.equal(captured[0]!.params[2], 1_000_000 - AGE_CUTOFF_MS) // default cutoff
  })

  test("custom ageMs override is respected", async () => {
    const { pool, captured } = makeFakePool([{ rows: [], rowCount: 0 }])
    await dropAgedPending(pool, 1_000_000, 60_000, 10)
    assert.equal(captured[0]!.params[2], 1_000_000 - 60_000)
  })
})

describe("outboxStore.purgeSentTombstones", () => {
  test("DELETE WHERE status='sent' AND sent_at < cutoff (default 24h)", async () => {
    const { pool, captured } = makeFakePool([{ rows: [], rowCount: 17 }])
    const n = await purgeSentTombstones(pool, 1_000_000)
    assert.equal(n, 17)
    const sql = captured[0]!.sql
    assert.match(sql, /DELETE FROM wechat_outbox/)
    assert.match(sql, /status = 'sent'/)
    assert.match(sql, /sent_at IS NOT NULL AND sent_at < \$1/)
    assert.equal(captured[0]!.params[0], 1_000_000 - SENT_TOMBSTONE_MS)
  })
})

describe("outboxStore.purgeFailedAged", () => {
  test("DELETE WHERE status='failed' AND updated_at < cutoff (default 7d)", async () => {
    const { pool, captured } = makeFakePool([{ rows: [], rowCount: 4 }])
    const n = await purgeFailedAged(pool, 1_000_000)
    assert.equal(n, 4)
    const sql = captured[0]!.sql
    assert.match(sql, /DELETE FROM wechat_outbox/)
    assert.match(sql, /status = 'failed' AND updated_at < \$1/)
    assert.equal(captured[0]!.params[0], 1_000_000 - FAILED_RETENTION_MS)
  })
})

describe("outboxStore constants alignment", () => {
  test("DEFAULT_MAX_ATTEMPTS is 10 (per RFC §4.6)", () => {
    assert.equal(DEFAULT_MAX_ATTEMPTS, 10)
  })

  test("SENT_TOMBSTONE_MS = 24h (matches migration comment)", () => {
    assert.equal(SENT_TOMBSTONE_MS, 24 * 60 * 60 * 1000)
  })

  test("FAILED_RETENTION_MS = 7d", () => {
    assert.equal(FAILED_RETENTION_MS, 7 * 24 * 60 * 60 * 1000)
  })

  test("STALE_SENDING_MS = 5min (worker crash recovery)", () => {
    assert.equal(STALE_SENDING_MS, 5 * 60 * 1000)
  })

  test("AGE_CUTOFF_MS = 24h (drop pending older than 24h)", () => {
    assert.equal(AGE_CUTOFF_MS, 24 * 60 * 60 * 1000)
  })
})
