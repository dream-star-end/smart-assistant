import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { type ContainerIdentityRepo, hashSecret } from '../../auth/containerIdentity.js'
import { signAccess } from '../../auth/jwt.js'
import type { RequestContext } from '../../http/handlers.js'
import { createHttpSitesEdgeClient, type SitesEdgeClient } from '../edgeClient.js'
import { createSitesEdgeServer } from '../edgeServer.js'
import { dispatchSitesBrowserRoute } from '../browserHttp.js'
import { makeSitesInternalHandler } from '../internalHttp.js'
import type {
  CommitPublishInput,
  DeleteReservation,
  MetaUpdateReservation,
  PublishReservation,
  PublishReservationInput,
  SitesRepo,
} from '../repo.js'
import { SitesService } from '../service.js'
import {
  SitesError,
  type SiteVisibility,
  type UserSiteRow,
  decodeSiteBundle,
  encodeSiteBundle,
} from '../types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OC_SITE_PY = resolve(
  HERE,
  '../../../agent-sandbox/platform-runtime/bin/oc-site.py',
)
const EDGE_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'

function createInMemorySitesRepo(): SitesRepo & {
  expireLease(slug: string): void
} {
  const bySlug = new Map<string, UserSiteRow>()
  const leases = new Map<string, { leaseId: string; leaseUntil: number; expectedRev: number }>()
  let revCounter = 0
  let idSeq = 0
  const LEASE_TTL_MS = 60_000

  function isLeaseActive(siteId: string): boolean {
    const l = leases.get(siteId)
    return Boolean(l && l.leaseUntil > Date.now())
  }

  return {
    expireLease(slug: string) {
      const row = bySlug.get(slug)
      if (row) leases.delete(row.id)
    },
    async listByUser(userId) {
      return [...bySlug.values()]
        .filter((r) => r.userId === userId && r.edgeRevision > 0)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    },
    async getByUserAndSlug(userId, slug) {
      const row = bySlug.get(slug)
      if (!row || row.userId !== userId || row.edgeRevision <= 0) return null
      return row
    },
    async listUnleasedPlaceholdersByUser(userId) {
      const now = Date.now()
      return [...bySlug.values()]
        .filter((r) => {
          const lease = leases.get(r.id)
          return r.userId === userId && r.edgeRevision === 0 && (!lease || lease.leaseUntil <= now)
        })
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    },
    async promoteUnleasedPlaceholder(input) {
      const cur = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.userId)
      if (!cur || cur.edgeRevision !== 0) return null
      const lease = leases.get(cur.id)
      if (lease && lease.leaseUntil > Date.now()) return null
      if (cur.edgeRevision >= input.edgeRevision) return null
      const now = new Date()
      const updated: UserSiteRow = {
        ...cur,
        title: input.title,
        visibility: input.visibility,
        passwordSalt: input.passwordSalt,
        passwordHash: input.passwordHash,
        spaMode: input.spaMode,
        fileCount: input.fileCount,
        sizeBytes: input.sizeBytes,
        contentSha256: input.contentSha256,
        edgeRevision: input.edgeRevision,
        updatedAt: now,
        lastPublishedAt: now,
      }
      bySlug.set(cur.slug, updated)
      leases.delete(cur.id)
      return updated
    },
    async deleteUnleasedPlaceholder(siteId, userId) {
      for (const [slug, r] of bySlug) {
        const lease = leases.get(r.id)
        if (
          r.id === siteId &&
          r.userId === userId &&
          r.edgeRevision === 0 &&
          (!lease || lease.leaseUntil <= Date.now())
        ) {
          bySlug.delete(slug)
          leases.delete(r.id)
        }
      }
    },
    async beginPublishReservation(input: PublishReservationInput): Promise<PublishReservation> {
      const existing = bySlug.get(input.slug)
      const leaseId = randomUUID()
      const leaseUntil = Date.now() + LEASE_TTL_MS
      if (existing) {
        if (existing.userId !== input.userId) {
          throw new SitesError('SLUG_TAKEN', `子域名 "${input.slug}" 已被占用`, 409)
        }
        if (isLeaseActive(existing.id)) {
          throw new SitesError(
            'SLUG_BUSY',
            `站点 "${input.slug}" 正在进行另一项发布或变更，请稍后重试`,
            409,
            true,
          )
        }
        revCounter += 1
        leases.set(existing.id, { leaseId, leaseUntil, expectedRev: existing.edgeRevision })
        return {
          siteId: existing.id,
          leaseId,
          isNewPlaceholder: existing.edgeRevision === 0,
          edgeRevision: revCounter,
          baseRevision: existing.edgeRevision,
          existing: existing.edgeRevision > 0 ? existing : null,
        }
      }
      const count = [...bySlug.values()].filter((r) => r.userId === input.userId).length
      if (count >= input.maxPerUser) {
        throw new SitesError('QUOTA_EXCEEDED', '站点配额已满', 429)
      }
      revCounter += 1
      idSeq += 1
      const now = new Date()
      const row: UserSiteRow = {
        id: `00000000-0000-4000-8000-${String(idSeq).padStart(12, '0')}`,
        slug: input.slug,
        userId: input.userId,
        title: input.title,
        visibility: input.visibility,
        passwordSalt: input.passwordSalt,
        passwordHash: input.passwordHash,
        spaMode: input.spaMode,
        fileCount: 0,
        sizeBytes: 0,
        contentSha256: '',
        edgeRevision: 0,
        createdAt: now,
        updatedAt: now,
        lastPublishedAt: now,
      }
      bySlug.set(input.slug, row)
      leases.set(row.id, { leaseId, leaseUntil, expectedRev: 0 })
      return {
        siteId: row.id,
        leaseId,
        isNewPlaceholder: true,
        edgeRevision: revCounter,
        baseRevision: 0,
        existing: null,
      }
    },
    async commitPublish(input: CommitPublishInput): Promise<UserSiteRow> {
      const cur = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.userId)
      if (!cur) throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
      if (cur.edgeRevision < input.edgeRevision) {
        const now = new Date()
        const updated: UserSiteRow = {
          ...cur,
          title: input.title,
          visibility: input.visibility,
          passwordSalt: input.passwordSalt,
          passwordHash: input.passwordHash,
          spaMode: input.spaMode,
          fileCount: input.fileCount,
          sizeBytes: input.sizeBytes,
          contentSha256: input.contentSha256,
          edgeRevision: input.edgeRevision,
          updatedAt: now,
          lastPublishedAt: now,
        }
        bySlug.set(cur.slug, updated)
        if (leases.get(cur.id)?.leaseId === input.leaseId) leases.delete(cur.id)
        return updated
      }
      if (cur.edgeRevision === input.edgeRevision) return cur
      throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
    },
    async abortPublishPlaceholder(siteId, userId, leaseId) {
      for (const [slug, r] of bySlug) {
        const lease = leases.get(r.id)
        if (
          r.id === siteId &&
          r.userId === userId &&
          r.edgeRevision === 0 &&
          lease?.leaseId === leaseId
        ) {
          bySlug.delete(slug)
          leases.delete(r.id)
        }
      }
    },
    async releaseLease(siteId, userId, leaseId) {
      const r = [...bySlug.values()].find((row) => row.id === siteId && row.userId === userId)
      if (!r) return
      const lease = leases.get(r.id)
      if (lease?.leaseId === leaseId) leases.delete(r.id)
    },
    async prepareMetaUpdate(userId, slug): Promise<MetaUpdateReservation> {
      const row = bySlug.get(slug)
      if (!row || row.userId !== userId || row.edgeRevision <= 0) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
      }
      if (isLeaseActive(row.id)) {
        throw new SitesError('SLUG_BUSY', `站点 "${slug}" 正在处理另一项变更`, 409, true)
      }
      revCounter += 1
      const leaseId = randomUUID()
      leases.set(row.id, { leaseId, leaseUntil: Date.now() + LEASE_TTL_MS, expectedRev: row.edgeRevision })
      return { site: row, leaseId, nextRevision: revCounter }
    },
    async commitMetaUpdate(input): Promise<UserSiteRow> {
      const cur = [...bySlug.values()].find((r) => r.id === input.siteId && r.userId === input.userId)
      if (!cur) throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
      if (cur.edgeRevision < input.edgeRevision) {
        const updated: UserSiteRow = {
          ...cur,
          title: input.title,
          visibility: input.visibility,
          passwordSalt: input.passwordSalt,
          passwordHash: input.passwordHash,
          spaMode: input.spaMode,
          edgeRevision: input.edgeRevision,
          updatedAt: new Date(),
        }
        bySlug.set(cur.slug, updated)
        if (leases.get(cur.id)?.leaseId === input.leaseId) leases.delete(cur.id)
        return updated
      }
      if (cur.edgeRevision === input.edgeRevision) return cur
      throw new SitesError('STALE_REVISION', '站点存在更新版本或已被删除', 409)
    },
    async prepareDelete(userId, slug): Promise<DeleteReservation> {
      const row = bySlug.get(slug)
      if (!row || row.userId !== userId || row.edgeRevision <= 0) {
        throw new SitesError('SITE_NOT_FOUND', `未找到站点 "${slug}"`, 404)
      }
      if (isLeaseActive(row.id)) {
        throw new SitesError('SLUG_BUSY', `站点 "${slug}" 正在处理另一项变更`, 409, true)
      }
      revCounter += 1
      const leaseId = randomUUID()
      leases.set(row.id, { leaseId, leaseUntil: Date.now() + LEASE_TTL_MS, expectedRev: row.edgeRevision })
      return { site: row, leaseId, deleteRevision: revCounter }
    },
    async commitDelete(siteId, userId, _leaseId, deleteRevision) {
      for (const [slug, r] of bySlug) {
        if (r.id === siteId && r.userId === userId && r.edgeRevision < deleteRevision) {
          bySlug.delete(slug)
          leases.delete(r.id)
        }
      }
    },
  }
}

function edgeHttpRequest(opts: {
  port: number
  method?: string
  path: string
  host?: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.host) headers.Host = opts.host
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body))
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
        res.on('error', rejectPromise)
      },
    )
    req.on('error', rejectPromise)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

function runPythonCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('python3', [OC_SITE_PY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += String(c)))
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

describe('sites hosting end-to-end (edge + master + oc-site CLI)', () => {
  let workDir = ''
  let edgePort = 0
  let masterPort = 0
  let closeEdge: () => Promise<void>
  let closeMaster: () => Promise<void>
  let edgeClient: ReturnType<typeof createHttpSitesEdgeClient>
  let user1Jwt = ''
  let user2Jwt = ''

  const SECRET_1 = '1111111111111111111111111111111111111111111111111111111111111111'
  const SECRET_2 = '2222222222222222222222222222222222222222222222222222222222222222'
  const TOKEN_1 = `oc-v3.101.${SECRET_1}`
  const TOKEN_2 = `oc-v3.202.${SECRET_2}`

  const tokenToUser = new Map<string, number>([
    [TOKEN_1, 1],
    [TOKEN_2, 2],
  ])

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'oc-sites-e2e-'))
    const edgeData = join(workDir, 'edge-data')
    const edge = createSitesEdgeServer({
      bind: '127.0.0.1',
      port: 0,
      dataRoot: edgeData,
      baseDomain: 'congjianai.com',
      secret: EDGE_SECRET,
      maxSiteBytes: 1024 * 1024,
    })
    const edgeAddr = await edge.listen()
    edgePort = edgeAddr.port
    closeEdge = edge.close

    edgeClient = createHttpSitesEdgeClient({
      baseUrl: `http://127.0.0.1:${edgePort}`,
      secret: EDGE_SECRET,
    })

    const repo = createInMemorySitesRepo()
    const service = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 2,
      maxSiteBytes: 1024 * 1024,
      repo,
      edge: edgeClient,
    })

    // verifyContainerIdentity checks SHA-256 of secret bytes against secret_hash.
    const realIdentityRepo: ContainerIdentityRepo = {
      async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) {
        if (boundIp === '10.0.0.1') {
          return {
            id: 101,
            user_id: 1,
            host_uuid: hostUuid,
            bound_ip: boundIp,
            secret_hash: hashSecret(SECRET_1),
          }
        }
        if (boundIp === '10.0.0.2') {
          return {
            id: 202,
            user_id: 2,
            host_uuid: hostUuid,
            bound_ip: boundIp,
            secret_hash: hashSecret(SECRET_2),
          }
        }
        return null
      },
    }

    const internalHandler = makeSitesInternalHandler({
      identityRepo: realIdentityRepo,
      sites: service,
    })

    const masterServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const pathname = (req.url ?? '/').split('?')[0]!
        if (pathname.startsWith('/internal/v3/sites/')) {
          const authHdr = req.headers.authorization ?? ''
          const tok = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : ''
          const uid = tokenToUser.get(tok) ?? 0
          await internalHandler(req, res, {
            hostUuid: 'test-host',
            boundIp: uid === 2 ? '10.0.0.2' : '10.0.0.1',
          })
          return
        }
        if (pathname === '/api/sites' || pathname.startsWith('/api/sites/')) {
          const ctx = {
            requestId: 'req-test',
            clientIp: '127.0.0.1',
            authBoundIp: '127.0.0.1',
            userAgent: 'test',
            log: { info() {}, warn() {}, error() {}, child() { return this } },
          } as unknown as RequestContext
          await dispatchSitesBrowserRoute(req, res, ctx, {
            jwtSecret: JWT_SECRET,
            sites: service,
          })
          return
        }
        res.statusCode = 404
        res.end('not found')
      })().catch((err) => {
        if (res.headersSent) return
        const e = err as { status?: number; code?: string; message?: string }
        res.statusCode = e.status ?? 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: { code: e.code ?? 'ERR', message: e.message ?? 'err' } }))
      })
    })

    await new Promise<void>((resolveListen) => {
      masterServer.listen(0, '127.0.0.1', () => {
        const addr = masterServer.address() as { port: number }
        masterPort = addr.port
        resolveListen()
      })
    })
    closeMaster = () =>
      new Promise<void>((resolveClose, rejectClose) =>
        masterServer.close((err) => (err ? rejectClose(err) : resolveClose())),
      )

    user1Jwt = (await signAccess({ sub: '1', role: 'user' }, JWT_SECRET)).token
    user2Jwt = (await signAccess({ sub: '2', role: 'user' }, JWT_SECRET)).token
  })

  after(async () => {
    await closeMaster?.()
    await closeEdge?.()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  test('bundle security rejects .env* and path traversal', () => {
    assert.throws(
      () =>
        encodeSiteBundle([
          { path: 'index.html', content: Buffer.from('<h1>ok</h1>') },
          { path: '.env.local', content: Buffer.from('SECRET=1') },
        ]),
      (e: unknown) => e instanceof SitesError && e.code === 'INVALID_BUNDLE',
    )
    assert.throws(
      () =>
        encodeSiteBundle([
          { path: 'index.html', content: Buffer.from('<h1>ok</h1>') },
          { path: '../escape.txt', content: Buffer.from('x') },
        ]),
      (e: unknown) => e instanceof SitesError && e.code === 'INVALID_BUNDLE',
    )
    const valid = encodeSiteBundle([{ path: 'index.html', content: Buffer.from('<h1>hi</h1>') }])
    const decoded = decodeSiteBundle(valid.gzipped)
    assert.equal(decoded.fileCount, 1)
    assert.equal(decoded.files[0]?.path, 'index.html')
  })

  test('oc-site CLI publishes dist, skips .env, serves SPA routes + immutable assets + tls-ask', async () => {
    const distDir = join(workDir, 'my-dist')
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>APP_V1</body></html>')
    writeFileSync(join(distDir, 'assets', 'app.deadbeef.js'), 'console.log(1);')
    writeFileSync(join(distDir, '.env'), 'SUPABASE_SERVICE_ROLE=super-secret')
    writeFileSync(join(distDir, 'dump.xyz'), 'binarydata')

    const pubRes = await runPythonCli(
      ['publish', distDir, '--slug', 'demo-app', '--title', '测试应用'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(pubRes.code, 0, pubRes.stderr)
    assert.match(pubRes.stderr, /skipped secret env file: \.env/)
    const parsed = JSON.parse(pubRes.stdout)
    assert.equal(parsed.site.slug, 'demo-app')
    assert.equal(parsed.site.url, 'https://demo-app.congjianai.com')
    assert.equal(parsed.site.fileCount, 3)

    // tls-ask: allowed for published public site, 404 for unknown / reserved
    const tlsOk = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=demo-app.congjianai.com`)
    assert.equal(tlsOk.status, 200)
    const tlsReserved = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=www.congjianai.com`)
    assert.equal(tlsReserved.status, 404)
    const tlsMissing = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=missing.congjianai.com`)
    assert.equal(tlsMissing.status, 404)

    // Serve root HTML (no-cache) & deep SPA route fallback & verify .env did not upload
    const home = await edgeHttpRequest({ port: edgePort, path: '/', host: 'demo-app.congjianai.com' })
    assert.equal(home.status, 200)
    assert.equal(home.headers['cache-control'], 'no-cache')
    assert.equal(home.headers['x-content-type-options'], 'nosniff')
    assert.match(home.text, /APP_V1/)

    const spaRoute = await edgeHttpRequest({
      port: edgePort,
      path: '/dashboard/users',
      host: 'demo-app.congjianai.com',
    })
    assert.equal(spaRoute.status, 200)
    assert.match(spaRoute.text, /APP_V1/)

    const asset = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/app.deadbeef.js',
      host: 'demo-app.congjianai.com',
    })
    assert.equal(asset.status, 200)
    assert.match(String(asset.headers['cache-control'] ?? ''), /immutable/)

    const envReq = await edgeHttpRequest({
      port: edgePort,
      path: '/.env',
      host: 'demo-app.congjianai.com',
    })
    assert.equal(envReq.status, 404)

    const unknownExt = await edgeHttpRequest({
      port: edgePort,
      path: '/dump.xyz',
      host: 'demo-app.congjianai.com',
    })
    assert.equal(unknownExt.status, 200)
    assert.equal(unknownExt.headers['content-disposition'], 'attachment')
  })

  test('enforces slug reservation, cross-user SLUG_TAKEN (409), password gate, and browser API management', async () => {
    const singleHtml = join(workDir, 'single.html')
    writeFileSync(singleHtml, '<h1>SECRET_CONTENT</h1>')

    // User 2 cannot steal user 1's slug "demo-app"
    const stealRes = await runPythonCli(
      ['publish', singleHtml, '--slug', 'demo-app'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_2,
      },
    )
    assert.equal(stealRes.code, 1)
    assert.match(stealRes.stderr, /SLUG_TAKEN/)

    // Reserved slug rejected
    const reservedRes = await runPythonCli(
      ['publish', singleHtml, '--slug', 'api'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(reservedRes.code, 1)
    assert.match(reservedRes.stderr, /RESERVED_SLUG/)

    // User 1 publishes a second password-protected site
    const pwPub = await runPythonCli(
      ['publish', singleHtml, '--slug', 'vip-notes', '--visibility', 'password', '--password', 'pass1234'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(pwPub.code, 0, pwPub.stderr)

    // Unauthenticated request gets 401 unlock form
    const locked = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
    })
    assert.equal(locked.status, 401)
    assert.doesNotMatch(locked.text, /SECRET_CONTENT/)

    // Wrong password rejected
    const wrongUnlock = await edgeHttpRequest({
      port: edgePort,
      method: 'POST',
      path: '/__oc_site_unlock',
      host: 'vip-notes.congjianai.com',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong&redirect=%2F',
    })
    assert.equal(wrongUnlock.status, 401)

    // Right password sets cookie and unlocks
    const okUnlock = await edgeHttpRequest({
      port: edgePort,
      method: 'POST',
      path: '/__oc_site_unlock',
      host: 'vip-notes.congjianai.com',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=pass1234&redirect=%2F',
    })
    assert.equal(okUnlock.status, 303)
    const rawSetCookie = okUnlock.headers['set-cookie']
    const setCookie = Array.isArray(rawSetCookie) ? (rawSetCookie[0] ?? '') : (rawSetCookie ?? '')
    assert.match(setCookie, /oc_site_auth=/)
    const cookiePair = setCookie.split(';')[0]!

    const unlocked = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
      headers: { Cookie: cookiePair },
    })
    assert.equal(unlocked.status, 200)
    assert.match(unlocked.text, /SECRET_CONTENT/)

    // User 2 cannot access or mutate user 1's site via browser API
    const u2Patch = await fetch(`http://127.0.0.1:${masterPort}/api/sites/vip-notes`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user2Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })
    assert.equal(u2Patch.status, 404)

    // User 1 rotates password via browser PATCH -> invalidates old cookie!
    const u1Patch = await fetch(`http://127.0.0.1:${masterPort}/api/sites/vip-notes`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'newpass999', spaMode: false }),
    })
    assert.equal(u1Patch.status, 200)

    const staleCookieCheck = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
      headers: { Cookie: cookiePair },
    })
    assert.equal(staleCookieCheck.status, 401)

    // User 1 quota (maxPerUser=2) blocks 3rd site
    const quotaFail = await runPythonCli(
      ['publish', singleHtml, '--slug', 'third-site'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(quotaFail.code, 1)
    assert.match(quotaFail.stderr, /QUOTA_EXCEEDED/)

    // Stale revision directly sent to edge is rejected (409 STALE_REVISION)
    await assert.rejects(
      () =>
        edgeClient.updateMeta({
          slug: 'vip-notes',
          revision: 1,
          meta: {
            title: 'stale',
            visibility: 'public',
            passwordSalt: null,
            passwordHash: null,
            spaMode: true,
          },
        }),
      (e: unknown) => e instanceof SitesError && e.code === 'STALE_REVISION',
    )

    // User 1 pauses vip-notes -> tls-ask returns 404 and serving returns 404
    const pauseRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/vip-notes`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user1Jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'disabled' }),
    })
    assert.equal(pauseRes.status, 200)
    const tlsPaused = await fetch(`http://127.0.0.1:${edgePort}/internal/tls-ask?domain=vip-notes.congjianai.com`)
    assert.equal(tlsPaused.status, 404)

    // Delete via browser API removes site & writes tombstone
    const delRes = await fetch(`http://127.0.0.1:${masterPort}/api/sites/vip-notes`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user1Jwt}` },
    })
    assert.equal(delRes.status, 200)

    const afterDel = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
    })
    assert.equal(afterDel.status, 404)

    // Re-creating the previously deleted slug succeeds cleanly with monotonic revision
    const repubRes = await runPythonCli(
      ['publish', singleHtml, '--slug', 'vip-notes', '--visibility', 'public'],
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`,
        OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN_1,
      },
    )
    assert.equal(repubRes.code, 0, repubRes.stderr)
    const repubLive = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'vip-notes.congjianai.com',
    })
    assert.equal(repubLive.status, 200)
  })
})

describe('sites concurrency, lease fencing, cache isolation, and rate limit (B1-B6)', () => {
  let workDir = ''
  let edgePort = 0
  let closeEdge: () => Promise<void>
  let rawEdge: SitesEdgeClient

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'oc-sites-hardening-'))
    const edge = createSitesEdgeServer({
      bind: '127.0.0.1',
      port: 0,
      dataRoot: join(workDir, 'edge-data'),
      baseDomain: 'congjianai.com',
      secret: EDGE_SECRET,
      maxSiteBytes: 1024 * 1024,
    })
    const addr = await edge.listen()
    edgePort = addr.port
    closeEdge = edge.close
    rawEdge = createHttpSitesEdgeClient({
      baseUrl: `http://127.0.0.1:${edgePort}`,
      secret: EDGE_SECRET,
    })
  })

  after(async () => {
    await closeEdge?.()
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  function buildStaticBundle(extra: Array<{ path: string; content: Buffer }> = []): Buffer {
    return encodeSiteBundle([
      { path: 'index.html', content: Buffer.from('<h1>PROTECTED_APP</h1>', 'utf8') },
      ...extra,
    ]).gzipped
  }

  test('B1: concurrent updateSite(visibility=password) + updateSite(title) preserves password protection and rejects stale cross-instance race', async () => {
    const repo = createInMemorySitesRepo()
    let slowFirstPatch = true
    const delayedEdge: SitesEdgeClient = {
      ...rawEdge,
      async updateMeta(args) {
        if (slowFirstPatch) {
          slowFirstPatch = false
          await delay(40)
        }
        return rawEdge.updateMeta(args)
      },
    }
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: delayedEdge,
    })

    await svc.publishSite(1, {
      slug: 'race-b1',
      title: 'initial',
      visibility: 'public',
      gzippedBundle: buildStaticBundle(),
    })

    await Promise.all([
      svc.updateSite(1, 'race-b1', { visibility: 'password', password: 'pw-strong-1' }),
      svc.updateSite(1, 'race-b1', { title: 'renamed-after-pw' }),
    ])

    const finalSite = await svc.getSite(1, 'race-b1')
    assert.equal(finalSite.visibility, 'password')
    assert.equal(finalSite.title, 'renamed-after-pw')

    // Edge must now reject unauthenticated access
    const edgeCheck = await edgeHttpRequest({
      port: edgePort,
      path: '/',
      host: 'race-b1.congjianai.com',
    })
    assert.equal(edgeCheck.status, 401)

    // Cross-instance race (no shared in-process mutex): second caller sees SLUG_BUSY and Edge rejects mismatched expectedBaseRevision
    let releaseFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let allowFinish!: () => void
    const gateFinish = new Promise<void>((resolve) => {
      allowFinish = resolve
    })

    const svcA = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: {
        ...rawEdge,
        async updateMeta(args) {
          releaseFirst()
          await gateFinish
          return rawEdge.updateMeta(args)
        },
      },
    })
    const svcB = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    const pA = svcA.updateSite(1, 'race-b1', { title: 'from-A' })
    await firstEntered
    await assert.rejects(
      () => svcB.updateSite(1, 'race-b1', { visibility: 'public' }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_BUSY',
    )
    allowFinish()
    const resA = await pA
    assert.equal(resA.visibility, 'password')
    assert.equal(resA.title, 'from-A')

    // Direct Edge PATCH with stale expectedBaseRevision is rejected with STALE_REVISION (409)
    await assert.rejects(
      () =>
        rawEdge.updateMeta({
          slug: 'race-b1',
          revision: resA.edgeRevision + 50,
          meta: {
            title: 'stale-cas',
            visibility: 'public',
            passwordSalt: null,
            passwordHash: null,
            spaMode: true,
            expectedBaseRevision: resA.edgeRevision - 1,
          },
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'STALE_REVISION',
    )
  })

  test('B2: delayed deleteSite vs publishSite lease fencing prevents deleting a newer revision', async () => {
    const repo = createInMemorySitesRepo()
    let onEdgeDeleteCalled!: () => void
    const deleteEntered = new Promise<void>((resolve) => {
      onEdgeDeleteCalled = resolve
    })
    let finishEdgeDelete!: () => void
    const releaseEdgeDelete = new Promise<void>((resolve) => {
      finishEdgeDelete = resolve
    })

    const svcSlowDel = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: {
        ...rawEdge,
        async deleteSite(args) {
          onEdgeDeleteCalled()
          await releaseEdgeDelete
          return rawEdge.deleteSite(args)
        },
      },
    })
    const svcFast = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    const initial = await svcFast.publishSite(1, {
      slug: 'race-b2',
      gzippedBundle: buildStaticBundle(),
    })

    const delPromise = svcSlowDel.deleteSite(1, 'race-b2')
    await deleteEntered

    // While delete holds lease, concurrent publish fails cleanly with SLUG_BUSY
    await assert.rejects(
      () =>
        svcFast.publishSite(1, {
          slug: 'race-b2',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_BUSY',
    )

    // Even if lease expires in DB and a newer publish commits before commitDelete executes,
    // both DB fencing (edge_revision < deleteRevision) and Edge STALE_REVISION block the old delete.
    const newer = await rawEdge.pushBundle({
      slug: 'race-b2',
      revision: initial.edgeRevision + 100,
      gzippedBundle: buildStaticBundle(),
      meta: {
        title: 'newer-rev',
        visibility: 'public',
        passwordSalt: null,
        passwordHash: null,
        spaMode: true,
        expectedBaseRevision: initial.edgeRevision,
      },
    })
    assert.equal(newer, undefined)

    finishEdgeDelete()
    await assert.rejects(
      () => delPromise,
      (err: unknown) => err instanceof SitesError && err.code === 'STALE_REVISION',
    )
    const status = await rawEdge.getSiteStatus({ slug: 'race-b2' })
    assert.equal(status.exists, true)
    assert.equal(status.revision, initial.edgeRevision + 100)

    // Direct repo commitDelete with old deleteRevision cannot delete a row whose edgeRevision is newer
    repo.expireLease('race-b2')
    const resNew = await svcFast.publishSite(1, {
      slug: 'race-b2-fence',
      gzippedBundle: buildStaticBundle(),
    })
    await repo.commitDelete(resNew.id, 1, 'non-matching-lease', resNew.edgeRevision - 1)
    const stillThere = await svcFast.getSite(1, 'race-b2-fence')
    assert.equal(stillThere.slug, 'race-b2-fence')
  })

  test('B3: concurrent first-time publishes lock slug and ambiguous EDGE_UNAVAILABLE reconciles via getSiteStatus', async () => {
    const repo = createInMemorySitesRepo()
    let dropResponseAfterCommit = true
    let failBeforeEdge = false
    let failStatusOnce = false

    const flakeyEdge: SitesEdgeClient = {
      ...rawEdge,
      async pushBundle(args) {
        if (failBeforeEdge) {
          throw new SitesError('EDGE_UNAVAILABLE', 'connect ECONNREFUSED', 502, true)
        }
        await rawEdge.pushBundle(args)
        if (dropResponseAfterCommit) {
          dropResponseAfterCommit = false
          throw new SitesError('EDGE_UNAVAILABLE', 'socket hang up after write', 502, true)
        }
      },
      async getSiteStatus(args) {
        if (failStatusOnce) {
          failStatusOnce = false
          throw new SitesError('EDGE_UNAVAILABLE', 'status probe timeout', 502, true)
        }
        return rawEdge.getSiteStatus(args)
      },
    }

    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: flakeyEdge,
    })

    // Ambiguous timeout AFTER Edge applied revision -> getSiteStatus sees committed rev and reconciles DB
    const recovered = await svc.publishSite(1, {
      slug: 'race-b3-recover',
      gzippedBundle: buildStaticBundle(),
    })
    assert.equal(recovered.slug, 'race-b3-recover')
    const listed = await svc.listSummary(1)
    assert.equal(listed.sites.some((s) => s.slug === 'race-b3-recover'), true)

    // Double fault: pushBundle commits on Edge, throws EDGE_UNAVAILABLE, AND immediate getSiteStatus probe throws once.
    // Placeholder stays retained until next listSummary/retry reconciles it instead of leaving an orphan or wedging at CAS.
    dropResponseAfterCommit = true
    failStatusOnce = true
    await assert.rejects(
      () =>
        svc.publishSite(1, {
          slug: 'race-b3-double-fault',
          title: 'double-fault-title',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    const afterRecoverList = await svc.listSummary(1)
    assert.equal(afterRecoverList.sites.some((s) => s.slug === 'race-b3-double-fault'), true)
    const retriedExplicit = await svc.publishSite(1, {
      slug: 'race-b3-double-fault',
      title: 'double-fault-updated',
      gzippedBundle: buildStaticBundle(),
    })
    assert.equal(retriedExplicit.title, 'double-fault-updated')

    // Failure BEFORE Edge wrote anything -> getSiteStatus sees !exists -> aborts placeholder so retry succeeds cleanly
    failBeforeEdge = true
    await assert.rejects(
      () =>
        svc.publishSite(1, {
          slug: 'race-b3-abort',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'EDGE_UNAVAILABLE',
    )
    failBeforeEdge = false
    const retried = await svc.publishSite(1, {
      slug: 'race-b3-abort',
      gzippedBundle: buildStaticBundle(),
    })
    assert.equal(retried.slug, 'race-b3-abort')

    // Concurrent first-time publish from two separate instances for same slug -> one wins, other gets SLUG_BUSY
    let slowStarted!: () => void
    const waited = new Promise<void>((resolve) => {
      slowStarted = resolve
    })
    let allowSlow!: () => void
    const releaseSlow = new Promise<void>((resolve) => {
      allowSlow = resolve
    })
    const svcSlow = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: {
        ...rawEdge,
        async pushBundle(args) {
          slowStarted()
          await releaseSlow
          return rawEdge.pushBundle(args)
        },
      },
    })
    const svcOther = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    const pWin = svcSlow.publishSite(1, {
      slug: 'race-b3-same-slug',
      gzippedBundle: buildStaticBundle(),
    })
    await waited
    await assert.rejects(
      () =>
        svcOther.publishSite(1, {
          slug: 'race-b3-same-slug',
          gzippedBundle: buildStaticBundle(),
        }),
      (err: unknown) => err instanceof SitesError && err.code === 'SLUG_BUSY',
    )
    allowSlow()
    const win = await pWin
    assert.equal(win.slug, 'race-b3-same-slug')
  })

  test('B4: password-protected assets disable shared caching and conditional 304 revalidation', async () => {
    const repo = createInMemorySitesRepo()
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    const bundle = buildStaticBundle([
      { path: 'assets/secret.deadbeef.js', content: Buffer.from('console.log("top-secret");', 'utf8') },
      { path: 'assets/private.json', content: Buffer.from('{"secret":true}', 'utf8') },
    ])

    await svc.publishSite(1, {
      slug: 'cache-b4-pw',
      visibility: 'password',
      password: 'vault-pass-1',
      gzippedBundle: bundle,
    })
    await svc.publishSite(1, {
      slug: 'cache-b4-pub',
      visibility: 'public',
      gzippedBundle: bundle,
    })

    // Protected unauthenticated request -> 401 + private, no-store + Vary: Cookie
    const unauthAsset = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/secret.deadbeef.js',
      host: 'cache-b4-pw.congjianai.com',
    })
    assert.equal(unauthAsset.status, 401)
    assert.equal(unauthAsset.headers['cache-control'], 'private, no-store')
    assert.equal(unauthAsset.headers.vary, 'Cookie')

    // Unlock protected site
    const unlock = await edgeHttpRequest({
      port: edgePort,
      method: 'POST',
      path: '/__oc_site_unlock',
      host: 'cache-b4-pw.congjianai.com',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=vault-pass-1&redirect=%2F',
    })
    assert.equal(unlock.status, 303)
    const setCookie = Array.isArray(unlock.headers['set-cookie'])
      ? (unlock.headers['set-cookie'][0] ?? '')
      : (unlock.headers['set-cookie'] ?? '')
    const cookiePair = setCookie.split(';')[0]!

    // Authenticated hashed JS asset must NEVER be public immutable
    const authJs = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/secret.deadbeef.js',
      host: 'cache-b4-pw.congjianai.com',
      headers: { Cookie: cookiePair },
    })
    assert.equal(authJs.status, 200)
    assert.equal(authJs.headers['cache-control'], 'private, no-store')
    assert.equal(authJs.headers.pragma, 'no-cache')
    assert.equal(authJs.headers.vary, 'Cookie')
    assert.equal(authJs.headers.etag, undefined)

    // Authenticated JSON + If-None-Match must NOT return 304
    const authJson = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/private.json',
      host: 'cache-b4-pw.congjianai.com',
      headers: { Cookie: cookiePair, 'If-None-Match': '"anything"' },
    })
    assert.equal(authJson.status, 200)
    assert.equal(authJson.headers['cache-control'], 'private, no-store')
    assert.equal(authJson.headers.vary, 'Cookie')

    // Public site hashed JS keeps long immutable cache + ETag + 304 support
    const pubJs = await edgeHttpRequest({
      port: edgePort,
      path: '/assets/secret.deadbeef.js',
      host: 'cache-b4-pub.congjianai.com',
    })
    assert.equal(pubJs.status, 200)
    assert.equal(pubJs.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.ok(typeof pubJs.headers.etag === 'string' && pubJs.headers.etag.length > 0)
  })

  test('B5: concurrent publishes of distinct new slugs count in-flight leases toward maxPerUser quota', async () => {
    const repo = createInMemorySitesRepo()
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 2,
      repo,
      edge: {
        ...rawEdge,
        async pushBundle(args) {
          await delay(30)
          return rawEdge.pushBundle(args)
        },
      },
    })

    // Consume 1 of 2 quota slots
    await svc.publishSite(1, { slug: 'quota-existing', gzippedBundle: buildStaticBundle() })

    // Fire 2 distinct new slugs concurrently while maxPerUser is 2 -> only 1 can succeed
    const results = await Promise.allSettled([
      svc.publishSite(1, { slug: 'quota-new-a', gzippedBundle: buildStaticBundle() }),
      svc.publishSite(1, { slug: 'quota-new-b', gzippedBundle: buildStaticBundle() }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(rejected[0]!.reason instanceof SitesError)
    assert.equal(rejected[0]!.reason.code, 'QUOTA_EXCEEDED')

    const summary = await svc.listSummary(1)
    assert.equal(summary.sites.length, 2)
  })

  test('B6: 15 simultaneous unlock attempts enforce atomic rate limit at 10 attempts (429)', async () => {
    const repo = createInMemorySitesRepo()
    const svc = new SitesService({
      enabled: true,
      baseDomain: 'congjianai.com',
      maxPerUser: 5,
      repo,
      edge: rawEdge,
    })

    await svc.publishSite(1, {
      slug: 'rate-b6-pw',
      visibility: 'password',
      password: 'correct-horse-battery',
      gzippedBundle: buildStaticBundle(),
    })

    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        edgeHttpRequest({
          port: edgePort,
          method: 'POST',
          path: '/__oc_site_unlock',
          host: 'rate-b6-pw.congjianai.com',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Real-IP': '203.0.113.77',
          },
          body: 'password=wrong-guess&redirect=%2F',
        }),
      ),
    )

    const counts = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    }, {})

    assert.equal(counts[401], 10)
    assert.equal(counts[429], 5)
    for (const r of responses.filter((x) => x.status === 429)) {
      assert.equal(r.headers['cache-control'], 'private, no-store')
      assert.equal(r.headers.vary, 'Cookie')
    }
  })
})
