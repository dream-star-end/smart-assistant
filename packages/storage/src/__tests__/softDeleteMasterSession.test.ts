/**
 * Tests for `softDeleteMasterSession()` (broker reconcile soft-delete wrapper).
 *
 * 关键不变量(slice 7a):
 *   1. 是 `deleteClientSession(sessionId, userId)` 的薄包装 —— 同样的 tenant-scope
 *      语义(只能删自己 userId 名下的行,跨 user 必须 no-op)
 *   2. 命中 → 设置 deleted_at + 清空 messages + 返回 true
 *   3. 二次调用幂等(已 soft-deleted 行不重复打标 → 返回 false)
 *   4. 错 userId 不删 → 返回 false
 *
 * Run: npx tsx --test packages/storage/src/__tests__/softDeleteMasterSession.test.ts
 */
import * as assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, it } from "node:test"

const testHome = await mkdtemp(join(tmpdir(), "oc-softdelmaster-"))
process.env.OPENCLAUDE_HOME = testHome

const { upsertMasterClientSession, softDeleteMasterSession, getSessionsDb } = await import(
  "../sessionsDb.js"
)

beforeEach(async () => {
  const db = await getSessionsDb()
  db.exec("DELETE FROM client_sessions")
})

describe("softDeleteMasterSession", () => {
  it("soft-deletes a live broker session and returns true", async () => {
    await upsertMasterClientSession({
      sessionId: "wsess-0123456789abcdef",
      userId: "user-A",
      agentId: "main",
      originChannel: "wechat",
      title: "t",
      createdAt: 100,
      lastAt: 100,
    })
    const ok = await softDeleteMasterSession("wsess-0123456789abcdef", "user-A")
    assert.equal(ok, true)
    const db = await getSessionsDb()
    const row = db
      .prepare("SELECT deleted_at, messages, message_count FROM client_sessions WHERE id = ?")
      .get("wsess-0123456789abcdef") as {
      deleted_at: number | null
      messages: string
      message_count: number
    }
    assert.ok(row.deleted_at != null, "deleted_at must be set after soft-delete")
    assert.equal(row.messages, "[]", "messages cleared on soft-delete")
    assert.equal(row.message_count, 0)
  })

  it("returns false on second soft-delete (already deleted) — idempotent guard", async () => {
    await upsertMasterClientSession({
      sessionId: "wsess-aaaabbbbccccdddd",
      userId: "user-B",
      agentId: "main",
      originChannel: "wechat",
      title: "t",
      createdAt: 100,
      lastAt: 100,
    })
    const first = await softDeleteMasterSession("wsess-aaaabbbbccccdddd", "user-B")
    assert.equal(first, true)
    const second = await softDeleteMasterSession("wsess-aaaabbbbccccdddd", "user-B")
    assert.equal(second, false, "already soft-deleted → no-op, return false")
  })

  it("refuses cross-tenant deletes (userId mismatch → false, row unchanged)", async () => {
    await upsertMasterClientSession({
      sessionId: "wsess-cccccccccccccccc",
      userId: "user-OWNER",
      agentId: "main",
      originChannel: "wechat",
      title: "t",
      createdAt: 100,
      lastAt: 100,
    })
    const ok = await softDeleteMasterSession("wsess-cccccccccccccccc", "user-ATTACKER")
    assert.equal(ok, false, "wrong userId must not soft-delete")
    const db = await getSessionsDb()
    const row = db
      .prepare("SELECT deleted_at FROM client_sessions WHERE id = ?")
      .get("wsess-cccccccccccccccc") as { deleted_at: number | null }
    assert.equal(row.deleted_at, null, "row must remain alive")
  })

  it("returns false when row never existed", async () => {
    const ok = await softDeleteMasterSession("wsess-deadbeefdeadbeef", "user-X")
    assert.equal(ok, false)
  })
})
