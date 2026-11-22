/**
 * OCV5-191 & OCV5-154: Narrow iframe embedding headers for repo-built tutorial
 * showcase HTML pages.
 *
 * Global gateway HTTP responses MUST keep `X-Frame-Options: DENY` untouched.
 * ONLY verified regular static files inside `webRoot` in `spa` mode matching
 * the two repo-built showcase HTML patterns receive:
 *   - `X-Frame-Options: SAMEORIGIN`
 *   - `Content-Security-Policy: frame-ancestors 'self'`
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/showcaseFrameHeaders.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  type GatewayHttpHost,
  SHOWCASE_EMBED_CSP,
  _handleHttpAfterCommercial,
  isTrustedShowcaseEmbedPath,
  serveWebStatic,
} from '../gatewayHttp.js'
import { Gateway } from '../server.js'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function createWebFixture(): { base: string; webRoot: string; overlayLink: string } {
  const base = mkdtempSync(join(tmpdir(), 'oc-showcase-hdr-'))
  tmpDirs.push(base)
  const webRoot = join(base, 'dist')
  mkdirSync(join(webRoot, 'tutorials', 'showcase-works', 'planet'), { recursive: true })
  mkdirSync(join(webRoot, 'tutorials', 'showcase-works', 'gravity'), { recursive: true })
  mkdirSync(join(webRoot, 'tutorials', 'showcase-works', 'escape'), { recursive: true })
  mkdirSync(join(webRoot, 'tutorials', 'cases', 'research-bike-demand', 'showcase'), {
    recursive: true,
  })
  mkdirSync(join(webRoot, 'tutorials', 'cases', 'general-public-data-brief', 'showcase'), {
    recursive: true,
  })
  mkdirSync(join(webRoot, 'tutorials', 'cases', 'general-meeting-actions', 'inputs'), {
    recursive: true,
  })

  writeFileSync(join(webRoot, 'index.html'), '<html><body>SPA root</body></html>')
  writeFileSync(join(webRoot, 'admin.html'), '<html><body>Admin</body></html>')
  writeFileSync(
    join(webRoot, 'tutorials', 'showcase-works', 'planet', 'index.html'),
    '<!doctype html><title>AURELIA</title>',
  )
  writeFileSync(
    join(webRoot, 'tutorials', 'showcase-works', 'gravity', 'index.html'),
    '<!doctype html><title>THREE</title><script src="./physics.js"></script>',
  )
  writeFileSync(
    join(webRoot, 'tutorials', 'showcase-works', 'gravity', 'physics.js'),
    'window.GravityPhysics = {};',
  )
  writeFileSync(
    join(webRoot, 'tutorials', 'cases', 'research-bike-demand', 'showcase', 'dashboard.html'),
    '<!doctype html><title>Bike Demand</title>',
  )
  writeFileSync(
    join(webRoot, 'tutorials', 'cases', 'general-public-data-brief', 'showcase', 'dashboard.html'),
    '<!doctype html><title>Public Data Brief</title>',
  )
  writeFileSync(
    join(
      webRoot,
      'tutorials',
      'cases',
      'general-meeting-actions',
      'inputs',
      'w3c-did-minutes.html',
    ),
    '<!doctype html><title>W3C Minutes</title>',
  )

  // Symlink escaping webRoot to verify fail-closed realpath containment.
  writeFileSync(join(base, 'outside.html'), '<!doctype html><title>OUTSIDE</title>')
  symlinkSync(
    join(base, 'outside.html'),
    join(webRoot, 'tutorials', 'showcase-works', 'escape', 'index.html'),
  )

  // Overlay symlink (matches production P0-Web OC_V5_WEB_OVERLAY_ROOT/<rel>/current -> dist).
  const overlayLink = join(base, 'current')
  symlinkSync(webRoot, overlayLink)

  return { base, webRoot, overlayLink }
}

function createGatewayHost(opts: {
  webRoot: string
  staticMode?: 'spa' | 'vanilla'
  authed?: boolean
}): GatewayHttpHost {
  const gw = Object.create(Gateway.prototype) as Record<string, unknown>
  gw._staticFileCache = new Map()
  gw.deps = {
    webRoot: opts.webRoot,
    staticMode: opts.staticMode ?? 'spa',
  }
  gw.log = { info() {}, warn() {}, error() {}, debug() {} }
  gw.checkBridgeBypass = () => false
  gw._isDelegateHttpPath = () => false
  gw._hasValidDelegateContext = () => false
  gw.checkHttpAuth = () => Boolean(opts.authed)
  gw.sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // Minimal route IO stubs — none of our test paths match preAuth/platform/etc.
  gw.preAuthRoutesIo = {}
  gw.platformRoutesIo = {}
  gw.systemRoutesIo = {}
  gw.clientSessionsIo = {}
  gw.appConfigRoutesIo = {}
  gw.agentRoutesIo = {}
  gw.workspaceApiRoutesIo = {}
  return gw as unknown as GatewayHttpHost
}

async function withServer<T>(gw: GatewayHttpHost, fn: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    _handleHttpAfterCommercial.call(gw, req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    server.close()
    throw new Error('failed to bind ephemeral port')
  }
  try {
    return await fn(addr.port)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function sendRawRequest(
  port: number,
  rawPath: string,
  opts?: { method?: string; headers?: Record<string, string> },
): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: rawPath,
        method: opts?.method ?? 'GET',
        headers: opts?.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('isTrustedShowcaseEmbedPath', () => {
  it('accepts ONLY exact repo-built showcase HTML patterns', () => {
    const valid = [
      '/tutorials/showcase-works/planet/index.html',
      '/tutorials/showcase-works/gravity/index.html',
      '/tutorials/showcase-works/a/index.html',
      '/tutorials/cases/research-bike-demand/showcase/dashboard.html',
      '/tutorials/cases/general-public-data-brief/showcase/dashboard.html',
    ]
    for (const p of valid) {
      assert.equal(isTrustedShowcaseEmbedPath(p), true, `expected allow: ${p}`)
    }
  })

  it('rejects non-matching paths, non-HTML assets, traversal, encoding, and malformed slugs', () => {
    const rejected = [
      '/',
      '/index.html',
      '/admin',
      '/admin.html',
      '/api/healthz',
      '/api/tutorial-embeds/deadbeef',
      '/tutorials/showcase-works/planet/cover.png',
      '/tutorials/showcase-works/gravity/physics.js',
      '/tutorials/showcase-works/planet/source.zip',
      '/tutorials/showcase-works/planet/manifest.json',
      '/tutorials/showcase-works/planet/other.html',
      '/tutorials/cases/research-bike-demand/showcase/derived.csv',
      '/tutorials/cases/research-bike-demand/showcase/report.md',
      '/tutorials/cases/research-bike-demand/showcase/index.html',
      '/tutorials/cases/general-meeting-actions/inputs/w3c-did-minutes.html',
      '/tutorials/showcase-works/../index.html',
      '/tutorials/showcase-works/%2e%2e/index.html',
      '/tutorials/showcase-works/..%2findex.html',
      '/tutorials/showcase-works/planet/%2e%2e/index.html',
      '/tutorials/showcase-works/planet/index.html/',
      '/tutorials/showcase-works/planet/INDEX.HTML',
      '/tutorials/showcase-works/Planet/index.html',
      '/tutorials/showcase-works/-planet/index.html',
      '/tutorials/showcase-works/planet-/index.html',
      '/tutorials/showcase-works/a/b/index.html',
      '/tutorials/showcase-works//planet/index.html',
      '/tutorials/showcase-works/planet/index.html?x=1',
      '/tutorials/showcase-works/planet\\..\\index.html',
      '/tutorials/cases/research-bike-demand/showcase/dashboard.html/',
      '/tutorials/cases/%2e%2e/showcase/dashboard.html',
      `/tutorials/showcase-works/${'a'.repeat(65)}/index.html`,
    ]
    for (const p of rejected) {
      assert.equal(isTrustedShowcaseEmbedPath(p), false, `expected reject: ${p}`)
    }
  })
})

describe('real HTTP showcase frame headers (_handleHttpAfterCommercial + serveWebStatic)', () => {
  it('sets SAMEORIGIN + frame-ancestors self for valid showcase works and case dashboards (GET, HEAD, cache hit, 304, query, overlay)', async () => {
    const { webRoot, overlayLink } = createWebFixture()
    const gw = createGatewayHost({ webRoot, staticMode: 'spa' })

    await withServer(gw, async (port) => {
      const paths = [
        '/tutorials/showcase-works/planet/index.html',
        '/tutorials/showcase-works/gravity/index.html',
        '/tutorials/cases/research-bike-demand/showcase/dashboard.html',
        '/tutorials/cases/general-public-data-brief/showcase/dashboard.html',
      ]
      for (const p of paths) {
        const res = await sendRawRequest(port, p)
        assert.equal(res.status, 200, p)
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN', p)
        assert.equal(res.headers['content-security-policy'], SHOWCASE_EMBED_CSP, p)
        assert.equal(res.headers['x-content-type-options'], 'nosniff', p)
        assert.equal(res.headers['referrer-policy'], 'no-referrer', p)
      }

      // HEAD request (matches `curl -sSI`)
      const headRes = await sendRawRequest(port, '/tutorials/showcase-works/planet/index.html', {
        method: 'HEAD',
      })
      assert.equal(headRes.status, 200)
      assert.equal(headRes.headers['x-frame-options'], 'SAMEORIGIN')
      assert.equal(headRes.headers['content-security-policy'], SHOWCASE_EMBED_CSP)

      // Cache hit + 304 revalidation preserve SAMEORIGIN and CSP
      const cachedRes = await sendRawRequest(port, '/tutorials/showcase-works/planet/index.html')
      assert.equal(cachedRes.status, 200)
      assert.equal(cachedRes.headers['x-frame-options'], 'SAMEORIGIN')
      assert.equal(cachedRes.headers['content-security-policy'], SHOWCASE_EMBED_CSP)
      const etag = String(cachedRes.headers.etag)
      assert.ok(etag.length > 0)

      const notMod = await sendRawRequest(port, '/tutorials/showcase-works/planet/index.html', {
        headers: { 'If-None-Match': etag },
      })
      assert.equal(notMod.status, 304)
      assert.equal(notMod.headers['x-frame-options'], 'SAMEORIGIN')
      assert.equal(notMod.headers['content-security-policy'], SHOWCASE_EMBED_CSP)

      // Query string on valid showcase HTML
      const withQuery = await sendRawRequest(
        port,
        '/tutorials/showcase-works/planet/index.html?v=2',
      )
      assert.equal(withQuery.status, 200)
      assert.equal(withQuery.headers['x-frame-options'], 'SAMEORIGIN')
      assert.equal(withQuery.headers['content-security-policy'], SHOWCASE_EMBED_CSP)
    })

    // Overlay symlink webRoot (production P0-Web layout) works identically
    const overlayGw = createGatewayHost({ webRoot: overlayLink, staticMode: 'spa' })
    await withServer(overlayGw, async (port) => {
      const res = await sendRawRequest(port, '/tutorials/showcase-works/planet/index.html')
      assert.equal(res.status, 200)
      assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
      assert.equal(res.headers['content-security-policy'], SHOWCASE_EMBED_CSP)
    })
  })

  it('keeps X-Frame-Options: DENY on /, SPA fallback, /admin, /api/*, non-matching static files, missing showcase 404s, symlinks, and traversals', async () => {
    const { webRoot } = createWebFixture()
    const gw = createGatewayHost({ webRoot, staticMode: 'spa', authed: false })

    await withServer(gw, async (port) => {
      const denyCases: Array<{ path: string; expectedStatus: number }> = [
        { path: '/', expectedStatus: 200 },
        { path: '/index.html', expectedStatus: 200 },
        { path: '/admin', expectedStatus: 302 },
        { path: '/admin.html', expectedStatus: 200 },
        { path: '/chat/session-123', expectedStatus: 200 }, // SPA fallback
        { path: '/api/sessions', expectedStatus: 401 }, // API auth gate
        { path: '/tutorials/showcase-works/gravity/physics.js', expectedStatus: 200 },
        {
          path: '/tutorials/cases/general-meeting-actions/inputs/w3c-did-minutes.html',
          expectedStatus: 200,
        },
        { path: '/tutorials/showcase-works/nonexistent/index.html', expectedStatus: 404 },
        { path: '/tutorials/cases/nonexistent/showcase/dashboard.html', expectedStatus: 404 },
        { path: '/tutorials/showcase-works/escape/index.html', expectedStatus: 404 }, // symlink escape
        { path: '/tutorials/showcase-works/../index.html', expectedStatus: 404 },
        { path: '/tutorials/showcase-works/../../index.html', expectedStatus: 200 },
        { path: '/tutorials/showcase-works/%2e%2e/index.html', expectedStatus: 404 },
        { path: '/tutorials/showcase-works/..%2f..%2findex.html', expectedStatus: 404 },
        { path: '/tutorials/cases/%2e%2e/showcase/dashboard.html', expectedStatus: 404 },
      ]

      for (const tc of denyCases) {
        const res = await sendRawRequest(port, tc.path)
        assert.equal(res.status, tc.expectedStatus, `status for ${tc.path}`)
        assert.equal(res.headers['x-frame-options'], 'DENY', `XFO for ${tc.path}`)
        assert.equal(
          res.headers['content-security-policy'],
          undefined,
          `unexpected CSP for ${tc.path}`,
        )
      }

      // After a cached showcase file is deleted from disk, next request MUST 404 with DENY
      const planetPath = '/tutorials/showcase-works/planet/index.html'
      const warm = await sendRawRequest(port, planetPath)
      assert.equal(warm.status, 200)
      assert.equal(warm.headers['x-frame-options'], 'SAMEORIGIN')

      unlinkSync(join(webRoot, 'tutorials', 'showcase-works', 'planet', 'index.html'))
      const gone = await sendRawRequest(port, planetPath)
      assert.equal(gone.status, 404)
      assert.equal(gone.headers['x-frame-options'], 'DENY')
      assert.equal(gone.headers['content-security-policy'], undefined)
    })

    // Authenticated unknown /api/* route still returns 404 JSON with X-Frame-Options: DENY
    const authedGw = createGatewayHost({ webRoot, staticMode: 'spa', authed: true })
    await withServer(authedGw, async (port) => {
      const api404 = await sendRawRequest(port, '/api/unknown-endpoint-xyz')
      assert.equal(api404.status, 404)
      assert.equal(api404.headers['x-frame-options'], 'DENY')
      assert.equal(api404.headers['content-security-policy'], undefined)
    })
  })

  it('keeps X-Frame-Options: DENY in vanilla mode even for valid showcase paths', async () => {
    const { webRoot } = createWebFixture()
    const vanillaGw = createGatewayHost({ webRoot, staticMode: 'vanilla' })

    await withServer(vanillaGw, async (port) => {
      const res = await sendRawRequest(port, '/tutorials/showcase-works/planet/index.html')
      assert.equal(res.status, 200)
      assert.equal(res.headers['x-frame-options'], 'DENY')
      assert.equal(res.headers['content-security-policy'], undefined)
    })
  })

  it('restores DENY and clears CSP fail-closed if _serveStaticCached fails after disk check (TOCTOU)', () => {
    const { webRoot } = createWebFixture()
    const headers = new Map<string, string>([['x-frame-options', 'DENY']])
    const fakeRes = {
      headersSent: false,
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value)
      },
      removeHeader(name: string) {
        headers.delete(name.toLowerCase())
      },
    } as unknown as ServerResponse

    const fakeHost: ThisParameterType<typeof serveWebStatic> = {
      deps: { webRoot, staticMode: 'spa' } as GatewayHttpHost['deps'],
      _serveStaticCached: (() => false) as unknown as GatewayHttpHost['_serveStaticCached'],
    }
    const served = serveWebStatic.call(
      fakeHost,
      new URL('http://127.0.0.1/tutorials/showcase-works/planet/index.html'),
      { headers: {} } as unknown as IncomingMessage,
      fakeRes,
    )
    assert.equal(served, false)
    assert.equal(headers.get('x-frame-options'), 'DENY')
    assert.equal(headers.has('content-security-policy'), false)
  })
})
