/**
 * A4 layer-2 promptSlots identity-compat tests (real temp OPENCLAUDE_HOME).
 *
 * Covers: the compat branch assembles the SAME segmented SOUL for both request
 * entries (profile decides, not requestedId/persona); default paths stay
 * byte-identical when the explicit param is absent; unregistered SOULs cannot
 * preempt (fail-closed); local-manual edits apply on the next build while the
 * market file stays untouched; the SKILLS slot consumes the compat store.
 *
 * Run:
 *   npx tsx --test --test-force-exit packages/gateway/src/__tests__/promptSlotsIdentityCompat.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-idcompat-slot-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
delete process.env.OPENCLAUDE_BASELINE_SKILLS_DIR

const { buildSoulSlot, buildSkillsSlot } = await import('../promptSlots.js')
const { resolveIdentityCompatAssets, isIdentityAssetsError } = await import('@openclaude/storage')
const { paths } = await import('@openclaude/storage')

const PROFILE = {
  profileId: 'uid3-butler-unification',
  legacyAgentId: 'butler',
  canonicalAgentId: 'personal-butler',
  localPersonaPath: 'agents/butler/CLAUDE.md',
  localSkillStorageId: 'butler',
} as const

const MANUAL_TEXT = '# Butler manual\n\n历史运行手册正文 UNIQUE-MANUAL-TOKEN。\n'
const MARKET_TEXT = '# Personal butler (market)\n\n市场底线正文 UNIQUE-MARKET-TOKEN。\n'

function seedBase(): void {
  rmSync(join(TEST_HOME, 'agents'), { recursive: true, force: true })
  rmSync(join(TEST_HOME, 'skills'), { recursive: true, force: true })
  rmSync(join(TEST_HOME, 'hub'), { recursive: true, force: true })
  rmSync(join(TEST_HOME, 'agents.yaml'), { force: true })
  rmSync(join(TEST_HOME, 'openclaude.json'), { force: true })

  mkdirSync(join(TEST_HOME, 'agents/main/memory'), { recursive: true })
  writeFileSync(join(TEST_HOME, 'agents/main/MEMORY.md'), '# main\n')
  mkdirSync(join(TEST_HOME, 'agents/butler'), { recursive: true })
  writeFileSync(join(TEST_HOME, 'agents/butler/CLAUDE.md'), MANUAL_TEXT)
  mkdirSync(join(TEST_HOME, 'agents/personal-butler'), { recursive: true })
  writeFileSync(join(TEST_HOME, 'agents/personal-butler/CLAUDE.md'), MARKET_TEXT)
  symlinkSync('../main/memory', join(TEST_HOME, 'agents/butler/memory'))
  symlinkSync('../main/memory', join(TEST_HOME, 'agents/personal-butler/memory'))
  symlinkSync('../main/MEMORY.md', join(TEST_HOME, 'agents/butler/MEMORY.md'))
  symlinkSync('../main/MEMORY.md', join(TEST_HOME, 'agents/personal-butler/MEMORY.md'))
  writeFileSync(
    join(TEST_HOME, 'agents.yaml'),
    [
      'agents:',
      '  - id: butler',
      '    persona: agents/butler/CLAUDE.md',
      '    permissionMode: bypassPermissions',
      '  - id: personal-butler',
      '  - id: main',
      'routes: []',
      'default: main',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(TEST_HOME, 'openclaude.json'),
    JSON.stringify({
      defaults: { model: 'm', permissionMode: 'bypassPermissions' },
      channels: { webchat: { enabled: true } },
      auth: { mode: 'subscription', claudeCodePath: '/x' },
    }),
  )
}

function seedLegacyPrivateSkill(): void {
  const dir = join(paths.agentSkillsDir('butler'), 'readonly-disk-audit-evidence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: readonly-disk-audit-evidence\ndescription: disk audit evidence\n---\n\nbody\n',
  )
}

const manualPath = join(TEST_HOME, 'agents/butler/CLAUDE.md')
const canonicalPersonaPath = join(TEST_HOME, 'agents/personal-butler/CLAUDE.md')

describe('promptSlots identity-compat', () => {
  it('DEFAULT PATH UNCHANGED: single-source persona per entry (the A4 defect, documented)', () => {
    seedBase()
    // Legacy-keyed entry passes the old manual as ctx.persona → market persona dropped.
    const legacyEntry = buildSoulSlot({ agentId: 'personal-butler', persona: manualPath })
    assert.ok(legacyEntry)
    assert.ok(legacyEntry.content.includes('UNIQUE-MANUAL-TOKEN'))
    assert.equal(legacyEntry.content.includes('UNIQUE-MARKET-TOKEN'), false)
    // Canonical entry passes the market persona → local manual dropped.
    const canonicalEntry = buildSoulSlot({ agentId: 'personal-butler', persona: canonicalPersonaPath })
    assert.ok(canonicalEntry)
    assert.ok(canonicalEntry.content.includes('UNIQUE-MARKET-TOKEN'))
    assert.equal(canonicalEntry.content.includes('UNIQUE-MANUAL-TOKEN'), false)
  })

  it('COMPAT: both request entries assemble the IDENTICAL segmented SOUL', async () => {
    seedBase()
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    // Entry A (was legacy-keyed: transport kept the old persona field) and entry B
    // (canonical) share the resolved assets → same bytes; persona fields ignored.
    const a = buildSoulSlot({ agentId: 'personal-butler', persona: manualPath, identityCompat: assets })
    const b = buildSoulSlot({ agentId: 'personal-butler', persona: canonicalPersonaPath, identityCompat: assets })
    assert.ok(a && b)
    assert.equal(a.content, b.content)
    assert.ok(a.content.includes('UNIQUE-MANUAL-TOKEN'))
    assert.ok(a.content.includes('UNIQUE-MARKET-TOKEN'))
    assert.ok(a.content.includes('oc-identity-compat:start'))
    assert.ok(a.content.includes('真实执行 Agent 是 canonical `personal-butler`'))
    assert.ok(a.content.includes('没有用户明确批准,不自动 approve'))
  })

  it('COMPAT: wiring mistake (agentId ≠ canonical) throws instead of overlaying', async () => {
    seedBase()
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    assert.throws(
      () => buildSoulSlot({ agentId: 'butler', identityCompat: assets }),
      (err: unknown) => isIdentityAssetsError(err),
    )
  })

  it('COMPAT: an unregistered SOUL cannot preempt — resolver and fresh build both fail closed', async () => {
    seedBase()
    writeFileSync(join(TEST_HOME, 'agents/personal-butler/SOUL.md'), '# planted\n')
    await assert.rejects(
      () => resolveIdentityCompatAssets({ profile: PROFILE }),
      (err: unknown) => isIdentityAssetsError(err),
    )
    rmSync(join(TEST_HOME, 'agents/personal-butler/SOUL.md'))
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    writeFileSync(join(TEST_HOME, 'agents/butler/SOUL.md'), '# planted later\n')
    assert.throws(
      () => buildSoulSlot({ agentId: 'personal-butler', identityCompat: assets }),
      (err: unknown) => isIdentityAssetsError(err),
    )
  })

  it('COMPAT: local manual edit applies on the NEXT build; market file untouched', async () => {
    seedBase()
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    const first = buildSoulSlot({ agentId: 'personal-butler', identityCompat: assets })
    assert.ok(first)
    writeFileSync(manualPath, '# Butler manual v2\n\nEDITED-MANUAL-TOKEN\n')
    const second = buildSoulSlot({ agentId: 'personal-butler', identityCompat: assets })
    assert.ok(second)
    assert.ok(second.content.includes('EDITED-MANUAL-TOKEN'))
    assert.equal(second.content.includes('UNIQUE-MANUAL-TOKEN'), false)
    assert.equal(readFileSync(canonicalPersonaPath, 'utf-8'), MARKET_TEXT)
  })

  it('SKILLS slot: compat store surfaces the legacy private skill; absent param stays unchanged', async () => {
    seedBase()
    seedLegacyPrivateSkill()
    const plain = await buildSkillsSlot({ agentId: 'personal-butler' })
    if (plain) {
      assert.equal(plain.content.includes('readonly-disk-audit-evidence'), false)
    }
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    const compat = await buildSkillsSlot({ agentId: 'personal-butler', identityCompat: assets })
    assert.ok(compat, 'with a visible skill the slot must exist')
    assert.ok(compat.content.includes('readonly-disk-audit-evidence'))
  })

  it('SKILLS slot: compat skill conflicts propagate (fail-closed, not swallowed)', async () => {
    seedBase()
    seedLegacyPrivateSkill()
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    const canonicalDir = join(paths.agentSkillsDir('personal-butler'), 'readonly-disk-audit-evidence')
    mkdirSync(canonicalDir, { recursive: true })
    writeFileSync(
      join(canonicalDir, 'SKILL.md'),
      '---\nname: readonly-disk-audit-evidence\ndescription: divergent canonical copy\n---\n\nother\n',
    )
    await assert.rejects(
      () => buildSkillsSlot({ agentId: 'personal-butler', identityCompat: assets }),
      (err: unknown) => isIdentityAssetsError(err),
    )
  })
})
