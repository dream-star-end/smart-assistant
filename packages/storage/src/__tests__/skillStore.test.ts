/**
 * Tests for SkillStore PR4: platform-baseline overlay with baseline-wins read
 * semantics, shadow-rejection on save, and tiered delete behavior.
 *
 * Run:
 *   npx tsx --test packages/storage/src/__tests__/skillStore.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'

// Point OPENCLAUDE_HOME at a throwaway dir BEFORE importing paths-aware modules.
const testHome = await mkdtemp(join(tmpdir(), 'oc-skillstore-'))
process.env.OPENCLAUDE_HOME = testHome

const { SkillStore } = await import('../skillStore.js')
const { paths } = await import('../paths.js')

const AGENT = 'test-agent'
const userRoot = paths.agentSkillsDir(AGENT)

async function writeSkillMd(root: string, name: string, content: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content, 'utf-8')
}

function fm(name: string, description: string, body = 'body content'): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nversion: 1.0.0\n---\n\n${body}\n`
}

describe('SkillStore — single-root (legacy, personal-version)', () => {
  before(async () => {
    await mkdir(userRoot, { recursive: true })
  })

  it('constructs without baselineDir and lists only user skills', async () => {
    await writeSkillMd(userRoot, 'solo-a', fm('solo-a', 'solo A'))
    await writeSkillMd(userRoot, 'solo-b', fm('solo-b', 'solo B'))
    const store = new SkillStore(AGENT)
    const list = await store.list()
    const names = list.map((s) => s.name)
    assert.ok(names.includes('solo-a'))
    assert.ok(names.includes('solo-b'))
    for (const s of list) assert.equal(s.source, 'user')
  })

  it('view returns user source when no baseline configured', async () => {
    const store = new SkillStore(AGENT)
    const v = await store.view('solo-a')
    assert.ok(v && typeof v !== 'string')
    assert.equal((v as any).source, 'user')
    assert.equal((v as any).name, 'solo-a')
  })

  it('rejects invalid agentId', () => {
    assert.throws(() => new SkillStore(''), /invalid agentId/)
    assert.throws(() => new SkillStore('bad/id'), /invalid agentId/)
  })
})

describe('SkillStore — constructor baseline validation', () => {
  it('throws if baselineDir is not absolute', () => {
    assert.throws(
      () => new SkillStore(AGENT, { baselineDir: 'relative/path' }),
      /must be an absolute path/,
    )
  })

  it('throws if baselineDir does not exist', () => {
    assert.throws(
      () => new SkillStore(AGENT, { baselineDir: '/definitely/not/a/real/path' }),
      /stat failed/,
    )
  })

  it('throws if baselineDir is a file, not a directory', async () => {
    const notDir = join(testHome, 'not-a-dir')
    await writeFile(notDir, 'hi', 'utf-8')
    assert.throws(
      () => new SkillStore(AGENT, { baselineDir: notDir }),
      /is not a directory/,
    )
  })
})

describe('SkillStore — PR4 baseline-wins merge', () => {
  let baselineRoot: string
  let mergeAgentUserRoot: string
  const MERGE_AGENT = 'merge-agent'

  before(async () => {
    baselineRoot = await mkdtemp(join(tmpdir(), 'oc-baseline-'))
    mergeAgentUserRoot = paths.agentSkillsDir(MERGE_AGENT)
    await mkdir(mergeAgentUserRoot, { recursive: true })
    // Platform baseline: system-info (authoritative) + platform-only
    await writeSkillMd(
      baselineRoot,
      'system-info',
      fm('system-info', 'Platform baseline — canonical', 'PLATFORM BODY'),
    )
    await writeSkillMd(
      baselineRoot,
      'platform-only',
      fm('platform-only', 'Only on platform'),
    )
    // User: a shadow over system-info + a user-only skill
    await writeSkillMd(
      mergeAgentUserRoot,
      'system-info',
      fm('system-info', 'User shadow — MUST NOT WIN', 'USER SHADOW BODY'),
    )
    await writeSkillMd(mergeAgentUserRoot, 'user-only', fm('user-only', 'Only in user dir'))
  })

  it('list() surfaces baseline entries with source=platform', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const list = await store.list()
    const byName = new Map(list.map((s) => [s.name, s]))
    assert.equal(byName.get('system-info')?.source, 'platform')
    assert.equal(byName.get('platform-only')?.source, 'platform')
    assert.equal(byName.get('user-only')?.source, 'user')
  })

  it('list() hides user shadow when a baseline owns the name (one entry only)', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const list = await store.list()
    const systemInfoEntries = list.filter((s) => s.name === 'system-info')
    assert.equal(systemInfoEntries.length, 1, 'exactly one system-info entry expected')
    assert.equal(systemInfoEntries[0].source, 'platform')
    assert.equal(systemInfoEntries[0].description, 'Platform baseline — canonical')
  })

  it('view() returns baseline content even when user shadow exists', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const v = await store.view('system-info')
    assert.ok(v && typeof v !== 'string')
    const content = v as any
    assert.equal(content.source, 'platform')
    assert.ok(
      content.rawContent.includes('PLATFORM BODY'),
      `expected platform body, got: ${content.rawContent.slice(0, 80)}`,
    )
    assert.ok(
      !content.rawContent.includes('USER SHADOW BODY'),
      'user shadow must not leak into view',
    )
  })

  it('view() falls back to user source for user-only skills', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const v = await store.view('user-only')
    assert.ok(v && typeof v !== 'string')
    assert.equal((v as any).source, 'user')
  })

  it('view() returns null for truly unknown names', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const v = await store.view('does-not-exist-anywhere')
    assert.equal(v, null)
  })

  it('save() rejects names that collide with baseline', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const r = await store.save(
      { name: 'system-info', description: 'trying to shadow' },
      'body',
    )
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /reserved for platform baseline skill/)
  })

  it('save() allows non-colliding user skills', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const r = await store.save(
      { name: 'new-user-skill', description: 'fine' },
      'body',
    )
    assert.equal(r.ok, true)
  })

  it('delete() on baseline-only returns specific error', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const r = await store.delete('platform-only')
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /cannot delete platform baseline skill/)
  })

  it('delete() on user shadow cleans user but reports baseline remains', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    // Confirm the user shadow still exists on disk before the delete call.
    const pre = await store.list()
    assert.equal(
      pre.filter((s) => s.name === 'system-info').length,
      1,
      'system-info should still be listed (baseline wins)',
    )
    const r = await store.delete('system-info')
    assert.equal(r.ok, true)
    assert.match(r.note ?? '', /platform baseline 'system-info' remains/)
    // After delete, baseline view still works (unaffected).
    const v = await store.view('system-info')
    assert.ok(v && typeof v !== 'string')
    assert.equal((v as any).source, 'platform')
  })

  it('delete() on user-only works normally (no note)', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const r = await store.delete('user-only')
    assert.equal(r.ok, true)
    assert.equal(r.note, undefined)
  })

  it('delete() on truly missing name returns not-found', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const r = await store.delete('nobody-here')
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /skill not found/)
  })
})

describe('SkillStore — PR4 safeReadFile cross-root symlink containment', () => {
  let baselineRoot: string
  let escapeAgentUserRoot: string
  const ESCAPE_AGENT = 'escape-agent'

  before(async () => {
    baselineRoot = await mkdtemp(join(tmpdir(), 'oc-baseline2-'))
    escapeAgentUserRoot = paths.agentSkillsDir(ESCAPE_AGENT)
    await mkdir(escapeAgentUserRoot, { recursive: true })
    // Baseline-authored file the attacker wants to exfiltrate.
    await writeSkillMd(
      baselineRoot,
      'secret-baseline',
      fm('secret-baseline', 'secret desc', 'SECRET BASELINE BODY'),
    )
    // Attacker plants a symlink under user root, pointing into baseline tree.
    const attackDir = join(escapeAgentUserRoot, 'pretend-user')
    await mkdir(attackDir, { recursive: true })
    await symlink(
      join(baselineRoot, 'secret-baseline', 'SKILL.md'),
      join(attackDir, 'SKILL.md'),
    )
  })

  it('list() drops symlinked user entries pointing outside user root', async () => {
    const store = new SkillStore(ESCAPE_AGENT, { baselineDir: baselineRoot })
    const list = await store.list()
    const names = list.map((s) => s.name)
    assert.ok(!names.includes('pretend-user'), 'symlinked user skill must not appear in list')
    // Legit baseline skill still visible:
    assert.ok(names.includes('secret-baseline'))
    const secret = list.find((s) => s.name === 'secret-baseline')
    assert.equal(secret?.source, 'platform')
  })

  it('view() refuses to read symlinked user SKILL.md that escapes user root', async () => {
    const store = new SkillStore(ESCAPE_AGENT, { baselineDir: baselineRoot })
    // Try to view by the attacker-controlled name — baseline-wins logic looks
    // up baseline first (no "pretend-user" there), falls back to user root,
    // where safeReadFile rejects the symlink escape.
    const v = await store.view('pretend-user')
    assert.equal(v, null)
  })
})
