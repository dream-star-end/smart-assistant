import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { after, before, describe, test } from 'node:test'

import { createChatGptProxyServer, type ChatGptProxyServer } from '../chatgptProxy/server.js'
import { defaultCutoverInFlightTracker } from '../deploy/cutoverReadiness.js'
import { createLogger } from '../logging/logger.js'

function startFakeUpstream(): Promise<{ port: number; close(): void; connects: string[] }> {
  const connects: string[] = []
  const server = createNetServer((socket: Socket) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const line = buf.slice(0, buf.indexOf('\r\n'))
      connects.push(line)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      socket.on('data', (c: Buffer) => socket.write(c.toString('utf8').toUpperCase()))
    }
    socket.on('data', onData)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ port, close: () => server.close(), connects })
    })
  })
}

function selfSignedCert(dir: string): { cert: string; key: string } {
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
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  )
  return { cert, key }
}

function tlsRequest(port: number, raw: string): Promise<{ status: number; headers: string; socket: TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write(raw)
    })
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)
      resolve({ status, headers: buf.slice(0, end), socket })
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

describe('chatgpt proxy server cutover fence (OCV5-854)', () => {
  let dir: string
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>
  let proxy: ChatGptProxyServer
  let port: number
  let verifyGate: { entered: () => void; release: Promise<void> } | null = null
  const tunnelEvents = new EventEmitter()

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oc-cgp-fence-'))
    const { cert, key } = selfSignedCert(dir)
    upstream = await startFakeUpstream()
    proxy = createChatGptProxyServer({
      publicHost: 'proxy.example.test',
      port: 0,
      tlsCertPath: cert,
      tlsKeyPath: key,
      upstream: new URL(`http://127.0.0.1:${upstream.port}`),
      verifyCredential: async (uid, secret) => {
        const g = verifyGate
        if (g) {
          g.entered()
          await g.release
        }
        return secret === `secret-for-${uid}`
      },
      resolveUserRole: async (uid) => (uid === 3 ? 'admin' : null),
      getEntitlement: async () => ({ assembled: true, allowlist: [7] }),
      logger: createLogger({
        level: 'info',
        out: (line) => {
          if (JSON.parse(line).msg === 'chatgpt_proxy.tunnel_closed') tunnelEvents.emit('closed')
        },
      }),
      listenHost: '127.0.0.1',
    })
    port = (await proxy.listen()).port
  })

  after(async () => {
    await proxy.close()
    upstream.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('cutover fence rejects new CONNECT with 503 + Retry-After: 1 while existing tunnel finishes', async () => {
    const existing = await tlsRequest(
      port,
      `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u3', 'secret-for-3')}\r\n\r\n`,
    )
    assert.equal(existing.status, 200)
    assert.equal(proxy.activeTunnels(), 1)

    defaultCutoverInFlightTracker.setFencing(true)
    try {
      const fenced = await tlsRequest(
        port,
        `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u3', 'secret-for-3')}\r\n\r\n`,
      )
      assert.equal(fenced.status, 503)
      assert.match(fenced.headers, /Retry-After:\s*1/i)
      fenced.socket.destroy()
      const echoed = await new Promise<string>((resolve) => {
        existing.socket.once('data', (c: Buffer) => resolve(c.toString('utf8')))
        existing.socket.write('still alive')
      })
      assert.equal(echoed, 'STILL ALIVE')
      const closed = once(tunnelEvents, 'closed', { signal: AbortSignal.timeout(5_000) })
      existing.socket.destroy()
      await closed
      assert.equal(proxy.activeTunnels(), 0)
    } finally {
      defaultCutoverInFlightTracker.setFencing(false)
    }
  })

  test('B04: CONNECT paused in async auth increments activeChatgptProxy and is rejected when fence enables mid-auth', async () => {
    defaultCutoverInFlightTracker.setChatgptProxyTunnelsGetter(() => proxy.activeTunnels())
    let enteredResolve!: () => void
    let releaseResolve!: () => void
    const enteredP = new Promise<void>((r) => {
      enteredResolve = r
    })
    const releaseP = new Promise<void>((r) => {
      releaseResolve = r
    })
    verifyGate = { entered: enteredResolve, release: releaseP }
    const upstreamBefore = upstream.connects.length

    try {
      const connectP = tlsRequest(
        port,
        `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u3', 'secret-for-3')}\r\n\r\n`,
      )
      await enteredP
      assert.ok(
        defaultCutoverInFlightTracker.snapshot().activeChatgptProxy >= 1,
        'CONNECT paused during async credential verification must be counted as in-flight',
      )

      defaultCutoverInFlightTracker.setFencing(true)
      releaseResolve()

      const res = await connectP
      assert.equal(res.status, 503)
      assert.match(res.headers, /Retry-After:\s*1/i)
      res.socket.destroy()

      assert.equal(proxy.activeTunnels(), 0, 'fenced CONNECT must never enter tunnels')
      assert.equal(upstream.connects.length, upstreamBefore, 'fenced CONNECT must not dial upstream')
      assert.equal(
        defaultCutoverInFlightTracker.snapshot().activeChatgptProxy,
        0,
        'in-flight counter must return to 0 after fenced rejection',
      )
    } finally {
      verifyGate = null
      defaultCutoverInFlightTracker.setFencing(false)
      defaultCutoverInFlightTracker.setChatgptProxyTunnelsGetter(null)
    }
  })
})
