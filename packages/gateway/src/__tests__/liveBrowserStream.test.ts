import * as assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  LIVE_BROWSER_ASSERTION_HEADER,
  LIVE_BROWSER_INTERNAL_WS_PATH,
  LIVE_BROWSER_PROTOCOL_VERSION,
  decodeLiveBrowserFrame,
  encodeAuthorityKeyring,
} from '@openclaude/protocol'
import { signLiveBrowserAssertion } from '@openclaude/protocol/containerPreviewAuth'
import { WebSocket } from 'ws'

import { LiveBrowserController, LiveBrowserError } from '../liveBrowserController.js'
import {
  acquireHumanTakeoverLease,
  assertLiveBrowserUrlPublic,
  isPrivateOrReservedIp,
  readActiveHumanTakeoverLease,
  releaseHumanTakeoverLease,
  renewHumanTakeoverLease,
} from '../liveBrowserSecurity.js'
import {
  LiveBrowserStreamManager,
  type LiveBrowserCdpTransport,
  discoverLiveBrowserCdpEndpoint,
  resolveLiveBrowserKeyEvent,
} from '../liveBrowserStream.js'

function makeTestJpeg(width = 640, height = 360): Buffer {
  // Minimal valid JPEG SOI + SOF0 header with exact width/height + EOI
  const buf = Buffer.alloc(20)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  buf[3] = 0xc0
  buf.writeUInt16BE(11, 4) // segment length
  buf[6] = 8 // precision
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  buf[11] = 1
  buf[12] = 1
  buf[13] = 0x11
  buf[14] = 0
  buf[15] = 0xff
  buf[16] = 0xd9
  return buf.subarray(0, 17)
}

function makeEd25519Signer(keyId = 'mak1_0123456789abcdef') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const rawPub = new Uint8Array(Buffer.from(jwk.x, 'base64url'))
  const keyring = new Map<string, Uint8Array>([[keyId, rawPub]])
  return {
    keyId,
    privateKey,
    keyringEnv: encodeAuthorityKeyring(keyring),
  }
}

class MockCdpTransport implements LiveBrowserCdpTransport {
  readonly calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  private readonly eventHandlers = new Set<(method: string, params: any, sessionId?: string) => void>()
  private readonly closeHandlers = new Set<() => void>()
  targets = [
    { targetId: 't-1', type: 'page', title: 'Initial Page', url: 'https://example.com/' },
  ]
  closed = false

  async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> {
    this.calls.push({ method, params, sessionId })
    switch (method) {
      case 'Target.getTargets':
        return { targetInfos: this.targets }
      case 'Target.attachToTarget':
        return { sessionId: `sid-${String(params?.targetId ?? 't-1')}` }
      case 'Target.createTarget': {
        const id = `t-${this.targets.length + 1}`
        const target = { targetId: id, type: 'page', title: 'New Tab', url: String(params?.url ?? 'about:blank') }
        this.targets.push(target)
        return { targetId: id }
      }
      case 'Target.closeTarget':
        this.targets = this.targets.filter((t) => t.targetId !== params?.targetId)
        return { success: true }
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: { clientWidth: 1000, clientHeight: 500 } }
      case 'Page.getNavigationHistory':
        return {
          currentIndex: 1,
          entries: [
            { id: 10, url: 'https://prev.example.com/' },
            { id: 11, url: 'https://example.com/' },
            { id: 12, url: 'https://next.example.com/' },
          ],
        }
      case 'Page.captureScreenshot':
        return { data: makeTestJpeg(1000, 500).toString('base64') }
      case 'Browser.getWindowForTarget':
        return { windowId: 7 }
      default:
        return {}
    }
  }

  emitEvent(method: string, params: any, sessionId?: string): void {
    for (const h of this.eventHandlers) h(method, params, sessionId)
  }

  onEvent(handler: (method: string, params: any, sessionId?: string) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const h of this.closeHandlers) h()
  }
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const val = fn()
    if (val) return val
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('timed out waiting for condition')
}

describe('liveBrowserSecurity', () => {
  it('blocks private IPv4/IPv6/mapped-IPv6/NAT64 literals and DNS rebinding to private IPs', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.2.3.4',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '64:ff9b::10.0.0.1',
    ]) {
      assert.equal(isPrivateOrReservedIp(ip), true, `expected ${ip} to be private`)
    }
    assert.equal(isPrivateOrReservedIp('93.184.216.34'), false)
    assert.equal(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946'), false)

    await assert.rejects(
      () =>
        assertLiveBrowserUrlPublic('https://evil-rebind.example.com/', {
          lookup: (async () => [{ address: '169.254.169.254', family: 4 }]) as any,
        }),
      (err: unknown) => err instanceof LiveBrowserError && err.code === 'UNSAFE_URL',
    )

      const ok = await assertLiveBrowserUrlPublic('https://public.example.com/page', {
      lookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
    })
    assert.equal(ok, 'https://public.example.com/page')

    // P1 #3: DNS lookup errors and empty records MUST fail-closed with UNSAFE_URL
    await assert.rejects(
      () =>
        assertLiveBrowserUrlPublic('https://nxdomain.example.invalid/', {
          lookup: (async () => {
            throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
          }) as any,
        }),
      (err: unknown) => err instanceof LiveBrowserError && err.code === 'UNSAFE_URL',
    )
    await assert.rejects(
      () =>
        assertLiveBrowserUrlPublic('https://empty.example.invalid/', {
          lookup: (async () => []) as any,
        }),
      (err: unknown) => err instanceof LiveBrowserError && err.code === 'UNSAFE_URL',
    )
  })

  it('acquires, renews, expires, and token-guards human takeover leases atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lb-lease-'))
    try {
      const now = 1_700_000_000_000
      const lease = acquireHumanTakeoverLease(dir, { token: 'tok-a', ttlMs: 90_000, now })
      assert.equal(lease.token, 'tok-a')
      assert.equal(lease.expiresAt, now + 90_000)

      assert.equal(readActiveHumanTakeoverLease(dir, now + 10_000)?.token, 'tok-a')
      assert.equal(readActiveHumanTakeoverLease(dir, now + 90_001), null)

      // P1 #5 + R2 #5: strictly mutually exclusive acquire; missing or wrong token cannot overwrite, renew, or release
      assert.throws(
        () => acquireHumanTakeoverLease(dir, { now: now + 5_000 }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'TAKEOVER_ALREADY_HELD',
      )
      assert.throws(
        () => acquireHumanTakeoverLease(dir, { token: 'tok-b', now: now + 5_000 }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'TAKEOVER_ALREADY_HELD',
      )
      assert.equal(renewHumanTakeoverLease(dir, 'tok-b', { now: now + 5_000 }), null)
      assert.equal(releaseHumanTakeoverLease(dir, undefined, now + 5_000), false)
      assert.equal(releaseHumanTakeoverLease(dir, 'tok-b', now + 5_000), false)
      assert.equal(readActiveHumanTakeoverLease(dir, now + 5_000)?.token, 'tok-a')

      // Owner token renews and releases cleanly
      const renewed = renewHumanTakeoverLease(dir, 'tok-a', { ttlMs: 90_000, now: now + 20_000 })
      assert.equal(renewed?.expiresAt, now + 110_000)
      assert.equal(releaseHumanTakeoverLease(dir, 'tok-a', now + 20_000), true)
      assert.equal(readActiveHumanTakeoverLease(dir, now + 20_000), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('liveBrowserStream', () => {
  it('discovers DevToolsActivePort from <stateDir>/profile-dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'lb-cdp-disc-'))
    try {
      const stateDir = join(root, 'state')
      const profileDir = join(root, 'profile')
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(stateDir, 'profile-dir'), `${profileDir}\n`)
      writeFileSync(join(profileDir, 'DevToolsActivePort'), '41234\n/devtools/browser/abc-123\n')

      const endpoint = discoverLiveBrowserCdpEndpoint(stateDir)
      assert.deepEqual(endpoint, {
        port: 41234,
        browserWsUrl: 'ws://127.0.0.1:41234/devtools/browser/abc-123',
        profileDir,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('authenticates signed assertion, streams OCLB frames, dispatches CDP inputs/dialogs/tabs, and cleans up lease', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'lb-stream-'))
    const mockCdp = new MockCdpTransport()
    const signer = makeEd25519Signer()
    let touched = 0
    const env: NodeJS.ProcessEnv = {
      OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
      OC_MODEL_AUTHORITY_KEYRING: signer.keyringEnv,
      OC_USER_ID: '42',
      OC_CONTAINER_ID: '99',
    }

    const manager = new LiveBrowserStreamManager({
      getEnv: () => env,
      stateDirFor: () => stateDir,
      touchActivity: () => {
        touched += 1
      },
      isAgentBusy: () => false,
      openBrowser: async () => {},
      closeBrowser: async () => {},
      discoverCdpEndpoint: () => ({
        port: 9222,
        browserWsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
        profileDir: stateDir,
      }),
      connectCdp: async () => mockCdp,
      dnsLookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
      settledDelayMs: 30,
      motionIntervalMs: 0,
    })

    const server: Server = createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const sign = (sessionId: string) =>
      signLiveBrowserAssertion(
        {
          v: LIVE_BROWSER_PROTOCOL_VERSION,
          keyId: signer.keyId,
          uid: 42,
          containerId: 99,
          agentId: 'main',
          sessionId,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 20_000,
        },
        signer.privateKey,
      )

    try {
      // Missing assertion rejected with 403
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const bad = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`)
            bad.once('open', () => resolve())
            bad.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            bad.once('error', reject)
          }),
        /HTTP 403/,
      )

      const assertion1 = sign('11111111111111111111111111111111')
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { [LIVE_BROWSER_ASSERTION_HEADER]: assertion1 },
      })
      const jsonMsgs: any[] = []
      const binaryFrames: ReturnType<typeof decodeLiveBrowserFrame>[] = []
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          binaryFrames.push(decodeLiveBrowserFrame(Buffer.from(data as any)))
        } else {
          jsonMsgs.push(JSON.parse(data.toString()))
        }
      })

      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })

      // Replay of same sessionId must be rejected with 403
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const replay = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
              headers: { [LIVE_BROWSER_ASSERTION_HEADER]: assertion1 },
            })
            replay.once('open', () => resolve())
            replay.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            replay.once('error', reject)
          }),
        /HTTP 403/,
      )

      // Wait for ready (emitted AFTER real CDP handshake & target attach per R2 #7) + settled screenshot
      const readyMsg = await waitFor(() => jsonMsgs.find((m) => m.type === 'ready'))
      assert.equal(readyMsg.state.active, true)
      assert.equal(readyMsg.state.cdpAvailable, true)
      assert.equal(readyMsg.state.targetId, 't-1')
      const settledFrame = await waitFor(() => binaryFrames.find((f) => f.settled === true))
      assert.equal(settledFrame.width, 1000)
      assert.equal(settledFrame.height, 500)
      assert.equal(settledFrame.format, 'jpeg')
      assert.equal(settledFrame.navGen, readyMsg.state.navGen & 0xffff)

      // Screencast frame emits ACK + motion OCLB frame
      mockCdp.emitEvent(
        'Page.screencastFrame',
        {
          sessionId: 77,
          data: makeTestJpeg(1000, 500).toString('base64'),
          metadata: { deviceWidth: 1000, deviceHeight: 500 },
        },
        'sid-t-1',
      )
      await waitFor(() =>
        mockCdp.calls.find((c) => c.method === 'Page.screencastFrameAck' && c.params?.sessionId === 77),
      )
      await waitFor(() => binaryFrames.find((f) => f.settled === false))

      // Takeover acquires lease file
      ws.send(JSON.stringify({ type: 'takeover', active: true }))
      await waitFor(() => readActiveHumanTakeoverLease(stateDir))

      // Pointer drag (down -> move with buttons bitmask -> up), wheel, key, insert_text (Chinese IME)
      ws.send(JSON.stringify({ type: 'pointer', action: 'down', x: 0.25, y: 0.5, button: 'left' }))
      ws.send(JSON.stringify({ type: 'pointer', action: 'move', x: 0.5, y: 0.5 }))
      ws.send(JSON.stringify({ type: 'pointer', action: 'up', x: 0.5, y: 0.5, button: 'left' }))
      ws.send(JSON.stringify({ type: 'wheel', x: 0.5, y: 0.5, deltaX: 0, deltaY: 120 }))
      ws.send(JSON.stringify({ type: 'key', action: 'press', key: 'a', modifiers: { ctrl: true } }))
      ws.send(JSON.stringify({ type: 'insert_text', text: '中文输入测试' }))

      await waitFor(() => mockCdp.calls.find((c) => c.method === 'Input.insertText'))
      const moveDuringDrag = mockCdp.calls.find(
        (c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseMoved' && c.params?.x === 500,
      )
      assert.equal(moveDuringDrag?.params?.buttons, 1)
      const ctrlA = mockCdp.calls.find(
        (c) => c.method === 'Input.dispatchKeyEvent' && c.params?.key === 'a',
      )
      assert.equal(ctrlA?.params?.modifiers, 2)
      assert.equal(ctrlA?.params?.text, undefined, 'Ctrl shortcut must omit text')
      assert.ok(touched > 0)

      // Dialog event forwarded to client and handled back via CDP
      mockCdp.emitEvent(
        'Page.javascriptDialogOpening',
        { type: 'confirm', message: 'Leave page?', url: 'https://example.com/' },
        'sid-t-1',
      )
      await waitFor(() => jsonMsgs.find((m) => m.type === 'state' && m.dialog?.message === 'Leave page?'))
      ws.send(JSON.stringify({ type: 'dialog', accept: true }))
      await waitFor(() =>
        mockCdp.calls.find((c) => c.method === 'Page.handleJavaScriptDialog' && c.params?.accept === true),
      )

      // SSRF navigate blocked
      ws.send(JSON.stringify({ type: 'navigate', url: 'http://127.0.0.1:18789/' }))
      await waitFor(() => jsonMsgs.find((m) => m.type === 'error' && m.code === 'UNSAFE_URL'))

      // target=_blank popup auto-attaches
      mockCdp.targets.push({
        targetId: 't-popup',
        type: 'page',
        title: 'OAuth Popup',
        url: 'https://accounts.example.com/',
        openerId: 't-1',
      } as any)
      mockCdp.emitEvent('Target.targetCreated', {
        targetInfo: mockCdp.targets[mockCdp.targets.length - 1],
      })
      await waitFor(() =>
        mockCdp.calls.find((c) => c.method === 'Target.attachToTarget' && c.params?.targetId === 't-popup'),
      )

      // Ping -> Pong
      ws.send(JSON.stringify({ type: 'ping', ts: 12345 }))
      const pong = await waitFor(() => jsonMsgs.find((m) => m.type === 'pong' && m.ts === 12345))
      assert.equal(typeof pong.serverTs, 'number')

      // Atomic replacement: second WS replaces first; closing first must NOT wipe second's takeover lease
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { [LIVE_BROWSER_ASSERTION_HEADER]: sign('22222222222222222222222222222222') },
      })
      const ws1Closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
      await new Promise<void>((resolve, reject) => {
        ws2.once('open', () => resolve())
        ws2.once('error', reject)
      })
      assert.equal(await ws1Closed, 4001)
      ws2.send(JSON.stringify({ type: 'takeover', active: true }))
      await waitFor(() => readActiveHumanTakeoverLease(stateDir))

      // Shutdown closes ws2 and releases takeover lease
      await manager.shutdown()
      assert.equal(readActiveHumanTakeoverLease(stateDir), null)
    } finally {
      await manager.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('controller handles flock busy gracefully (agentBusy on GET, 409 on POST & takeover) and propagates OPENCLAUDE_LIVE_BROWSER_INTERNAL=1', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'lb-ctrl-busy-'))
    try {
      const seenInternalEnv: Array<string | undefined> = []
      let lockBusy = true
      const ctrl = new LiveBrowserController({
        ocBrowserBin: '/usr/local/bin/oc-browser',
        stateRoot,
        existsSync: () => true,
        execFn: async (_bin, _args, opts) => {
          seenInternalEnv.push(opts.env.OPENCLAUDE_LIVE_BROWSER_INTERNAL)
          return { stdout: '', stderr: '' }
        },
        resolveDaemonEndpoint: (stateDir) => ({ socketPath: join(stateDir, 'x.sock'), version: '0.1.14', stateDir }),
        daemonRpcFn: async () => ({ text: '' }),
        withLock: async (_dir, fn) => {
          if (lockBusy) throw new Error('activity lock busy (flock exit 1)')
          return fn()
        },
        dnsLookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
      })

      const live = await ctrl.getLiveState('main')
      assert.equal(live.active, true)
      assert.equal(live.agentBusy, true)
      assert.equal(live.streamAvailable, true)

      // OCV5-873 Blocker 1: takeover MUST fail 409 AGENT_RUNNING when activity.lock is held by CLI
      await assert.rejects(
        () => ctrl.performAction('main', { action: 'takeover', active: true }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'AGENT_RUNNING',
      )

      // Release lock to acquire takeover, then re-engage lockBusy to verify reload gets 409 AGENT_RUNNING
      lockBusy = false
      const acquired = await ctrl.performAction('main', { action: 'takeover', active: true })
      assert.equal(acquired.humanTakeover, true)
      assert.equal(typeof acquired.takeoverToken, 'string')

      lockBusy = true
      await assert.rejects(
        () => ctrl.performAction('main', { action: 'reload', takeoverToken: acquired.takeoverToken }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'AGENT_RUNNING',
      )
      lockBusy = false

      // Release without token or wrong token fails with 409 TAKEOVER_TOKEN_MISMATCH
      await assert.rejects(
        () => ctrl.performAction('main', { action: 'takeover', active: false }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'TAKEOVER_TOKEN_MISMATCH',
      )
      await assert.rejects(
        () => ctrl.performAction('main', { action: 'takeover', active: false, token: 'wrong-tok' }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'TAKEOVER_TOKEN_MISMATCH',
      )
      // Renew + release with owning token succeeds
      const renewed = await ctrl.performAction('main', { action: 'takeover', active: true, token: acquired.takeoverToken })
      assert.equal(renewed.takeoverToken, acquired.takeoverToken)
      const released = await ctrl.performAction('main', { action: 'takeover', active: false, token: acquired.takeoverToken })
      assert.equal(released.humanTakeover, false)

      // P1 #7: HTTP close rejected when agent is running
      ctrl.setAgentRunningCheck(() => true)
      await assert.rejects(
        () => ctrl.performAction('main', { action: 'close' }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'AGENT_RUNNING',
      )
      ctrl.setAgentRunningCheck(() => false)

      // Close requires takeover when browser is active, and invokes execFn with OPENCLAUDE_LIVE_BROWSER_INTERNAL=1
      const closeLease = await ctrl.performAction('main', { action: 'takeover', active: true })
      await ctrl.performAction('main', { action: 'close', takeoverToken: closeLease.takeoverToken })
      assert.equal(seenInternalEnv[0], '1')
    } finally {
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })

  it('P1 #2, #3, #4, #7, #12, #16, #17, #18, #19: standalone auth/origin, Fetch SSRF, origin fence, CDP_UNAVAILABLE, keys, and tab sync/idempotency', async () => {
    // P1 #16: key + code + modifiers & legacy combo string mapping
    const shiftTabNative = resolveLiveBrowserKeyEvent('Tab', 'Tab', undefined, 8)
    assert.equal(shiftTabNative.def.key, 'Tab')
    assert.equal(shiftTabNative.def.keyCode, 9)
    assert.equal(shiftTabNative.modifiers, 8)
    const shiftTabCombo = resolveLiveBrowserKeyEvent('Shift+Tab')
    assert.equal(shiftTabCombo.def.key, 'Tab')
    assert.equal(shiftTabCombo.def.keyCode, 9)
    assert.equal(shiftTabCombo.modifiers, 8)
    const ctrlACombo = resolveLiveBrowserKeyEvent('Control+a')
    assert.equal(ctrlACombo.def.key, 'a')
    assert.equal(ctrlACombo.def.code, 'KeyA')
    assert.equal(ctrlACombo.def.keyCode, 65)
    assert.equal(ctrlACombo.modifiers, 2)

    const stateDir = mkdtempSync(join(tmpdir(), 'lb-p1-all-'))
    const mockCdp = new MockCdpTransport()
    mockCdp.targets = [
      { targetId: 't-a', type: 'page', title: 'Tab A', url: 'https://a.example.com/' },
      { targetId: 't-b', type: 'page', title: 'Tab B', url: 'https://b.example.com/' },
    ]
    let agentBusy = false
    let cdpEndpointAvailable = false
    const syncedTabs: Array<{ agentId: string; index: number; url?: string }> = []

    const manager = new LiveBrowserStreamManager({
      getEnv: () => ({}),
      stateDirFor: () => stateDir,
      touchActivity: () => {},
      isAgentBusy: () => agentBusy,
      isBrowserProcessActive: () => true,
      openBrowser: async () => {},
      closeBrowser: async () => {},
      syncDaemonTab: async (agentId, op) => {
        syncedTabs.push({ agentId, index: op.index, url: op.url })
      },
      checkHttpAuth: (req) => req.headers.authorization === 'Bearer local-ok',
      discoverCdpEndpoint: () =>
        cdpEndpointAvailable
          ? { port: 9222, browserWsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock', profileDir: stateDir }
          : null,
      connectCdp: async () => mockCdp,
      dnsLookup: (async (host: string) => {
        if (host.includes('private')) return [{ address: '10.0.0.5', family: 4 }]
        return [{ address: '93.184.216.34', family: 4 }]
      }) as any,
      settledDelayMs: 20,
      motionIntervalMs: 0,
    })

    const server: Server = createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      // P1 #2: unauthenticated loopback rejected with 401
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`)
            ws.once('open', () => resolve())
            ws.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            ws.once('error', reject)
          }),
        /HTTP 401/,
      )

      // P1 #2: cross-site Origin rejected with 403 even with valid Bearer token
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
              headers: { authorization: 'Bearer local-ok' },
              origin: 'https://evil.example.com',
            })
            ws.once('open', () => resolve())
            ws.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            ws.once('error', reject)
          }),
        /HTTP 403/,
      )

      // P1 #12: active legacy browser without CDP reports active=true, cdpAvailable=false + CDP_UNAVAILABLE
      const wsLegacy = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { authorization: 'Bearer local-ok' },
        origin: `http://127.0.0.1:${port}`,
      })
      const legacyMsgs: any[] = []
      wsLegacy.on('message', (data, isBinary) => {
        if (!isBinary) legacyMsgs.push(JSON.parse(data.toString()))
      })
      await new Promise<void>((resolve, reject) => {
        wsLegacy.once('open', () => resolve())
        wsLegacy.once('error', reject)
      })
      const readyLegacy = await waitFor(() => legacyMsgs.find((m) => m.type === 'ready'))
      assert.equal(readyLegacy.state.active, true)
      assert.equal(readyLegacy.state.cdpAvailable, false)
      await waitFor(() => legacyMsgs.find((m) => m.type === 'error' && m.code === 'CDP_UNAVAILABLE'))
      wsLegacy.close()

      // Now enable CDP endpoint and connect
      cdpEndpointAvailable = true
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { authorization: 'Bearer local-ok' },
        origin: `http://127.0.0.1:${port}`,
      })
      const msgs: any[] = []
      ws.on('message', (data, isBinary) => {
        if (!isBinary) msgs.push(JSON.parse(data.toString()))
      })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })

      const readyActive = await waitFor(() => msgs.find((m) => m.type === 'ready'))
      const activeState = readyActive.state
      assert.equal(activeState.active, true)
      assert.equal(activeState.cdpAvailable, true)
      assert.equal(activeState.targetId, 't-b')
      assert.equal(activeState.origin, 'https://b.example.com')
      assert.equal(typeof activeState.navGen, 'number')

      // P1 #3: Fetch.enable was installed; private requestPaused -> Fetch.failRequest, public -> Fetch.continueRequest
      assert.ok(mockCdp.calls.some((c) => c.method === 'Fetch.enable'))
      mockCdp.emitEvent('Fetch.requestPaused', { requestId: 'req-priv', request: { url: 'http://private.internal.test/secret' } }, 'sid-t-b')
      mockCdp.emitEvent('Fetch.requestPaused', { requestId: 'req-pub', request: { url: 'https://public.example.com/app.js' } }, 'sid-t-b')
      await waitFor(() => mockCdp.calls.find((c) => c.method === 'Fetch.failRequest' && c.params?.requestId === 'req-priv'))
      await waitFor(() => mockCdp.calls.find((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'req-pub'))

      // OCV5-873 Blocker 2: watching mode (no takeover) MUST reject mutating WS ops with TAKEOVER_REQUIRED
      const callsBeforeWatchReject = mockCdp.calls.length
      for (const watchMsg of [
        { type: 'tab', action: 'close', targetId: 't-a' },
        { type: 'navigate', url: 'https://other.example.com/' },
        { type: 'pointer', action: 'click', x: 0.5, y: 0.5 },
        { type: 'open', url: 'https://other.example.com/' },
        { type: 'close_browser' },
      ]) {
        const errBefore = msgs.filter((m) => m.type === 'error' && m.code === 'TAKEOVER_REQUIRED').length
        ws.send(JSON.stringify(watchMsg))
        await waitFor(
          () => msgs.filter((m) => m.type === 'error' && m.code === 'TAKEOVER_REQUIRED').length > errBefore,
        )
      }
      assert.equal(
        mockCdp.calls
          .slice(callsBeforeWatchReject)
          .some((c) => c.method.startsWith('Input.') || c.method === 'Target.closeTarget' || c.method === 'Page.navigate'),
        false,
        'watching-mode rejected writes must not mutate CDP state',
      )
      assert.equal(mockCdp.targets.length, 2)

      // Enter takeover before running interactive write tests
      ws.send(JSON.stringify({ type: 'takeover', active: true }))
      await waitFor(() => msgs.find((m) => m.type === 'state' && m.humanTakeover === true))

      // P1 #4: ORIGIN_MISMATCH blocks input when expectedOrigin or expectedTargetId mismatches
      const inputCallsBefore = mockCdp.calls.filter((c) => c.method.startsWith('Input.')).length
      ws.send(JSON.stringify({ type: 'insert_text', text: 'secret-pw', expectedOrigin: 'https://a.example.com', expectedTargetId: 't-b' }))
      await waitFor(() => msgs.find((m) => m.type === 'error' && m.code === 'ORIGIN_MISMATCH'))
      assert.equal(mockCdp.calls.filter((c) => c.method.startsWith('Input.')).length, inputCallsBefore)

      // P1 #18: unknown targetId -> TAB_NOT_FOUND (no fallback closing active tab)
      ws.send(JSON.stringify({ type: 'tab', action: 'close', targetId: 't-nonexistent' }))
      await waitFor(() => msgs.find((m) => m.type === 'error' && m.code === 'TAB_NOT_FOUND'))

      // P1 #19: re-selecting already-attached targetId 't-b' is idempotent (no duplicate attachToTarget)
      const attachCountBefore = mockCdp.calls.filter((c) => c.method === 'Target.attachToTarget').length
      ws.send(JSON.stringify({ type: 'tab', action: 'select', targetId: 't-b' }))
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(mockCdp.calls.filter((c) => c.method === 'Target.attachToTarget').length, attachCountBefore)

      // P1 #17: switching to 't-a' attaches 't-a' and calls syncDaemonTab with index 0 + URL of Tab A
      ws.send(JSON.stringify({ type: 'tab', action: 'select', targetId: 't-a' }))
      await waitFor(() => syncedTabs.find((s) => s.url === 'https://a.example.com/'))
      assert.equal(syncedTabs[syncedTabs.length - 1]!.index, 0)

      // P1 #7: close_browser rejected when agentBusy is true
      agentBusy = true
      ws.send(JSON.stringify({ type: 'close_browser' }))
      await waitFor(() => msgs.find((m) => m.type === 'error' && m.code === 'AGENT_RUNNING'))
      agentBusy = false

      ws.close()
    } finally {
      await manager.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('R2 #1-#10: full-origin port check, commercial master guard, fresh DNS & strict Fetch/tab-new, navGen frame+fence, exclusive takeover, aborted open guard, deferred ready, duplicate about:blank tab sync, targetDestroyed recovery, and tab/close targetId requirement', async () => {
    // R2 #3: no positive DNS host cache — immediate rebind to private IP is blocked on 2nd lookup
    let dnsCalls = 0
    const rebindLookup = (async () => {
      dnsCalls += 1
      return dnsCalls === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.9', family: 4 }]
    }) as any
    await assertLiveBrowserUrlPublic('https://rebind.example.com/', { lookup: rebindLookup })
    await assert.rejects(
      () => assertLiveBrowserUrlPublic('https://rebind.example.com/', { lookup: rebindLookup }),
      (err: unknown) => err instanceof LiveBrowserError && err.code === 'UNSAFE_URL',
    )
    assert.equal(dnsCalls, 2)

    const stateDir = mkdtempSync(join(tmpdir(), 'lb-r2-all-'))
    const mockCdp = new MockCdpTransport()
    mockCdp.targets = [
      { targetId: 't-a', type: 'page', title: 'Page A', url: 'https://a.example.com/' },
      { targetId: 't-popup', type: 'page', title: 'Popup B', url: 'https://popup.example.com/' },
    ]
    let failConnect = true
    let failFetchEnable = false
    let openCalls = 0
    let releaseSlowConnect: ((cdp: LiveBrowserCdpTransport) => void) | null = null
    let slowConnectMode = false

    const origSend = mockCdp.send.bind(mockCdp)
    mockCdp.send = async (method, params, sessionId) => {
      if (method === 'Fetch.enable' && failFetchEnable) {
        throw new Error('Fetch domain denied')
      }
      return origSend(method, params, sessionId)
    }

    const manager = new LiveBrowserStreamManager({
      getEnv: () => ({}),
      stateDirFor: () => stateDir,
      touchActivity: () => {},
      isAgentBusy: () => false,
      isBrowserProcessActive: () => true,
      openBrowser: async () => {
        openCalls += 1
      },
      closeBrowser: async () => {},
      checkHttpAuth: (req) => req.headers.authorization === 'Bearer local-ok',
      discoverCdpEndpoint: () => ({
        port: 9222,
        browserWsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
        profileDir: stateDir,
      }),
      connectCdp: async () => {
        if (slowConnectMode) {
          return new Promise<LiveBrowserCdpTransport>((resolve) => {
            releaseSlowConnect = resolve
          })
        }
        if (failConnect) throw new Error('ECONNREFUSED stale DevToolsActivePort')
        return mockCdp
      },
      dnsLookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
      settledDelayMs: 25,
      motionIntervalMs: 0,
    })

    const server: Server = createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      // R2 #1: different loopback port or mismatched scheme rejected with 403
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const badPort = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
              headers: { authorization: 'Bearer local-ok' },
              origin: `http://127.0.0.1:${port + 1}`,
            })
            badPort.once('open', () => resolve())
            badPort.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            badPort.once('error', reject)
          }),
        /HTTP 403/,
      )
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const badScheme = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
              headers: { authorization: 'Bearer local-ok' },
              origin: `https://127.0.0.1:${port}`,
            })
            badScheme.once('open', () => resolve())
            badScheme.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            badScheme.once('error', reject)
          }),
        /HTTP 403/,
      )

      // R2 #2: commercial master mode rejects standalone fallback even with valid Bearer + Origin
      manager.setCommercialMasterMode(true)
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const wsMaster = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
              headers: { authorization: 'Bearer local-ok' },
              origin: `http://127.0.0.1:${port}`,
            })
            wsMaster.once('open', () => resolve())
            wsMaster.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            wsMaster.once('error', reject)
          }),
        /HTTP 403/,
      )
      manager.setCommercialMasterMode(false)

      // R2 #7: stale DevToolsActivePort (connectCdp fails while browser active) emits ready(active:true, cdpAvailable:false) + CDP_UNAVAILABLE
      const wsStale = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { authorization: 'Bearer local-ok' },
        origin: `http://127.0.0.1:${port}`,
      })
      const staleMsgs: any[] = []
      wsStale.on('message', (data, isBinary) => {
        if (!isBinary) staleMsgs.push(JSON.parse(data.toString()))
      })
      await new Promise<void>((resolve, reject) => {
        wsStale.once('open', () => resolve())
        wsStale.once('error', reject)
      })
      const staleReady = await waitFor(() => staleMsgs.find((m) => m.type === 'ready'))
      assert.equal(staleReady.state.active, true)
      assert.equal(staleReady.state.cdpAvailable, false)
      await waitFor(() => staleMsgs.find((m) => m.type === 'error' && m.code === 'CDP_UNAVAILABLE'))
      wsStale.close()
      await new Promise((r) => setTimeout(r, 30))

      // R2 #6: closing WS while connectCdp is pending ('aborted') must NOT invoke openBrowser
      slowConnectMode = true
      const wsAbort = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { authorization: 'Bearer local-ok' },
        origin: `http://127.0.0.1:${port}`,
      })
      await new Promise<void>((resolve, reject) => {
        wsAbort.once('open', () => resolve())
        wsAbort.once('error', reject)
      })
      wsAbort.send(JSON.stringify({ type: 'open', url: 'https://example.com/' }))
      await waitFor(() => Boolean(releaseSlowConnect))
      wsAbort.close()
      await new Promise((r) => setTimeout(r, 30))
      releaseSlowConnect!(new MockCdpTransport())
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(openCalls, 0, 'aborted connectCdp must never fall through to openBrowser')
      slowConnectMode = false

      // R2 #5 (WS side): pre-existing lease held by another connection prevents claiming humanTakeover or dispatching input
      acquireHumanTakeoverLease(stateDir, { token: 'other-holder-token', ttlMs: 90_000 })

      failConnect = false
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { authorization: 'Bearer local-ok' },
        origin: `http://127.0.0.1:${port}`,
      })
      const msgs: any[] = []
      const frames: ReturnType<typeof decodeLiveBrowserFrame>[] = []
      ws.on('message', (data, isBinary) => {
        if (isBinary) frames.push(decodeLiveBrowserFrame(Buffer.from(data as any)))
        else msgs.push(JSON.parse(data.toString()))
      })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      const ready = await waitFor(() => msgs.find((m) => m.type === 'ready'))
      assert.equal(ready.state.active, true)
      assert.equal(ready.state.cdpAvailable, true)
      assert.equal(ready.state.humanTakeover, false)
      assert.equal(ready.state.takeoverToken, undefined)
      assert.equal(ready.state.targetId, 't-popup')

      ws.send(JSON.stringify({ type: 'takeover', active: true }))
      await waitFor(() => msgs.find((m) => m.type === 'error' && m.code === 'TAKEOVER_ALREADY_HELD'))
      assert.equal(msgs.some((m) => m.type === 'state' && m.humanTakeover === true), false)

      ws.send(JSON.stringify({ type: 'insert_text', text: 'blocked-by-other-lease' }))
      await waitFor(() => msgs.find((m) => m.type === 'error' && m.code === 'TAKEOVER_TOKEN_MISMATCH'))

      // Release external lease so this WS can take over cleanly
      releaseHumanTakeoverLease(stateDir, 'other-holder-token')
      ws.send(JSON.stringify({ type: 'takeover', active: true }))
      const ownedState = await waitFor(() => msgs.find((m) => m.type === 'state' && m.humanTakeover === true))
      assert.equal(typeof ownedState.takeoverToken, 'string')

      // R2 #4: binary frame carries navGen; stale expectedNavGen is rejected with ORIGIN_MISMATCH
      const firstFrame = await waitFor(() => frames.find((f) => f.settled === true))
      assert.equal(firstFrame.navGen, ready.state.navGen & 0xffff)
      const inputsBefore = mockCdp.calls.filter((c) => c.method.startsWith('Input.')).length
      ws.send(
        JSON.stringify({
          type: 'insert_text',
          text: 'stale-nav-gen',
          expectedOrigin: 'https://popup.example.com',
          expectedTargetId: 't-popup',
          expectedNavGen: (ready.state.navGen + 1) & 0xffff,
        }),
      )
      await waitFor(() => msgs.find((m) => m.type === 'error' && m.code === 'ORIGIN_MISMATCH'))
      assert.equal(mockCdp.calls.filter((c) => c.method.startsWith('Input.')).length, inputsBefore)

      // R2 #9: active popup B self-destructs (Target.targetDestroyed) -> auto-recovers remaining Page A and streams frames from A
      const framesBeforeDestroy = frames.length
      mockCdp.targets = mockCdp.targets.filter((t) => t.targetId !== 't-popup')
      mockCdp.emitEvent('Target.targetDestroyed', { targetId: 't-popup' })
      const recoveredState = await waitFor(() =>
        msgs.find((m) => m.type === 'state' && m.targetId === 't-a'),
      )
      assert.equal(recoveredState.active, true)
      assert.equal(msgs.some((m) => m.type === 'error' && m.code === 'BROWSER_NOT_ACTIVE'), false)
      const frameFromA = await waitFor(() =>
        frames.slice(framesBeforeDestroy).find((f) => f.navGen === (recoveredState.navGen & 0xffff)),
      )
      assert.equal(frameFromA.width, 1000)

      // R2 #10: WS tab/close without targetId (index-only) rejected with TAB_NOT_FOUND, 0 Target.closeTarget calls
      const closeCallsBefore = mockCdp.calls.filter((c) => c.method === 'Target.closeTarget').length
      ws.send(JSON.stringify({ type: 'tab', action: 'close', index: 0 }))
      await waitFor(() => msgs.find((m) => m.type === 'error' && m.code === 'TAB_NOT_FOUND'))
      assert.equal(mockCdp.calls.filter((c) => c.method === 'Target.closeTarget').length, closeCallsBefore)

      // R2 #3: tab/new ALWAYS creates about:blank -> attaches + Fetch.enable -> ONLY then Page.navigate
      const callIdxStart = mockCdp.calls.length
      ws.send(JSON.stringify({ type: 'tab', action: 'new', url: 'https://new.example.com/landing' }))
      await waitFor(() =>
        mockCdp.calls
          .slice(callIdxStart)
          .find((c) => c.method === 'Page.navigate' && c.params?.url === 'https://new.example.com/landing'),
      )
      const newTabCalls = mockCdp.calls.slice(callIdxStart)
      const createIdx = newTabCalls.findIndex((c) => c.method === 'Target.createTarget')
      const fetchIdx = newTabCalls.findIndex((c) => c.method === 'Fetch.enable')
      const navIdx = newTabCalls.findIndex((c) => c.method === 'Page.navigate')
      assert.equal(newTabCalls[createIdx]?.params?.url, 'about:blank')
      assert.ok(createIdx >= 0 && fetchIdx > createIdx && navIdx > fetchIdx)

      // R2 #3 fail-closed: if Fetch.enable fails on tab/new, Page.navigate MUST NOT be called
      failFetchEnable = true
      const navCallsBefore = mockCdp.calls.filter((c) => c.method === 'Page.navigate').length
      ws.send(JSON.stringify({ type: 'tab', action: 'new', url: 'https://blocked-nav.example.com/' }))
      await waitFor(() => msgs.find((m) => m.type === 'error' && m.code === 'FETCH_GUARD_UNAVAILABLE'))
      assert.equal(mockCdp.calls.filter((c) => c.method === 'Page.navigate').length, navCallsBefore)
      failFetchEnable = false

      ws.close()
    } finally {
      await manager.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('R2 #5 & #8 (controller): exclusive HTTP takeover + token check on input, and duplicate about:blank tab sync selects index 1', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'lb-r2-ctrl-'))
    const rpcCalls: Array<Record<string, unknown>> = []
    const mockCdp = new MockCdpTransport()
    mockCdp.targets = [
      { targetId: 't-blank-0', type: 'page', title: 'about:blank', url: 'about:blank' },
      { targetId: 't-blank-1', type: 'page', title: 'about:blank', url: 'about:blank' },
    ]
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      stateRoot,
      env: {},
      existsSync: () => true,
      execFn: async () => ({ stdout: '', stderr: '' }),
      resolveDaemonEndpoint: (stateDir) => ({
        socketPath: join(stateDir, 'browser.sock'),
        version: '0.1.14',
        stateDir,
      }),
      daemonRpcFn: async (_ep, args) => {
        rpcCalls.push(args)
        const cmd = (args._ as string[])[0]
        if (cmd === 'tab-list') {
          return { text: '- 0: (current) [about:blank](about:blank)\n- 1: [about:blank](about:blank)' }
        }
        return { text: '' }
      },
      withLock: async (_dir, fn) => fn(),
      discoverCdpEndpoint: (stateDir) => ({
        port: 9222,
        browserWsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
        profileDir: stateDir,
      }),
      connectCdp: async () => mockCdp,
      dnsLookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
    })
    ctrl.setUpgradeAuthCheck((req) => req.headers.authorization === 'Bearer ok')

    const server: Server = createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!ctrl.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      // R2 #5: HTTP takeover is strictly mutually exclusive; mismatched takeoverToken on action -> 409
      const firstLease = await ctrl.performAction('main', { action: 'takeover', active: true })
      assert.equal(typeof firstLease.takeoverToken, 'string')
      await assert.rejects(
        () => ctrl.performAction('main', { action: 'takeover', active: true }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'TAKEOVER_ALREADY_HELD',
      )
      await assert.rejects(
        () => ctrl.performAction('main', { action: 'reload', takeoverToken: 'wrong-token' }),
        (err: unknown) => err instanceof LiveBrowserError && err.status === 409 && err.code === 'TAKEOVER_TOKEN_MISMATCH',
      )
      await ctrl.performAction('main', { action: 'takeover', active: false, token: firstLease.takeoverToken })

      // R2 #8: two about:blank tabs — selecting index 1 (t-blank-1) via WS MUST sync `tab-select 1` (not `tab-select 0`)!
      const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { authorization: 'Bearer ok' },
        origin: `http://127.0.0.1:${port}`,
      })
      const msgs: any[] = []
      ws.on('message', (d, isBinary) => {
        if (!isBinary) msgs.push(JSON.parse(d.toString()))
      })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      await waitFor(() => msgs.find((m) => m.type === 'ready'))

      // Acquire takeover before selecting tabs
      ws.send(JSON.stringify({ type: 'takeover', active: true }))
      await waitFor(() => msgs.find((m) => m.type === 'state' && m.humanTakeover === true))

      // First select t-blank-0, then explicitly select t-blank-1 (second about:blank)
      ws.send(JSON.stringify({ type: 'tab', action: 'select', targetId: 't-blank-0' }))
      await waitFor(() => rpcCalls.find((c) => Array.isArray(c._) && c._[0] === 'tab-select' && c._[1] === '0'))
      rpcCalls.length = 0

      ws.send(JSON.stringify({ type: 'tab', action: 'select', targetId: 't-blank-1' }))
      const selectCall = await waitFor(() =>
        rpcCalls.find((c) => Array.isArray(c._) && c._[0] === 'tab-select'),
      )
      assert.deepEqual(selectCall._, ['tab-select', '1'])

      ws.close()
    } finally {
      await ctrl.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })

  it('OCV5-873 Blocker 1 & 2 (WS via controller): WS takeover waits on activity.lock, releases orphan lease if socket closes mid-wait, and close_browser works cleanly in takeover', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'lb-b1-ws-'))
    const mockCdp = new MockCdpTransport()
    let lockHeld = true
    let releaseLock!: () => void
    const lockGate = new Promise<void>((r) => {
      releaseLock = r
    })
    let closeCalls = 0
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      stateRoot,
      env: {},
      existsSync: () => true,
      execFn: async (_bin, args) => {
        if (args[0] === 'close') closeCalls += 1
        return { stdout: '', stderr: '' }
      },
      withLock: async (_dir, fn) => {
        if (lockHeld) await lockGate
        return fn()
      },
      discoverCdpEndpoint: (stateDir) => ({
        port: 9222,
        browserWsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
        profileDir: stateDir,
      }),
      connectCdp: async () => mockCdp,
      dnsLookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
    })
    ctrl.setUpgradeAuthCheck((req) => req.headers.authorization === 'Bearer ok')

    const server: Server = createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!ctrl.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    try {
      // 1) WS takeover blocks while simulated CLI holds activity.lock; closing WS mid-wait releases lease immediately on wake
      const wsDrop = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { authorization: 'Bearer ok' },
        origin: `http://127.0.0.1:${port}`,
      })
      const dropMsgs: any[] = []
      wsDrop.on('message', (d, isBinary) => {
        if (!isBinary) dropMsgs.push(JSON.parse(d.toString()))
      })
      await new Promise<void>((resolve, reject) => {
        wsDrop.once('open', () => resolve())
        wsDrop.once('error', reject)
      })
      await waitFor(() => dropMsgs.find((m) => m.type === 'ready'))

      wsDrop.send(JSON.stringify({ type: 'takeover', active: true }))
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(ctrl.isHumanTakeoverActive('main'), false, 'WS takeover must not coexist with held activity.lock')

      // Close WS while still waiting on lock -> releasing lock must NOT leave an orphan takeover lease
      wsDrop.close()
      await new Promise((r) => setTimeout(r, 30))
      lockHeld = false
      releaseLock()
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(ctrl.isHumanTakeoverActive('main'), false, 'dropped WS must immediately release post-await lease')

      // 2) Active WS in takeover can cleanly close_browser (passes takeoverToken to controller close) and releases lease
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { authorization: 'Bearer ok' },
        origin: `http://127.0.0.1:${port}`,
      })
      const msgs2: any[] = []
      ws2.on('message', (d, isBinary) => {
        if (!isBinary) msgs2.push(JSON.parse(d.toString()))
      })
      await new Promise<void>((resolve, reject) => {
        ws2.once('open', () => resolve())
        ws2.once('error', reject)
      })
      await waitFor(() => msgs2.find((m) => m.type === 'ready'))
      ws2.send(JSON.stringify({ type: 'takeover', active: true }))
      await waitFor(() => msgs2.find((m) => m.type === 'state' && m.humanTakeover === true))

      ws2.send(JSON.stringify({ type: 'close_browser' }))
      await waitFor(() => closeCalls === 1)
      await waitFor(() => !ctrl.isHumanTakeoverActive('main'))
      ws2.close()
    } finally {
      await ctrl.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(stateRoot, { recursive: true, force: true })
    }
  })
})
