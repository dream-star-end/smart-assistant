import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

// Point OPENCLAUDE_HOME at a throwaway dir BEFORE importing paths-aware modules.
const prevHome = process.env.OPENCLAUDE_HOME
const testHome = mkdtempSync(join(tmpdir(), 'oc-skill-save-preserve-'))
process.env.OPENCLAUDE_HOME = testHome

const { SkillStore, paths } = await import('../index.js')

describe('SkillStore.save — multi-file preservation & semver patch bump (OCV5-865)', () => {
  after(() => {
    if (prevHome === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = prevHome
    rmSync(testHome, { recursive: true, force: true })
  })

  it('new skill defaults to 1.0.0; updating preserves sibling scripts/references and bumps patch version', async () => {
    const sharedDir = join(testHome, 'skills')
    const store = new SkillStore('main', { sharedDir, aggregateLegacy: true })

    // 1. Create new skill (no explicit version → 1.0.0)
    const r1 = await store.save(
      { name: 'multi-file-lab', description: 'Lab pipeline v1', tags: ['research'] },
      '# Initial instructions',
    )
    assert.equal(r1.ok, true)
    assert.equal(r1.version, '1.0.0')

    // Populate sibling scripts/ and references/ and set version to 1.0.3
    const skillDir = join(sharedDir, 'multi-file-lab')
    mkdirSync(join(skillDir, 'scripts'), { recursive: true })
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    writeFileSync(join(skillDir, 'scripts', 'run_eval.py'), 'print("ok")\n', 'utf8')
    writeFileSync(join(skillDir, 'references', 'rubric.md'), '# Rubric\n', 'utf8')

    const rExplicit = await store.save(
      { name: 'multi-file-lab', description: 'Lab pipeline v1.0.3', version: '1.0.3', tags: ['research'] },
      '# Version 1.0.3 body',
    )
    assert.equal(rExplicit.ok, true)
    assert.equal(rExplicit.version, '1.0.3')
    const beforeView = (await store.view('multi-file-lab')) as { created_at?: string; version?: string; files?: string[] }
    assert.equal(beforeView.version, '1.0.3')
    assert.ok(beforeView.created_at, 'created_at should be recorded')

    // 2. Update without explicit version → must bump 1.0.3 → 1.0.4 and keep scripts/ & references/
    const rUpdate = await store.save(
      { name: 'multi-file-lab', description: 'Lab pipeline updated', tags: ['research', 'eval'] },
      '# Updated instructions v1.0.4',
    )
    assert.equal(rUpdate.ok, true)
    assert.equal(rUpdate.version, '1.0.4')

    const afterView = (await store.view('multi-file-lab')) as {
      version?: string
      created_at?: string
      files?: string[]
      body: string
    }
    assert.equal(afterView.version, '1.0.4')
    assert.equal(afterView.created_at, beforeView.created_at, 'created_at must be preserved across updates')
    assert.equal(afterView.body.trim(), '# Updated instructions v1.0.4')
    assert.ok(afterView.files?.includes('scripts/run_eval.py'), 'scripts/run_eval.py must survive skill_save update')
    assert.ok(afterView.files?.includes('references/rubric.md'), 'references/rubric.md must survive skill_save update')
    assert.equal(readFileSync(join(skillDir, 'scripts', 'run_eval.py'), 'utf8'), 'print("ok")\n')
    assert.equal(readFileSync(join(skillDir, 'references', 'rubric.md'), 'utf8'), '# Rubric\n')
  })

  it('updating a legacy multi-file skill via shared store preserves sibling files and bumps version instead of resetting to 1.0.0', async () => {
    const legacySkillDir = join(paths.agentSkillsDir('research-assistant'), 'legacy-suite')
    mkdirSync(join(legacySkillDir, 'scripts'), { recursive: true })
    mkdirSync(join(legacySkillDir, 'references'), { recursive: true })
    writeFileSync(
      join(legacySkillDir, 'SKILL.md'),
      [
        '---',
        'name: legacy-suite',
        'description: "Legacy multi-file skill"',
        'version: 1.0.3',
        'created_at: 2026-01-01T00:00:00.000Z',
        '---',
        '',
        '# Old legacy body',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(join(legacySkillDir, 'scripts', 'helper.sh'), '#!/bin/sh\necho hi\n', 'utf8')
    writeFileSync(join(legacySkillDir, 'references', 'checklist.md'), '- item 1\n', 'utf8')

    const sharedDir = join(testHome, 'skills')
    const store = new SkillStore('main', { sharedDir, aggregateLegacy: true })

    // Save update via shared store without explicit version
    const r = await store.save(
      { name: 'legacy-suite', description: 'Promoted multi-file skill' },
      '# New promoted body',
    )
    assert.equal(r.ok, true, r.error)
    assert.equal(r.version, '1.0.4', 'must bump legacy 1.0.3 → 1.0.4 rather than resetting to 1.0.0')

    const promotedDir = join(sharedDir, 'legacy-suite')
    assert.ok(existsSync(join(promotedDir, 'scripts', 'helper.sh')), 'scripts/helper.sh copied to shared dir')
    assert.ok(existsSync(join(promotedDir, 'references', 'checklist.md')), 'references/checklist.md copied to shared dir')

    const view = (await store.view('legacy-suite')) as {
      version?: string
      created_at?: string
      files?: string[]
    }
    assert.equal(view.version, '1.0.4')
    assert.equal(view.created_at, '2026-01-01T00:00:00.000Z')
    assert.ok(view.files?.includes('scripts/helper.sh'))
    assert.ok(view.files?.includes('references/checklist.md'))
    assert.equal(await store.view('legacy-suite', 'scripts/helper.sh'), '#!/bin/sh\necho hi\n')
  })

  it('rejects dangling destination symlink without writing outside root or publishing incomplete skill (OCV5-865 #1)', async () => {
    const legacySkillDir = join(paths.agentSkillsDir('research-assistant'), 'symlink-guard-skill')
    mkdirSync(join(legacySkillDir, 'scripts'), { recursive: true })
    writeFileSync(
      join(legacySkillDir, 'SKILL.md'),
      '---\nname: symlink-guard-skill\ndescription: "Legacy"\nversion: 1.0.2\n---\n\n# Legacy safe body\n',
      'utf8',
    )
    writeFileSync(join(legacySkillDir, 'scripts', 'payload.sh'), 'echo secret\n', 'utf8')

    // Pre-create shared target dir (without SKILL.md) containing a dangling leaf symlink pointing outside skills root
    const outsideDir = mkdtempSync(join(tmpdir(), 'oc-outside-escape-'))
    const outsideTarget = join(outsideDir, 'escaped.sh')
    const sharedDir = join(testHome, 'skills')
    const poisonedDir = join(sharedDir, 'symlink-guard-skill', 'scripts')
    mkdirSync(poisonedDir, { recursive: true })
    symlinkSync(outsideTarget, join(poisonedDir, 'payload.sh'))

    try {
      const store = new SkillStore('main', { sharedDir, aggregateLegacy: true })
      const res = await store.save(
        { name: 'symlink-guard-skill', description: 'Attempted promotion' },
        '# Should fail',
      )
      assert.equal(res.ok, false, 'save must fail when destination leaf is a dangling symlink')
      assert.match(res.error ?? '', /symlink/i)
      assert.equal(existsSync(outsideTarget), false, 'must NEVER create file outside skills root via dangling symlink')
      assert.equal(
        existsSync(join(sharedDir, 'symlink-guard-skill', 'SKILL.md')),
        false,
        'must NOT publish SKILL.md when asset preservation fails',
      )
      const legacyStillVisible = (await store.view('symlink-guard-skill')) as { version?: string; body?: string }
      assert.equal(legacyStillVisible.version, '1.0.2', 'original legacy skill must remain visible')
      assert.ok(legacyStillVisible.body?.includes('Legacy safe body'))
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('fails closed when legacy skill exceeds 250-file limit and keeps old skill visible (OCV5-865 #2)', async () => {
    const legacySkillDir = join(paths.agentSkillsDir('research-assistant'), 'overlimit-skill')
    mkdirSync(join(legacySkillDir, 'data'), { recursive: true })
    writeFileSync(
      join(legacySkillDir, 'SKILL.md'),
      '---\nname: overlimit-skill\ndescription: "251 assets"\nversion: 1.0.0\n---\n\n# Legacy 251 body\n',
      'utf8',
    )
    for (let i = 0; i < 251; i++) {
      writeFileSync(join(legacySkillDir, 'data', `f-${String(i).padStart(3, '0')}.txt`), `v${i}\n`, 'utf8')
    }

    const sharedDir = join(testHome, 'skills')
    const store = new SkillStore('main', { sharedDir, aggregateLegacy: true })
    const res = await store.save(
      { name: 'overlimit-skill', description: 'Should fail overlimit' },
      '# Should not publish truncated skill',
    )
    assert.equal(res.ok, false, '251 files must fail save instead of silently truncating at 250')
    assert.match(res.error ?? '', /exceeds limit/i)
    assert.equal(
      existsSync(join(sharedDir, 'overlimit-skill', 'SKILL.md')),
      false,
      'truncated skill must NOT be published into shared',
    )
    const view = (await store.view('overlimit-skill')) as { version?: string; body?: string }
    assert.equal(view.version, '1.0.0')
    assert.ok(view.body?.includes('Legacy 251 body'))
  })

  it('serializes concurrent saves on the same skill with contiguous versions and full history (OCV5-865 #3)', async () => {
    const sharedDir = join(testHome, 'skills')
    const storeA = new SkillStore('main', { sharedDir, aggregateLegacy: true })
    const storeB = new SkillStore('main', { sharedDir, aggregateLegacy: true })

    await storeA.save({ name: 'concurrent-skill', description: 'v1.0.1', version: '1.0.1' }, '# Base v1.0.1')

    const [r1, r2] = await Promise.all([
      storeA.save({ name: 'concurrent-skill', description: 'Concurrent A' }, '# Body Alpha'),
      storeB.save({ name: 'concurrent-skill', description: 'Concurrent B' }, '# Body Beta'),
    ])
    assert.equal(r1.ok, true, r1.error)
    assert.equal(r2.ok, true, r2.error)
    const versions = [r1.version, r2.version].sort()
    assert.deepEqual(versions, ['1.0.2', '1.0.3'], 'concurrent saves must produce contiguous distinct versions')

    const history101 = readFileSync(join(sharedDir, 'concurrent-skill', 'history', '1.0.1.md'), 'utf8')
    const history102 = readFileSync(join(sharedDir, 'concurrent-skill', 'history', '1.0.2.md'), 'utf8')
    const latest = readFileSync(join(sharedDir, 'concurrent-skill', 'SKILL.md'), 'utf8')
    assert.ok(history101.includes('# Base v1.0.1'))
    const bodies = [history102, latest]
    assert.ok(bodies.some((b) => b.includes('# Body Alpha')), 'Body Alpha must be preserved in history or latest')
    assert.ok(bodies.some((b) => b.includes('# Body Beta')), 'Body Beta must be preserved in history or latest')
  })
})
