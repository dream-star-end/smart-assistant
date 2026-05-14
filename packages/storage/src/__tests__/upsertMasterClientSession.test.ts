/**
 * Tests for `upsertMasterClientSession()` (broker Step 2 insert).
 *
 * 关键不变量(slice 7a):
 *   1. 写入一行 client_sessions,字段如实落库 + origin_channel='wechat'
 *   2. **Plain INSERT** — id 碰撞必须抛 SQLITE_CONSTRAINT,以便 dispatcher 走
 *      step2_failed → compensation 回滚 PG pointer。绝不能 INSERT OR IGNORE /
 *      ON CONFLICT DO UPDATE
 *   3. Codex 7a NIT:downstream 协议依赖 `next_seq` 默认 1、`deleted_at` 默认 NULL。
 *      helper 显式省略了这两列,定 DB schema 兜底,这里 pin 住
 *
 * Run: npx tsx --test packages/storage/src/__tests__/upsertMasterClientSession.test.ts
 */
import * as assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, it } from "node:test"

const testHome = await mkdtemp(join(tmpdir(), "oc-upsertmaster-"))
process.env.OPENCLAUDE_HOME = testHome

const { upsertMasterClientSession, getSessionsDb } = await import("../sessionsDb.js")

beforeEach(async () => {
  const db = await getSessionsDb()
  db.exec("DELETE FROM client_sessions")
})

describe("upsertMasterClientSession", () => {
  it("inserts a row with all provided fields + origin_channel='wechat'", async () => {
    await upsertMasterClientSession({
      sessionId: "wsess-0123456789abcdef",
      userId: "user-A",
      agentId: "main",
      originChannel: "wechat",
      title: "微信会话",
      createdAt: 1000,
      lastAt: 1500,
    })
    const db = await getSessionsDb()
    const row = db
      .prepare(
        `SELECT id, user_id, agent_id, title, created_at, last_at, updated_at,
                origin_channel, pinned, messages, message_count
           FROM client_sessions WHERE id = ?`,
      )
      .get("wsess-0123456789abcdef") as any
    assert.equal(row.id, "wsess-0123456789abcdef")
    assert.equal(row.user_id, "user-A")
    assert.equal(row.agent_id, "main")
    assert.equal(row.title, "微信会话")
    assert.equal(row.created_at, 1000)
    assert.equal(row.last_at, 1500)
    assert.equal(row.updated_at, 1500, "updated_at defaults to lastAt at insert time")
    assert.equal(row.origin_channel, "wechat")
    // 显式省略列由 schema DEFAULT 兜底
    assert.equal(row.pinned, 0)
    assert.equal(row.messages, "[]")
    assert.equal(row.message_count, 0)
  })

  it("defaults: next_seq=1, deleted_at=NULL (Codex 7a NIT — downstream protocols rely on these)", async () => {
    await upsertMasterClientSession({
      sessionId: "wsess-aaaabbbbccccdddd",
      userId: "user-B",
      agentId: "main",
      originChannel: "wechat",
      title: "t",
      createdAt: 100,
      lastAt: 100,
    })
    const db = await getSessionsDb()
    const row = db
      .prepare("SELECT next_seq, deleted_at FROM client_sessions WHERE id = ?")
      .get("wsess-aaaabbbbccccdddd") as { next_seq: number; deleted_at: number | null }
    assert.equal(row.next_seq, 1, "next_seq must default to 1 (incremental GET protocol seed)")
    assert.equal(row.deleted_at, null, "deleted_at must default to NULL (alive row)")
  })

  it("throws on duplicate id — caller MUST catch and trigger compensation (plain INSERT contract)", async () => {
    await upsertMasterClientSession({
      sessionId: "wsess-1111111111111111",
      userId: "user-X",
      agentId: "main",
      originChannel: "wechat",
      title: "first",
      createdAt: 100,
      lastAt: 100,
    })
    await assert.rejects(
      upsertMasterClientSession({
        sessionId: "wsess-1111111111111111",
        userId: "user-X",
        agentId: "main",
        originChannel: "wechat",
        title: "dup",
        createdAt: 200,
        lastAt: 200,
      }),
      (err: Error) => {
        // better-sqlite3 throws SqliteError with code SQLITE_CONSTRAINT_PRIMARYKEY.
        // We don't pin the exact code string (better-sqlite3 minor versions vary
        // between SQLITE_CONSTRAINT_PRIMARYKEY and SQLITE_CONSTRAINT_UNIQUE) —
        // what matters is that the error bubbles, not that it's swallowed.
        assert.match(err.message, /UNIQUE constraint failed|PRIMARY KEY/i)
        return true
      },
    )
    // First row must remain intact (no overwrite via dup attempt)
    const db = await getSessionsDb()
    const row = db
      .prepare("SELECT title FROM client_sessions WHERE id = ?")
      .get("wsess-1111111111111111") as { title: string }
    assert.equal(row.title, "first")
  })
})
