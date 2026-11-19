import * as assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import * as net from 'node:net'
import { describe, it } from 'node:test'
import {
  _buildPinnedLookup,
  detectBlockedContent,
  fetchWebContextUrl,
  isPublicIpAddress,
  looksOoxml,
  normalizeHttpUrl,
  sniffWebContextContent,
  startWebContextSsrfProxy,
} from '../webContextSafety.js'

function fakeLookup(address: string, family: 4 | 6 = 4): any {
  return async () => [{ address, family }]
}

describe('_buildPinnedLookup (Node autoSelectFamily contract)', () => {
  const pinned = { address: '203.0.113.7', family: 4 as const }

  it('returns an ARRAY under { all: true } (Node ≥18.13 lookupAndConnectMultiple)', () => {
    // Regression: the legacy triplet under {all:true} made Node read a bare
    // string as an address array → ERR_INVALID_IP_ADDRESS "Invalid IP address:
    // undefined", which broke every oc-web extract on Node 20.
    const lookup = _buildPinnedLookup(pinned, 'example.com')
    let received: unknown
    let err: unknown
    lookup('example.com', { all: true }, (e, addr) => {
      err = e
      received = addr
    })
    assert.equal(err, null)
    assert.deepEqual(received, [{ address: '203.0.113.7', family: 4 }])
  })

  it('returns the legacy (address, family) triplet when all is absent', () => {
    const lookup = _buildPinnedLookup(pinned, 'example.com')
    let addr: unknown
    let fam: unknown
    lookup('example.com', undefined, (_e, a, f) => {
      addr = a
      fam = f
    })
    assert.equal(addr, '203.0.113.7')
    assert.equal(fam, 4)
  })

  it('errors when the connect host drifts from the vetted host (SSRF guard)', () => {
    const lookup = _buildPinnedLookup(pinned, 'example.com')
    let err: unknown
    lookup('evil.example.net', { all: true }, (e) => {
      err = e
    })
    assert.ok(err instanceof Error)
    assert.match((err as Error).message, /unexpected hostname/)
  })
})

describe('webContextSafety', () => {
  it('rejects non-http, credentials, localhost and non-public IPs', () => {
    assert.throws(() => normalizeHttpUrl('file:///etc/passwd'), /http\/https/)
    assert.throws(() => normalizeHttpUrl('https://u:p@example.com'), /credentials/)
    assert.throws(() => normalizeHttpUrl('http://localhost:3000'), /localhost/)
    assert.equal(isPublicIpAddress('127.0.0.1'), false)
    assert.equal(isPublicIpAddress('10.0.0.1'), false)
    assert.equal(isPublicIpAddress('169.254.169.254'), false)
    assert.equal(isPublicIpAddress('::1'), false)
    assert.equal(isPublicIpAddress('fc00::1'), false)
    assert.equal(isPublicIpAddress('fd12::1'), false)
    assert.equal(isPublicIpAddress('fe80::1'), false)
    assert.equal(isPublicIpAddress('fec0::1'), false)
    assert.equal(isPublicIpAddress('ff00::1'), false)
    assert.equal(isPublicIpAddress('64:ff9b::0808:0808'), false)
    assert.equal(isPublicIpAddress('100::1'), false)
    assert.equal(isPublicIpAddress('2001::1'), false)
    assert.equal(isPublicIpAddress('2001:db8::1'), false)
    assert.equal(isPublicIpAddress('2002::1'), false)
    assert.equal(isPublicIpAddress('[::1]'), false)
    assert.equal(isPublicIpAddress('2001:4860:4860::8888'), true)
    assert.equal(isPublicIpAddress('[2001:4860:4860::8888]'), true)
    assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false)
    assert.equal(isPublicIpAddress('[::ffff:7f00:1]'), false)
    assert.equal(isPublicIpAddress('[::ffff:a9fe:a9fe]'), false)
    assert.equal(isPublicIpAddress('[::ffff:0808:0808]'), true)
    assert.equal(isPublicIpAddress('8.8.8.8'), true)
  })

  it('sniffs safe text/html/pdf content and rejects binary mismatches', () => {
    assert.deepEqual(
      sniffWebContextContent(
        Buffer.from('<!doctype html><html><body>x</body></html>'),
        'text/html',
        'https://example.com/a',
      ),
      { kind: 'html', reason: 'html_mime' },
    )
    assert.deepEqual(
      sniffWebContextContent(
        Buffer.from('{"ok":true}'),
        'application/json',
        'https://example.com/a.json',
      ),
      { kind: 'text', reason: 'text_mime' },
    )
    assert.equal(
      sniffWebContextContent(
        Buffer.from('not a pdf'),
        'application/pdf',
        'https://example.com/a.pdf',
      ).kind,
      null,
    )
    assert.equal(
      sniffWebContextContent(
        Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        'image/jpeg',
        'https://example.com/a.jpg',
      ).kind,
      null,
    )
  })

  it('requires OOXML markers before accepting Office zip documents', () => {
    const docxish = Buffer.from('PK\x03\x04xxxx[Content_Types].xmlxxxxword/document.xml', 'latin1')
    assert.equal(looksOoxml(docxish, 'docx'), true)
    assert.deepEqual(
      sniffWebContextContent(
        docxish,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'https://example.com/a.docx',
      ),
      { kind: 'docx', reason: 'ooxml_magic' },
    )
    assert.equal(
      sniffWebContextContent(
        Buffer.from('PK\x03\x04plain zip', 'latin1'),
        'application/zip',
        'https://example.com/a.zip',
      ).kind,
      null,
    )
  })

  it('detects common anti-bot blocks without bypassing them', () => {
    assert.equal(detectBlockedContent(403, Buffer.from('ok')), 'http_403')
    assert.equal(
      detectBlockedContent(200, Buffer.from('Checking your browser before accessing')),
      'blocked_phrase:checking your browser',
    )
  })

  it('refuses to fetch a host that resolves to a private address', async () => {
    await assert.rejects(
      () => fetchWebContextUrl('http://example.com/', { lookup: fakeLookup('127.0.0.1') }),
      /resolve to a public IP address/,
    )
  })
})

function sendRawConnect(
  proxyPort: number,
  target: string,
  authHeader?: string,
): Promise<{ statusLine: string; raw: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: proxyPort }, () => {
      const auth = authHeader ? `Proxy-Authorization: ${authHeader}\r\n` : ''
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
    })
    let buf = ''
    sock.setTimeout(3_000, () => {
      sock.destroy()
      reject(new Error('raw CONNECT timed out'))
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (buf.includes('\r\n\r\n')) {
        sock.destroy()
        resolve({ statusLine: buf.split('\r\n', 1)[0] ?? '', raw: buf })
      }
    })
    sock.on('end', () => resolve({ statusLine: buf.split('\r\n', 1)[0] ?? '', raw: buf }))
    sock.on('error', reject)
  })
}

function sendProxyHttp(
  proxyPort: number,
  targetUrl: string,
  authHeader?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: targetUrl,
        headers: authHeader ? { 'Proxy-Authorization': authHeader } : {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('startWebContextSsrfProxy', () => {
  it('requires valid per-invocation Proxy-Authorization on both HTTP and CONNECT', async () => {
    const proxy = await startWebContextSsrfProxy()
    try {
      const noAuthHttp = await sendProxyHttp(proxy.port, 'http://example.com/')
      assert.equal(noAuthHttp.status, 407)

      const wrongAuth = `Basic ${Buffer.from('ocweb:wrong').toString('base64')}`
      const badAuthHttp = await sendProxyHttp(proxy.port, 'http://example.com/', wrongAuth)
      assert.equal(badAuthHttp.status, 407)

      const noAuthConnect = await sendRawConnect(proxy.port, 'example.com:443')
      assert.match(noAuthConnect.statusLine, /^HTTP\/1\.1 407\b/)
    } finally {
      await proxy.close()
    }
  })

  it('blocks private IPs, localhost, non-allowlisted ports, and DNS rebinding before opening sockets', async () => {
    const upstreamTargets: Array<{ host: string; port: number }> = []
    const fixture = createServer((req, res) => {
      assert.equal(req.headers['proxy-authorization'], undefined)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok-public')
    })
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done))
    const fixturePort = (fixture.address() as net.AddressInfo).port

    let rebindCount = 0
    const proxy = await startWebContextSsrfProxy({
      lookup: (async (host: string) => {
        if (host === 'rebind.example.test') {
          rebindCount += 1
          return [{ address: rebindCount === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
        }
        return [{ address: '93.184.216.34', family: 4 }]
      }) as any,
      connectSocket: ({ host, port }) => {
        upstreamTargets.push({ host, port })
        if (host !== '93.184.216.34') throw new Error(`unexpected non-public connect to ${host}`)
        return net.connect({ host: '127.0.0.1', port: fixturePort })
      },
    })

    const auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
    try {
      for (const blockedUrl of [
        'http://127.0.0.1/secret',
        'http://localhost/secret',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::ffff:127.0.0.1]/secret',
        'http://example.com:6379/',
        'https://example.com/',
      ]) {
        const res = await sendProxyHttp(proxy.port, blockedUrl, auth)
        assert.equal(res.status, 403, `expected 403 for ${blockedUrl}`)
        assert.equal(res.headers['x-openclaude-ssrf-blocked'], '1')
      }

      for (const blockedAuthority of [
        '127.0.0.1:443',
        'localhost:443',
        '[::1]:443',
        '169.254.169.254:443',
        'example.com:80',
        'example.com:6379',
      ]) {
        const res = await sendRawConnect(proxy.port, blockedAuthority, auth)
        assert.match(res.statusLine, /^HTTP\/1\.1 403\b/, `expected 403 CONNECT for ${blockedAuthority}`)
      }
      assert.equal(upstreamTargets.length, 0)

      // First lookup resolves to public IP 93.184.216.34 and succeeds (headers sanitized)
      const first = await sendProxyHttp(proxy.port, 'http://rebind.example.test/hello', auth)
      assert.equal(first.status, 200)
      assert.equal(first.body, 'ok-public')
      assert.deepEqual(upstreamTargets, [{ host: '93.184.216.34', port: 80 }])

      // Second lookup flips to 127.0.0.1 (DNS rebinding) -> blocked before any socket connect
      const second = await sendProxyHttp(proxy.port, 'http://rebind.example.test/hello', auth)
      assert.equal(second.status, 403)
      assert.equal(upstreamTargets.length, 1)

      const stats = proxy.getStats()
      assert.equal(stats.allowedCount, 1)
      assert.equal(stats.blockedCount, 13)
    } finally {
      await proxy.close()
      await new Promise<void>((done) => fixture.close(() => done()))
    }

    await assert.rejects(() => sendProxyHttp(proxy.port, 'http://example.com/', auth))
  })

  it('enforces shared wall-clock deadlineMs across slow DNS/redirects in fetchWebContextUrl', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/r1') {
        setTimeout(() => {
          res.writeHead(302, { Location: 'http://example.test/r2' })
          res.end()
        }, 400)
        return
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('late-body')
      }, 400)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const serverPort = (server.address() as net.AddressInfo).port
    try {
      await assert.rejects(
        () =>
          fetchWebContextUrl('http://example.test/r1', {
            timeoutMs: 1_500,
            deadlineMs: Date.now() + 550,
            lookup: fakeLookup('93.184.216.34'),
            connectSocket: () => net.connect({ host: '127.0.0.1', port: serverPort }),
          }),
        /timed out/,
      )
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
})
