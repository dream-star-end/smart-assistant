/**
 * Tests for MemoryStore: USER.md user-level sharing + cross-process write lock,
 * MEMORY.md per-agent isolation.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/memoryStore.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// Point OPENCLAUDE_HOME at a throwaway dir BEFORE importing paths-aware modules.
const testHome = await mkdtemp(join(tmpdir(), 'oc-memstore-'))
process.env.OPENCLAUDE_HOME = testHome

const { MemoryStore } = await import('../memoryStore.js')
const { paths } = await import('../paths.js')

describe('MemoryStore — USER.md user-level shared, MEMORY.md per-agent', () => {
  it('user target is shared across agents (codex writes → main reads), at volume root', async () => {
    const codex = new MemoryStore('codex')
    await codex.load()
    const r = await codex.add('user', '用户是工程师')
    assert.equal(r.ok, true)
    // Written to the shared volume-root user.md, NOT the per-agent USER.md.
    assert.ok(existsSync(paths.sharedUserMd), 'user.md exists at volume root')
    assert.ok(!existsSync(paths.agentUserMd('codex')), 'not written to per-agent USER.md')
    // A different agent reads the same shared fact.
    const main = new MemoryStore('main')
    await main.load()
    assert.ok(main.read('user').includes('用户是工程师'), 'main sees codex-written user fact')
  })

  it('memory target stays per-agent (isolated, not shared)', async () => {
    const codex = new MemoryStore('codex')
    await codex.load()
    await codex.add('memory', 'codex 的工作笔记')
    assert.ok(existsSync(paths.agentMemoryMd('codex')), 'codex MEMORY.md is per-agent')
    const main = new MemoryStore('main')
    await main.load()
    assert.ok(
      !main.read('memory').includes('codex 的工作笔记'),
      'main does NOT see codex MEMORY.md (per-agent isolated)',
    )
  })

  it('concurrent user writes do not lose updates (write lock + re-read under lock)', async () => {
    const a = new MemoryStore('a-agent')
    await a.load()
    const b = new MemoryStore('b-agent')
    await b.load()
    // Two agents add to the shared user.md concurrently — the cross-process file lock
    // + re-read-under-lock must keep BOTH (no last-writer-wins lost update).
    await Promise.all([a.add('user', 'fact-A-unique'), b.add('user', 'fact-B-unique')])
    const reader = new MemoryStore('reader')
    await reader.load()
    const txt = reader.read('user')
    assert.ok(txt.includes('fact-A-unique'), 'fact-A survived')
    assert.ok(txt.includes('fact-B-unique'), 'fact-B survived (no lost update)')
  })

  it('overwrite (UI editor) writes shared and is visible to all agents', async () => {
    const main = new MemoryStore('main')
    await main.load()
    const r = await main.overwrite('user', 'OVERWRITTEN-IDENTITY')
    assert.equal(r.ok, true)
    const other = new MemoryStore('researcher')
    await other.load()
    assert.equal(other.read('user'), 'OVERWRITTEN-IDENTITY')
  })
})

describe('MemoryStore — per-agent memory 跨进程锁 + overwrite 乐观并发', () => {
  it('concurrent memory writes to the SAME agent do not lose updates (per-agent lock)', async () => {
    // 同一个 agent 的 MEMORY.md 在 v5 下有两个写进程(gateway UI + mcp-memory 子进程)。
    // 用相同 agentId 的两个 MemoryStore 实例模拟双进程交替写,断言无丢条目。
    const p1 = new MemoryStore('concurrent-mem-agent')
    await p1.load()
    const p2 = new MemoryStore('concurrent-mem-agent')
    await p2.load()
    await Promise.all([p1.add('memory', 'mem-fact-P1'), p2.add('memory', 'mem-fact-P2')])
    const reader = new MemoryStore('concurrent-mem-agent')
    await reader.load()
    const txt = reader.read('memory')
    assert.ok(txt.includes('mem-fact-P1'), 'P1 survived')
    assert.ok(txt.includes('mem-fact-P2'), 'P2 survived (no lost update, per-agent lock 生效)')
  })

  it('overwrite with a stale expectedVersion returns conflict and does NOT write disk', async () => {
    // A 打开编辑器(拿到 version)→ B(AI)并发写入新条目 → A 用旧 version 保存。
    const a = new MemoryStore('ov-conflict-agent')
    await a.load()
    await a.add('memory', 'seed-entry') // A 先落一条种子内容到盘
    const staleVersion = a.version('memory') // A 编辑器持有的快照版本 = [seed-entry]

    const b = new MemoryStore('ov-conflict-agent')
    await b.load()
    const rb = await b.add('memory', 'concurrent-AI-entry') // B 并发写入(mcp-memory)
    assert.equal(rb.ok, true)

    // A 用陈旧 version 整段覆盖 → 必须冲突,不写盘。
    const conflict = await a.overwrite('memory', 'A-edited-content', staleVersion)
    assert.equal(conflict.ok, false, '陈旧版本必须被拒')
    assert.equal(conflict.error, 'version conflict')
    assert.ok(conflict.conflict, 'conflict payload 回带')
    assert.ok(
      conflict.conflict?.text.includes('concurrent-AI-entry'),
      'conflict.text 反映盘上最新内容(含 B 的条目)',
    )

    // 盘上内容未被 A 覆盖:B 的条目还在,A 的编辑内容没落盘。
    const r1 = new MemoryStore('ov-conflict-agent')
    await r1.load()
    assert.ok(r1.read('memory').includes('concurrent-AI-entry'), 'B 的条目仍在盘上')
    assert.ok(!r1.read('memory').includes('A-edited-content'), 'A 的覆盖没有落盘')

    // A 用 conflict 回带的最新 version 重试 → 成功覆盖。
    const retry = await a.overwrite('memory', 'A-edited-content', conflict.conflict?.version)
    assert.equal(retry.ok, true, '用最新 version 重试成功')
    const r2 = new MemoryStore('ov-conflict-agent')
    await r2.load()
    assert.equal(r2.read('memory'), 'A-edited-content', '重试后盘上是 A 的新内容')
  })

  it('overwrite without expectedVersion keeps last-writer-wins (兼容旧调用)', async () => {
    const a = new MemoryStore('ov-compat-agent')
    await a.load()
    await a.add('memory', 'old-entry')
    // 不传 version → 直接覆盖,不做冲突检查。
    const r = await a.overwrite('memory', 'brand-new-content')
    assert.equal(r.ok, true)
    const reader = new MemoryStore('ov-compat-agent')
    await reader.load()
    assert.equal(reader.read('memory'), 'brand-new-content')
  })

  it('version() is stable for identical content and empty content is hashable', async () => {
    const a = new MemoryStore('ov-version-agent')
    await a.load()
    // 空内容也能算 version(hash of '')。
    const empty = a.version('memory')
    assert.equal(typeof empty, 'string')
    assert.equal(empty.length, 16)
    await a.add('memory', 'stable-entry')
    const v1 = a.version('memory')
    const b = new MemoryStore('ov-version-agent')
    await b.load()
    assert.equal(b.version('memory'), v1, '相同内容跨实例 version 一致')
  })
})
