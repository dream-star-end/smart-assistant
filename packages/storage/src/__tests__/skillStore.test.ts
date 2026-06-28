/**
 * Tests for SkillStore PR4: platform-baseline overlay with baseline-wins read
 * semantics, shadow-rejection on save, and tiered delete behavior.
 *
 * Run:
 *   npx tsx --test packages/storage/src/__tests__/skillStore.test.ts
 */
import * as assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'

// Point OPENCLAUDE_HOME at a throwaway dir BEFORE importing paths-aware modules.
const testHome = await mkdtemp(join(tmpdir(), 'oc-skillstore-'))
process.env.OPENCLAUDE_HOME = testHome

const { SkillStore, searchSkillMetadata } = await import('../skillStore.js')
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

  // ── user-management view ({ includePlatform: false }) — platform skills must be
  //    fully invisible so /api/skills cannot leak baseline/seed content to end users ──
  it('list({ includePlatform:false }) drops every platform skill', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const list = await store.list({ includePlatform: false })
    assert.ok(!list.some((s) => s.source === 'platform'), 'no platform-sourced entry may leak')
    assert.ok(!list.some((s) => s.name === 'platform-only'), 'platform-only must be hidden')
    // a baseline-owned name now resolves to the user's own shadow (symmetric with view())
    const systemInfo = list.find((s) => s.name === 'system-info')
    assert.equal(systemInfo?.source, 'user')
    assert.ok(systemInfo?.description.includes('User shadow'))
    assert.ok(list.some((s) => s.name === 'user-only'), 'user skills stay visible')
  })

  it('view({ includePlatform:false }) returns null for a platform-only skill', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const v = await store.view('platform-only', undefined, { includePlatform: false })
    assert.equal(v, null)
  })

  it('view({ includePlatform:false }) returns the user shadow, never the platform body', async () => {
    const store = new SkillStore(MERGE_AGENT, { baselineDir: baselineRoot })
    const v = await store.view('system-info', undefined, { includePlatform: false })
    assert.ok(v && typeof v !== 'string')
    const content = v as any
    assert.equal(content.source, 'user')
    assert.ok(content.rawContent.includes('USER SHADOW BODY'))
    assert.ok(!content.rawContent.includes('PLATFORM BODY'), 'platform body must not leak')
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
    // Message generalized to "platform skill" now that platform layers include
    // both baseline and per-agent agent-seed.
    assert.match(r.error ?? '', /cannot delete platform skill/)
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
    assert.match(r.note ?? '', /platform skill 'system-info' remains/)
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

describe('searchSkillMetadata — tier-1 skill discovery', () => {
  const fixtures = [
    {
      name: 'skill-search',
      description: '搜索和发现可用 skills,再决定调用 skill_view',
      tags: ['system', 'meta', 'learning'],
      related_skills: ['skill-management'],
      path: '/platform/skill-search',
      source: 'platform',
    },
    {
      name: 'scheduled-tasks',
      description: '定时提醒和 cron 任务创建方法',
      tags: ['system', 'scheduling', 'cron'],
      path: '/platform/scheduled-tasks',
      source: 'platform',
    },
    {
      name: 'deploy-to-vps',
      description: '部署 Node 服务到 VPS 的完整流程',
      tags: ['deployment'],
      path: '/user/deploy-to-vps',
      source: 'user',
    },
  ] as const

  it('matches compact names so "skill search" finds skill-search first', () => {
    const hits = searchSkillMetadata(fixtures as any, 'skill search', 5)
    assert.equal(hits[0]?.name, 'skill-search')
    assert.equal(hits[0]?.source, 'platform')
    assert.ok(hits[0]?.matched.includes('name:compact'))
  })

  it('matches Chinese descriptions and preserves source metadata', () => {
    const hits = searchSkillMetadata(fixtures as any, '定时提醒')
    assert.equal(hits[0]?.name, 'scheduled-tasks')
    assert.equal(hits[0]?.source, 'platform')
    assert.ok(hits[0]?.matched.some((m: string) => m.startsWith('description')))
  })

  it('matches tags and honors the result limit cap parameter', () => {
    const hits = searchSkillMetadata(fixtures as any, 'system', 1)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.source, 'platform')
    assert.ok(hits[0]?.matched.some((m: string) => m.startsWith('tags')))
  })

  it('returns [] for blank queries', () => {
    assert.deepEqual(searchSkillMetadata(fixtures as any, '   '), [])
  })
})

describe('SkillStore — four-layer overlay (baseline > agent-seed > shared > legacy)', () => {
  const OA = 'overlay-agent'
  const seedDir = paths.agentSeedSkillsDir(OA)
  const legacyDir = paths.agentSkillsDir(OA)
  const sharedDir = paths.sharedSkillsDir
  let baselineDir: string

  before(async () => {
    baselineDir = await mkdtemp(join(tmpdir(), 'oc-overlay-baseline-'))
    await mkdir(seedDir, { recursive: true })
    await mkdir(legacyDir, { recursive: true })
    await mkdir(sharedDir, { recursive: true })
  })

  const mkStore = () => new SkillStore(OA, { baselineDir, agentSeedDir: seedDir, sharedDir })

  it('read priority dedups same-named skill: baseline wins', async () => {
    await writeSkillMd(baselineDir, 'pri', fm('pri', 'from-baseline'))
    await writeSkillMd(seedDir, 'pri', fm('pri', 'from-seed'))
    await writeSkillMd(sharedDir, 'pri', fm('pri', 'from-shared'))
    await writeSkillMd(legacyDir, 'pri', fm('pri', 'from-legacy'))
    const list = await mkStore().list()
    const pri = list.filter((s) => s.name === 'pri')
    assert.equal(pri.length, 1)
    assert.equal(pri[0].layer, 'platform')
    assert.equal(pri[0].description, 'from-baseline')
    assert.equal((await mkStore().view('pri') as any).layer, 'platform')
  })

  it('agent-seed wins over shared and legacy (read-only)', async () => {
    await writeSkillMd(seedDir, 'seedwin', fm('seedwin', 'seed'))
    await writeSkillMd(sharedDir, 'seedwin', fm('seedwin', 'shared'))
    const v = (await mkStore().view('seedwin')) as any
    assert.equal(v.layer, 'agent-seed')
    assert.equal(v.source, 'platform')
    assert.equal(v.writable, false)
  })

  it('shared wins over legacy; layer/writable flags correct', async () => {
    await writeSkillMd(sharedDir, 'shw', fm('shw', 'shared-v'))
    await writeSkillMd(legacyDir, 'shw', fm('shw', 'legacy-v'))
    const v = (await mkStore().view('shw')) as any
    assert.equal(v.layer, 'shared')
    assert.equal(v.writable, true)
    assert.equal(v.description, 'shared-v')
    await writeSkillMd(legacyDir, 'legonly', fm('legonly', 'leg'))
    const v2 = (await mkStore().view('legonly')) as any
    assert.equal(v2.layer, 'legacy')
    assert.equal(v2.writable, false)
  })

  it('save writes to shared, not the per-agent legacy dir', async () => {
    const r = await mkStore().save({ name: 'written', description: 'w' }, 'body')
    assert.equal(r.ok, true)
    assert.ok(existsSync(join(sharedDir, 'written', 'SKILL.md')))
    assert.ok(!existsSync(join(legacyDir, 'written', 'SKILL.md')))
    assert.equal((await mkStore().view('written') as any).layer, 'shared')
  })

  it('save rejects names reserved by baseline or agent-seed', async () => {
    await writeSkillMd(baselineDir, 'bres', fm('bres', 'b'))
    await writeSkillMd(seedDir, 'sres', fm('sres', 's'))
    const r1 = await mkStore().save({ name: 'bres', description: 'x' }, 'b')
    assert.equal(r1.ok, false)
    assert.match(r1.error ?? '', /reserved for platform baseline/)
    const r2 = await mkStore().save({ name: 'sres', description: 'x' }, 'b')
    assert.equal(r2.ok, false)
    assert.match(r2.error ?? '', /reserved for platform agent-seed/)
  })

  it('delete sweeps same-named legacy residue across ALL agents', async () => {
    await writeSkillMd(sharedDir, 'sweep', fm('sweep', 'shared'))
    await writeSkillMd(paths.agentSkillsDir('agA'), 'sweep', fm('sweep', 'a'))
    await writeSkillMd(paths.agentSkillsDir('agB'), 'sweep', fm('sweep', 'b'))
    const r = await mkStore().delete('sweep')
    assert.equal(r.ok, true)
    assert.ok(!existsSync(join(sharedDir, 'sweep')))
    assert.ok(!existsSync(join(paths.agentSkillsDir('agA'), 'sweep')))
    assert.ok(!existsSync(join(paths.agentSkillsDir('agB'), 'sweep')))
  })

  it('delete of legacy-only residue in another agent does not resurface', async () => {
    await writeSkillMd(paths.agentSkillsDir('agC'), 'ghost', fm('ghost', 'g'))
    const r = await mkStore().delete('ghost')
    assert.equal(r.ok, true)
    assert.ok(!existsSync(join(paths.agentSkillsDir('agC'), 'ghost')))
  })

  it('rejects a sharedDir resolving outside home', () => {
    assert.throws(
      () => new SkillStore(OA, { sharedDir: join(tmpdir(), 'outside-home-skills') }),
      /within home/,
    )
  })

  it('aggregateLegacy merges all agents legacy + shared, excludes agent-seed', async () => {
    await writeSkillMd(paths.agentSkillsDir('uA'), 'agg-a', fm('agg-a', 'a'))
    await writeSkillMd(paths.agentSkillsDir('uB'), 'agg-b', fm('agg-b', 'b'))
    await writeSkillMd(sharedDir, 'agg-shared', fm('agg-shared', 's'))
    await writeSkillMd(paths.agentSeedSkillsDir('uA'), 'agg-seed', fm('agg-seed', 'seed'))
    const store = new SkillStore('main', { baselineDir, sharedDir, aggregateLegacy: true })
    const names = (await store.list()).map((s) => s.name)
    assert.ok(names.includes('agg-a'))
    assert.ok(names.includes('agg-b'))
    assert.ok(names.includes('agg-shared'))
    assert.ok(!names.includes('agg-seed'), 'agent-seed must NOT appear in user-level aggregate')
  })

  it('user-level save is rejected for names reserved by ANY agent seed (anti-shadow)', async () => {
    await writeSkillMd(paths.agentSeedSkillsDir('scientist'), 'reserved-seed', fm('reserved-seed', 'seed'))
    const userStore = new SkillStore('main', { baselineDir, sharedDir, aggregateLegacy: true })
    const r = await userStore.save({ name: 'reserved-seed', description: 'x' }, 'b')
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /reserved for a platform agent-seed/)
    assert.ok(!existsSync(join(sharedDir, 'reserved-seed')), 'must not have written a shadowed shared skill')
  })
})
