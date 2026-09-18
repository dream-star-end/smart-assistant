/**
 * A4 layer-2 identity-compat asset resolver tests.
 *
 * Real temp OPENCLAUDE_HOME fixtures (agents.yaml + openclaude.json + real
 * files/symlinks); no business data, no writes outside the temp home, memory
 * contents are never read.
 *
 * Run:
 *   npx tsx --test --test-force-exit packages/storage/src/__tests__/identityCompatAssets.test.ts
 */
import * as assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-idassets-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
delete process.env.OPENCLAUDE_BASELINE_SKILLS_DIR

const { resolveIdentityCompatAssets, isIdentityAssetsError, IDENTITY_COMPAT_SOUL_START, IDENTITY_COMPAT_SOUL_END } =
  await import('../identityCompatAssets.js')

const PROFILE = {
  profileId: 'uid3-butler-unification',
  legacyAgentId: 'butler',
  canonicalAgentId: 'personal-butler',
  localPersonaPath: 'agents/butler/CLAUDE.md',
  localSkillStorageId: 'butler',
} as const

const MANUAL_TEXT = '# Butler manual\n\n历史运行手册:绿级 chore 可自动批准;agentId=butler。\n'
const MARKET_TEXT = '# Personal butler (market baseline)\n\n不要自动批准任何操作。\n'

interface SeedOpts {
  /** undefined = site default 'bypassPermissions' (explicit on the legacy entry); null = omit. */
  legacyPermissionMode?: string | null
  canonicalPermissionMode?: string
  defaultsPermissionMode?: string
  legacyPersona?: string
  canonicalPersona?: string
  omitCanonicalEntry?: boolean
  manualText?: string
  noDefaultsKey?: boolean
}

function seedHome(opts: SeedOpts = {}): void {
  rmSync(join(TEST_HOME, 'agents'), { recursive: true, force: true })
  rmSync(join(TEST_HOME, 'agents.yaml'), { force: true })
  rmSync(join(TEST_HOME, 'openclaude.json'), { force: true })

  mkdirSync(join(TEST_HOME, 'agents/main/memory'), { recursive: true })
  writeFileSync(join(TEST_HOME, 'agents/main/MEMORY.md'), '# main index\n')

  mkdirSync(join(TEST_HOME, 'agents/butler'), { recursive: true })
  writeFileSync(join(TEST_HOME, 'agents/butler/CLAUDE.md'), opts.manualText ?? MANUAL_TEXT)
  mkdirSync(join(TEST_HOME, 'agents/personal-butler'), { recursive: true })
  writeFileSync(join(TEST_HOME, 'agents/personal-butler/CLAUDE.md'), MARKET_TEXT)
  symlinkSync('../main/memory', join(TEST_HOME, 'agents/butler/memory'))
  symlinkSync('../main/memory', join(TEST_HOME, 'agents/personal-butler/memory'))
  symlinkSync('../main/MEMORY.md', join(TEST_HOME, 'agents/butler/MEMORY.md'))
  symlinkSync('../main/MEMORY.md', join(TEST_HOME, 'agents/personal-butler/MEMORY.md'))

  const legacyMode =
    opts.legacyPermissionMode === undefined ? 'bypassPermissions' : opts.legacyPermissionMode
  const entries = [
    '  - id: butler',
    `    persona: ${opts.legacyPersona ?? 'agents/butler/CLAUDE.md'}`,
    ...(legacyMode ? [`    permissionMode: ${legacyMode}`] : []),
    ...(opts.omitCanonicalEntry
      ? []
      : [
          '  - id: personal-butler',
          ...(opts.canonicalPersona ? [`    persona: ${opts.canonicalPersona}`] : []),
          ...(opts.canonicalPermissionMode
            ? [`    permissionMode: ${opts.canonicalPermissionMode}`]
            : []),
        ]),
    '  - id: main',
  ]
  writeFileSync(
    join(TEST_HOME, 'agents.yaml'),
    `agents:\n${entries.join('\n')}\nroutes: []\ndefault: main\n`,
  )
  const defaults: Record<string, unknown> = { model: 'm' }
  if (!opts.noDefaultsKey) defaults.permissionMode = opts.defaultsPermissionMode ?? 'bypassPermissions'
  writeFileSync(
    join(TEST_HOME, 'openclaude.json'),
    JSON.stringify({
      defaults,
      channels: { webchat: { enabled: true } },
      auth: { mode: 'subscription', claudeCodePath: '/x' },
    }),
  )
}

function expectConflict(promise: Promise<unknown>, code: string, needle?: string): Promise<void> {
  return promise.then(
    () => assert.fail(`expected ${code}`),
    (err: unknown) => {
      assert.ok(isIdentityAssetsError(err), `expected IdentityAssetsError, got ${String(err)}`)
      assert.equal(err.code, code)
      if (needle) assert.ok(err.message.includes(needle), err.message)
    },
  )
}

describe('resolveIdentityCompatAssets', () => {
  beforeEach(() => seedHome())

  it('rejects an unreadable defaults authority rather than treating both permissions as absent', async () => {
    seedHome({ legacyPermissionMode: null })
    writeFileSync(join(TEST_HOME, 'openclaude.json'), '{broken')
    await expectConflict(resolveIdentityCompatAssets({ profile: PROFILE }), 'COMPAT_CONFIG_CONFLICT')
  })

  it('requires both the Core directory and its index to remain the same existing store', async () => {
    rmSync(join(TEST_HOME, 'agents/personal-butler/MEMORY.md'))
    writeFileSync(join(TEST_HOME, 'agents/personal-butler/MEMORY.md'), '# split index')
    await expectConflict(resolveIdentityCompatAssets({ profile: PROFILE }), 'COMPAT_CONFIG_CONFLICT')
  })

  it('resolves the registered assets with equal effective permissionMode (site shape)', async () => {
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    assert.equal(assets.profile, PROFILE)
    assert.equal(assets.effectivePermissionMode, 'bypassPermissions') // legacy explicit + defaults, canonical inherits
    assert.equal(assets.localManualPath, join(TEST_HOME, 'agents/butler/CLAUDE.md'))
    assert.equal(assets.canonicalPersonaPath, join(TEST_HOME, 'agents/personal-butler/CLAUDE.md'))
  })

  it('resolves when both sides fall back to the engine default (no explicit values anywhere)', async () => {
    seedHome({ legacyPermissionMode: null, noDefaultsKey: true })
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    assert.equal(assets.effectivePermissionMode, undefined)
  })

  it('assembles the three-segment SOUL from verbatim sources with fixed conflict priorities', async () => {
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    const soul = assets.buildSoul()
    assert.ok(soul.content.startsWith('# WHO I AM (Agent Persona)\n'))
    assert.ok(soul.content.includes(IDENTITY_COMPAT_SOUL_START))
    assert.ok(soul.content.includes(IDENTITY_COMPAT_SOUL_END))
    assert.ok(soul.content.includes(MARKET_TEXT.trim()))
    assert.ok(soul.content.includes(MANUAL_TEXT.trim()))
    assert.ok(soul.content.includes("canonical `personal-butler`"))
    assert.ok(soul.content.includes('没有用户明确批准,不自动 approve'))
    assert.ok(soul.content.includes('按黄级处理'))
    assert.ok(soul.content.includes('不扩大模型、toolset 或 capability 授权'))
    assert.equal(soul.segments.localManual, MANUAL_TEXT.trim())
    assert.equal(soul.segments.marketPersona, MARKET_TEXT.trim())
    assert.match(soul.localManualSha256, /^[0-9a-f]{64}$/)
    assert.match(soul.canonicalPersonaSha256, /^[0-9a-f]{64}$/)
  })

  it('produces identical SOUL bytes for both request entries sharing the profile', async () => {
    const a = await resolveIdentityCompatAssets({ profile: PROFILE })
    const b = await resolveIdentityCompatAssets({ profile: PROFILE })
    assert.equal(a.buildSoul().content, b.buildSoul().content)
  })

  it('reads the local manual FRESH per build (edit applies next build; market file untouched)', async () => {
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    const first = assets.buildSoul()
    const updatedManual = '# Butler manual v2\n\n编辑后的手册内容。\n'
    writeFileSync(join(TEST_HOME, 'agents/butler/CLAUDE.md'), updatedManual)
    const second = assets.buildSoul()
    assert.notEqual(second.localManualSha256, first.localManualSha256)
    assert.ok(second.content.includes('编辑后的手册内容'))
    assert.equal(second.canonicalPersonaSha256, first.canonicalPersonaSha256)
    assert.equal(readFileSync(join(TEST_HOME, 'agents/personal-butler/CLAUDE.md'), 'utf-8'), MARKET_TEXT)
  })

  it('throws COMPAT_PERMISSION_CONFLICT when effective permission modes differ', async () => {
    seedHome({ canonicalPermissionMode: 'plan' }) // legacy=bypass(explicit), canonical=plan → differ
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_PERMISSION_CONFLICT',
      "bypassPermissions",
    )
  })

  it('throws COMPAT_PERMISSION_CONFLICT when only defaults disagree with the legacy explicit value', async () => {
    seedHome({ defaultsPermissionMode: 'default' }) // legacy=bypass(explicit) vs canonical=default(inherited)
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_PERMISSION_CONFLICT',
      'bypassPermissions',
    )
  })

  it('rejects an unregistered SOUL.md on either side (config conflict, never silent overlay)', async () => {
    writeFileSync(join(TEST_HOME, 'agents/personal-butler/SOUL.md'), '# rogue\n')
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      'SOUL.md',
    )
    rmSync(join(TEST_HOME, 'agents/personal-butler/SOUL.md'))
    writeFileSync(join(TEST_HOME, 'agents/butler/SOUL.md'), '# rogue legacy\n')
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      'SOUL.md',
    )
  })

  it('rejects Core memory divergence (different realpath / one-sided) without migrating', async () => {
    rmSync(join(TEST_HOME, 'agents/personal-butler/memory'))
    mkdirSync(join(TEST_HOME, 'agents/personal-butler/memory'), { recursive: true })
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      'realpath',
    )
    rmSync(join(TEST_HOME, 'agents/personal-butler/memory'), { recursive: true, force: true })
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      '(missing)',
    )
  })

  it('rejects persona registration drift between agents.yaml and the profile', async () => {
    seedHome({ legacyPersona: 'agents/butler/OTHER.md' }) // file does not exist
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      'does not resolve',
    )
    writeFileSync(join(TEST_HOME, 'agents/butler/OTHER.md'), '# other\n')
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      'registration and on-disk config disagree',
    )
  })

  it('rejects a missing registered manual file', async () => {
    rmSync(join(TEST_HOME, 'agents/butler/CLAUDE.md'))
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      'not an existing regular file',
    )
  })

  it('rejects a missing canonical agents.yaml entry', async () => {
    seedHome({ omitCanonicalEntry: true })
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      'personal-butler',
    )
  })

  it('rejects canonical persona and local manual being the same file', async () => {
    seedHome({ canonicalPersona: 'agents/butler/CLAUDE.md' })
    await expectConflict(
      resolveIdentityCompatAssets({ profile: PROFILE }),
      'COMPAT_CONFIG_CONFLICT',
      'two independent sources',
    )
  })

  it('buildSoul fails closed when the manual disappears or a SOUL appears after resolution', async () => {
    const assets = await resolveIdentityCompatAssets({ profile: PROFILE })
    rmSync(join(TEST_HOME, 'agents/butler/CLAUDE.md'))
    assert.throws(() => assets.buildSoul(), (err: unknown) => isIdentityAssetsError(err))
    writeFileSync(join(TEST_HOME, 'agents/butler/CLAUDE.md'), MANUAL_TEXT)
    writeFileSync(join(TEST_HOME, 'agents/personal-butler/SOUL.md'), '# planted later\n')
    assert.throws(
      () => assets.buildSoul(),
      (err: unknown) => isIdentityAssetsError(err) && err.code === 'COMPAT_CONFIG_CONFLICT',
    )
  })
})
