/**
 * Context Governance unit tests (OCV5-840 Pillar 1):
 * - Reversible archive & restore (single id, whole batchId, idempotency, conflict guard, legacy compat)
 * - SkillStore.save() rolling history cap (<= 5 snapshots)
 * - skill_usage_local SQLite counters & classifySkillTier (hot/warm/cold)
 * - ProjectMemoryLedger.restoreDeprecated
 * - buildContextHealthReport & runContextJanitor (dryRun + live + full batch rollback)
 *
 * Run: npx tsx --test packages/storage/src/__tests__/contextGovernance.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'

const testHome = await mkdtemp(join(tmpdir(), 'oc-ctx-gov-'))
process.env.OPENCLAUDE_HOME = testHome

const storage = await import('../index.js')
const {
  archiveMemoryFiles,
  archiveUserSkill,
  buildContextHealthReport,
  classifySkillTier,
  createMemoryDirForAgentDir,
  ensureProjectMemoryLedger,
  ensureSkillUsageLocalTable,
  getLocalSkillUsageMap,
  listArchivedMemories,
  listArchivedSkills,
  listContextHygieneHistory,
  MAX_SKILL_HISTORY_VERSIONS,
  ProjectMemoryLedger,
  recordLocalSkillSearchHits,
  recordLocalSkillView,
  restoreArchivedMemories,
  restoreArchivedSkills,
  runContextJanitor,
  SkillStore,
} = storage

const memDoc = (name: string, desc: string, body: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${desc}\ntype: project\n${extra}---\n${body}\n`

describe('contextArchive — Core Memory 可逆归档与还原', () => {
  it('支持归档、MEMORY.md 同步更新、单条/整批还原、幂等与重名保护', async () => {
    const agentDir = await mkdtemp(join(testHome, 'agent-mem-'))
    const memdir = createMemoryDirForAgentDir(agentDir, 'main')

    await memdir.write('alpha.md', memDoc('Alpha', 'alpha hook', 'alpha body'))
    await memdir.write('beta.md', memDoc('Beta', 'beta hook', 'beta body'))
    await memdir.write('keep.md', memDoc('Keep', 'keep hook', 'keep body'))

    // Archive alpha & beta plus one missing + one invalid path
    const res = await archiveMemoryFiles(agentDir, ['alpha.md', 'beta.md', 'missing.md', '../evil.md'], {
      reason: 'manual_slim',
      actor: 'tester',
    })
    assert.equal(res.archived.length, 2)
    assert.equal(res.skipped.length, 2)
    assert.ok(res.bytesSaved > 0)
    assert.equal(existsSync(join(agentDir, 'memory', 'alpha.md')), false)
    assert.equal(existsSync(join(agentDir, 'memory', 'beta.md')), false)
    assert.equal(existsSync(join(agentDir, 'memory', 'keep.md')), true)

    // Manifest file permissions = 0600
    const manifestStat = await stat(join(agentDir, 'memory-archive', 'archive-manifest.json'))
    assert.equal(manifestStat.mode & 0o777, 0o600)

    // MEMORY.md index must no longer contain alpha.md / beta.md
    const idxAfterArchive = await readFile(join(agentDir, 'MEMORY.md'), 'utf8')
    assert.equal(idxAfterArchive.includes('alpha.md'), false)
    assert.equal(idxAfterArchive.includes('beta.md'), false)
    assert.equal(idxAfterArchive.includes('keep.md'), true)

    // Legacy loose file compatibility in memory-archive/
    await writeFile(
      join(agentDir, 'memory-archive', 'legacy-note.md'),
      memDoc('Legacy', 'legacy hook', 'legacy body'),
    )
    const listed = await listArchivedMemories(agentDir)
    assert.equal(listed.length, 3)
    assert.ok(listed.some((e) => e.id === 'legacy:legacy-note.md'))

    // Single restore by id (alpha)
    const alphaEntry = res.archived.find((e) => e.file === 'alpha.md')!
    const singleRestore = await restoreArchivedMemories(agentDir, { id: alphaEntry.id })
    assert.equal(singleRestore.restored.length, 1)
    assert.equal(singleRestore.restored[0]!.file, 'alpha.md')
    assert.equal(existsSync(join(agentDir, 'memory', 'alpha.md')), true)
    const idxAfterSingle = await readFile(join(agentDir, 'MEMORY.md'), 'utf8')
    assert.equal(idxAfterSingle.includes('alpha.md'), true)

    // Repeating same restore is idempotent (no error)
    const repeatRestore = await restoreArchivedMemories(agentDir, { id: alphaEntry.id })
    assert.equal(repeatRestore.restored.length, 0)
    assert.equal(repeatRestore.skipped.length, 0)

    // Conflict guard: if beta.md already exists live, restore skips without clobbering
    await memdir.write('beta.md', memDoc('Beta Live', 'live version', 'do not clobber'))
    const conflictRestore = await restoreArchivedMemories(agentDir, { batchId: res.batchId })
    assert.equal(conflictRestore.restored.length, 0)
    assert.equal(conflictRestore.skipped.length, 1)
    assert.equal(conflictRestore.skipped[0]!.reason, 'target_exists')
    const liveBeta = await readFile(join(agentDir, 'memory', 'beta.md'), 'utf8')
    assert.ok(liveBeta.includes('do not clobber'))

    // After removing conflicting live file, batch restore succeeds cleanly
    await memdir.remove('beta.md')
    const batchRestore = await restoreArchivedMemories(agentDir, { batchId: res.batchId })
    assert.equal(batchRestore.restored.length, 1)
    assert.equal(batchRestore.restored[0]!.file, 'beta.md')
    const restoredBeta = await readFile(join(agentDir, 'memory', 'beta.md'), 'utf8')
    assert.ok(restoredBeta.includes('beta body'))
  })
})

describe('contextArchive & SkillStore — 技能可逆归档与历史 5 份上限', () => {
  it('SkillStore.save() 滚动保留最多 5 份 history 快照且不影响 restore', async () => {
    const skillsDir = join(testHome, 'skills-hist-test')
    await mkdir(skillsDir, { recursive: true })
    const store = new SkillStore('main', { sharedDir: skillsDir, sharedWritable: true })

    for (let i = 0; i < 9; i++) {
      const saved = await store.save(
        { name: 'rolling-skill', description: `revision ${i}` },
        `# Body revision ${i}`,
      )
      assert.equal(saved.ok, true)
    }

    const hist = await store.history('rolling-skill')
    assert.equal(hist.length, MAX_SKILL_HISTORY_VERSIONS)
    assert.equal(hist.length, 5)
    // Current is 1.0.8; retained snapshots should be 1.0.7 down to 1.0.3
    assert.deepEqual(
      hist.map((h) => h.version),
      ['1.0.7', '1.0.6', '1.0.5', '1.0.4', '1.0.3'],
    )

    // Restore from a retained snapshot still works
    const restored = await store.restore('rolling-skill', '1.0.5')
    assert.equal(restored.ok, true)
    const viewed = await store.view('rolling-skill')
    assert.ok(viewed && typeof viewed !== 'string')
    assert.ok(viewed.body.includes('Body revision 5'))
  })

  it('支持用户技能归档、列出（含旧手工归档桶）、按 name/batchId 还原与重名保护', async () => {
    const root = await mkdtemp(join(testHome, 'skill-arch-'))
    const skillsDir = join(root, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const store = new SkillStore('main', { sharedDir: skillsDir, sharedWritable: true })
    await store.save({ name: 'cold-alpha', description: 'alpha skill' }, '# Alpha instructions')
    await store.save({ name: 'cold-beta', description: 'beta skill' }, '# Beta instructions')

    const r1 = await archiveUserSkill(skillsDir, 'cold-alpha', {
      reason: 'cold_skill',
      actor: 'tester',
      batchId: 'batch-skill-1',
    })
    const r2 = await archiveUserSkill(skillsDir, 'cold-beta', {
      reason: 'cold_skill',
      actor: 'tester',
      batchId: 'batch-skill-1',
    })
    assert.ok(r1.entry && r2.entry)
    assert.equal(existsSync(join(skillsDir, 'cold-alpha')), false)
    assert.equal(existsSync(join(skillsDir, 'cold-beta')), false)

    // Missing skill archive returns skippedReason cleanly
    const missing = await archiveUserSkill(skillsDir, 'does-not-exist', { reason: 'test' })
    assert.equal(missing.entry, null)
    assert.equal(missing.skippedReason, 'not_found')

    // Legacy bucket compatibility (skills-archive/20261108/legacy-tool/SKILL.md)
    const legacyDir = join(root, 'skills-archive', '20261108', 'legacy-tool')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'SKILL.md'),
      '---\nname: legacy-tool\ndescription: "legacy desc"\n---\n# Legacy\n',
    )
    const listed = await listArchivedSkills(skillsDir)
    assert.equal(listed.length, 3)
    assert.ok(listed.some((s) => s.id === 'legacy:20261108/legacy-tool'))

    // Restore entire batch
    const restored = await restoreArchivedSkills(skillsDir, { batchId: 'batch-skill-1' })
    assert.equal(restored.restored.length, 2)
    assert.equal(existsSync(join(skillsDir, 'cold-alpha', 'SKILL.md')), true)
    assert.equal(existsSync(join(skillsDir, 'cold-beta', 'SKILL.md')), true)

    // Repeating restore is idempotent
    const repeat = await restoreArchivedSkills(skillsDir, { batchId: 'batch-skill-1' })
    assert.equal(repeat.restored.length, 0)
    assert.equal(repeat.skipped.length, 0)
  })
})

describe('skillUsageLocal — 本地技能热度账本与冷热分级', () => {
  it('正确读写 skill_usage_local 并按 priority / 30d / 60d 分级', async () => {
    const db = new Database(':memory:')
    ensureSkillUsageLocalTable(db)

    const now = Date.UTC(2026, 10, 22, 0, 0, 0)
    const day = 86_400_000
    await recordLocalSkillView('hot-skill', 'user', { db, nowMs: now - 5 * day })
    await recordLocalSkillView('hot-skill', 'user', { db, nowMs: now - 2 * day })
    await recordLocalSkillView('warm-skill', 'user', { db, nowMs: now - 45 * day })
    await recordLocalSkillSearchHits(['search-warm', 'hot-skill'], 'user', {
      db,
      nowMs: now - 10 * day,
    })
    await recordLocalSkillView('cold-skill', 'user', { db, nowMs: now - 90 * day })

    const usageMap = await getLocalSkillUsageMap({ db })
    assert.equal(usageMap.get('hot-skill')?.useCount, 2)
    assert.equal(usageMap.get('hot-skill')?.searchHitCount, 1)
    assert.equal(usageMap.get('warm-skill')?.useCount, 1)

    assert.equal(classifySkillTier(usageMap.get('hot-skill'), { nowMs: now }), 'hot')
    assert.equal(classifySkillTier(usageMap.get('warm-skill'), { nowMs: now }), 'warm')
    assert.equal(classifySkillTier(usageMap.get('search-warm'), { nowMs: now }), 'warm')
    assert.equal(classifySkillTier(usageMap.get('cold-skill'), { nowMs: now }), 'cold')
    // Pinned priority >= 60 is always hot even if never used
    assert.equal(classifySkillTier(undefined, { priority: 60, nowMs: now }), 'hot')
    // Newly created skill (<60d mtime) is warm; old never-used skill (>60d mtime) is cold
    assert.equal(classifySkillTier(undefined, { nowMs: now, mtimeMs: now - 3 * day }), 'warm')
    assert.equal(classifySkillTier(undefined, { nowMs: now, mtimeMs: now - 75 * day }), 'cold')
    db.close()
  })
})

describe('ProjectMemoryLedger.restoreDeprecated — 废弃项目记忆恢复', () => {
  it('把 deprecated 正式条目安全恢复回 official 并保证幂等', async () => {
    const db = new Database(':memory:')
    ensureProjectMemoryLedger(db)
    const ledger = new ProjectMemoryLedger(db)
    const projectId = '11111111-2222-3333-4444-555555555555'

    const created = await ledger.createCandidate({
      projectId,
      slug: 'arch-decision.md',
      content: memDoc('Arch', 'architecture decision', 'Use reversible archives.'),
      actor: 'user',
    })
    assert.equal(created.ok, true)
    assert.equal(ledger.listOfficial(projectId).length, 1)

    const offBefore = ledger.getOfficial(projectId, 'arch-decision.md')!
    const dep = ledger.deprecate({
      projectId,
      slug: 'arch-decision.md',
      expectedVersion: offBefore.version,
      actor: 'user',
    })
    assert.equal(dep.ok, true)
    assert.equal(ledger.listOfficial(projectId).length, 0)

    const restored = ledger.restoreDeprecated(projectId, 'arch-decision.md', 'user')
    assert.equal(restored.ok, true)
    if (restored.ok) {
      assert.equal(restored.restored, true)
      assert.equal(restored.official.deprecated, false)
    }
    assert.equal(ledger.listOfficial(projectId).length, 1)

    // Idempotent repeat
    const repeat = ledger.restoreDeprecated(projectId, 'arch-decision.md', 'user')
    assert.equal(repeat.ok, true)
    if (repeat.ok) {
      assert.equal(repeat.restored, false)
      assert.equal(repeat.idempotent, true)
    }
    db.close()
  })
})

describe('contextJanitor — 体检报告、L1 确定性清理与整批回滚', () => {
  it('dryRun 不落盘，live 归档过期记忆/冷技能、裁剪历史、衰减 archival，并支持整批回滚', async () => {
    const root = await mkdtemp(join(testHome, 'janitor-'))
    const agentDir = join(root, 'agents', 'main')
    const skillsDir = join(root, 'skills')
    const userProfilePath = join(root, 'user.md')
    await mkdir(agentDir, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(agentDir, 'CLAUDE.md'), '# Persona rules\nKeep context clean.\n')
    await writeFile(userProfilePath, '- User prefers concise Chinese replies.\n')

    const nowMs = Date.UTC(2026, 10, 22, 0, 0, 0)
    const today = '2026-11-22'
    const day = 86_400_000

    // Seed Core memories: 1 expired, 1 fresh, 1 oversized (>6KB)
    const memdir = createMemoryDirForAgentDir(agentDir, 'main')
    await memdir.write(
      'expired-note.md',
      memDoc('Expired Note', 'old temp fact', 'expired body', 'source: auto\nexpires: 2026-10-01\n'),
    )
    await memdir.write('fresh-note.md', memDoc('Fresh Note', 'active fact', 'fresh body'))
    await memdir.write(
      'huge-note.md',
      memDoc('Huge Note', 'oversized doc', 'x'.repeat(7000)),
    )

    // Seed skills: cold-old (>60d mtime, never used), pinned-old (priority 80), hot-used, excess-hist (7 snapshots)
    const store = new SkillStore('main', { sharedDir: skillsDir, sharedWritable: true })
    await store.save({ name: 'cold-old', description: 'old unused skill' }, '# Cold')
    await store.save(
      { name: 'pinned-old', description: 'pinned skill', priority: 80 },
      '# Pinned',
    )
    // Manually ensure priority frontmatter is present (SkillStore.formatFrontmatter omits priority, so write explicitly)
    await writeFile(
      join(skillsDir, 'pinned-old', 'SKILL.md'),
      '---\nname: pinned-old\ndescription: "pinned skill"\npriority: 80\n---\n\n# Pinned\n',
    )
    await store.save({ name: 'hot-used', description: 'active skill' }, '# Hot')
    await store.save({ name: 'excess-hist', description: 'history bloat skill' }, '# History')

    const oldDate = new Date(nowMs - 90 * day)
    await utimes(join(skillsDir, 'cold-old', 'SKILL.md'), oldDate, oldDate)
    await utimes(join(skillsDir, 'pinned-old', 'SKILL.md'), oldDate, oldDate)

    // Create 7 synthetic history snapshots inside excess-hist/history/
    const histDir = join(skillsDir, 'excess-hist', 'history')
    await mkdir(histDir, { recursive: true })
    for (let v = 0; v < 7; v++) {
      await writeFile(join(histDir, `1.0.${v}.md`), `# v1.0.${v}\n`)
    }

    // Seed isolated SQLite DB with skill_usage_local + archival
    const db = new Database(':memory:')
    ensureSkillUsageLocalTable(db)
    await recordLocalSkillView('hot-used', 'user', { db, nowMs: nowMs - 2 * day })
    db.exec(`
      CREATE TABLE archival (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT DEFAULT ''
      );
    `)
    db.prepare(
      `INSERT INTO archival (id, agent_id, content, tags, created_at, access_count, last_accessed)
       VALUES (?, 'main', ?, 'old', '2026-08-01 00:00:00', 0, '')`,
    ).run('arc-stale-1', 'stale archival entry')
    db.prepare(
      `INSERT INTO archival (id, agent_id, content, tags, created_at, access_count, last_accessed)
       VALUES (?, 'main', ?, 'decay', '2026-09-01 00:00:00', 2, '2026-09-10 00:00:00')`,
    ).run('arc-decay-1', 'inactive archival entry')

    // 1. Health report inspection
    const report = await buildContextHealthReport({
      agentId: 'main',
      agentDir,
      userProfilePath,
      skillsDir,
      sessionsDb: db,
      today,
      nowMs,
    })
    assert.equal(report.summary.coreMemoryCount, 3)
    assert.equal(report.summary.expiredMemoryCount, 1)
    assert.equal(report.summary.oversizedMemoryCount, 1)
    assert.equal(report.summary.activeSkillCount, 4)
    assert.equal(report.summary.coldSkillCount, 1)
    assert.equal(report.summary.staleArchivalCount, 1)
    assert.ok(report.slimCandidates.some((c) => c.kind === 'expired_memory' && c.target === 'expired-note.md'))
    assert.ok(report.slimCandidates.some((c) => c.kind === 'oversized_memory' && c.target === 'huge-note.md'))
    assert.ok(report.slimCandidates.some((c) => c.kind === 'cold_skill' && c.target === 'cold-old'))
    assert.ok(report.slimCandidates.some((c) => c.kind === 'skill_history' && c.target === 'excess-hist'))
    assert.ok(report.slimCandidates.some((c) => c.kind === 'stale_archival'))

    // 2. Dry-run (auto policy) must not mutate disk or DB or write history
    const dry = await runContextJanitor({
      agentId: 'main',
      agentDir,
      skillsDir,
      sessionsDb: db,
      dryRun: true,
      mode: 'auto',
      archiveExpiredMemories: true,
      archiveColdSkills: true,
      pruneSkillHistory: true,
      decayArchival: true,
      today,
      nowMs,
    })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.expiredMemoriesArchived, 1)
    assert.equal(dry.coldSkillsArchived, 1)
    assert.equal(dry.skillHistoriesPruned, 2)
    assert.equal(dry.archivalDecayed, 1)
    assert.equal(dry.archivalCleaned, 1)
    assert.equal(existsSync(join(agentDir, 'memory', 'expired-note.md')), true)
    assert.equal(existsSync(join(skillsDir, 'cold-old', 'SKILL.md')), true)
    assert.equal((await listContextHygieneHistory(agentDir)).length, 0)

    // 3. Live run (auto policy) mutates safely and records history
    const live = await runContextJanitor({
      agentId: 'main',
      agentDir,
      skillsDir,
      sessionsDb: db,
      dryRun: false,
      mode: 'auto',
      archiveExpiredMemories: true,
      archiveColdSkills: true,
      pruneSkillHistory: true,
      decayArchival: true,
      today,
      nowMs,
    })
    assert.equal(live.expiredMemoriesArchived, 1)
    assert.deepEqual(live.archivedMemoryFiles, ['expired-note.md'])
    assert.equal(live.coldSkillsArchived, 1)
    assert.deepEqual(live.archivedSkillNames, ['cold-old'])
    assert.equal(live.skillHistoriesPruned, 2)
    assert.equal(live.archivalDecayed, 1)
    assert.equal(live.archivalCleaned, 1)
    assert.ok(live.batchId)
    assert.equal(live.errors.length, 0)

    // Pinned & hot skills untouched; cold-old archived; excess-hist trimmed to 5
    assert.equal(existsSync(join(agentDir, 'memory', 'expired-note.md')), false)
    assert.equal(existsSync(join(agentDir, 'memory', 'fresh-note.md')), true)
    assert.equal(existsSync(join(skillsDir, 'cold-old')), false)
    assert.equal(existsSync(join(skillsDir, 'pinned-old', 'SKILL.md')), true)
    assert.equal(existsSync(join(skillsDir, 'hot-used', 'SKILL.md')), true)
    assert.equal((await readdir(histDir)).length, 5)

    // Archival DB verified: stale row deleted, inactive row decayed 2 -> 1
    const remArchival = db
      .prepare('SELECT id, access_count FROM archival ORDER BY id')
      .all() as Array<{ id: string; access_count: number }>
    assert.deepEqual(remArchival, [{ id: 'arc-decay-1', access_count: 1 }])

    // Hygiene history persisted with 0600 mode
    const histRuns = await listContextHygieneHistory(agentDir)
    assert.equal(histRuns.length, 1)
    assert.equal(histRuns[0]!.runId, live.runId)
    const histStat = await stat(join(agentDir, 'context-hygiene-history.json'))
    assert.equal(histStat.mode & 0o777, 0o600)

    // 4. Whole-batch rollback restores BOTH expired memory and cold skill
    const memRollback = await restoreArchivedMemories(agentDir, { batchId: live.batchId! })
    const skillRollback = await restoreArchivedSkills(skillsDir, { batchId: live.batchId! })
    assert.equal(memRollback.restored.length, 1)
    assert.equal(skillRollback.restored.length, 1)
    assert.equal(existsSync(join(agentDir, 'memory', 'expired-note.md')), true)
    assert.equal(existsSync(join(skillsDir, 'cold-old', 'SKILL.md')), true)
    const idxRestored = await readFile(join(agentDir, 'MEMORY.md'), 'utf8')
    assert.equal(idxRestored.includes('expired-note.md'), true)
    db.close()
  })
})

describe('T2 审计反例实证 — B1/B2/N2/N5 根治验证', () => {
  it('反例 1 (B1)：同 batchId 先后归档同名 foo.md v1/v2 不互覆盖，按 id1 恢复精确读回 v1', async () => {
    const agentDir = await mkdtemp(join(testHome, 'b1-same-batch-mem-'))
    const memdir = createMemoryDirForAgentDir(agentDir, 'main')

    const v1Content = memDoc('Foo v1', 'first version', 'VERSION_ONE_EXACT_BYTES')
    const v2Content = memDoc('Foo v2', 'second version', 'VERSION_TWO_EXACT_BYTES')

    await memdir.write('foo.md', v1Content)
    const r1 = await archiveMemoryFiles(agentDir, ['foo.md'], {
      reason: 'first',
      actor: 'tester',
      batchId: 'shared-batch-001',
    })
    assert.equal(r1.archived.length, 1)
    const id1 = r1.archived[0]!.id

    await memdir.write('foo.md', v2Content)
    const r2 = await archiveMemoryFiles(agentDir, ['foo.md'], {
      reason: 'second',
      actor: 'tester',
      batchId: 'shared-batch-001',
    })
    assert.equal(r2.archived.length, 1)
    const id2 = r2.archived[0]!.id

    assert.notEqual(id1, id2)
    assert.notEqual(r1.archived[0]!.archivedRelPath, r2.archived[0]!.archivedRelPath)

    const listed = await listArchivedMemories(agentDir)
    assert.equal(listed.length, 2)
    assert.ok(listed.some((e) => e.id === id1))
    assert.ok(listed.some((e) => e.id === id2))

    // Restore specifically id1 -> must read back exact v1 bytes!
    const restored = await restoreArchivedMemories(agentDir, { id: id1 })
    assert.equal(restored.restored.length, 1)
    const liveFoo = await readFile(join(agentDir, 'memory', 'foo.md'), 'utf8')
    assert.equal(liveFoo, v1Content)

    // Same check for user skills archived twice under the same batchId
    const skillRoot = await mkdtemp(join(testHome, 'b1-same-batch-skill-'))
    const skillsDir = join(skillRoot, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const store = new SkillStore('main', { sharedDir: skillsDir, sharedWritable: true })

    await store.save({ name: 'dup-skill', description: 'skill v1' }, '# SKILL_V1_BODY')
    const sr1 = await archiveUserSkill(skillsDir, 'dup-skill', {
      reason: 'first',
      batchId: 'shared-skill-batch',
    })
    assert.ok(sr1.entry)

    await store.save({ name: 'dup-skill', description: 'skill v2' }, '# SKILL_V2_BODY')
    const sr2 = await archiveUserSkill(skillsDir, 'dup-skill', {
      reason: 'second',
      batchId: 'shared-skill-batch',
    })
    assert.ok(sr2.entry)
    assert.notEqual(sr1.entry.archivedRelPath, sr2.entry.archivedRelPath)
    assert.equal((await listArchivedSkills(skillsDir)).length, 2)

    const sRestored = await restoreArchivedSkills(skillsDir, { id: sr1.entry.id })
    assert.equal(sRestored.restored.length, 1)
    const restoredMd = await readFile(join(skillsDir, 'dup-skill', 'SKILL.md'), 'utf8')
    assert.ok(restoredMd.includes('SKILL_V1_BODY'))
    assert.equal(restoredMd.includes('SKILL_V2_BODY'), false)
  })

  it('反例 2 (B1)：文件/技能已移至 batches/<batchId>/ 但 manifest 未落盘时，公开 list 与 restore 仍发现并精确还原', async () => {
    const agentDir = await mkdtemp(join(testHome, 'b1-orphan-mem-'))
    const memdir = createMemoryDirForAgentDir(agentDir, 'main')
    await memdir.ensureMigrated()

    const orphanBytes = memDoc('Orphan Note', 'crash window test', 'EXACT_ORPHAN_PAYLOAD_42')
    const orphanBatchDir = join(agentDir, 'memory-archive', 'batches', 'crash-batch-99')
    await mkdir(orphanBatchDir, { recursive: true })
    await writeFile(join(orphanBatchDir, 'mem-orphan123456__orphan.md'), orphanBytes)

    // No archive-manifest.json written at all!
    const listed = await listArchivedMemories(agentDir)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.id, 'mem-orphan123456')
    assert.equal(listed[0]!.file, 'orphan.md')
    assert.equal(listed[0]!.batchId, 'crash-batch-99')

    const restored = await restoreArchivedMemories(agentDir, { id: 'mem-orphan123456' })
    assert.equal(restored.restored.length, 1)
    const recovered = await readFile(join(agentDir, 'memory', 'orphan.md'), 'utf8')
    assert.equal(recovered, orphanBytes)

    // Same interrupted-manifest recovery for skills
    const skillRoot = await mkdtemp(join(testHome, 'b1-orphan-skill-'))
    const skillsDir = join(skillRoot, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const orphanSkillDir = join(
      skillRoot,
      'skills-archive',
      'batches',
      'crash-skill-99',
      'skill-orphan9999__orphan-skill',
    )
    await mkdir(orphanSkillDir, { recursive: true })
    const orphanSkillMd = '---\nname: orphan-skill\ndescription: "orphan"\n---\n\n# ORPHAN_SKILL_BODY\n'
    await writeFile(join(orphanSkillDir, 'SKILL.md'), orphanSkillMd)

    const listedSkills = await listArchivedSkills(skillsDir)
    assert.equal(listedSkills.length, 1)
    assert.equal(listedSkills[0]!.id, 'skill-orphan9999')
    assert.equal(listedSkills[0]!.name, 'orphan-skill')

    const restoredSkills = await restoreArchivedSkills(skillsDir, { batchId: 'crash-skill-99' })
    assert.equal(restoredSkills.restored.length, 1)
    assert.equal(await readFile(join(skillsDir, 'orphan-skill', 'SKILL.md'), 'utf8'), orphanSkillMd)
  })

  it('反例 3 (B2)：精确选择集 pruneSkillHistoryNames 与 pruneArchivalIds 严禁动未选项，且候选诚实标注 reversible:false', async () => {
    const root = await mkdtemp(join(testHome, 'b2-exact-select-'))
    const agentDir = join(root, 'agents', 'main')
    const skillsDir = join(root, 'skills')
    await mkdir(agentDir, { recursive: true })
    await mkdir(skillsDir, { recursive: true })

    const store = new SkillStore('main', { sharedDir: skillsDir, sharedWritable: true })
    await store.save({ name: 'alpha', description: 'alpha skill' }, '# Alpha')
    await store.save({ name: 'beta', description: 'beta skill' }, '# Beta')

    for (const skillName of ['alpha', 'beta']) {
      const hDir = join(skillsDir, skillName, 'history')
      await mkdir(hDir, { recursive: true })
      for (let v = 0; v < 6; v++) {
        await writeFile(join(hDir, `1.0.${v}.md`), `# ${skillName} v1.0.${v}\n`)
      }
    }

    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE archival (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT DEFAULT ''
      );
    `)
    db.prepare(
      `INSERT INTO archival (id, agent_id, content, created_at, access_count, last_accessed)
       VALUES ('arc-1', 'main', 'old 1', '2026-08-01 00:00:00', 0, ''),
              ('arc-2', 'main', 'old 2', '2026-08-02 00:00:00', 0, '')`,
    ).run()

    // Health report marks permanent pruning items with reversible: false
    const report = await buildContextHealthReport({
      agentId: 'main',
      agentDir,
      skillsDir,
      sessionsDb: db,
      today: '2026-11-22',
      nowMs: Date.UTC(2026, 10, 22),
    })
    const histCandidates = report.slimCandidates.filter((c) => c.kind === 'skill_history')
    assert.equal(histCandidates.length, 2)
    assert.ok(histCandidates.every((c) => c.reversible === false))
    const archCandidate = report.slimCandidates.find((c) => c.kind === 'stale_archival')
    assert.ok(archCandidate)
    assert.equal(archCandidate.reversible, false)

    // Prune ONLY alpha's history and ONLY arc-1 -> beta MUST keep all 6 snapshots and arc-2 MUST survive!
    const run = await runContextJanitor({
      agentId: 'main',
      agentDir,
      skillsDir,
      sessionsDb: db,
      archiveExpiredMemories: false,
      archiveColdSkills: false,
      pruneSkillHistory: true,
      pruneSkillHistoryNames: ['alpha'],
      decayArchival: true,
      pruneArchivalIds: ['arc-1'],
      today: '2026-11-22',
      nowMs: Date.UTC(2026, 10, 22),
    })
    assert.equal(run.skillHistoriesPruned, 1)
    assert.equal(run.archivalCleaned, 1)

    assert.equal((await readdir(join(skillsDir, 'alpha', 'history'))).length, 5)
    assert.equal((await readdir(join(skillsDir, 'beta', 'history'))).length, 6)
    const survivingArchival = db
      .prepare('SELECT id FROM archival ORDER BY id')
      .all() as Array<{ id: string }>
    assert.deepEqual(survivingArchival, [{ id: 'arc-2' }])
    db.close()
  })

  it('反例 4 (N2)：严格归档根校验拒绝指向归档目录外或符号链接越界的伪造 manifest', async () => {
    const agentDir = await mkdtemp(join(testHome, 'n2-root-guard-'))
    const memdir = createMemoryDirForAgentDir(agentDir, 'main')
    await memdir.ensureMigrated()
    await writeFile(join(agentDir, 'outside-secret.md'), 'TOP_SECRET')

    const archDir = join(agentDir, 'memory-archive')
    const batchDir = join(archDir, 'batches', 'evil-batch')
    await mkdir(batchDir, { recursive: true })
    await symlink(join(agentDir, 'outside-secret.md'), join(batchDir, 'mem-sym123__sym.md'))

    // Plant tampered manifest with: (1) traversal outside memory-archive/, (2) symlink inside archive
    await writeFile(
      join(archDir, 'archive-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            id: 'mem-escape1',
            batchId: 'evil-batch',
            slug: 'escape',
            file: 'escape.md',
            originalRelPath: 'memory/escape.md',
            archivedRelPath: 'outside-secret.md',
            archivedAt: '2026-11-22T00:00:00.000Z',
            reason: 'tampered',
            actor: 'attacker',
            bytes: 10,
          },
          {
            id: 'mem-sym123',
            batchId: 'evil-batch',
            slug: 'sym',
            file: 'sym.md',
            originalRelPath: 'memory/sym.md',
            archivedRelPath: 'memory-archive/batches/evil-batch/mem-sym123__sym.md',
            archivedAt: '2026-11-22T00:00:00.000Z',
            reason: 'tampered',
            actor: 'attacker',
            bytes: 10,
          },
        ],
      }),
    )

    assert.equal((await listArchivedMemories(agentDir)).length, 0)
    const res = await restoreArchivedMemories(agentDir, { batchId: 'evil-batch' })
    assert.equal(res.restored.length, 0)
    assert.equal(res.skipped.length, 2)
    assert.equal(existsSync(join(agentDir, 'memory', 'escape.md')), false)
    assert.equal(existsSync(join(agentDir, 'memory', 'sym.md')), false)
    assert.equal(existsSync(join(agentDir, 'outside-secret.md')), true)
  })

  it('反例 5 (N5)：dryRun:true 对旧版 archival 表零写副作用（不执行 ALTER TABLE 且预览匹配真实清理）', async () => {
    const root = await mkdtemp(join(testHome, 'n5-dryrun-'))
    const agentDir = join(root, 'agents', 'main')
    await mkdir(agentDir, { recursive: true })

    // Legacy archival schema WITHOUT access_count / last_accessed columns
    const legacyDb = new Database(':memory:')
    legacyDb.exec(`
      CREATE TABLE archival (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `)
    legacyDb
      .prepare(`INSERT INTO archival (id, agent_id, content, created_at) VALUES ('old-1', 'main', 'legacy', '2026-08-01 00:00:00')`)
      .run()

    const dry = await runContextJanitor({
      agentId: 'main',
      agentDir,
      sessionsDb: legacyDb,
      dryRun: true,
      mode: 'auto',
      decayArchival: true,
      archiveExpiredMemories: false,
      pruneSkillHistory: false,
      today: '2026-11-22',
      nowMs: Date.UTC(2026, 10, 22),
    })
    assert.equal(dry.archivalCleaned, 1)

    // Schema MUST remain completely untouched (no ALTER TABLE!)
    const colsAfterDry = legacyDb.prepare('PRAGMA table_info(archival)').all() as Array<{ name: string }>
    assert.equal(colsAfterDry.some((c) => c.name === 'access_count'), false)
    assert.equal(colsAfterDry.some((c) => c.name === 'last_accessed'), false)
    // And no lockfile/history written to agentDir during dryRun
    assert.equal(existsSync(join(agentDir, 'context-hygiene-history.json')), false)
    assert.equal(existsSync(join(agentDir, '.context-hygiene.lock')), false)
    legacyDb.close()
  })

  it('反例 6 (B2 残余)：manual 模式传 pruneArchivalIds:[A] 绝不全局衰减未选条目 B 的 access_count', async () => {
    const root = await mkdtemp(join(testHome, 'b2-manual-no-global-decay-'))
    const agentDir = join(root, 'agents', 'main')
    await mkdir(agentDir, { recursive: true })

    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE archival (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT DEFAULT ''
      );
    `)
    db.prepare(
      `INSERT INTO archival (id, agent_id, content, created_at, access_count, last_accessed)
       VALUES ('arc-A', 'main', 'entry A', '2026-08-01 00:00:00', 2, '2026-09-01 00:00:00'),
              ('arc-B', 'main', 'entry B', '2026-08-01 00:00:00', 2, '2026-09-01 00:00:00')`,
    ).run()

    const run = await runContextJanitor({
      agentId: 'main',
      agentDir,
      sessionsDb: db,
      mode: 'manual',
      archiveExpiredMemories: false,
      archiveColdSkills: false,
      pruneSkillHistory: false,
      decayArchival: true,
      pruneArchivalIds: ['arc-A'],
      today: '2026-11-22',
      nowMs: Date.UTC(2026, 10, 22),
    })

    assert.equal(run.archivalCleaned, 1)
    assert.equal(run.archivalDecayed, 0)
    const remaining = db
      .prepare('SELECT id, access_count FROM archival ORDER BY id')
      .all() as Array<{ id: string; access_count: number }>
    assert.deepEqual(remaining, [{ id: 'arc-B', access_count: 2 }])
    db.close()
  })

  it('反例 7 (B2 残余)：manual 模式 decayArchival:true 但未传 pruneArchivalIds 时零删除零衰减', async () => {
    const root = await mkdtemp(join(testHome, 'b2-manual-no-ids-noop-'))
    const agentDir = join(root, 'agents', 'main')
    await mkdir(agentDir, { recursive: true })

    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE archival (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT DEFAULT ''
      );
    `)
    db.prepare(
      `INSERT INTO archival (id, agent_id, content, created_at, access_count, last_accessed)
       VALUES ('arc-stale', 'main', 'stale', '2026-08-01 00:00:00', 0, ''),
              ('arc-warm', 'main', 'warm', '2026-08-01 00:00:00', 3, '2026-09-01 00:00:00')`,
    ).run()

    const run = await runContextJanitor({
      agentId: 'main',
      agentDir,
      sessionsDb: db,
      mode: 'manual',
      archiveExpiredMemories: false,
      archiveColdSkills: false,
      pruneSkillHistory: false,
      decayArchival: true,
      today: '2026-11-22',
      nowMs: Date.UTC(2026, 10, 22),
    })

    assert.equal(run.archivalCleaned, 0)
    assert.equal(run.archivalDecayed, 0)
    const remaining = db
      .prepare('SELECT id, access_count FROM archival ORDER BY id')
      .all() as Array<{ id: string; access_count: number }>
    assert.deepEqual(remaining, [
      { id: 'arc-stale', access_count: 0 },
      { id: 'arc-warm', access_count: 3 },
    ])
    db.close()
  })
})

