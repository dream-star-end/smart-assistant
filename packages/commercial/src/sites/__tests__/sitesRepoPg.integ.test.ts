/** Real PostgreSQL + SitesService concurrency, quota, fencing, and double-fault reconciliation tests (B1/B2/B3/B5). */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const MIGRATION_0345 = resolve(HERE, '../../db/migrations/0345_user_sites.sql')
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
    await pool.query('CREATE TABLE users (id INTEGER PRIMARY KEY)')
    await pool.query('INSERT INTO users (id) VALUES (1), (2)')
    const ddl = readFileSync(MIGRATION_0345, 'utf8')
    await pool.query(ddl)

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
          await rawEdge.pushBundle(args)
          if (failPushOnce) {
            failPushOnce = false
            throw new SitesError('EDGE_UNAVAILABLE', 'dropped ack', 502, true)
          }
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
})
