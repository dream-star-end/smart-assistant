import assert from 'node:assert/strict'
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  createServer,
  request as httpRequest,
} from 'node:http'
import { after, before, describe, test } from 'node:test'

import {
  CONTAINER_PREVIEW_ASSERTION_HEADER,
  CONTAINER_PREVIEW_DIRECT_BRIDGE_PATH,
  CONTAINER_PREVIEW_DIRECT_PROXY_PATH,
  CONTAINER_PREVIEW_PROTOCOL_VERSION,
  CONTAINER_PREVIEW_TARGET_HEADER,
  CONTAINER_PREVIEW_VIEWPORT_HEADER,
  encodeAuthorityKeyring,
} from '@openclaude/protocol'
import {
  type ContainerPreviewBridgeAssertionPayload,
  containerPreviewAssertionSigningInput,
  containerPreviewTargetHash,
  encodeContainerPreviewAssertion,
} from '@openclaude/protocol/containerPreviewAuth'

import { WebSocket, WebSocketServer } from 'ws'
import {
  ContainerPreviewHandler,
  probeHtmlApplication,
  resolvePlaywrightMcpPackageJson,
  verifyContainerPreviewUpgrade,
} from '../containerPreview.js'

test('explicit Playwright MCP package path is fail-closed', () => {
  assert.throws(
    () => resolvePlaywrightMcpPackageJson('/definitely/missing/playwright-mcp-package.json'),
    /configured Playwright MCP package is unavailable/,
  )
})

const now = 1_780_000_000_000
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicRaw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
const keyId = 'mak1_0123456789abcdef'
const keyringEnv = encodeAuthorityKeyring(new Map([[keyId, publicRaw]]))
const viewport = { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false } as const
const previewEnv = {
  OC_CONTAINER_PREVIEW_ENABLED: '1',
  OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
  OC_USER_ID: '42',
  OC_CONTAINER_ID: '7',
  OC_MODEL_AUTHORITY_KEYRING: keyringEnv,
}

function signedAssertion(over: Partial<ContainerPreviewBridgeAssertionPayload> = {}): string {
  const payload: ContainerPreviewBridgeAssertionPayload = {
    v: CONTAINER_PREVIEW_PROTOCOL_VERSION,
    keyId,
    uid: 42,
    containerId: 7,
    sessionId: 'a'.repeat(32),
    targetHash: containerPreviewTargetHash('http://127.0.0.1:3000/', viewport),
    issuedAt: now,
    expiresAt: now + 30_000,
    ...over,
  }
  return encodeContainerPreviewAssertion(
    payload,
    cryptoSign(null, containerPreviewAssertionSigningInput(payload), privateKey),
  )
}

describe('container preview upgrade authorization', () => {
  const env = {
    OPENCLAUDE_TRUST_BRIDGE_IP: '172.31.0.1',
    OC_USER_ID: '42',
    OC_CONTAINER_ID: '7',
    OC_MODEL_AUTHORITY_KEYRING: keyringEnv,
  }

  function request(remoteAddress: string, assertion = signedAssertion()) {
    return {
      headers: { [CONTAINER_PREVIEW_ASSERTION_HEADER]: assertion },
      socket: { remoteAddress },
    } as unknown as Pick<IncomingMessage, 'headers' | 'socket'>
  }

  test('accepts only a signed, identity-bound assertion from the exact bridge IP', () => {
    const accepted = verifyContainerPreviewUpgrade(request('172.31.0.1'), env, now + 1)
    assert.equal(accepted.sessionId, 'a'.repeat(32))
    assert.equal(accepted.expiresAt, now + 30_000)
    assert.throws(
      () => verifyContainerPreviewUpgrade(request('172.31.0.2'), env, now + 1),
      /wrong bridge source/,
    )
    assert.throws(
      () =>
        verifyContainerPreviewUpgrade(
          request('172.31.0.1', signedAssertion({ uid: 43 })),
          env,
          now + 1,
        ),
      /identity mismatch/,
    )
  })

  test('rejects missing trust configuration and expired assertions', () => {
    assert.throws(() =>
      verifyContainerPreviewUpgrade(
        request('172.31.0.1'),
        { ...env, OPENCLAUDE_TRUST_BRIDGE_IP: '' },
        now,
      ),
    )
    assert.throws(() => verifyContainerPreviewUpgrade(request('172.31.0.1'), env, now + 30_000))
  })
})

test('signed direct HTTP proxy injects the platform bridge and consumes assertions once', async () => {
  let seenHost = ''
  let seenCookie = ''
  const app = createServer((req, res) => {
    seenHost = req.headers.host ?? ''
    seenCookie = req.headers.cookie ?? ''
    const html = '<!doctype html><html><head><title>native</title></head><body>ok</body></html>'
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(html)),
      ETag: 'stale-after-injection',
    })
    res.end(html)
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
  const appAddress = app.address()
  if (!appAddress || typeof appAddress === 'string') throw new Error('app did not bind')
  const targetUrl = `http://127.0.0.1:${appAddress.port}/page?q=1`
  const handler = new ContainerPreviewHandler({ env: previewEnv, now: () => now + 1 })
  const gateway = createServer((req, res) => {
    if (!handler.handleHttp(req, res)) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const gatewayAddress = gateway.address()
  if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('gateway did not bind')

  const assertion = signedAssertion({
    sessionId: 'd'.repeat(32),
    targetHash: containerPreviewTargetHash(targetUrl, viewport),
  })
  const headers = {
    [CONTAINER_PREVIEW_ASSERTION_HEADER]: assertion,
    [CONTAINER_PREVIEW_TARGET_HEADER]: targetUrl,
    [CONTAINER_PREVIEW_VIEWPORT_HEADER]: JSON.stringify(viewport),
    Cookie: '__Host-oc_preview=platform-secret; app_cookie=kept',
  }
  try {
    const response = await httpCall(
      gatewayAddress.port,
      CONTAINER_PREVIEW_DIRECT_PROXY_PATH,
      headers,
    )
    assert.equal(response.status, 200)
    assert.match(
      response.body,
      new RegExp(CONTAINER_PREVIEW_DIRECT_BRIDGE_PATH.replaceAll('/', '\\/')),
    )
    assert.equal(response.headers.etag, undefined)
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body))
    assert.equal(seenHost, `127.0.0.1:${appAddress.port}`)
    assert.equal(seenCookie, 'app_cookie=kept')

    const replay = await httpCall(gatewayAddress.port, CONTAINER_PREVIEW_DIRECT_PROXY_PATH, headers)
    assert.equal(replay.status, 401)
  } finally {
    await handler.shutdown()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await new Promise<void>((resolve) => app.close(() => resolve()))
  }
})

test('signed direct HTTP proxy tears down a streaming target when its downstream closes', async () => {
  let closeTarget!: () => void
  const targetClosed = new Promise<void>((resolve) => {
    closeTarget = resolve
  })
  const app = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    const timer = setInterval(() => res.write('stream-chunk\n'), 5)
    res.once('close', () => {
      clearInterval(timer)
      closeTarget()
    })
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
  const appAddress = app.address()
  if (!appAddress || typeof appAddress === 'string') throw new Error('app did not bind')
  const targetUrl = `http://127.0.0.1:${appAddress.port}/stream`
  const handler = new ContainerPreviewHandler({ env: previewEnv, now: () => now + 1 })
  const gateway = createServer((req, res) => {
    if (!handler.handleHttp(req, res)) res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const gatewayAddress = gateway.address()
  if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('gateway did not bind')
  const headers = {
    [CONTAINER_PREVIEW_ASSERTION_HEADER]: signedAssertion({
      sessionId: 'f'.repeat(32),
      targetHash: containerPreviewTargetHash(targetUrl, viewport),
    }),
    [CONTAINER_PREVIEW_TARGET_HEADER]: targetUrl,
    [CONTAINER_PREVIEW_VIEWPORT_HEADER]: JSON.stringify(viewport),
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gatewayAddress.port,
          path: CONTAINER_PREVIEW_DIRECT_PROXY_PATH,
          headers,
        },
        (res) => {
          res.once('data', () => {
            res.destroy()
            resolve()
          })
        },
      )
      req.once('error', reject)
      req.end()
    })
    await Promise.race([
      targetClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('stream target was not closed')), 500),
      ),
    ])
  } finally {
    await handler.shutdown()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await new Promise<void>((resolve) => app.close(() => resolve()))
  }
})

test('signed direct WebSocket proxy preserves HMR-style upgrades without leaking platform state', async () => {
  let seenOrigin = ''
  let seenCookie = ''
  const app = createServer()
  const appWss = new WebSocketServer({ server: app })
  appWss.on('connection', (socket, req) => {
    seenOrigin = req.headers.origin ?? ''
    seenCookie = req.headers.cookie ?? ''
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`))
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
  const appAddress = app.address()
  if (!appAddress || typeof appAddress === 'string') throw new Error('app did not bind')
  const targetUrl = `http://127.0.0.1:${appAddress.port}/hmr`

  const handler = new ContainerPreviewHandler({ env: previewEnv, now: () => now + 1 })
  const gateway = createServer()
  gateway.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const gatewayAddress = gateway.address()
  if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('gateway did not bind')
  const assertion = signedAssertion({
    sessionId: 'e'.repeat(32),
    targetHash: containerPreviewTargetHash(targetUrl, viewport),
  })
  const client = new WebSocket(
    `ws://127.0.0.1:${gatewayAddress.port}${CONTAINER_PREVIEW_DIRECT_PROXY_PATH}`,
    {
      headers: {
        [CONTAINER_PREVIEW_ASSERTION_HEADER]: assertion,
        [CONTAINER_PREVIEW_TARGET_HEADER]: targetUrl,
        [CONTAINER_PREVIEW_VIEWPORT_HEADER]: JSON.stringify(viewport),
        Cookie: '__Host-oc_preview=platform-secret; hmr_cookie=kept',
        Origin: 'https://alpha-preview.trycloudflare.com',
      },
    },
  )
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    const echoed = await new Promise<string>((resolve, reject) => {
      client.once('message', (data) => resolve(data.toString()))
      client.once('error', reject)
      client.send('hot-update')
    })
    assert.equal(echoed, 'echo:hot-update')
    assert.equal(seenOrigin, `http://127.0.0.1:${appAddress.port}`)
    assert.equal(seenCookie, 'hmr_cookie=kept')
  } finally {
    client.terminate()
    await handler.shutdown()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await new Promise<void>((resolve) => appWss.close(() => resolve()))
    await new Promise<void>((resolve) => app.close(() => resolve()))
  }
})

async function httpCall(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

test('container preview capability is explicit and fail-closed', async () => {
  const disabledEnvs = [
    { ...previewEnv, OC_CONTAINER_PREVIEW_ENABLED: undefined },
    { ...previewEnv, OC_CONTAINER_PREVIEW_ENABLED: '0' },
    {
      ...previewEnv,
      OC_CONTAINER_PREVIEW_ENABLED: undefined,
      OC_RUNTIME_CHANNEL: 'v5',
    },
  ]
  for (const env of disabledEnvs) {
    const handler = new ContainerPreviewHandler({ env })
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/container-preview`)
      ws.once('unexpected-response', (_req, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      ws.once('open', () => reject(new Error('preview opened without its capability flag')))
      ws.once('error', reject)
    })
    assert.equal(status, 503)
    await handler.shutdown()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a fresh signed upgrade replaces the active in-container session', async () => {
  const handler = new ContainerPreviewHandler({
    env: previewEnv,
    now: () => now + 1,
    launcher: { launch: async () => Promise.reject(new Error('launcher must not run')) },
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  const connect = (sessionId: string) =>
    new WebSocket(`ws://127.0.0.1:${address.port}/ws/container-preview`, {
      headers: {
        [CONTAINER_PREVIEW_ASSERTION_HEADER]: signedAssertion({ sessionId }),
      },
    })
  const first = connect('b'.repeat(32))
  await new Promise<void>((resolve, reject) => {
    first.once('open', resolve)
    first.once('error', reject)
  })
  const firstClosed = new Promise<void>((resolve) => first.once('close', () => resolve()))
  const second = connect('c'.repeat(32))
  await new Promise<void>((resolve, reject) => {
    second.once('open', resolve)
    second.once('error', reject)
  })
  await firstClosed
  assert.equal(second.readyState, WebSocket.OPEN)
  second.close()
  await new Promise<void>((resolve) => second.once('close', () => resolve()))
  await handler.shutdown()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('stuck CDP cleanup is bounded, force-kills Chromium and releases the handler', async () => {
  const html = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>cleanup</title>')
  })
  await new Promise<void>((resolve) => html.listen(0, '127.0.0.1', resolve))
  const htmlAddress = html.address()
  if (!htmlAddress || typeof htmlAddress === 'string') throw new Error('HTML server did not bind')
  const targetUrl = `http://127.0.0.1:${htmlAddress.port}/`

  let detachCalls = 0
  let forceCloseCalls = 0
  const never = new Promise<void>(() => {})
  const page = {
    mouse: {
      move: async () => {},
      down: async () => {},
      up: async () => {},
      click: async () => {},
      wheel: async () => {},
    },
    keyboard: { press: async () => {}, insertText: async () => {} },
    goto: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    title: async () => 'cleanup',
    url: () => targetUrl,
    evaluate: async () => null,
    screenshot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    setViewportSize: async () => {},
    close: async () => {},
    on: () => {},
    isClosed: () => false,
    mainFrame: () => page,
  }
  const cdp = {
    send: async () => {},
    on: () => {},
    detach: () => {
      detachCalls += 1
      return never
    },
  }
  const context = {
    route: async () => {},
    routeWebSocket: async () => {},
    addInitScript: async () => {},
    newPage: async () => page,
    newCDPSession: async () => cdp,
    close: async () => {},
    on: () => {},
  }
  const browser = {
    newContext: async () => context,
    close: async () => {},
    forceClose: () => {
      forceCloseCalls += 1
    },
    on: () => {},
  }
  const handler = new ContainerPreviewHandler({
    env: previewEnv,
    now: () => now + 1,
    cleanupTimeoutMs: 30,
    launcher: { launch: async () => browser as any },
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('preview server did not bind')
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/container-preview`, {
    headers: {
      [CONTAINER_PREVIEW_ASSERTION_HEADER]: signedAssertion({
        sessionId: 'd'.repeat(32),
        targetHash: containerPreviewTargetHash(targetUrl, viewport),
      }),
    },
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      const message = JSON.parse(raw.toString())
      if (message.type === 'preview.ready') resolve()
    })
    ws.once('error', reject)
  })
  ws.send(
    JSON.stringify({
      type: 'preview.open',
      protocolVersion: CONTAINER_PREVIEW_PROTOCOL_VERSION,
      url: targetUrl,
      viewport,
    }),
  )
  await ready
  assert.equal(handler.activeCount(), 1)

  const started = Date.now()
  await handler.shutdown()
  assert.ok(Date.now() - started < 250, 'cleanup deadline must bound gateway shutdown')
  assert.equal(detachCalls, 1)
  assert.equal(forceCloseCalls, 1)
  assert.equal(handler.activeCount(), 0)

  ws.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => html.close(() => resolve()))
})

describe('container preview HTML probe', () => {
  let origin = ''
  const server = createServer((req, res) => {
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>ok</title>')
      return
    }
    if (req.url === '/sniff') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('  <html><body>SPA</body></html>')
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/html' })
      res.end()
      return
    }
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.url === '/trickle') {
      res.writeHead(200, { 'content-type': 'text/html' })
      const timer = setInterval(() => res.write(' '), 5)
      res.once('close', () => clearInterval(timer))
      return
    }
    res.writeHead(404).end()
  })

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    origin = `http://127.0.0.1:${address.port}`
  })
  after(async () => new Promise<void>((resolve) => server.close(() => resolve())))

  test('accepts declared/sniffed HTML and same-origin redirects', async () => {
    assert.equal((await probeHtmlApplication(`${origin}/html`, origin)).status, 200)
    assert.equal((await probeHtmlApplication(`${origin}/sniff`, origin)).status, 200)
    assert.equal(
      (await probeHtmlApplication(`${origin}/redirect`, origin)).finalUrl,
      `${origin}/html`,
    )
  })

  test('rejects non-HTML responses and enforces a wall-clock timeout', async () => {
    await assert.rejects(() => probeHtmlApplication(`${origin}/json`, origin), /not an HTML/)
    const started = Date.now()
    await assert.rejects(
      () => probeHtmlApplication(`${origin}/trickle`, origin, { timeoutMs: 80 }),
      /timed out/,
    )
    assert.ok(
      Date.now() - started < 500,
      'trickle response must not hold the slot beyond the deadline',
    )
  })
})
