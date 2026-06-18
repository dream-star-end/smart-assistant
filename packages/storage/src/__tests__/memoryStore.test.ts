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
