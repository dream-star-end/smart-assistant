/**
 * A4 layer-2 compat SkillStore tests (real temp OPENCLAUDE_HOME fixtures).
 *
 * Covers: private read/write target = the registered legacy namespace only;
 * shared-scope equivalence for THIS registered pair (hub stays canonical);
 * same-name canonical-private conflicts fail closed; constructor guards;
 * builders pass compat through without swallowing conflicts or falling back
 * to a second write source; plain (non-compat) agents byte-identical.
 *
 * Run:
 *   npx tsx --test --test-force-exit packages/storage/src/__tests__/skillStoreCompat.test.ts
 */
import * as assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-skillcompat-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
delete process.env.OPENCLAUDE_BASELINE_SKILLS_DIR

import type { SkillStore, SkillMetadata } from '../skillStore.js'

const { paths } = await import('../paths.js')
const { SkillStore: SkillStoreCtor, buildAgentSkillStore, buildRunSkillStore } = await import('../skillStore.js')
const { isIdentityAssetsError } = await import('../identityCompatAssets.js')

const PROFILE = {
  profileId: 'uid3-butler-unification',
  legacyAgentId: 'butler',
  canonicalAgentId: 'personal-butler',
  localPersonaPath: 'agents/butler/CLAUDE.md',
  localSkillStorageId: 'butler',
} as const

const LEGACY_PRIVATE = 'readonly-disk-audit-evidence'

function writeSkill(
  root: string,
  name: string,
  body: string,
  opts?: { scope?: string[] },
): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
  )
  if (opts?.scope) {
    writeFileSync(
      join(root, name, '.openclaude-agent-scope.json'),
      `${JSON.stringify({ agentIds: opts.scope }, null, 2)}\n`,
    )
  }
}

function compatStore(): SkillStore {
  return new SkillStoreCtor('personal-butler', {
    sharedDir: paths.sharedSkillsDir,
    sharedWritable: false,
    hubDir: join(paths.hubDir, 'skills'),
    compat: { profile: PROFILE },
  })
}

describe('SkillStore compat assets', () => {
  beforeEach(() => {
    rmSync(join(TEST_HOME, 'agents'), { recursive: true, force: true })
    rmSync(join(TEST_HOME, 'skills'), { recursive: true, force: true })
    rmSync(join(TEST_HOME, 'hub'), { recursive: true, force: true })
    // legacy private skill (the real site asset)
    writeSkill(paths.agentSkillsDir(PROFILE.legacyAgentId), LEGACY_PRIVATE, 'disk audit evidence body')
    // shared skill assigned to the LEGACY id only
    writeSkill(paths.sharedSkillsDir, 'shared-old', 'shared body', { scope: ['butler'] })
    // hub (marketplace) skills: one legacy-authorized, one canonical-authorized
    writeSkill(join(paths.hubDir, 'skills'), 'hub-legacy-only', 'hub body', { scope: ['butler'] })
    writeSkill(join(paths.hubDir, 'skills'), 'hub-canonical', 'hub body', {
      scope: ['personal-butler'],
    })
  })

  it('reads legacy private + shared(old scope) + canonical-authorized hub through the compat store', async () => {
    const store = compatStore()
    const list = await store.list()
    const byName = new Map<string, SkillMetadata>(list.map((s) => [s.name, s] as const))
    const legacy = byName.get(LEGACY_PRIVATE)
    assert.ok(legacy, 'legacy private skill must be visible')
    assert.equal(legacy.layer, 'legacy')
    assert.equal(legacy.writable, true, 'the registered dir is the write target → editable')
    assert.deepEqual(legacy.agentIds, ['butler'])
    assert.equal(legacy.path, join(paths.agentSkillsDir('butler'), LEGACY_PRIVATE))
    assert.ok(byName.get('shared-old'), 'shared skill assigned to the legacy id stays visible (registered-pair equivalence)')
    assert.equal(byName.get('shared-old')?.layer, 'shared')
    assert.ok(byName.get('hub-canonical'), 'hub skill authorized for canonical stays visible')
    assert.equal(byName.get('hub-legacy-only'), undefined, 'hub is NOT widened by the asset alias (market readiness canonical-only)')
  })

  it('plain canonical store (no compat) is unchanged: no legacy private, no legacy-scoped shared/hub', async () => {
    const store = new SkillStoreCtor('personal-butler', {
      sharedDir: paths.sharedSkillsDir,
      sharedWritable: false,
      hubDir: join(paths.hubDir, 'skills'),
    })
    const names = (await store.list()).map((s) => s.name)
    assert.equal(names.includes(LEGACY_PRIVATE), false)
    assert.equal(names.includes('shared-old'), false)
    assert.equal(names.includes('hub-legacy-only'), false)
  })

  it('plain legacy-id store (no compat) still sees its own private skills (pre-A4 behavior)', async () => {
    const store = new SkillStoreCtor('butler', {
      sharedDir: paths.sharedSkillsDir,
      sharedWritable: false,
      hubDir: join(paths.hubDir, 'skills'),
    })
    const names = (await store.list()).map((s) => s.name)
    assert.ok(names.includes(LEGACY_PRIVATE))
  })

  it('view() serves the legacy private skill from the registered dir only', async () => {
    const store = compatStore()
    const content = await store.view(LEGACY_PRIVATE)
    assert.ok(content && typeof content !== 'string')
    assert.ok((content as { body: string }).body.includes('disk audit evidence body'))
    assert.equal((content as { path: string }).path, join(paths.agentSkillsDir('butler'), LEGACY_PRIVATE))
  })

  it('save() writes ONLY into the registered legacy dir — the canonical dir is never a second write source', async () => {
    const store = compatStore()
    const res = await store.save({ name: 'new-butler-skill', description: 'fresh' }, 'fresh body')
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.ok(existsSync(join(paths.agentSkillsDir('butler'), 'new-butler-skill', 'SKILL.md')))
    assert.equal(existsSync(paths.agentSkillsDir('personal-butler')), false)

    const upd = await store.save({ name: LEGACY_PRIVATE, description: 'updated' }, 'updated body')
    assert.equal(upd.ok, true, JSON.stringify(upd))
    const after = (await store.view(LEGACY_PRIVATE)) as { body: string }
    assert.ok(after.body.includes('updated body'))
    assert.equal(existsSync(paths.agentSkillsDir('personal-butler')), false)
  })

  it('same-named canonical private skill fails closed everywhere (list/view/save/delete)', async () => {
    writeSkill(paths.agentSkillsDir('personal-butler'), LEGACY_PRIVATE, 'a DIFFERENT canonical copy')
    const store = compatStore()
    const conflictOn = (err: unknown): boolean =>
      isIdentityAssetsError(err) && err.code === 'COMPAT_SKILL_CONFLICT'
    await assert.rejects(() => store.list(), conflictOn, 'list must reject')
    await assert.rejects(() => store.view(LEGACY_PRIVATE), conflictOn, 'view must reject')
    const saveRes = await store.save({ name: LEGACY_PRIVATE, description: 'x' }, 'y')
    assert.equal(saveRes.ok, false)
    assert.ok(saveRes.error?.includes(LEGACY_PRIVATE), saveRes.error)
    await assert.rejects(() => store.delete(LEGACY_PRIVATE), conflictOn, 'delete must reject')
  })

  it('constructor guards: legacy execution id / default aggregator / shared write / aggregate mode', () => {
    assert.throws(
      () =>
        new SkillStoreCtor('butler', {
          sharedDir: paths.sharedSkillsDir,
          sharedWritable: false,
          hubDir: join(paths.hubDir, 'skills'),
          compat: { profile: PROFILE },
        }),
      (err: unknown) => isIdentityAssetsError(err) && err.code === 'COMPAT_CONFIG_CONFLICT',
    )
    assert.throws(
      () => buildAgentSkillStore('main', { profile: PROFILE }),
      (err: unknown) => isIdentityAssetsError(err) && err.code === 'COMPAT_CONFIG_CONFLICT',
    )
    assert.throws(
      () =>
        new SkillStoreCtor('personal-butler', {
          sharedDir: paths.sharedSkillsDir,
          hubDir: join(paths.hubDir, 'skills'),
          compat: { profile: PROFILE },
        }), // sharedWritable defaults true → write target would be shared
      (err: unknown) => isIdentityAssetsError(err) && err.code === 'COMPAT_CONFIG_CONFLICT',
    )
    assert.throws(
      () =>
        new SkillStoreCtor('personal-butler', {
          sharedDir: paths.sharedSkillsDir,
          sharedWritable: false,
          aggregateLegacy: true,
          hubDir: join(paths.hubDir, 'skills'),
          compat: { profile: PROFILE },
        }),
      (err: unknown) => isIdentityAssetsError(err) && err.code === 'COMPAT_CONFIG_CONFLICT',
    )
  })

  it('builders propagate compat config conflicts instead of swallowing them into a fallback store', () => {
    assert.throws(
      () => buildAgentSkillStore('butler', { profile: PROFILE }),
      (err: unknown) => isIdentityAssetsError(err),
    )
    assert.throws(
      () => buildRunSkillStore({ agentId: 'butler', projectId: 'proj-1', compat: { profile: PROFILE } }),
      (err: unknown) => isIdentityAssetsError(err),
    )
  })

  it('builder drops an invalid baseline dir but KEEPS compat (fallback must not change the write target)', async () => {
    const notADir = join(TEST_HOME, 'baseline-is-a-file')
    writeFileSync(notADir, 'not a dir')
    process.env.OPENCLAUDE_BASELINE_SKILLS_DIR = notADir
    try {
      const store = buildAgentSkillStore('personal-butler', { profile: PROFILE })
      const names = (await store.list()).map((s) => s.name)
      assert.ok(names.includes(LEGACY_PRIVATE), 'compat wiring survives the baseline fallback')
      const res = await store.save({ name: 'fallback-check', description: 'd' }, 'b')
      assert.equal(res.ok, true, JSON.stringify(res))
      assert.ok(existsSync(join(paths.agentSkillsDir('butler'), 'fallback-check', 'SKILL.md')))
      assert.equal(existsSync(paths.agentSkillsDir('personal-butler')), false)
    } finally {
      delete process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
    }
  })

  it('buildRunSkillStore keeps compat with a project overlay', async () => {
    const store = buildRunSkillStore({
      agentId: 'personal-butler',
      projectId: 'proj-1',
      compat: { profile: PROFILE },
    })
    const names = (await store.list()).map((s) => s.name)
    assert.ok(names.includes(LEGACY_PRIVATE))
    assert.ok(names.includes('shared-old'))
  })
})
