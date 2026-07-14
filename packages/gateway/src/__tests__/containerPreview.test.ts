import assert from 'node:assert/strict'
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { type IncomingMessage, createServer } from 'node:http'
import { after, before, describe, test } from 'node:test'

import {
  CONTAINER_PREVIEW_ASSERTION_HEADER,
  CONTAINER_PREVIEW_PROTOCOL_VERSION,
  encodeAuthorityKeyring,
} from '@openclaude/protocol'
import {
  type ContainerPreviewBridgeAssertionPayload,
  containerPreviewAssertionSigningInput,
  containerPreviewTargetHash,
  encodeContainerPreviewAssertion,
} from '@openclaude/protocol/containerPreviewAuth'

import { WebSocket } from 'ws'
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
  OC_RUNTIME_CHANNEL: 'v5',
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
