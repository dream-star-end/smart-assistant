import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { after, before, describe, test } from 'node:test'

import { createChatGptProxyServer, type ChatGptProxyServer } from '../server.js'

/**
 * Fake upstream HTTP CONNECT proxy: answers 200 and echoes bytes back upper-cased
 * so the test can prove the tunnel is transparent end-to-end.
 */
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

interface ConnectResult {
  status: number
  headers: string
  socket: TLSSocket
}

function tlsRequest(port: number, raw: string): Promise<ConnectResult> {
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

describe('chatgpt proxy server', () => {
  let dir: string
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>
  let proxy: ChatGptProxyServer
  let port: number
  let entitled = true
  const allowlist: number[] = [7]
  const used: number[] = []

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oc-cgp-'))
    const { cert, key } = selfSignedCert(dir)
    upstream = await startFakeUpstream()
    proxy = createChatGptProxyServer({
      publicHost: 'proxy.example.test',
      port: 0,
      tlsCertPath: cert,
      tlsKeyPath: key,
      upstream: new URL(`http://127.0.0.1:${upstream.port}`),
      verifyCredential: async (uid, secret) => secret === `secret-for-${uid}`,
      resolveUserRole: async (uid) =>
        uid === 3 ? 'admin' : uid === 7 || uid === 9 ? 'user' : null,
      getEntitlement: async () => ({ assembled: entitled, allowlist }),
      onTunnelUsed: (uid) => used.push(uid),
      listenHost: '127.0.0.1',
    })
    port = (await proxy.listen()).port
  })

  after(async () => {
    await proxy.close()
    upstream.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('serves PAC and healthz without auth; 404 elsewhere', async () => {
    const pac = await tlsRequest(port, 'GET /pac HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    assert.equal(pac.status, 200)
    assert.match(pac.headers, /x-ns-proxy-autoconfig/)
    pac.socket.destroy()
    const health = await tlsRequest(
      port,
      'GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    )
    assert.equal(health.status, 200)
    health.socket.destroy()
    const other = await tlsRequest(
      port,
      'GET /anything HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    )
    assert.equal(other.status, 404)
    other.socket.destroy()
  })

  test('CONNECT without credentials → 407 with Proxy-Authenticate', async () => {
    const r = await tlsRequest(
      port,
      'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n',
    )
    assert.equal(r.status, 407)
    assert.match(r.headers, /Proxy-Authenticate: Basic realm=/)
    r.socket.destroy()
  })

  test('CONNECT with wrong secret → 407', async () => {
    const r = await tlsRequest(
      port,
      `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u3', 'nope')}\r\n\r\n`,
    )
    assert.equal(r.status, 407)
    r.socket.destroy()
  })

  test('valid credential but not entitled (not admin, not allowlisted) → 403', async () => {
    const r = await tlsRequest(
      port,
      `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u9', 'secret-for-9')}\r\n\r\n`,
    )
    assert.equal(r.status, 403)
    r.socket.destroy()
  })

  test('allowlisted host outside whitelist → 403; port 80 → 403', async () => {
    const a = await tlsRequest(
      port,
      `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${basic('u3', 'secret-for-3')}\r\n\r\n`,
    )
    assert.equal(a.status, 403)
    a.socket.destroy()
    const b = await tlsRequest(
      port,
      `CONNECT chatgpt.com:80 HTTP/1.1\r\nHost: chatgpt.com:80\r\nProxy-Authorization: ${basic('u3', 'secret-for-3')}\r\n\r\n`,
    )
    assert.equal(b.status, 403)
    b.socket.destroy()
    assert.equal(upstream.connects.length, 0)
  })

  test('admin CONNECT to chatgpt.com builds transparent tunnel via upstream', async () => {
    const r = await tlsRequest(
      port,
      `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u3', 'secret-for-3')}\r\n\r\n`,
    )
    assert.equal(r.status, 200)
    assert.deepEqual(upstream.connects, ['CONNECT chatgpt.com:443 HTTP/1.1'])
    assert.equal(proxy.activeTunnels(), 1)
    assert.deepEqual(used, [3])
    const echoed = await new Promise<string>((resolve) => {
      r.socket.once('data', (c: Buffer) => resolve(c.toString('utf8')))
      r.socket.write('hello tunnel')
    })
    assert.equal(echoed, 'HELLO TUNNEL')
    r.socket.destroy()
    await new Promise((res) => setTimeout(res, 50))
    assert.equal(proxy.activeTunnels(), 0)
  })

  test('allowlisted regular user is admitted; settings off blocks even admin', async () => {
    const ok = await tlsRequest(
      port,
      `CONNECT cdn.oaistatic.com:443 HTTP/1.1\r\nHost: cdn.oaistatic.com:443\r\nProxy-Authorization: ${basic('u7', 'secret-for-7')}\r\n\r\n`,
    )
    assert.equal(ok.status, 200)
    ok.socket.destroy()
    entitled = false
    const blocked = await tlsRequest(
      port,
      `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u3', 'secret-for-3')}\r\n\r\n`,
    )
    assert.equal(blocked.status, 403)
    blocked.socket.destroy()
    entitled = true
  })
})

/**
 * Upstream whose CONNECT handshake is held until the test releases it, so the
 * proxy sits in the pending (reserved, pre-200) phase under test control.
 * Tracks the real server-side sockets, not just proxy-internal counters.
 */
function startHoldingUpstream(): Promise<{
  port: number
  close(): void
  heldCount(): number
  liveCount(): number
  waitForHeld(n: number, timeoutMs?: number): Promise<void>
  rejectOldest(): void
  acceptAll(): void
}> {
  const held: Socket[] = []
  const live = new Set<Socket>()
  interface HeldWaiter {
    n: number
    resolve: () => void
    timer: ReturnType<typeof setTimeout>
  }
  const waiters: HeldWaiter[] = []
  const poke = () => {
    while (waiters.length > 0 && held.length >= waiters[0].n) {
      const w = waiters.shift()
      if (!w) break
      clearTimeout(w.timer)
      w.resolve()
    }
  }
  const server = createNetServer((socket: Socket) => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      held.push(socket)
      poke()
    }
    socket.on('data', onData)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        close: () => server.close(),
        heldCount: () => held.length,
        liveCount: () => live.size,
        waitForHeld(n: number, timeoutMs = 5_000): Promise<void> {
          return new Promise((res, rej) => {
            const w: HeldWaiter = {
              n,
              resolve: () => res(),
              timer: setTimeout(() => {
                const idx = waiters.indexOf(w)
                if (idx >= 0) waiters.splice(idx, 1)
                rej(new Error(`upstream held only ${held.length}/${n} CONNECTs`))
              }, timeoutMs),
            }
            waiters.push(w)
            poke()
          })
        },
        rejectOldest(): void {
          const s = held.shift()
          if (!s) return
          s.write('HTTP/1.1 502 Refused\r\nContent-Length: 0\r\n\r\n')
          setTimeout(() => s.destroy(), 20)
        },
        acceptAll(): void {
          for (const s of held.splice(0)) {
            s.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            // Active-tunnel sockets keep echoing; client-aborted ones will be
            // destroyed by the proxy and disappear from `live` on their own.
            s.on('data', (c: Buffer) => s.write(c.toString('utf8').toUpperCase()))
          }
        },
      })
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

describe('chatgpt proxy cap reservation (pending + active)', () => {
  let dir: string
  let upstream: Awaited<ReturnType<typeof startHoldingUpstream>>
  let proxy: ChatGptProxyServer
  let port: number

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oc-cgp-cap-'))
    const { cert, key } = selfSignedCert(dir)
    upstream = await startHoldingUpstream()
    proxy = createChatGptProxyServer({
      publicHost: 'proxy.example.test',
      port: 0,
      tlsCertPath: cert,
      tlsKeyPath: key,
      upstream: new URL(`http://127.0.0.1:${upstream.port}`),
      verifyCredential: async (uid, secret) => secret === `secret-for-${uid}`,
      resolveUserRole: async (uid) => (uid === 7 ? 'user' : null),
      getEntitlement: async () => ({ assembled: true, allowlist: [7] }),
      listenHost: '127.0.0.1',
    })
    port = (await proxy.listen()).port
  })

  after(async () => {
    await proxy.close()
    upstream.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('client close during pending keeps reservation; 65th 429; release frees; no double count', async () => {
    const connectLine = `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u7', 'secret-for-7')}\r\n\r\n`
    // 64 concurrent CONNECTs, upstream handshakes all held pending.
    const clients: TLSSocket[] = []
    for (let i = 0; i < 64; i++) {
      const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        socket.write(connectLine)
      })
      clients.push(socket)
    }
    await upstream.waitForHeld(64)
    assert.equal(proxy.activeTunnels(), 64)
    assert.equal(upstream.liveCount(), 64)

    // All clients go away while the upstreams are still pending: reservations
    // must be held and the real upstream sockets must stay open (no early
    // release that would let new CONNECTs pile the cap).
    for (const c of clients) c.destroy()
    await sleep(150)
    assert.equal(proxy.activeTunnels(), 64)
    assert.equal(upstream.liveCount(), 64)
    assert.equal(upstream.heldCount(), 64)

    // The 65th CONNECT for the same user is rejected while the 64 old
    // upstreams have not reached a terminal state.
    const r65 = await tlsRequest(port, connectLine)
    assert.equal(r65.status, 429)
    r65.socket.destroy()

    // One upstream settles by refusing: its reservation is released exactly
    // once, and a new CONNECT is admitted into the freed slot.
    upstream.rejectOldest()
    await sleep(100)
    assert.equal(proxy.activeTunnels(), 63)
    const r66 = tlsRequest(port, connectLine)
    await upstream.waitForHeld(64)
    assert.equal(proxy.activeTunnels(), 64)

    // Settle everything: client-gone tunnels get their late success, which
    // must destroy the actual upstream socket and never acknowledge/pipe.
    upstream.acceptAll()
    const ok66 = await r66
    assert.equal(ok66.status, 200)
    await sleep(200)
    // Only r66 survives (single count — success did not double-reserve).
    assert.equal(proxy.activeTunnels(), 1)
    assert.equal(upstream.liveCount(), 1)

    // Closing the active client still releases the active tunnel.
    ok66.socket.destroy()
    await sleep(100)
    assert.equal(proxy.activeTunnels(), 0)
    assert.equal(upstream.liveCount(), 0)
  })

  test('upstream failure during pending releases the reservation without 200', async () => {
    const connectLine = `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u7', 'secret-for-7')}\r\n\r\n`
    // Upstream handshake failure tears the client connection down without any
    // 200/pipe; detect closure plus whatever bytes made it out.
    const closed = new Promise<number>((resolve) => {
      const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        socket.write(connectLine)
      })
      let buf = ''
      socket.on('data', (c: Buffer) => {
        buf += c.toString('latin1')
      })
      socket.once('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)))
    })
    await upstream.waitForHeld(1)
    assert.equal(proxy.activeTunnels(), 1)
    upstream.rejectOldest()
    const status = await closed
    assert.equal(status, 0)
    await sleep(100)
    assert.equal(proxy.activeTunnels(), 0)
    assert.equal(upstream.liveCount(), 0)
  })

  test('client close + 10s upstream timeout releases reservation and real socket', async () => {
    const connectLine = `CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Authorization: ${basic('u7', 'secret-for-7')}\r\n\r\n`
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      socket.write(connectLine)
    })
    await upstream.waitForHeld(1)
    assert.equal(proxy.activeTunnels(), 1)
    assert.equal(upstream.liveCount(), 1)
    socket.destroy()
    await sleep(150)
    // Reservation and the real upstream socket stay until the 10s bound.
    assert.equal(proxy.activeTunnels(), 1)
    assert.equal(upstream.liveCount(), 1)
    await sleep(10_500)
    assert.equal(proxy.activeTunnels(), 0)
    assert.equal(upstream.liveCount(), 0)
  })
})
