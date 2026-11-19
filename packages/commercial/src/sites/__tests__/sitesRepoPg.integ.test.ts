/** Real PostgreSQL + SitesService concurrency, quota, fencing, and double-fault reconciliation tests (B1/B2/B3/B5). */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { createHttpSitesEdgeClient, type SitesEdgeClient } from '../edgeClient.js'
import { createSitesEdgeServer } from '../edgeServer.js'
import { createPgSitesRepo } from '../repo.js'
import { SitesService } from '../service.js'
import { SitesError, encodeSiteBundle } from '../types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(HERE, '../../db/migrations')
const SITES_MIGRATIONS = [
  resolve(MIGRATIONS_DIR, '0342_commercial_user_sites.sql'),
  resolve(MIGRATIONS_DIR, '0345_user_sites.sql'),
  resolve(MIGRATIONS_DIR, '0347_user_sites_fullstack.sql'),
  resolve(MIGRATIONS_DIR, '0349_user_site_collaborators.sql'),
].filter((p) => existsSync(p))
const EDGE_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const targetUrl = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test',
)
if (
  !['127.0.0.1', 'localhost'].includes(targetUrl.hostname) ||
  !targetUrl.pathname.endsWith('_test')
) {
  throw new Error('isolated local *_test database required for sitesRepoPg.integ.test.ts')
}

const SCHEMA = `oc_sites_pg_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: targetUrl.toString(), max: 1 })
const pool = new Pool({
  connectionString: targetUrl.toString(),
  max: 6,
  options: `-c search_path=${SCHEMA},public`,
})

function buildBundle(html = '<h1>PG_INTEGRATION_SITE</h1>'): Buffer {
  return encodeSiteBundle([{ path: 'index.html', content: Buffer.from(html, 'utf8') }]).gzipped
}

describe('createPgSitesRepo + SitesService real PostgreSQL concurrency proofs', () => {
  let workDir = ''
  let closeEdge: () => Promise<void>
  let rawEdge: SitesEdgeClient

  before(async () => {
    await admin.query(`CREATE SCHEMA ${SCHEMA}`)
    await pool.query(
      `CREATE TABLE users (
         id INTEGER PRIMARY KEY,
         email TEXT NOT NULL UNIQUE,
         display_name TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         email_verified BOOLEAN NOT NULL DEFAULT TRUE
       )`,
    )
    await pool.query(
      `INSERT INTO users (id, email, display_name, status, email_verified)
       VALUES
         (1, 'u1@example.com', 'User One', 'active', TRUE),
         (2, 'u2@example.com', 'User Two', 'active', TRUE),
         (3, 'u3@example.com', 'User Three', 'active', TRUE),
         (4, 'unverified@example.com', 'User Four', 'active', FALSE)`,
    )
    assert.ok(SITES_MIGRATIONS.length > 0, 'at least one user_sites migration must exist')
    for (const file of SITES_MIGRATIONS) {
      await pool.query(readFileSync(file, 'utf8'))
    }

    workDir = mkdtempSync(join(tmpdir(), 'oc-sites-pg-integ-'))
    const edge = createSitesEdgeServer({
      bind: '127.0.0.1',
      port: 0,
      dataRoot: join(workDir, 'edge-data'),
      baseDomain: 'congjianai.com',
      secret: EDGE_SECRET,
      maxSiteBytes: 1024 * 1024,
    })
    const addr = await edge.listen()
    closeEdge = edge.close
    rawEdge = createHttpSitesEdgeClient({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      secret: EDGE_SECRET,
    })
  })

  after(async () => {
    await closeEdge?.()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {})
    await admin.end()
  })

  test('B5 real PG: concurrent publishes of two distinct new slugs enforce maxPerUser quota', async () => {
    const repo = createPgSitesRepo(pool)
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 2,
      repo,
      edge: {
        ...rawEdge,
        async pushBundle(args) {
          await delay(40)
          return rawEdge.pushBundle(args)
        },
      },
    })

    // User 2 starts with 1 published site out of maxPerUser=2
    await svc.publishSite(2, { slug: 'pg-quota-base', gzippedBundle: buildBundle() })

    const results = await Promise.allSettled([
      svc.publishSite(2, { slug: 'pg-quota-a', gzippedBundle: buildBundle() }),
      svc.publishSite(2, { slug: 'pg-quota-b', gzippedBundle: buildBundle() }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0]!.reason instanceof SitesError)
    assert.equal(rejected[0]!.reason.code, 'QUOTA_EXCEEDED')

    const countRes = await pool.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM user_sites WHERE user_id = 2',
    )
    assert.equal(countRes.rows[0]!.cnt, 2)
  })

  test('B1 + B2 + B3 real PG: lease isolation, fenced delete, and double-fault random-slug reconciliation', async () => {
    const repo = createPgSitesRepo(pool)

    // B1: Two independent SitesService instances racing on same slug
    let enterPatch!: () => void
    const patchEntered = new Promise<void>((resolve) => {
      enterPatch = resolve
    })
    let allowPatch!: () => void
    const releasePatch = new Promise<void>((resolve) => {
      allowPatch = resolve
    })

    const svcA = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 10,
      repo,
      edge: {
        ...rawEdge,
        async updateMeta(args) {
          enterPatch()
          await releasePatch
          return rawEdge.updateMeta(args)
        },
      },
    })
    const svcB = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 10,
      repo,
      edge: rawEdge,
    })

    await svcB.publishSite(1, {
      slug: 'pg-race',
      title: 'v1',
      visibility: 'public',
      gzippedBundle: buildBundle(),
    })

    const pA = svcA.updateSite(1, 'pg-race', { visibility: 'password', password: 'pg-secret-99' })
    await patchEntered
    await assert.rejects(
      () => svcB.updateSite(1, 'pg-race', { title: 'stale-public-write' }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_BUSY',
    )
    allowPatch()
    const afterPw = await pA
    assert.equal(afterPw.visibility, 'password')

    const afterTitle = await svcB.updateSite(1, 'pg-race', { title: 'pg-race-updated' })
    assert.equal(afterTitle.visibility, 'password')
    assert.equal(afterTitle.title, 'pg-race-updated')

    // B2: Fenced commitDelete cannot remove a row at edge_revision >= deleteRevision
    const delPrep = await repo.prepareDelete(1, 'pg-race')
    await repo.commitDelete(delPrep.site.id, 1, delPrep.leaseId, delPrep.site.edgeRevision)
    const stillPresent = await repo.getByUserAndSlug(1, 'pg-race')
    assert.ok(stillPresent)
    await repo.releaseLease(delPrep.site.id, 1, delPrep.leaseId)

    await svcB.deleteSite(1, 'pg-race')
    assert.equal(await repo.getByUserAndSlug(1, 'pg-race'), null)

    // B3: Double-fault reconciliation for BOTH random-slug placeholder AND existing-site overwrite/PATCH
    let failPushOnce = true
    let failPatchOnce = false
    let failProbeOnce = true
    const svcDoubleFault = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 10,
      repo,
      edge: {
        ...rawEdge,
        async pushBundle(args) {
          const out = await rawEdge.pushBundle(args)
          if (failPushOnce) {
            failPushOnce = false
            throw new SitesError('EDGE_UNAVAILABLE', 'dropped ack', 502, true)
          }
          return out
        },
        async updateMeta(args) {
          await rawEdge.updateMeta(args)
          if (failPatchOnce) {
            failPatchOnce = false
            throw new SitesError('EDGE_UNAVAILABLE', 'dropped patch ack', 502, true)
          }
        },
        async getSiteStatus(args) {
          if (failProbeOnce) {
            failProbeOnce = false
            throw new SitesError('EDGE_UNAVAILABLE', 'probe failed once', 502, true)
          }
          return rawEdge.getSiteStatus(args)
        },
      },
    })

    await assert.rejects(
      () => svcDoubleFault.publishSite(1, { title: 'random-df', gzippedBundle: buildBundle() }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )

    // Unleased placeholder exists in PG and blocks quota leak before reconciliation
    const preRows = await pool.query<{ slug: string; edge_revision: string }>(
      'SELECT slug, edge_revision FROM user_sites WHERE user_id = 1',
    )
    assert.equal(preRows.rows.length, 1)
    assert.equal(Number(preRows.rows[0]!.edge_revision), 0)
    const orphanSlug = preRows.rows[0]!.slug

    // Next listSummary reconciles the placeholder from Edge status into a visible, manageable row
    const summary = await svcDoubleFault.listSummary(1)
    assert.equal(summary.sites.length, 1)
    assert.equal(summary.sites[0]!.slug, orphanSlug)
    assert.equal(summary.sites[0]!.title, 'random-df')

    // Existing-site overwrite publishSite double fault -> DB stays behind until next updateSite reconciles and succeeds
    failPushOnce = true
    failProbeOnce = true
    await assert.rejects(
      () =>
        svcDoubleFault.publishSite(1, {
          slug: orphanSlug,
          title: 'pg-overwrite-df',
          gzippedBundle: buildBundle('<h1>V2</h1>'),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    const afterOverwritePw = await svcDoubleFault.updateSite(1, orphanSlug, {
      visibility: 'password',
      password: 'pg-recovered-99',
    })
    assert.equal(afterOverwritePw.title, 'pg-overwrite-df')
    assert.equal(afterOverwritePw.visibility, 'password')

    // Existing-site updateSite PATCH double fault -> next publishSite reconciles Edge revision and avoids 409 CAS wedge
    failPatchOnce = true
    failProbeOnce = true
    await assert.rejects(
      () =>
        svcDoubleFault.updateSite(1, orphanSlug, {
          title: 'pg-patch-df',
          visibility: 'disabled',
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    const afterPatchRepub = await svcDoubleFault.publishSite(1, {
      slug: orphanSlug,
      visibility: 'public',
      gzippedBundle: buildBundle('<h1>V3</h1>'),
    })
    assert.equal(afterPatchRepub.title, 'pg-patch-df')
    assert.equal(afterPatchRepub.visibility, 'public')
    const edgeFinal = await rawEdge.getSiteStatus({ slug: orphanSlug })
    assert.equal(edgeFinal.revision, afterPatchRepub.edgeRevision)

    await svcDoubleFault.deleteSite(1, orphanSlug)
    assert.equal((await svcDoubleFault.listSummary(1)).sites.length, 0)
  })

  test('0347 migration: encrypted secrets at rest, unique verified custom_domain, and renameSite preserving env + crash recovery', async () => {
    const repo = createPgSitesRepo(pool)
    const txtRecords = new Map<string, string[][]>()
    const resolveTxt = async (host: string) => txtRecords.get(host) ?? []
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      edgeSecret: EDGE_SECRET,
      repo,
      edge: rawEdge,
      resolveTxt,
    })

    const created = await svc.publishSite(1, {
      slug: 'pg-fs-alpha',
      title: 'Alpha Fullstack',
      originSessionId: 'agent:main:webchat:dm:alpha',
      gzippedBundle: buildBundle('<h1>ALPHA</h1>'),
    })
    assert.equal(created.originSessionId, 'agent:main:webchat:dm:alpha')

    await svc.setEnvVar(1, 'pg-fs-alpha', {
      key: 'DEEPSEEK_API_KEY',
      value: 'sk-live-secret-999',
      isSecret: true,
    })
    await svc.setEnvVar(1, 'pg-fs-alpha', {
      key: 'PUBLIC_APP_NAME',
      value: 'DemoApp',
      isSecret: false,
    })

    const rawEnvRows = await pool.query<{
      env_key: string
      is_secret: boolean
      plain_value: string | null
      ciphertext: Buffer | null
      nonce: Buffer | null
    }>(
      `SELECT env_key, is_secret, plain_value, ciphertext, nonce
       FROM user_site_env_vars
       WHERE site_id = $1
       ORDER BY env_key ASC`,
      [created.id],
    )
    assert.equal(rawEnvRows.rows.length, 2)
    const secretRow = rawEnvRows.rows.find((r) => r.env_key === 'DEEPSEEK_API_KEY')!
    assert.equal(secretRow.is_secret, true)
    assert.equal(secretRow.plain_value, null)
    assert.ok(secretRow.ciphertext && secretRow.ciphertext.length > 0)
    assert.ok(secretRow.nonce && secretRow.nonce.length > 0)
    assert.equal(secretRow.ciphertext.toString('utf8').includes('sk-live-secret-999'), false)

    const maskedDtos = await svc.listEnvVars(1, 'pg-fs-alpha')
    assert.equal(maskedDtos.find((v) => v.key === 'DEEPSEEK_API_KEY')?.value, null)
    assert.equal(maskedDtos.find((v) => v.key === 'PUBLIC_APP_NAME')?.value, 'DemoApp')

    await svc.publishSite(2, {
      slug: 'pg-fs-beta',
      gzippedBundle: buildBundle('<h1>BETA</h1>'),
    })
    const pendingAlpha = await svc.updateSite(1, 'pg-fs-alpha', { customDomain: 'portal.customer.com' })
    assert.equal(pendingAlpha.customDomainStatus, 'pending')
    txtRecords.set(pendingAlpha.customDomainTxtName!, [[pendingAlpha.customDomainTxtValue!]])
    const verifiedAlpha = await svc.verifyCustomDomain(1, 'pg-fs-alpha')
    assert.equal(verifiedAlpha.customDomainStatus, 'verified')

    await assert.rejects(
      () => svc.updateSite(2, 'pg-fs-beta', { customDomain: 'portal.customer.com' }),
      (e: unknown) => e instanceof SitesError && e.code === 'DOMAIN_TAKEN',
    )
    await svc.updateSite(1, 'pg-fs-alpha', { customDomain: null })
    const pendingBeta = await svc.updateSite(2, 'pg-fs-beta', { customDomain: 'portal.customer.com' })
    txtRecords.set(pendingBeta.customDomainTxtName!, [[pendingBeta.customDomainTxtValue!]])
    const boundBeta = await svc.verifyCustomDomain(2, 'pg-fs-beta')
    assert.equal(boundBeta.customDomain, 'portal.customer.com')
    assert.equal(boundBeta.customDomainStatus, 'verified')

    const renamed = await svc.renameSite(1, 'pg-fs-alpha', 'pg-fs-renamed')
    assert.equal(renamed.slug, 'pg-fs-renamed')
    assert.equal(renamed.originSessionId, 'agent:main:webchat:dm:alpha')
    const envAfterRename = await svc.listEnvVars(1, 'pg-fs-renamed')
    assert.equal(envAfterRename.length, 2)

    // P0 #2 + P1 #8: Crash after Edge rename BEFORE PG commit:
    // Target slug claim blocks concurrent user 2, and reconcile completes rename preserving secrets!
    const crashSvc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      edgeSecret: EDGE_SECRET,
      repo,
      resolveTxt,
      edge: {
        ...rawEdge,
        async renameSite(args) {
          await rawEdge.renameSite(args)
          throw new SitesError('EDGE_UNAVAILABLE', 'simulated gateway crash after rename', 502, true)
        },
        async getSiteStatus() {
          throw new SitesError('EDGE_UNAVAILABLE', 'simulated probe failure before crash', 502, true)
        },
      },
    })
    await assert.rejects(
      () => crashSvc.renameSite(1, 'pg-fs-renamed', 'pg-fs-crash-dst'),
      (e: unknown) => e instanceof SitesError && e.code === 'EDGE_UNAVAILABLE',
    )

    // Concurrent user 2 cannot steal the reserved rename target slug
    await assert.rejects(
      () => svc.publishSite(2, { slug: 'pg-fs-crash-dst', gzippedBundle: buildBundle() }),
      (e: unknown) => e instanceof SitesError && e.code === 'SLUG_TAKEN',
    )

    // Next read on user 1 reconciles rename cleanly and preserves secret env vars!
    const u1After = await svc.listSummary(1)
    assert.equal(u1After.sites.length, 1)
    assert.equal(u1After.sites[0]!.slug, 'pg-fs-crash-dst')
    const envAfterCrash = await svc.listEnvVars(1, 'pg-fs-crash-dst')
    assert.equal(envAfterCrash.length, 2)

    await svc.deleteSite(1, 'pg-fs-crash-dst')
    await svc.deleteSite(2, 'pg-fs-beta')
  })

  test('PG collaborators & single-use invite concurrency + owner secret env AAD integrity on editor publish', async () => {
    const repo = createPgSitesRepo(pool)
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      edgeSecret: EDGE_SECRET,
      repo,
      edge: rawEdge,
      resolveTxt: async () => [],
    })

    const ownerApiCode = 'export default async function handler(ctx) { return ctx.json({ ok: true }) }\n'
    const v1Site = await svc.publishSite(1, {
      slug: 'pg-collab-site',
      title: 'PG Collab',
      originSessionId: 'agent:main:webchat:dm:owner-pg',
      gzippedBundle: encodeSiteBundle([
        { path: 'index.html', content: Buffer.from('<h1>PG_COLLAB_V1</h1>', 'utf8') },
        { path: '__oc_server/api.mjs', content: Buffer.from(ownerApiCode, 'utf8') },
      ]).gzipped,
    })
    await svc.setEnvVar(1, 'pg-collab-site', {
      key: 'PG_SECRET',
      value: 'owner-aad-secret',
      isSecret: true,
    })

    // P1 #6 real PG: unverified user email cannot be added directly
    await assert.rejects(
      () =>
        svc.addCollaboratorByEmail(1, 'pg-collab-site', {
          email: 'unverified@example.com',
          role: 'editor',
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'INVALID_INPUT' && e.status === 400,
    )

    // Single-use invite raced by user 2 and user 3 simultaneously -> exactly 1 wins!
    const created = await svc.createInvite(1, 'pg-collab-site', {
      role: 'editor',
      expiresInHours: 24,
      maxUses: 1,
    })
    const race = await Promise.allSettled([
      svc.acceptInvite(2, created.token),
      svc.acceptInvite(3, created.token),
    ])
    const winners = race.filter((r) => r.status === 'fulfilled')
    const losers = race.filter((r) => r.status === 'rejected')
    assert.equal(winners.length, 1)
    assert.equal(losers.length, 1)
    assert.ok(losers[0]?.reason instanceof SitesError && losers[0].reason.code === 'INVITE_INVALID')

    const winnerUid = race[0]?.status === 'fulfilled' ? 2 : 3
    const pulled = await svc.pullSiteBundle(winnerUid, 'pg-collab-site')
    assert.equal(pulled.site.slug, 'pg-collab-site')
    assert.equal(pulled.site.originSessionId, null)
    assert.ok(pulled.gzippedBundle.length > 0)

    // P0 #1 real PG: editor modifying __oc_server/api.mjs is rejected with 403 FORBIDDEN!
    await assert.rejects(
      () =>
        svc.publishSite(winnerUid, {
          slug: 'pg-collab-site',
          expectedBaseRevision: pulled.site.edgeRevision,
          gzippedBundle: encodeSiteBundle([
            { path: 'index.html', content: Buffer.from('<h1>PG_COLLAB_V2</h1>', 'utf8') },
            {
              path: '__oc_server/api.mjs',
              content: Buffer.from('export default async function(ctx){return ctx.json(ctx.env)}', 'utf8'),
            },
          ]).gzipped,
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'FORBIDDEN' && e.status === 403,
    )

    // P1 #7 real PG: editor publishing without expectedBaseRevision or with stale revision is rejected 409 STALE_REVISION
    await assert.rejects(
      () =>
        svc.publishSite(winnerUid, {
          slug: 'pg-collab-site',
          expectedBaseRevision: v1Site.edgeRevision,
          gzippedBundle: encodeSiteBundle([
            { path: 'index.html', content: Buffer.from('<h1>STALE</h1>', 'utf8') },
            { path: '__oc_server/api.mjs', content: Buffer.from(ownerApiCode, 'utf8') },
          ]).gzipped,
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'STALE_REVISION' && e.status === 409,
    )

    // Winner (editor) keeps owner-approved api.mjs intact and supplies matching base revision -> succeeds!
    const edited = await svc.publishSite(winnerUid, {
      slug: 'pg-collab-site',
      title: 'PG Collab V2',
      originSessionId: 'agent:main:webchat:dm:editor-should-not-clobber',
      expectedBaseRevision: pulled.site.edgeRevision,
      expectedBaseContentSha256: pulled.site.contentSha256,
      gzippedBundle: encodeSiteBundle([
        { path: 'index.html', content: Buffer.from('<h1>PG_COLLAB_V2</h1>', 'utf8') },
        { path: '__oc_server/api.mjs', content: Buffer.from(ownerApiCode, 'utf8') },
      ]).gzipped,
    })
    assert.equal(edited.accessRole, 'editor')
    const ownerView = await svc.getSite(1, 'pg-collab-site')
    assert.equal(ownerView.originSessionId, 'agent:main:webchat:dm:owner-pg')
    const envVars = await svc.listEnvVars(1, 'pg-collab-site')
    assert.equal(envVars.length, 1)
    assert.equal(envVars[0]?.key, 'PG_SECRET')

    // P1 #3 real PG: removing collaborator bumps preview_acl_version in PG and Edge!
    await svc.removeCollaborator(1, 'pg-collab-site', winnerUid)
    const aclRow = await pool.query<{ preview_acl_version: string | number }>(
      'SELECT preview_acl_version FROM user_sites WHERE slug = $1',
      ['pg-collab-site'],
    )
    assert.ok(Number(aclRow.rows[0]?.preview_acl_version) >= 2)
    const edgeStatus = await rawEdge.getSiteStatus({ slug: 'pg-collab-site' })
    assert.ok((edgeStatus.meta?.previewAclVersion ?? 0) >= 2)

    // Round-2 P1 #1 real PG: owner updates api.mjs A -> B with simulated Edge-commit / PG-crash -> reconcile promotes sha(B)!
    // Editor keeping B succeeds; editor trying to roll back to old A is rejected 403 FORBIDDEN!
    await svc.addCollaboratorByEmail(1, 'pg-collab-site', {
      email: 'u2@example.com',
      role: 'editor',
    })
    const ownerApiCodeB = 'export default async function handler(ctx) { return ctx.json({ ver: "B" }) }\n'
    let failPushOnce = true
    let failProbeOnce = true
    const crashPublishSvc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      edgeSecret: EDGE_SECRET,
      repo,
      resolveTxt: async () => [],
      edge: {
        ...rawEdge,
        async pushBundle(args) {
          const out = await rawEdge.pushBundle(args)
          if (failPushOnce) {
            failPushOnce = false
            throw new SitesError('EDGE_UNAVAILABLE', 'simulated ack drop after Edge commit B', 502, true)
          }
          return out
        },
        async getSiteStatus(args) {
          if (failProbeOnce) {
            failProbeOnce = false
            throw new SitesError('EDGE_UNAVAILABLE', 'simulated probe fail before crash', 502, true)
          }
          return rawEdge.getSiteStatus(args)
        },
      },
    })
    await assert.rejects(
      () =>
        crashPublishSvc.publishSite(1, {
          slug: 'pg-collab-site',
          gzippedBundle: encodeSiteBundle([
            { path: 'index.html', content: Buffer.from('<h1>OWNER_B</h1>', 'utf8') },
            { path: '__oc_server/api.mjs', content: Buffer.from(ownerApiCodeB, 'utf8') },
          ]).gzipped,
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'EDGE_UNAVAILABLE',
    )
    // Next read reconciles from Edge and promotes owner's approved sha(B)
    const pulledB = await svc.pullSiteBundle(2, 'pg-collab-site')
    // Editor trying to roll back to old ownerApiCode (A) MUST be rejected 403!
    await assert.rejects(
      () =>
        svc.publishSite(2, {
          slug: 'pg-collab-site',
          expectedSiteId: pulledB.site.id,
          expectedBaseRevision: pulledB.site.edgeRevision,
          expectedBaseContentSha256: pulledB.site.contentSha256,
          gzippedBundle: encodeSiteBundle([
            { path: 'index.html', content: Buffer.from('<h1>ROLLBACK_A</h1>', 'utf8') },
            { path: '__oc_server/api.mjs', content: Buffer.from(ownerApiCode, 'utf8') },
          ]).gzipped,
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'FORBIDDEN' && e.status === 403,
    )
    // Editor keeping B intact and updating frontend SUCCEEDS!
    const editedB = await svc.publishSite(2, {
      slug: 'pg-collab-site',
      expectedSiteId: pulledB.site.id,
      expectedBaseRevision: pulledB.site.edgeRevision,
      expectedBaseContentSha256: pulledB.site.contentSha256,
      gzippedBundle: encodeSiteBundle([
        { path: 'index.html', content: Buffer.from('<h1>EDITOR_WITH_B</h1>', 'utf8') },
        { path: '__oc_server/api.mjs', content: Buffer.from(ownerApiCodeB, 'utf8') },
      ]).gzipped,
    })
    assert.equal(editedB.accessRole, 'editor')

    // Round-2 P1 #3 real PG: retry removeCollaborator after Edge failure STILL syncs durable preview_acl_target_version!
    const preRetryEdge = await rawEdge.getSiteStatus({ slug: 'pg-collab-site' })
    const preRetryAcl = preRetryEdge.meta?.previewAclVersion ?? 1
    let failAclMetaOnce = true
    const flakyAclSvc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      edgeSecret: EDGE_SECRET,
      repo,
      resolveTxt: async () => [],
      edge: {
        ...rawEdge,
        async updateMeta(args) {
          if (failAclMetaOnce) {
            failAclMetaOnce = false
            throw new SitesError('EDGE_UNAVAILABLE', 'simulated edge failure during removeCollaborator', 502, true)
          }
          return rawEdge.updateMeta(args)
        },
      },
    })
    await assert.rejects(
      () => flakyAclSvc.removeCollaborator(1, 'pg-collab-site', 2),
      (e: unknown) => e instanceof SitesError && e.code === 'EDGE_UNAVAILABLE',
    )
    // Retry removeCollaborator (DB row already gone -> rowCount=0), MUST still push target ACL version to Edge!
    await flakyAclSvc.removeCollaborator(1, 'pg-collab-site', 2)
    const postRetryEdge = await rawEdge.getSiteStatus({ slug: 'pg-collab-site' })
    assert.ok((postRetryEdge.meta?.previewAclVersion ?? 0) > preRetryAcl)

    // Round-2 P1 #7 real PG: baseline publish after owner deletes site MUST fail 409 STALE_REVISION (never recreate public site!)
    await svc.deleteSite(1, 'pg-collab-site')
    await assert.rejects(
      () =>
        svc.publishSite(2, {
          slug: 'pg-collab-site',
          expectedSiteId: editedB.id,
          expectedBaseRevision: editedB.edgeRevision,
          expectedBaseContentSha256: editedB.contentSha256,
          gzippedBundle: buildBundle('<h1>SHOULD_NOT_RECREATE</h1>'),
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'STALE_REVISION' && e.status === 409,
    )
    assert.equal(await repo.getByUserAndSlug(2, 'pg-collab-site'), null)
  })

  test('0342 migration is idempotent per table across multiple schemas in one database', async (t) => {
    const commercial0342 = SITES_MIGRATIONS.find((p) => p.endsWith('0342_commercial_user_sites.sql'))
    if (!commercial0342) {
      t.skip('commercial 0342 migration not present on selfhost')
      return
    }
    const sql = readFileSync(commercial0342, 'utf8')
    const schemaA = `oc_sites_0342_a_${randomUUID().replaceAll('-', '')}`
    const schemaB = `oc_sites_0342_b_${randomUUID().replaceAll('-', '')}`
    const client = await admin.connect()
    try {
      await client.query(`CREATE SCHEMA ${schemaA}; CREATE SCHEMA ${schemaB};`)
      for (const s of [schemaA, schemaB]) {
        await client.query(`
          BEGIN;
          SET LOCAL search_path = ${s};
          CREATE TABLE users (id INTEGER PRIMARY KEY);
        `)
        await client.query(sql)
        await client.query(sql)
        const chks = await client.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt
             FROM pg_constraint
            WHERE conrelid = 'user_sites'::regclass
              AND conname IN ('user_sites_custom_domain_format_chk', 'user_sites_op_kind_chk')`,
        )
        assert.equal(chks.rows[0]!.cnt, 2, `expected 2 check constraints on ${s}.user_sites`)
        await client.query('COMMIT')
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaA}, ${schemaB} CASCADE`).catch(() => {})
    }
  })
})
