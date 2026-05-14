/**
 * Tests for `allMasterWsessRows()` (broker-owned wechat session listing).
 *
 * 关键不变量(Codex R5 PASS + slice 7a):
 *   1. 精确 16-hex GLOB:`wsess-` literal prefix + 16 个 [0-9a-f] 字符,**不允许**
 *      `wsess-` 任意后缀(否则会被运维手工塞的 `wsess-manual` 之类污染 orphan 检测)
 *   2. 仅 `origin_channel = 'wechat'` 的行命中(slice 7a:加 channel 显式 tag,
 *      与未来其他 channel 的 broker 隔离;legacy/webchat 行 origin_channel IS NULL)
 *   3. 仅返回未 soft-delete(deleted_at IS NULL)的行
 *   4. 返回 `{id, userId, createdAt}`,createdAt = epoch ms(reconcile grace 期判定)
 *
 * Run: npx tsx --test packages/storage/src/__tests__/allMasterWsessRows.test.ts
 */
import * as assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, it } from "node:test"

const testHome = await mkdtemp(join(tmpdir(), "oc-wsess-"))
process.env.OPENCLAUDE_HOME = testHome

const { allMasterWsessRows, getSessionsDb } = await import("../sessionsDb.js")

async function seed(
  id: string,
  userId: string,
  createdAt: number,
  opts: { deletedAt?: number | null; originChannel?: string | null } = {},
): Promise<void> {
  const db = await getSessionsDb()
  const deletedAt = opts.deletedAt ?? null
  const originChannel = opts.originChannel === undefined ? "wechat" : opts.originChannel
  db.prepare(
    `INSERT INTO client_sessions
       (id, user_id, agent_id, title, pinned, created_at, last_at, messages, message_count, updated_at, deleted_at, origin_channel)
     VALUES (?, ?, 'main', 't', 0, ?, ?, '[]', 0, ?, ?, ?)`,
  ).run(id, userId, createdAt, createdAt, createdAt, deletedAt, originChannel)
}

beforeEach(async () => {
  const db = await getSessionsDb()
  db.exec("DELETE FROM client_sessions")
})

describe("allMasterWsessRows", () => {
  it("returns {id, userId, createdAt} rows matching canonical wsess-{16hex} namespace + origin_channel='wechat'", async () => {
    await seed("wsess-0123456789abcdef", "user-A", 1000)
    await seed("wsess-ffffffffffffffff", "user-B", 2000)
    const out = await allMasterWsessRows()
    const byId = new Map(out.map((r) => [r.id, r] as const))
    assert.equal(out.length, 2)
    assert.deepEqual(byId.get("wsess-0123456789abcdef"), {
      id: "wsess-0123456789abcdef",
      userId: "user-A",
      createdAt: 1000,
    })
    assert.deepEqual(byId.get("wsess-ffffffffffffffff"), {
      id: "wsess-ffffffffffffffff",
      userId: "user-B",
      createdAt: 2000,
    })
  })

  it("excludes soft-deleted rows even with canonical id + origin_channel", async () => {
    await seed("wsess-aaaaaaaaaaaaaaaa", "user-X", 1000, { deletedAt: 5000 })
    await seed("wsess-bbbbbbbbbbbbbbbb", "user-X", 1000)
    const out = await allMasterWsessRows()
    assert.deepEqual(
      out.map((r) => r.id),
      ["wsess-bbbbbbbbbbbbbbbb"],
    )
  })

  it("rejects non-canonical wsess-* shapes (Codex R5: GLOB precise to 16-hex)", async () => {
    // 不能命中的污染样本(都标 origin_channel='wechat' 以隔离 GLOB 维度的覆盖)
    await seed("wsess-manual", "u", 1000) // 不是 16-hex
    await seed("wsess-shortid", "u", 1000) // 7 chars
    await seed("wsess-0123456789abcdef0", "u", 1000) // 17 chars
    await seed("wsess-zzzzzzzzzzzzzzzz", "u", 1000) // 非 hex
    await seed("wsess-0123456789ABCDEF", "u", 1000) // 大写 hex(GLOB 默认大小写敏感)
    await seed("sess-0123456789abcdef", "u", 1000) // 错前缀
    // canonical 一行作为命中对照
    await seed("wsess-0123456789abcdef", "u", 2000)
    const out = await allMasterWsessRows()
    assert.deepEqual(
      out.map((r) => r.id),
      ["wsess-0123456789abcdef"],
    )
  })

  it("excludes rows with origin_channel != 'wechat' even if id matches canonical shape (slice 7a)", async () => {
    // legacy / webchat 行:NULL origin_channel —— 即便 id 形如 wsess-* 也不算 broker-owned
    await seed("wsess-1111111111111111", "u", 1000, { originChannel: null })
    // 假想未来 channel:某天加 'wechat-work' 类型也不能被本函数误捞
    await seed("wsess-2222222222222222", "u", 1000, { originChannel: "wechat-work" })
    // 命中对照
    await seed("wsess-3333333333333333", "u", 2000, { originChannel: "wechat" })
    const out = await allMasterWsessRows()
    assert.deepEqual(
      out.map((r) => r.id),
      ["wsess-3333333333333333"],
    )
  })

  it("empty table → empty array (no false NULL row)", async () => {
    const out = await allMasterWsessRows()
    assert.deepEqual(out, [])
  })

  it("non-wsess sessions are ignored (normal client_sessions don't leak in)", async () => {
    await seed("sess-abc123", "u", 1000, { originChannel: null }) // 普通前缀
    await seed("01HVZ8K3GMNNJX6RKE6CCNK3TQ", "u", 1000, { originChannel: null }) // ulid-ish
    await seed("wsess-0123456789abcdef", "u", 2000)
    const out = await allMasterWsessRows()
    assert.deepEqual(
      out.map((r) => r.id),
      ["wsess-0123456789abcdef"],
    )
  })
})
