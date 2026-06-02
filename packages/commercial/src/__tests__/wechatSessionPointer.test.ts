/**
 * Unit tests for sessionPointer 的纯函数面:
 *   - newWechatSessionId 命名空间约束
 *   - listOrphanWechatSessions grace 边界 + active set 过滤
 *
 * PG-touching helper(getCurrentSessionId/setCurrentSessionId/activeWsessIdsFromPg/deletePointer)
 * 走 integ test(独立文件,需要真 PG),本文件全 pure。
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  newWechatSessionId,
  listOrphanWechatSessions,
  setCurrentSessionId,
  RECONCILE_GRACE_MS_DEFAULT,
  type PgConn,
} from "../wechat/sessionPointer.js"
import { WECHAT_SESSION_ID_REGEX, isWechatSessionId } from "../wechat/types.js"

describe("wechat sessionPointer.newWechatSessionId", () => {
  test("returns wsess-{16hex} matching the namespace regex", () => {
    for (let i = 0; i < 50; i++) {
      const id = newWechatSessionId()
      assert.match(id, WECHAT_SESSION_ID_REGEX)
      assert.equal(isWechatSessionId(id), true)
    }
  })

  test("injectable rand for deterministic output", () => {
    const id = newWechatSessionId(() => "0123456789abcdef")
    assert.equal(id, "wsess-0123456789abcdef")
  })

  test("throws if rand returns invalid hex / wrong length / uppercase", () => {
    assert.throws(() => newWechatSessionId(() => "DEADBEEFDEADBEEF"), /16 lowercase hex/) // upper
    assert.throws(() => newWechatSessionId(() => "short"), /16 lowercase hex/)
    assert.throws(() => newWechatSessionId(() => "0123456789abcdef0"), /16 lowercase hex/) // 17
    assert.throws(() => newWechatSessionId(() => "0123456789abcdez"), /16 lowercase hex/) // z
  })
})

describe("wechat sessionPointer.listOrphanWechatSessions", () => {
  const now = 10_000_000
  const grace = 1000

  test("row in active PG set is never orphan, regardless of createdAt age", () => {
    return listOrphanWechatSessions({
      allWsess: async () => [{ id: "wsess-aaaaaaaaaaaaaaaa", createdAt: 1 }],
      activeFromPg: async () => new Set(["wsess-aaaaaaaaaaaaaaaa"]),
      now: () => now,
      graceMs: grace,
    }).then((out) => assert.deepEqual(out, []))
  })

  test("row not in active set AND createdAt < now - grace → orphan", () => {
    return listOrphanWechatSessions({
      allWsess: async () => [{ id: "wsess-bbbbbbbbbbbbbbbb", createdAt: now - grace - 1 }],
      activeFromPg: async () => new Set(),
      now: () => now,
      graceMs: grace,
    }).then((out) => assert.deepEqual(out, ["wsess-bbbbbbbbbbbbbbbb"]))
  })

  test("row not in active set BUT createdAt within grace → NOT orphan (race window protection)", () => {
    return listOrphanWechatSessions({
      allWsess: async () => [
        { id: "wsess-cccccccccccccccc", createdAt: now - grace + 1 }, // 1ms 内 grace
        { id: "wsess-dddddddddddddddd", createdAt: now }, // 刚创建
      ],
      activeFromPg: async () => new Set(),
      now: () => now,
      graceMs: grace,
    }).then((out) => assert.deepEqual(out, []))
  })

  test("strict < cutoff boundary: createdAt === cutoff is NOT orphan", () => {
    // R5 review 边界用例:cutoff = now - grace,createdAt = cutoff 不应被列出
    return listOrphanWechatSessions({
      allWsess: async () => [{ id: "wsess-eeeeeeeeeeeeeeee", createdAt: now - grace }],
      activeFromPg: async () => new Set(),
      now: () => now,
      graceMs: grace,
    }).then((out) => assert.deepEqual(out, []))
  })

  test("mixed batch: only filters down to truly aged + inactive rows", () => {
    return listOrphanWechatSessions({
      allWsess: async () => [
        { id: "wsess-1111111111111111", createdAt: 1 }, // 老 & inactive → orphan
        { id: "wsess-2222222222222222", createdAt: 1 }, // 老 & active → skip
        { id: "wsess-3333333333333333", createdAt: now - 1 }, // 新 & inactive → skip (grace)
        { id: "wsess-4444444444444444", createdAt: 1 }, // 老 & inactive → orphan
      ],
      activeFromPg: async () => new Set(["wsess-2222222222222222"]),
      now: () => now,
      graceMs: grace,
    }).then((out) =>
      assert.deepEqual(out.sort(), ["wsess-1111111111111111", "wsess-4444444444444444"]),
    )
  })

  test("defaults: now=Date.now(), graceMs=RECONCILE_GRACE_MS_DEFAULT", async () => {
    const fixedNow = Date.now()
    const out = await listOrphanWechatSessions({
      allWsess: async () => [
        { id: "wsess-5555555555555555", createdAt: fixedNow - RECONCILE_GRACE_MS_DEFAULT - 10_000 },
        { id: "wsess-6666666666666666", createdAt: fixedNow - 100 }, // 100ms ago,绝对在 grace 内
      ],
      activeFromPg: async () => new Set(),
    })
    // 5555 远超 grace → orphan;6666 远在 grace 内 → 不算
    assert.deepEqual(out, ["wsess-5555555555555555"])
  })

  test("empty inputs → empty output (no crashes on NOT-IN empty trap)", async () => {
    const out = await listOrphanWechatSessions({
      allWsess: async () => [],
      activeFromPg: async () => new Set(),
      now: () => now,
      graceMs: grace,
    })
    assert.deepEqual(out, [])
  })
})

describe("wechat sessionPointer.setCurrentSessionId (SQL guard)", () => {
  // Codex slice 2 r1 BLOCKER:防"较老 ts 晚到把较新 ts 覆盖回旧 session"。
  // 真 PG integ test 留 slice 4(broker.ts integ),这里捕获 SQL string + 模拟 rowCount。

  function captureConn(rowCount: number): { conn: PgConn; captured: { sql: string; params: ReadonlyArray<unknown> }[] } {
    const captured: { sql: string; params: ReadonlyArray<unknown> }[] = []
    const conn: PgConn = {
      query: async (sql: string, params: ReadonlyArray<unknown> = []) => {
        captured.push({ sql, params })
        return { rows: [], rowCount }
      },
    }
    return { conn, captured }
  }

  test("SQL emits WHERE wechat_session_pointer.updated_at <= EXCLUDED.updated_at (回退保护)", async () => {
    const { conn, captured } = captureConn(1)
    await setCurrentSessionId(conn, "u1", "wsess-0123456789abcdef", 1000)
    assert.equal(captured.length, 1)
    // 不锁字面,只锁语义:必须有 WHERE 子句比较表内 updated_at 与 EXCLUDED.updated_at
    assert.match(
      captured[0]!.sql.replace(/\s+/g, " "),
      /WHERE wechat_session_pointer\.updated_at\s*<=\s*EXCLUDED\.updated_at/,
    )
    assert.deepEqual(captured[0]!.params, ["u1", "wsess-0123456789abcdef", 1000, null])
  })

  test("returns true when rowCount > 0 (写入生效)", async () => {
    const { conn } = captureConn(1)
    const ok = await setCurrentSessionId(conn, "u1", "wsess-0123456789abcdef", 1000)
    assert.equal(ok, true)
  })

  test("returns false when rowCount === 0 (stale skip,被 WHERE 子句过滤)", async () => {
    const { conn } = captureConn(0)
    const ok = await setCurrentSessionId(conn, "u1", "wsess-0123456789abcdef", 500)
    assert.equal(ok, false)
  })

  test("handles null rowCount as zero (pg driver 偶发返回 null)", async () => {
    const conn: PgConn = {
      query: async () => ({ rows: [], rowCount: null }),
    }
    const ok = await setCurrentSessionId(conn, "u1", "wsess-0123456789abcdef", 500)
    assert.equal(ok, false)
  })
})

describe("wechat types.isWechatSessionId", () => {
  test("accepts canonical 16-hex form", () => {
    assert.equal(isWechatSessionId("wsess-0123456789abcdef"), true)
    assert.equal(isWechatSessionId("wsess-ffffffffffffffff"), true)
  })

  test("rejects malformed / wrong namespace (Codex R5 boundary)", () => {
    // 短
    assert.equal(isWechatSessionId("wsess-123"), false)
    // 非 hex
    assert.equal(isWechatSessionId("wsess-zzzzzzzzzzzzzzzz"), false)
    // 大写 hex
    assert.equal(isWechatSessionId("wsess-0123456789ABCDEF"), false)
    // 17 长度
    assert.equal(isWechatSessionId("wsess-0123456789abcdef0"), false)
    // wsess-{16hex}-extra:应被严格 anchor 拒绝
    assert.equal(isWechatSessionId("wsess-0123456789abcdef-extra"), false)
    // 别的前缀
    assert.equal(isWechatSessionId("sess-0123456789abcdef"), false)
    assert.equal(isWechatSessionId("0123456789abcdef"), false)
    // 空 / 边角
    assert.equal(isWechatSessionId(""), false)
    assert.equal(isWechatSessionId("wsess-"), false)
  })
})
