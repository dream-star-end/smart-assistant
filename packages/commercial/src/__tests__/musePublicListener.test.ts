// Muse bridge direct public HTTPS listener (OCV5-561 follow-up): routing, cert reload, retry, close.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { type Server, createServer as createNetServer, connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { TLSSocket } from 'node:tls'

import {
  type MusePublicListener,
  readMusePublicConfig,
  startMusePublicListener,
} from '../muse/publicListener.js'

function selfSignedCert(dir: string, cn: string): { cert: string; key: string } {
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      `/CN=${cn}`,
    ],
    { stdio: 'ignore' },
  )
  return { cert, key }
}

interface Reply {
  status: number
  body: string
  cn: string
}

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, method, path, headers, rejectUnauthorized: false, agent: false },
      (res) => {
        const cn = String((res.socket as TLSSocket).getPeerCertificate?.()?.subject?.CN ?? '')
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cn }))
      },
    )
    req.on('error', reject)
    req.end(method === 'GET' ? undefined : '{}')
  })
}

const silent = {
  child: () => silent,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never

describe('readMusePublicConfig', () => {
  it('is off without a port and refuses a port without cert/key', () => {
    assert.equal(readMusePublicConfig({}), null)
    assert.match(
      String((readMusePublicConfig({ OC_MUSE_PUBLIC_PORT: 8444 }) as { error: string }).error),
      /OC_MUSE_PUBLIC_TLS_CERT/,
    )
    assert.deepEqual(
      readMusePublicConfig({
        OC_MUSE_PUBLIC_PORT: 8444,
        OC_MUSE_PUBLIC_TLS_CERT: '/c',
        OC_MUSE_PUBLIC_TLS_KEY: '/k',
      }),
      { port: 8444, bind: '0.0.0.0', certPath: '/c', keyPath: '/k' },
    )
  })
})

describe('Muse public listener', () => {
  let dir: string
  let tls: { cert: string; key: string }
  const seen: Array<{ method: string; url: string; clientIp: string }> = []
  let hang: ServerResponse | null = null
  const handler = async (req: IncomingMessage, res: ServerResponse, ctx: { clientIp: string }) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', clientIp: ctx.clientIp })
    if (req.url === '/api/muse-bridge/v1/boom') throw new Error('boom')
    if (req.url === '/api/muse-bridge/v1/poll') {
      hang = res // a long-poll that never answers on its own
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'muse-public-'))
    tls = selfSignedCert(dir, 'first.test')
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('serves only /api/muse-bridge/* and answers JSON 404 elsewhere', async () => {
    const l = startMusePublicListener({
      port: 0,
      bind: '127.0.0.1',
      certPath: tls.cert,
      keyPath: tls.key,
      handler,
      logger: silent,
    })
    try {
      const port = await l.ready
      assert.ok(port)
      seen.length = 0
      const ok = await call(port, 'POST', '/api/muse-bridge/v1/hello', {
        'X-Forwarded-For': '6.6.6.6',
      })
      assert.equal(ok.status, 200)
      assert.equal(ok.cn, 'first.test')
      const probe = await call(port, 'POST', '/api/muse-bridge/probe')
      assert.equal(
        probe.status,
        200,
        'the whole prefix goes to the bridge handler (its own 404 for probe)',
      )
      for (const [m, p] of [
        ['GET', '/'],
        ['GET', '/healthz'],
        ['GET', '/api/auth/me'],
        ['POST', '/api/muse-bridgeX/v1/hello'],
        ['GET', '/internal/v3/muse-media/jobs'],
        ['POST', '/api/muse-bridge'],
      ] as const) {
        const r = await call(port, m, p)
        assert.equal(r.status, 404, `${m} ${p}`)
        assert.equal(JSON.parse(r.body).error.code, 'NOT_FOUND')
      }
      assert.deepEqual(
        seen.map((s) => s.url),
        ['/api/muse-bridge/v1/hello', '/api/muse-bridge/probe'],
      )
      // The client IP (auth lockout key) is the TCP peer, never X-Forwarded-For.
      assert.equal(seen[0]!.clientIp, '127.0.0.1')
    } finally {
      await l.close()
    }
  })

  it('answers 500 when the handler throws, and keeps serving', async () => {
    const l = startMusePublicListener({
      port: 0,
      bind: '127.0.0.1',
      certPath: tls.cert,
      keyPath: tls.key,
      handler,
      logger: silent,
    })
    try {
      const port = (await l.ready)!
      const r = await call(port, 'POST', '/api/muse-bridge/v1/boom')
      assert.equal(r.status, 500)
      assert.equal(JSON.parse(r.body).error.code, 'INTERNAL')
      assert.equal((await call(port, 'POST', '/api/muse-bridge/v1/hello')).status, 200)
    } finally {
      await l.close()
    }
  })

  it('picks up a renewed certificate without a restart', async () => {
    const certDir = mkdtempSync(join(dir, 'renew-'))
    const first = selfSignedCert(certDir, 'old.test')
    const l = startMusePublicListener({
      port: 0,
      bind: '127.0.0.1',
      certPath: first.cert,
      keyPath: first.key,
      handler,
      logger: silent,
      certReloadMs: 50,
    })
    try {
      const port = (await l.ready)!
      assert.equal((await call(port, 'POST', '/api/muse-bridge/v1/hello')).cn, 'old.test')
      selfSignedCert(certDir, 'new.test') // same paths, like certbot's live/ symlinks
      const future = new Date(Date.now() + 60_000)
      utimesSync(first.cert, future, future)
      let cn = ''
      for (let i = 0; i < 40 && cn !== 'new.test'; i++) {
        await new Promise((r) => setTimeout(r, 50))
        cn = (await call(port, 'POST', '/api/muse-bridge/v1/hello')).cn
      }
      assert.equal(cn, 'new.test')
    } finally {
      await l.close()
    }
  })

  it('keeps the loaded certificate when the files become unreadable', async () => {
    const certDir = mkdtempSync(join(dir, 'gone-'))
    const c = selfSignedCert(certDir, 'kept.test')
    const l = startMusePublicListener({
      port: 0,
      bind: '127.0.0.1',
      certPath: c.cert,
      keyPath: c.key,
      handler,
      logger: silent,
      certReloadMs: 30,
    })
    try {
      const port = (await l.ready)!
      rmSync(certDir, { recursive: true, force: true })
      await new Promise((r) => setTimeout(r, 120))
      assert.equal((await call(port, 'POST', '/api/muse-bridge/v1/hello')).cn, 'kept.test')
    } finally {
      await l.close()
    }
  })

  it('waits for a busy port (previous master still exiting) and then listens', async () => {
    const blocker: Server = createNetServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as { port: number }).port
    const l = startMusePublicListener({
      port,
      bind: '127.0.0.1',
      certPath: tls.cert,
      keyPath: tls.key,
      handler,
      logger: silent,
      retryMs: 30,
    })
    try {
      await new Promise((r) => setTimeout(r, 100))
      await new Promise<void>((r) => blocker.close(() => r()))
      assert.equal(await l.ready, port)
      assert.equal((await call(port, 'POST', '/api/muse-bridge/v1/hello')).status, 200)
    } finally {
      await l.close()
    }
  })

  it('gives up (null, no throw) when the port stays busy past the deadline', async () => {
    const blocker: Server = createNetServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as { port: number }).port
    const l = startMusePublicListener({
      port,
      bind: '127.0.0.1',
      certPath: tls.cert,
      keyPath: tls.key,
      handler,
      logger: silent,
      retryMs: 20,
      maxWaitMs: 80,
    })
    try {
      assert.equal(await l.ready, null)
    } finally {
      await l.close()
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })

  it('close() does not wait for a held long-poll', async () => {
    const l: MusePublicListener = startMusePublicListener({
      port: 0,
      bind: '127.0.0.1',
      certPath: tls.cert,
      keyPath: tls.key,
      handler,
      logger: silent,
    })
    const port = (await l.ready)!
    const pending = call(port, 'POST', '/api/muse-bridge/v1/poll').catch((e: Error) => e)
    for (let i = 0; i < 50 && !hang; i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(hang, 'poll reached the handler')
    const t0 = Date.now()
    await l.close()
    assert.ok(Date.now() - t0 < 2_000, 'close returned promptly')
    assert.ok((await pending) instanceof Error, 'the held poll was cut, not answered')
  })

  it('close() does not wait for a client that never starts the TLS handshake', async () => {
    const l = startMusePublicListener({
      port: 0,
      bind: '127.0.0.1',
      certPath: tls.cert,
      keyPath: tls.key,
      handler,
      logger: silent,
    })
    const port = (await l.ready)!
    const raw = netConnect(port, '127.0.0.1')
    raw.on('error', () => {})
    await new Promise<void>((r) => raw.once('connect', () => r()))
    await new Promise((r) => setTimeout(r, 50))
    const t0 = Date.now()
    await l.close()
    const took = Date.now() - t0
    raw.destroy()
    assert.ok(took < 2_000, `close returned promptly (${took} ms)`)
  })

  it('throws at start when the certificate cannot be read (caller turns it off)', () => {
    assert.throws(() =>
      startMusePublicListener({
        port: 0,
        bind: '127.0.0.1',
        certPath: join(dir, 'nope.pem'),
        keyPath: join(dir, 'nope.key'),
        handler,
        logger: silent,
      }),
    )
  })
})
