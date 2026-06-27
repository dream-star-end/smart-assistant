/**
 * Integration: skill marketplace data layer on real Postgres (migration 0087).
 *
 * Locks the security invariants the design depends on (and Codex flagged):
 *   1. publish creates an owner-locked listing + a pending version
 *   2. slug is owner-locked: a 2nd publisher of the same slug is refused
 *   3. duplicate (slug, version) is refused
 *   4. reviewer must differ from submitter
 *   5. approve flips status + sets the listing's current_approved_version_id;
 *      it then appears in the searchable catalog; reject does not
 *   6. install pins (version_id, artifact_hash) and supersedes the prior active row
 *   7. installing a non-current / revoked version → NOT_INSTALLABLE (TOCTOU-safe)
 *   8. revoke is a kill-switch: listActiveInstalledArtifacts drops the skill
 *   9. a pinned-hash vs version-content divergence is excluded from the sync feed
 *  10. uninstall soft-deletes the active row
 *
 * PG-only (no Redis). Skips when no test DB is reachable unless REQUIRE_TEST_DB=1.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { marketplaceArtifactHash, skillContentHash } from '@openclaude/storage'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import {
  MarketplaceError,
  getListingDetail,
  installApprovedVersion,
  listActiveInstalledArtifacts,
  listApprovedForSearch,
  listInstalled,
  listPendingVersions,
  publishSkillVersion,
  recordUninstall,
  reviewVersion,
  revokeListing,
} from '../marketplace/marketplaceDb.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

// Throwaway test DB: nuke the whole schema and let runMigrations rebuild it from
// scratch (a fixed DROP-TABLE subset leaves other migrated tables behind and the
// next run's migrations fail with "relation already exists").
async function resetSchema(): Promise<void> {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
}

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* ignore */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required (REQUIRE_TEST_DB=1)')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await resetSchema()
  await runMigrations()
})

after(async () => {
  if (pgAvailable) {
    try {
      await resetSchema()
    } catch {
      /* ignore */
    }
    await closePool()
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE marketplace_installs, marketplace_skill_versions, marketplace_skill_listings, admin_audit, users RESTART IDENTITY CASCADE',
  )
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

async function createUser(email: string): Promise<number> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role) VALUES ($1, 'argon2$stub', 0, 'user') RETURNING id::text AS id",
    [email],
  )
  return Number.parseInt(r.rows[0].id, 10)
}

/** Build a canonical SKILL.md the same way the publish route does (name := slug). */
function buildPublish(slug: string, owner: number, version = '1.0.0', extraBody = '') {
  const name = slug
  const description = `${slug} 描述`
  const tags = ['t1']
  const rawSkillMd = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\ntags: [${tags.join(', ')}]\nversion: ${version}\n---\n\n# ${slug}\n步骤${extraBody}\n`
  return {
    slug,
    ownerUserId: owner,
    version,
    name,
    description,
    tags,
    rawSkillMd,
    artifactHash: marketplaceArtifactHash(rawSkillMd),
    embeddingHash: skillContentHash({ name, description, tags }),
    riskFlags: [],
    policyVersion: 1,
    submittedBy: owner,
  }
}

/** Build an agent artifact (kind='agent', manifest, no SKILL.md) — M2 generalization. */
function buildPublishAgent(slug: string, owner: number, version = '1.0.0') {
  const name = slug
  const description = `${slug} 智能体`
  const tags = ['agent']
  const manifest = {
    model: 'glm-5.2',
    toolsets: ['assistant'],
    skillDeps: [],
    persona: '你是一个测试智能体。',
  }
  const rawArtifact = JSON.stringify(manifest, null, 2)
  return {
    slug,
    ownerUserId: owner,
    version,
    name,
    description,
    tags,
    rawSkillMd: null,
    rawArtifact,
    manifest,
    kind: 'agent' as const,
    artifactHash: marketplaceArtifactHash(rawArtifact),
    embeddingHash: skillContentHash({ name, description, tags }),
    riskFlags: [],
    policyVersion: 1,
    submittedBy: owner,
  }
}

async function expectMarketplaceError(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof MarketplaceError, `expected MarketplaceError, got ${e}`)
    assert.equal(e.code, code)
    return true
  })
}

describe('marketplaceDb (integ)', () => {
  test('publish creates owner-locked listing + pending version', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('pdf-helper', owner))
    assert.ok(versionId)
    const pending = await listPendingVersions()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].slug, 'pdf-helper')
    assert.equal(pending[0].rawArtifact.includes('name: pdf-helper'), true)
    // not yet searchable
    assert.equal((await listApprovedForSearch()).length, 0)
  })

  test('slug is owner-locked: a different user cannot publish the same slug', async (t) => {
    if (skipIfNoPg(t)) return
    const a = await createUser('a@x.com')
    const b = await createUser('b@x.com')
    await publishSkillVersion(buildPublish('dup-slug', a))
    await expectMarketplaceError(
      () => publishSkillVersion(buildPublish('dup-slug', b, '2.0.0')),
      'SLUG_OWNED_BY_OTHER',
    )
  })

  test('duplicate (slug, version) is refused', async (t) => {
    if (skipIfNoPg(t)) return
    const a = await createUser('a@x.com')
    await publishSkillVersion(buildPublish('verdup', a, '1.0.0'))
    await expectMarketplaceError(
      () => publishSkillVersion(buildPublish('verdup', a, '1.0.0')),
      'DUPLICATE_VERSION',
    )
  })

  test('reviewer must differ from submitter', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('self-review', owner))
    await expectMarketplaceError(
      () => reviewVersion({ versionId, reviewerUserId: owner, approve: true }),
      'REVIEWER_IS_AUTHOR',
    )
  })

  test('approve sets current + makes searchable; reject does not', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const ok = await publishSkillVersion(buildPublish('approve-me', owner))
    await reviewVersion({ versionId: ok.versionId, reviewerUserId: admin, approve: true })
    const cat = await listApprovedForSearch()
    assert.equal(cat.length, 1)
    assert.equal(cat[0].slug, 'approve-me')
    const detail = await getListingDetail('approve-me')
    assert.ok(detail)
    assert.equal(detail?.version, '1.0.0')

    const rej = await publishSkillVersion(buildPublish('reject-me', owner))
    await reviewVersion({ versionId: rej.versionId, reviewerUserId: admin, approve: false })
    assert.equal(await getListingDetail('reject-me'), null)
  })

  test('M2: skill defaults kind=skill; detail/search expose kind + raw_artifact', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('m2skill@x.com')
    const admin = await createUser('m2sadmin@x.com')
    const p = await publishSkillVersion(buildPublish('m2-skill', owner))
    await reviewVersion({ versionId: p.versionId, reviewerUserId: admin, approve: true })
    const row = (await listApprovedForSearch()).find((c) => c.slug === 'm2-skill')
    assert.equal(row?.kind, 'skill')
    const detail = await getListingDetail('m2-skill')
    assert.equal(detail?.kind, 'skill')
    // raw_artifact backfilled == the SKILL.md for skills
    assert.ok(detail?.rawArtifact.includes('name: m2-skill'))
    assert.ok(detail?.rawSkillMd?.includes('name: m2-skill'))
    assert.equal(detail?.manifest, null)
  })

  test('M2: agent kind round-trips; kind filter + kind-lock', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('m2agent@x.com')
    const admin = await createUser('m2aadmin@x.com')
    const a = await publishSkillVersion(buildPublishAgent('m2-agent', owner))
    await reviewVersion({ versionId: a.versionId, reviewerUserId: admin, approve: true })

    // kind filter: 'agent' returns the agent and no skills
    const agents = await listApprovedForSearch('agent')
    assert.ok(agents.some((c) => c.slug === 'm2-agent'))
    assert.ok(agents.every((c) => c.kind === 'agent'))
    const skills = await listApprovedForSearch('skill')
    assert.ok(!skills.some((c) => c.slug === 'm2-agent'))

    // agent detail: rawArtifact = manifest text, rawSkillMd null, manifest present
    const detail = await getListingDetail('m2-agent')
    assert.equal(detail?.kind, 'agent')
    assert.equal(detail?.rawSkillMd, null)
    assert.ok(detail?.manifest)

    // slug is kind-locked: cannot republish an agent slug as a skill
    await expectMarketplaceError(
      () => publishSkillVersion(buildPublish('m2-agent', owner, '2.0.0')),
      'KIND_MISMATCH',
    )

    // M2 fail-closed: an approved agent is NOT installable yet (no delivery path
    // until M3) — install must reject it rather than record an undeliverable install.
    const installer = await createUser('m2installer@x.com')
    await expectMarketplaceError(
      () => installApprovedVersion({ userId: installer, versionId: a.versionId }),
      'NOT_INSTALLABLE',
    )
  })

  test('cannot re-review a non-pending version', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('once', owner))
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })
    await expectMarketplaceError(
      () => reviewVersion({ versionId, reviewerUserId: admin, approve: false }),
      'NOT_PENDING',
    )
  })

  test('install pins version+hash and supersedes the prior active row', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const p = buildPublish('inst-skill', owner)
    const { versionId } = await publishSkillVersion(p)
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })

    const r = await installApprovedVersion({ userId: installer, versionId })
    assert.equal(r.slug, 'inst-skill')
    const installed = await listInstalled(installer)
    assert.equal(installed.length, 1)
    assert.equal(installed[0].artifactHash, p.artifactHash)

    // re-install (same version) supersedes — still exactly one active row
    await installApprovedVersion({ userId: installer, versionId })
    assert.equal((await listInstalled(installer)).length, 1)
    const activeRows = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM marketplace_installs WHERE user_id = $1 AND uninstalled_at IS NULL',
      [installer],
    )
    assert.equal(activeRows.rows[0].n, '1')
  })

  test('installing a superseded (non-current) version is refused', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const v1 = await publishSkillVersion(buildPublish('multi-ver', owner, '1.0.0'))
    await reviewVersion({ versionId: v1.versionId, reviewerUserId: admin, approve: true })
    const v2 = await publishSkillVersion(buildPublish('multi-ver', owner, '2.0.0'))
    await reviewVersion({ versionId: v2.versionId, reviewerUserId: admin, approve: true })
    // v1 is no longer the listing's current approved version
    await expectMarketplaceError(
      () => installApprovedVersion({ userId: installer, versionId: v1.versionId }),
      'NOT_INSTALLABLE',
    )
    // v2 (current) installs fine
    const r = await installApprovedVersion({ userId: installer, versionId: v2.versionId })
    assert.equal(r.version, '2.0.0')
  })

  test('revoke is a kill-switch: install drops out of the sync feed', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const p = buildPublish('kill-me', owner)
    const { versionId } = await publishSkillVersion(p)
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })
    await installApprovedVersion({ userId: installer, versionId })
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 1)

    const affected = await revokeListing('kill-me', 'bad skill')
    assert.deepEqual(affected, [installer])
    // kill-switch: revoked listing no longer materializes in the container feed
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 0)
    // and re-install of a revoked listing is refused
    await expectMarketplaceError(
      () => installApprovedVersion({ userId: installer, versionId }),
      'NOT_INSTALLABLE',
    )
  })

  test('pinned-vs-version artifact_hash divergence is excluded from the sync feed', async (t) => {
    if (skipIfNoPg(t)) return
    // This guards the master SQL `i.artifact_hash = v.artifact_hash` join condition:
    // if the version's recorded hash ever diverges from the hash pinned at install,
    // the row is not emitted to the container feed. (Content-vs-hash tampering of
    // raw_skill_md is a separate, container-side defense: marketplaceSync re-hashes
    // the body with marketplaceArtifactHash before writing.)
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const p = buildPublish('tamper', owner)
    const { versionId } = await publishSkillVersion(p)
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })
    await installApprovedVersion({ userId: installer, versionId })
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 1)
    // simulate the version's recorded hash diverging from the install's pinned hash
    await query('UPDATE marketplace_skill_versions SET artifact_hash = $2 WHERE id = $1', [
      versionId,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ])
    assert.equal((await listActiveInstalledArtifacts(installer)).length, 0)
  })

  test('uninstall soft-deletes the active row', async (t) => {
    if (skipIfNoPg(t)) return
    const owner = await createUser('owner@x.com')
    const admin = await createUser('admin@x.com')
    const installer = await createUser('inst@x.com')
    const { versionId } = await publishSkillVersion(buildPublish('removable', owner))
    await reviewVersion({ versionId, reviewerUserId: admin, approve: true })
    await installApprovedVersion({ userId: installer, versionId })
    assert.equal(await recordUninstall(installer, 'removable'), true)
    assert.equal((await listInstalled(installer)).length, 0)
    // idempotent: a second uninstall reports no active row
    assert.equal(await recordUninstall(installer, 'removable'), false)
  })
})
