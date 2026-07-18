/**
 * BLOCKER-1 首建 updated_at 服务端时钟下限(RFC-v5-sessions-pg D3b;SQLite backend)。
 *
 * 修前:upsertClientSession / upsertMasterClientSession 的**首建(无冲突)**路径无条件写客户端
 * 回传的 updatedAt。客户端可回传 0 / 旧值 → 首建后紧跟一个 baseSyncedAt=0 的第二个 PUT 会因
 * existing.updated_at 仍是 0(0<=0)而击穿乐观并发 stale 检测 → 双写静默覆盖。
 * 修后:首建 updated_at = MAX(客户端值, 服务端 now),严格 ≥ 服务端时钟 → 后续 stale PUT 被正确拒。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsUpsertClockFloor.test.ts
 */
import * as assert from "node:assert/strict"
import { readdirSync, rmSync, statSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, it } from "node:test"

// 本文件是 node:test 风格,但 vitest collect 匹配 __tests__/*.test.ts 时同样会 import
// 本模块 → 顶层 mkdtemp 照跑;且 vitest forks 池以信号结束 worker,exit 钩子不保证执行
// (曾累积泄漏 143 个 /tmp/oc-clockfloor-*)。所以采用自愈式回收:每次加载先扫掉 1 小时
// 前的残留目录 —— 无论上一个进程怎么死,泄漏总量有界。运行中的并发测试目录(分钟级
// 生命周期)绝不会命中 1h 阈值。
const CLOCKFLOOR_STALE_MS = 60 * 60 * 1000
try {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith("oc-clockfloor-")) continue
    const stale = join(tmpdir(), entry)
    try {
      if (Date.now() - statSync(stale).mtimeMs > CLOCKFLOOR_STALE_MS) {
        rmSync(stale, { recursive: true, force: true })
      }
    } catch {}
  }
} catch {}

const testHome = await mkdtemp(join(tmpdir(), "oc-clockfloor-"))
process.env.OPENCLAUDE_HOME = testHome
// 正常退出路径(node:test 直跑)仍即时清理自己。
process.once("exit", () => {
  try {
    rmSync(testHome, { recursive: true, force: true })
  } catch {}
})

const { upsertClientSession, getSessionsDb } = await import("../sessionsDb.js")

function mkSession(over: Record<string, unknown> = {}) {
  return {
    id: "s-cf",
    userId: "u-1",
    agentId: "main",
    title: "t",
    pinned: false,
    createdAt: 1,
    lastAt: 1,
    messages: [] as unknown[],
    updatedAt: 0,
    ...over,
  } as Parameters<typeof upsertClientSession>[0]
}

beforeEach(async () => {
  const db = await getSessionsDb()
  db.exec("DELETE FROM client_sessions")
})

describe("upsertClientSession 首建服务端时钟下限(BLOCKER-1)", () => {
  it("updatedAt=0 首建 → 存库 updated_at 是服务端墙钟(≥ now)", async () => {
    const before = Date.now()
    assert.equal(await upsertClientSession(mkSession({ updatedAt: 0 })), "applied")
    const after = Date.now()
    const db = await getSessionsDb()
    const row = db.prepare("SELECT updated_at FROM client_sessions WHERE id = ?").get("s-cf") as {
      updated_at: number
    }
    assert.ok(
      row.updated_at >= before && row.updated_at <= after,
      `首建 updated_at(${row.updated_at}) 应落在 [${before},${after}]`,
    )
  })

  it("updatedAt=0 首建后,第二个 baseSyncedAt=0 的 upsert 必须 rejected_stale(串行)", async () => {
    assert.equal(await upsertClientSession(mkSession({ updatedAt: 0 })), "applied")
    // baseSyncedAt=0:existing.updated_at(≈now) > 0 → 拒(修前 0<=0 会被误 applied = 双写击穿)。
    const r = await upsertClientSession(mkSession({ title: "改", updatedAt: 0 }), 0)
    assert.equal(r, "rejected_stale")
    // 标题未被覆盖(第二次写被拒)。
    const db = await getSessionsDb()
    const row = db.prepare("SELECT title FROM client_sessions WHERE id = ?").get("s-cf") as { title: string }
    assert.equal(row.title, "t", "被拒的 PUT 不得覆盖已存行")
  })

  it("客户端 updatedAt 远大于服务端 now → 取客户端值(MAX 语义,不倒退)", async () => {
    const future = Date.now() + 10 * 60_000
    assert.equal(await upsertClientSession(mkSession({ updatedAt: future })), "applied")
    const db = await getSessionsDb()
    const row = db.prepare("SELECT updated_at FROM client_sessions WHERE id = ?").get("s-cf") as {
      updated_at: number
    }
    assert.equal(row.updated_at, future, "客户端值更大时首建取客户端值(MAX)")
  })
})
