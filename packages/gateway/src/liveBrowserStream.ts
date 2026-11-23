/**
 * Native CDP WebSocket live-stream & real-time interactive takeover server (OCV5-857).
 *
 * Mounts internal `/ws/live-browser` on the container Gateway, attaches to the agent Chrome
 * CDP session with per-hop `Fetch` SSRF enforcement (zero `Runtime.enable`), streams binary
 * `OCLB` frames with capture-time monotonic `seq` and backpressure, dispatches origin-fenced
 * native CDP inputs, syncs tab switches with Playwright CLI daemon, and manages takeover leases.
 */
import { randomBytes } from 'node:crypto'
import type { lookup as dnsLookup } from 'node:dns/promises'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { LIVE_BROWSER_BINARY_HEADER_BYTES, LIVE_BROWSER_INTERNAL_WS_PATH, LIVE_BROWSER_MAX_BINARY_FRAME_BYTES, LIVE_BROWSER_PROTOCOL_VERSION, type BrowserHandoffResumeWhen, type LiveBrowserClientMessage, type LiveBrowserDialogInfo, type LiveBrowserMouseButton, type LiveBrowserServerMessage, type LiveBrowserStatePayload, type LiveBrowserTab, type LiveBrowserViewport, encodeLiveBrowserFrame, liveBrowserModifiersToBitmask, normalizeBrowserHandoffResumeWhen } from '@openclaude/protocol'
import { WebSocket, WebSocketServer } from 'ws'

import { LiveBrowserAutoResumeWatcher } from './liveBrowserAutoResume.js'

import { LiveBrowserUpgradeAuthError, type LiveBrowserCdpEndpoint, type LiveBrowserCdpTransport, type VerifiedLiveBrowserUpgrade, defaultConnectCdp, discoverLiveBrowserCdpEndpoint, extractHttpOrigin, readJpegDimensions, resolveLiveBrowserKeyEvent, safePathname, verifyLiveBrowserUpgrade, writeHttpRejection } from './liveBrowserCdpHelpers.js'
import { DEFAULT_HUMAN_TAKEOVER_TTL_MS, LiveBrowserError, acquireHumanTakeoverLease, assertLiveBrowserUrlPublic, readActiveHumanTakeoverLease, releaseHumanTakeoverLease, renewHumanTakeoverLease } from './liveBrowserSecurity.js'

export { LiveBrowserUpgradeAuthError, type LiveBrowserCdpEndpoint, type LiveBrowserCdpTransport, type VerifiedLiveBrowserUpgrade, discoverLiveBrowserCdpEndpoint, readJpegDimensions, resolveLiveBrowserKeyEvent, verifyLiveBrowserUpgrade }

const MAX_CONTROL_BYTES = 64 * 1024
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024
const MOTION_FRAME_INTERVAL_MS = 70 // ~14 FPS
const SETTLED_SCREENSHOT_MS = 180
const TAKEOVER_RENEW_INTERVAL_MS = 30_000
const TAKEOVER_TOUCH_THROTTLE_MS = 10_000
const ATTACH_POLL_INTERVAL_MS = 1_500
const STATUS_POLL_INTERVAL_MS = 2_000
const ASSERTION_CACHE_CAP = 4_096
const MAX_QUEUED_CONTROLS = 128

export interface LiveBrowserStreamManagerDeps {
  getEnv: () => NodeJS.ProcessEnv
  stateDirFor: (agentId: string) => string
  touchActivity: (agentId: string) => void
  isAgentBusy: (agentId: string) => boolean
  isBrowserProcessActive?: (agentId: string) => boolean
  acquireTakeoverLease?: (
    agentId: string,
    opts: { token: string; ttlMs: number; now: number },
  ) => Promise<{ token: string; expiresAt: number }>
  openBrowser: (agentId: string, url?: string) => Promise<void>
  closeBrowser: (agentId: string, takeoverToken?: string) => Promise<void>
  syncDaemonTab?: (
    agentId: string,
    op: { index: number; url?: string; occurrenceIndex?: number },
  ) => Promise<void>
  checkHttpAuth?: (req: IncomingMessage) => boolean
  isCommercialMaster?: boolean
  now?: () => number
  dnsLookup?: typeof dnsLookup
  discoverCdpEndpoint?: (stateDir: string) => LiveBrowserCdpEndpoint | null
  connectCdp?: (endpoint: LiveBrowserCdpEndpoint) => Promise<LiveBrowserCdpTransport>
  settledDelayMs?: number
  motionIntervalMs?: number
  takeoverTtlMs?: number
  autoResumePollIntervalMs?: number
}

function clampNum(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, v))
}

function mouseButtonMask(button: LiveBrowserMouseButton): number {
  if (button === 'right') return 2
  if (button === 'middle') return 4
  return 1
}

function bounded(text: unknown, maxLen: number): string {
  return typeof text === 'string' ? text.slice(0, maxLen) : ''
}

interface CdpTargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  openerId?: string
}

type CdpAttachResult = 'attached' | 'not_running' | 'aborted'

type ControlQueueItem =
  | { readonly kind: 'client'; readonly raw: unknown }
  | { readonly kind: 'recover_target' }
  | { readonly kind: 'follow_popup'; readonly targetId: string }

class LiveBrowserStreamSession {
  private readonly takeoverToken = randomBytes(16).toString('hex')
  private readonly stateDir: string
  private readonly controlQueue: ControlQueueItem[] = []
  private drainingControl = false
  private readySent = false
  private sessionGen = 0
  private cdp: LiveBrowserCdpTransport | null = null
  private unsubCdpEvents: (() => void) | null = null
  private unsubCdpClose: (() => void) | null = null
  private activeTargetId: string | null = null
  private pageSessionId: string | null = null
  private targets: CdpTargetInfo[] = []
  private viewport: LiveBrowserViewport = { width: 1280, height: 720, deviceScaleFactor: 1 }
  private url = ''
  private title = ''
  private navGen = 0
  private loading = false
  private dialog: LiveBrowserDialogInfo | null = null
  private ownsTakeoverLease = false
  private humanTakeover = false
  private cdpAvailable: boolean | undefined = undefined
  private emittedCdpUnavailable = false
  private pressedButtons = 0
  private lastAgentBusy = false
  private frameSeq = 0
  private lastMotionSentAt = 0
  private lastLeaseRenewAt = 0
  private pendingMotion: { buf: Buffer; seq: number; navGen: number } | null = null
  private pendingBinary: { buf: Buffer; settled: boolean; seq: number; navGen: number } | null = null
  private motionTimer: ReturnType<typeof setTimeout> | null = null
  private settledTimer: ReturnType<typeof setTimeout> | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private leaseRenewTimer: ReturnType<typeof setInterval> | null = null
  private attachPollTimer: ReturnType<typeof setInterval> | null = null
  private statusPollTimer: ReturnType<typeof setInterval> | null = null
  private screenshotInFlight = false
  private screenshotAgain = false
  private attachInFlight: Promise<CdpAttachResult> | null = null
  private pendingResumeWhen: BrowserHandoffResumeWhen | undefined = undefined
  private pendingWatchId: string | undefined = undefined
  private readonly autoResumeWatcher: LiveBrowserAutoResumeWatcher
  private closed = false

  constructor(
    readonly agentId: string,
    private readonly ws: WebSocket,
    private readonly deps: LiveBrowserStreamManagerDeps,
    private readonly onClosed: (session: LiveBrowserStreamSession) => void,
  ) {
    this.stateDir = deps.stateDirFor(agentId)
    this.ownsTakeoverLease = false
    this.humanTakeover = false
    this.lastAgentBusy = this.deps.isAgentBusy(agentId)
    this.autoResumeWatcher = new LiveBrowserAutoResumeWatcher({
      getCdp: () =>
        this.cdp && this.pageSessionId
          ? { cdp: this.cdp, sessionId: this.pageSessionId }
          : null,
      isActive: () => !this.closed && this.humanTakeover && this.ownsTakeoverLease,
      isLoading: () => this.loading,
      getFallbackUrl: () => this.url,
      getFallbackTitle: () => this.title,
      now: () => this.now(),
      pollIntervalMs: this.deps.autoResumePollIntervalMs,
      onReady: (msg) => {
        if (!this.closed && this.humanTakeover && this.ownsTakeoverLease) {
          this.send(msg)
        }
      },
      onVetoed: (msg) => {
        if (!this.closed && this.humanTakeover && this.ownsTakeoverLease) {
          this.send(msg)
        }
      },
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary || this.closed) return
      let parsed: unknown
      try {
        const text = typeof data === 'string' ? data : Buffer.from(data as any).toString('utf8')
        parsed = JSON.parse(text)
      } catch {
        this.sendError('INVALID_JSON', '控制消息不是有效的 JSON', false)
        return
      }
      this.enqueueControl({ kind: 'client', raw: parsed })
    })
    ws.once('close', () => {
      void this.close(1000, 'client closed')
    })
    ws.once('error', () => {
      void this.close(1011, 'socket error')
    })

    // R2 #7: perform real CDP handshake + target attach BEFORE emitting `ready`.
    void this.initialize()

    this.attachPollTimer = setInterval(() => {
      if (this.readySent && !this.cdp && !this.attachInFlight && !this.closed) {
        void this.tryAttachCdp()
      }
    }, ATTACH_POLL_INTERVAL_MS)
    this.attachPollTimer.unref?.()

    this.statusPollTimer = setInterval(() => {
      if (this.closed || !this.readySent) return
      const busy = this.deps.isAgentBusy(this.agentId)
      const activeLease = readActiveHumanTakeoverLease(this.stateDir, this.now())
      const iHoldLease = Boolean(activeLease && activeLease.token === this.takeoverToken)
      if (busy !== this.lastAgentBusy || iHoldLease !== this.ownsTakeoverLease) {
        this.lastAgentBusy = busy
        this.ownsTakeoverLease = iHoldLease
        this.humanTakeover = iHoldLease
        if (!iHoldLease) {
          this.autoResumeWatcher.stop()
          if (this.leaseRenewTimer) {
            clearInterval(this.leaseRenewTimer)
            this.leaseRenewTimer = null
          }
        }
        this.emitState()
      }
    }, STATUS_POLL_INTERVAL_MS)
    this.statusPollTimer.unref?.()
  }

  private async initialize(): Promise<void> {
    const gen = this.sessionGen
    const status = await this.tryAttachCdp(gen)
    if (!this.isAlive(gen)) return
    if (status === 'attached') {
      this.cdpAvailable = true
    } else if (this.deps.isBrowserProcessActive?.(this.agentId)) {
      this.cdpAvailable = false
    }
    this.readySent = true
    this.send({
      type: 'ready',
      protocolVersion: LIVE_BROWSER_PROTOCOL_VERSION,
      agentId: this.agentId,
      state: this.buildStatePayload(),
    })
    if (this.cdpAvailable === false) {
      this.emitCdpUnavailableOnce()
    }
    if (this.controlQueue.length > 0 && !this.drainingControl) {
      void this.drainControlQueue()
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private isAlive(gen: number): boolean {
    return !this.closed && this.sessionGen === gen
  }

  private emitCdpUnavailableOnce(): void {
    if (this.emittedCdpUnavailable || this.closed) return
    this.emittedCdpUnavailable = true
    this.sendError(
      'CDP_UNAVAILABLE',
      '当前浏览器会话不支持实时流，已自动回退到兼容模式',
      false,
    )
  }

  private buildStatePayload(): LiveBrowserStatePayload {
    const pageTargets = this.targets.filter((t) => t.type === 'page')
    const tabs: LiveBrowserTab[] = pageTargets.map((t, idx) => ({
      index: idx,
      id: t.targetId,
      title: bounded(t.title, 160),
      url: bounded(t.url, 2_048),
      active: t.targetId === this.activeTargetId,
    }))
    const cdpAttached = Boolean(this.cdp && this.pageSessionId)
    const active = cdpAttached || Boolean(this.deps.isBrowserProcessActive?.(this.agentId))
    const origin = extractHttpOrigin(this.url)
    const activeLease = readActiveHumanTakeoverLease(this.stateDir, this.now())
    const holdsLease =
      this.ownsTakeoverLease && Boolean(activeLease && activeLease.token === this.takeoverToken)
    this.humanTakeover = holdsLease
    return {
      active,
      agentBusy: this.deps.isAgentBusy(this.agentId),
      humanTakeover: holdsLease,
      url: bounded(this.url, 2_048),
      title: bounded(this.title, 240),
      loading: this.loading,
      viewport: { ...this.viewport },
      tabs,
      dialog: this.dialog,
      capturedAt: this.now(),
      ...(this.activeTargetId ? { targetId: this.activeTargetId } : {}),
      navGen: this.navGen,
      ...(origin ? { origin } : {}),
      ...(this.cdpAvailable !== undefined ? { cdpAvailable: this.cdpAvailable } : {}),
      ...(holdsLease ? { takeoverToken: this.takeoverToken } : {}),
    }
  }

  private emitState(): void {
    this.send({
      type: 'state',
      ...this.buildStatePayload(),
    })
  }

  private send(msg: LiveBrowserServerMessage): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {}
  }

  private sendError(code: string, message: string, retryable = true): void {
    this.send({ type: 'error', code, message, retryable })
  }

  private enqueueControl(item: ControlQueueItem): void {
    if (this.closed) return
    if (item.kind === 'client' && this.controlQueue.length >= MAX_QUEUED_CONTROLS) {
      this.sendError('BROWSER_BUSY', '操作队列已满，请稍后再试', true)
      return
    }
    this.controlQueue.push(item)
    if (this.readySent && !this.drainingControl) {
      void this.drainControlQueue()
    }
  }

  private async drainControlQueue(): Promise<void> {
    if (this.drainingControl) return
    this.drainingControl = true
    const gen = this.sessionGen
    try {
      while (this.controlQueue.length > 0 && this.isAlive(gen)) {
        const next = this.controlQueue.shift()!
        try {
          if (next.kind === 'recover_target') {
            await this.recoverActiveTargetAfterDestroy(gen)
          } else if (next.kind === 'follow_popup') {
            await this.followPopupTarget(next.targetId, gen)
          } else {
            await this.handleMessage(next.raw, gen)
          }
        } catch (err) {
          if (!this.isAlive(gen)) return
          if (next.kind !== 'client') {
            // Internal recovery failure: surface latest state without spurious user action errors.
            this.emitState()
            continue
          }
          if (err instanceof LiveBrowserError) {
            this.sendError(err.code, err.message, err.status >= 500 || err.status === 409)
          } else {
            const msg = err instanceof Error ? err.message : String(err)
            this.sendError('BROWSER_ACTION_FAILED', msg.slice(0, 240), true)
          }
        }
      }
    } finally {
      this.drainingControl = false
    }
  }

  private tryAttachCdp(expectedGen?: number): Promise<CdpAttachResult> {
    const gen = expectedGen ?? this.sessionGen
    if (!this.isAlive(gen)) return Promise.resolve('aborted')
    if (this.cdp) return Promise.resolve('attached')
    if (this.attachInFlight) return this.attachInFlight
    const task = this.runAttachCdp(gen).finally(() => {
      if (this.attachInFlight === task) this.attachInFlight = null
    })
    this.attachInFlight = task
    return task
  }

  private async runAttachCdp(gen: number): Promise<CdpAttachResult> {
    if (!this.isAlive(gen)) return 'aborted'
    const discover = this.deps.discoverCdpEndpoint ?? discoverLiveBrowserCdpEndpoint
    const endpoint = discover(this.stateDir)
    if (!endpoint) {
      if (this.deps.isBrowserProcessActive?.(this.agentId)) {
        const changed = this.cdpAvailable !== false
        this.cdpAvailable = false
        if (this.readySent) {
          if (changed) this.emitState()
          this.emitCdpUnavailableOnce()
        }
      }
      return 'not_running'
    }

    try {
      const connect = this.deps.connectCdp ?? defaultConnectCdp
      const cdp = await connect(endpoint)
      if (!this.isAlive(gen)) {
        cdp.close()
        return 'aborted'
      }
      this.cdp = cdp
      this.unsubCdpEvents = cdp.onEvent((method, params, sessionId) => {
        this.onCdpEvent(method, params, sessionId)
      })
      this.unsubCdpClose = cdp.onClose(() => {
        this.onCdpDisconnected()
      })

      await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
      if (!this.isAlive(gen)) {
        this.detachCdpLocal()
        return 'aborted'
      }
      await this.refreshTargets()
      if (!this.isAlive(gen)) {
        this.detachCdpLocal()
        return 'aborted'
      }
      const firstPage = this.pickBestPageTarget()
      if (firstPage) {
        await this.attachPageTarget(firstPage.targetId, gen)
      }
      if (!this.isAlive(gen)) {
        this.detachCdpLocal()
        return 'aborted'
      }
      this.cdpAvailable = true
      this.emittedCdpUnavailable = false
      if (this.humanTakeover && this.ownsTakeoverLease && this.pendingResumeWhen && !this.autoResumeWatcher.isRunning()) {
        this.autoResumeWatcher.start(this.pendingResumeWhen, this.pendingWatchId)
      }
      if (this.readySent) this.emitState()
      return 'attached'
    } catch {
      this.detachCdpLocal()
      if (!this.isAlive(gen)) return 'aborted'
      if (this.deps.isBrowserProcessActive?.(this.agentId)) {
        const changed = this.cdpAvailable !== false
        this.cdpAvailable = false
        if (this.readySent) {
          if (changed) this.emitState()
          this.emitCdpUnavailableOnce()
        }
      }
      return 'not_running'
    }
  }

  private pickBestPageTarget(): CdpTargetInfo | null {
    const pages = this.targets.filter((t) => t.type === 'page')
    if (pages.length === 0) return null
    if (this.activeTargetId) {
      const existing = pages.find((t) => t.targetId === this.activeTargetId)
      if (existing) return existing
    }
    const nonInternal = pages.filter(
      (t) => !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://'),
    )
    const pool = nonInternal.length > 0 ? nonInternal : pages
    return pool[pool.length - 1] ?? null
  }

  private async refreshTargets(): Promise<void> {
    if (!this.cdp) return
    const res = (await this.cdp.send('Target.getTargets')) as { targetInfos?: unknown[] }
    const infos = Array.isArray(res?.targetInfos) ? res.targetInfos : []
    this.targets = infos
      .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
      .map((t) => ({
        targetId: String(t.targetId ?? ''),
        type: String(t.type ?? ''),
        title: String(t.title ?? ''),
        url: String(t.url ?? ''),
        ...(typeof t.openerId === 'string' ? { openerId: t.openerId } : {}),
      }))
      .filter((t) => t.targetId.length > 0 && t.type === 'page')
  }

  private async attachPageTarget(targetId: string, gen: number): Promise<void> {
    const cdp = this.cdp
    if (!cdp || !this.isAlive(gen)) return

    // P1 #19: re-selecting the already attached target is idempotent; never leak duplicate sessions.
    if (this.activeTargetId === targetId && this.pageSessionId) {
      return
    }

    if (this.pageSessionId && this.activeTargetId !== targetId) {
      const prevSession = this.pageSessionId
      this.pageSessionId = null
      await cdp.send('Page.stopScreencast', {}, prevSession).catch(() => {})
      await cdp.send('Fetch.disable', {}, prevSession).catch(() => {})
      await cdp.send('Target.detachFromTarget', { sessionId: prevSession }).catch(() => {})
    }
    if (!this.isAlive(gen) || this.cdp !== cdp) return

    const attached = (await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId?: unknown }
    if (!this.isAlive(gen) || this.cdp !== cdp) return
    const sessionId = typeof attached?.sessionId === 'string' ? attached.sessionId : ''
    if (!sessionId) throw new Error('failed to attach CDP page target')

    this.activeTargetId = targetId
    this.pageSessionId = sessionId
    this.navGen += 1
    this.dialog = null

    const target = this.targets.find((t) => t.targetId === targetId)
    if (target) {
      this.url = target.url
      this.title = target.title
    }

    try {
      await cdp.send('Page.enable', {}, sessionId)
      // R2 #3: per-hop SSRF enforcement via Fetch domain MUST succeed fail-closed (never swallow).
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId)
    } catch (err) {
      if (this.pageSessionId === sessionId) {
        this.pageSessionId = null
        this.activeTargetId = null
      }
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
      throw new LiveBrowserError(
        502,
        'FETCH_GUARD_UNAVAILABLE',
        err instanceof Error ? `安全网络拦截初始化失败: ${err.message}` : '安全网络拦截初始化失败',
      )
    }
    if (!this.isAlive(gen) || this.pageSessionId !== sessionId) return

    const metrics = (await cdp.send('Page.getLayoutMetrics', {}, sessionId).catch(() => null)) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
      layoutViewport?: { clientWidth?: number; clientHeight?: number }
    } | null
    if (!this.isAlive(gen) || this.pageSessionId !== sessionId) return

    const vp = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport ?? metrics?.layoutViewport
    if (
      vp &&
      typeof vp.clientWidth === 'number' &&
      typeof vp.clientHeight === 'number' &&
      vp.clientWidth >= 64 &&
      vp.clientHeight >= 64
    ) {
      this.viewport = {
        width: Math.round(vp.clientWidth),
        height: Math.round(vp.clientHeight),
        deviceScaleFactor: this.viewport.deviceScaleFactor ?? 1,
      }
    }

    await cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: 72,
        maxWidth: 1440,
        maxHeight: 900,
        everyNthFrame: 1,
      },
      sessionId,
    )
    if (this.isAlive(gen)) {
      this.scheduleSettledScreenshot()
    }
  }

  private async handleFetchRequestPaused(
    params: { requestId?: unknown; request?: { url?: unknown } },
    sessionId: string,
  ): Promise<void> {
    const cdp = this.cdp
    const requestId = typeof params?.requestId === 'string' ? params.requestId : ''
    const rawUrl = typeof params?.request?.url === 'string' ? params.request.url : ''
    if (!cdp || !requestId || this.closed || this.pageSessionId !== sessionId) return

    let allowed = false
    if (
      rawUrl === 'about:blank' ||
      rawUrl.startsWith('data:') ||
      rawUrl.startsWith('blob:')
    ) {
      allowed = true
    } else {
      let checkUrl = rawUrl
      if (rawUrl.startsWith('ws://')) checkUrl = `http://${rawUrl.slice(5)}`
      else if (rawUrl.startsWith('wss://')) checkUrl = `https://${rawUrl.slice(6)}`
      try {
        await assertLiveBrowserUrlPublic(checkUrl, {
          lookup: this.deps.dnsLookup,
        })
        allowed = true
      } catch {
        allowed = false
      }
    }

    if (this.closed || this.cdp !== cdp || this.pageSessionId !== sessionId) return
    if (allowed) {
      await cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {})
    } else {
      await cdp
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId)
        .catch(() => {})
    }
  }

  private onCdpDisconnected(): void {
    const wasTakeover = this.humanTakeover
    const watchId = this.pendingWatchId
    this.cdpAvailable = false
    this.detachCdpLocal()
    if (!this.closed) {
      if (wasTakeover && this.pendingResumeWhen) {
        this.send({
          type: 'handoff_vetoed',
          reason: 'cdp_disconnected',
          ...(watchId ? { watchId } : {}),
          detectedAt: this.now(),
        })
      }
      this.emitState()
    }
  }

  private detachCdpLocal(): void {
    this.autoResumeWatcher.stop()
    this.unsubCdpEvents?.()
    this.unsubCdpEvents = null
    this.unsubCdpClose?.()
    this.unsubCdpClose = null
    if (this.cdp) {
      this.cdp.close()
      this.cdp = null
    }
    this.pageSessionId = null
    this.activeTargetId = null
    this.targets = []
    this.dialog = null
    this.loading = false
    this.pressedButtons = 0
  }

  private onCdpEvent(method: string, params: any, sessionId?: string): void {
    if (this.closed) return

    if (method === 'Fetch.requestPaused' && sessionId && sessionId === this.pageSessionId) {
      void this.handleFetchRequestPaused(params ?? {}, sessionId)
      return
    }

    if (method === 'Page.screencastFrame' && sessionId === this.pageSessionId) {
      const ackId = typeof params?.sessionId === 'number' ? params.sessionId : null
      if (ackId !== null && this.cdp && this.pageSessionId) {
        void this.cdp
          .send('Page.screencastFrameAck', { sessionId: ackId }, this.pageSessionId)
          .catch(() => {})
      }
      const meta = params?.metadata as
        | { deviceWidth?: unknown; deviceHeight?: unknown; pageScaleFactor?: unknown }
        | undefined
      if (
        meta &&
        typeof meta.deviceWidth === 'number' &&
        typeof meta.deviceHeight === 'number' &&
        meta.deviceWidth >= 64 &&
        meta.deviceHeight >= 64
      ) {
        this.viewport = {
          width: Math.round(meta.deviceWidth),
          height: Math.round(meta.deviceHeight),
          deviceScaleFactor: this.viewport.deviceScaleFactor ?? 1,
        }
      }
      if (typeof params?.data === 'string' && params.data.length > 0) {
        this.handleScreencastPayload(Buffer.from(params.data, 'base64'))
      }
      return
    }

    if (method === 'Page.javascriptDialogOpening' && sessionId === this.pageSessionId) {
      const rawType = String(params?.type ?? 'alert')
      const dialogType: LiveBrowserDialogInfo['type'] =
        rawType === 'confirm' || rawType === 'prompt' || rawType === 'beforeunload'
          ? rawType
          : 'alert'
      this.dialog = {
        type: dialogType,
        message: bounded(params?.message, 1_024),
        ...(typeof params?.defaultPrompt === 'string'
          ? { defaultPrompt: bounded(params.defaultPrompt, 512) }
          : {}),
        ...(typeof params?.url === 'string' ? { url: bounded(params.url, 512) } : {}),
      }
      this.emitState()
      return
    }

    if (method === 'Page.javascriptDialogClosed' && sessionId === this.pageSessionId) {
      this.dialog = null
      this.emitState()
      this.scheduleSettledScreenshot()
      return
    }

    if (method === 'Page.frameStartedLoading' && sessionId === this.pageSessionId) {
      if (!this.loading) {
        this.loading = true
        this.emitState()
      }
      return
    }

    if (
      (method === 'Page.downloadWillBegin' || method === 'Browser.downloadWillBegin') &&
      (!sessionId || sessionId === this.pageSessionId)
    ) {
      const guid = typeof params?.guid === 'string' ? params.guid : ''
      const suggestedFilename =
        typeof params?.suggestedFilename === 'string' ? params.suggestedFilename : undefined
      if (guid) {
        this.autoResumeWatcher.onDownloadBegin(guid, suggestedFilename)
      }
      return
    }

    if (
      (method === 'Page.downloadProgress' || method === 'Browser.downloadProgress') &&
      (!sessionId || sessionId === this.pageSessionId)
    ) {
      const guid = typeof params?.guid === 'string' ? params.guid : ''
      const state = typeof params?.state === 'string' ? params.state : ''
      if (guid && state) {
        this.autoResumeWatcher.onDownloadProgress(guid, state)
      }
      return
    }

    if (
      (method === 'Page.frameStoppedLoading' || method === 'Page.loadEventFired') &&
      sessionId === this.pageSessionId
    ) {
      this.loading = false
      this.emitState()
      this.scheduleSettledScreenshot()
      this.autoResumeWatcher.onNavigation()
      return
    }

    if (method === 'Page.frameNavigated' && sessionId === this.pageSessionId) {
      const frame = params?.frame as { parentId?: unknown; url?: unknown } | undefined
      if (frame && !frame.parentId && typeof frame.url === 'string') {
        this.url = frame.url
        this.navGen += 1
        this.emitState()
        this.scheduleSettledScreenshot()
        this.autoResumeWatcher.onNavigation()
      }
      return
    }

    if (method === 'Target.targetCreated') {
      const info = params?.targetInfo as CdpTargetInfo | undefined
      if (info && info.type === 'page' && info.targetId) {
        const exists = this.targets.some((t) => t.targetId === info.targetId)
        if (!exists) this.targets.push(info)
        // Automatically follow target=_blank popups opened from the currently attached page.
        if (info.openerId && info.openerId === this.activeTargetId) {
          this.enqueueControl({ kind: 'follow_popup', targetId: info.targetId })
        } else {
          this.emitState()
        }
      }
      return
    }

    if (method === 'Target.targetInfoChanged') {
      const info = params?.targetInfo as CdpTargetInfo | undefined
      if (info && info.type === 'page' && info.targetId) {
        const idx = this.targets.findIndex((t) => t.targetId === info.targetId)
        if (idx >= 0) this.targets[idx] = info
        else this.targets.push(info)
        if (info.targetId === this.activeTargetId) {
          if (info.url !== this.url) {
            this.navGen += 1
          }
          this.url = info.url
          this.title = info.title
        }
        this.emitState()
      }
      return
    }

    if (method === 'Target.targetDestroyed') {
      const destroyedId = typeof params?.targetId === 'string' ? params.targetId : ''
      if (!destroyedId) return
      this.targets = this.targets.filter((t) => t.targetId !== destroyedId)
      if (destroyedId === this.activeTargetId) {
        this.activeTargetId = null
        this.pageSessionId = null
        this.dialog = null
        // R2 #9: recover via browser-level CDP method that does not require an existing pageSessionId.
        this.enqueueControl({ kind: 'recover_target' })
      } else {
        this.emitState()
      }
    }
  }

  private async recoverActiveTargetAfterDestroy(gen: number): Promise<void> {
    const cdp = this.cdp
    if (!cdp || !this.isAlive(gen)) return
    if (this.activeTargetId && this.pageSessionId) return
    await this.refreshTargets()
    if (!this.isAlive(gen) || this.cdp !== cdp) return
    const fallback = this.pickBestPageTarget()
    if (!fallback) {
      this.emitState()
      return
    }
    await cdp.send('Target.activateTarget', { targetId: fallback.targetId }).catch(() => {})
    if (!this.isAlive(gen) || this.cdp !== cdp) return
    await this.attachPageTarget(fallback.targetId, gen)
    if (!this.isAlive(gen) || this.cdp !== cdp) return
    await this.syncActiveTabToDaemon(gen)
    if (this.isAlive(gen)) this.emitState()
  }

  private async followPopupTarget(targetId: string, gen: number): Promise<void> {
    const cdp = this.cdp
    if (!cdp || !this.isAlive(gen)) return
    await this.refreshTargets()
    if (!this.isAlive(gen) || this.cdp !== cdp) return
    const popup = this.targets.find((t) => t.type === 'page' && t.targetId === targetId)
    if (!popup) return
    await cdp.send('Target.activateTarget', { targetId: popup.targetId }).catch(() => {})
    if (!this.isAlive(gen) || this.cdp !== cdp) return
    await this.attachPageTarget(popup.targetId, gen)
    if (!this.isAlive(gen) || this.cdp !== cdp) return
    await this.syncActiveTabToDaemon(gen)
    if (this.isAlive(gen)) this.emitState()
  }

  private allocateFrameSeq(): number {
    this.frameSeq = (this.frameSeq + 1) >>> 0
    return this.frameSeq
  }

  private handleScreencastPayload(jpeg: Buffer): void {
    // P1 #14 + R2 #4: assign monotonic seq and snapshot navGen at capture/receipt time.
    const seq = this.allocateFrameSeq()
    const navGen = this.navGen & 0xffff
    const interval = this.deps.motionIntervalMs ?? MOTION_FRAME_INTERVAL_MS
    const now = this.now()
    const wait = interval - (now - this.lastMotionSentAt)
    if (wait <= 0) {
      this.pendingMotion = null
      if (this.motionTimer) {
        clearTimeout(this.motionTimer)
        this.motionTimer = null
      }
      this.lastMotionSentAt = now
      this.queueBinary(jpeg, false, seq, navGen)
      return
    }
    this.pendingMotion = { buf: jpeg, seq, navGen }
    if (this.motionTimer) return
    this.motionTimer = setTimeout(() => {
      this.motionTimer = null
      const pending = this.pendingMotion
      this.pendingMotion = null
      if (!pending || this.closed) return
      this.lastMotionSentAt = this.now()
      this.queueBinary(pending.buf, false, pending.seq, pending.navGen)
    }, wait)
  }

  private scheduleSettledScreenshot(): void {
    if (this.settledTimer) clearTimeout(this.settledTimer)
    const delay = this.deps.settledDelayMs ?? SETTLED_SCREENSHOT_MS
    this.settledTimer = setTimeout(() => {
      this.settledTimer = null
      void this.captureSettledScreenshot()
    }, delay)
  }

  private async captureSettledScreenshot(): Promise<void> {
    if (this.screenshotInFlight) {
      this.screenshotAgain = true
      return
    }
    if (!this.cdp || !this.pageSessionId || this.closed) return
    const expectedGen = this.sessionGen
    const expectedTargetId = this.activeTargetId
    const expectedNavGen = this.navGen
    const cdp = this.cdp
    const sid = this.pageSessionId
    this.screenshotInFlight = true
    try {
      const res = (await cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 82 },
        sid,
      )) as { data?: unknown }
      // P1 #14: drop stale settled screenshot if target/navigation/session changed while in flight.
      if (
        !this.isAlive(expectedGen) ||
        this.activeTargetId !== expectedTargetId ||
        this.navGen !== expectedNavGen
      ) {
        return
      }
      if (typeof res?.data === 'string' && res.data.length > 0) {
        const seq = this.allocateFrameSeq()
        this.queueBinary(Buffer.from(res.data, 'base64'), true, seq, expectedNavGen & 0xffff)
      }
    } catch {
      // Best-effort settled frame.
    } finally {
      this.screenshotInFlight = false
      if (this.screenshotAgain && !this.closed) {
        this.screenshotAgain = false
        this.scheduleSettledScreenshot()
      }
    }
  }

  private queueBinary(buf: Buffer, settled: boolean, seq: number, navGen: number): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return
    if (this.ws.bufferedAmount >= MAX_BUFFERED_BYTES) {
      if (!this.pendingBinary || seq > this.pendingBinary.seq) {
        this.pendingBinary = { buf, settled, seq, navGen }
      }
      this.scheduleDrain()
      return
    }
    // P1 #14: invalidate any older pending drain frame before sending a newer frame directly.
    if (this.pendingBinary && seq >= this.pendingBinary.seq) {
      this.pendingBinary = null
      if (this.drainTimer) {
        clearTimeout(this.drainTimer)
        this.drainTimer = null
      }
    }
    this.sendBinaryNow(buf, settled, seq, navGen)
  }

  private sendBinaryNow(buf: Buffer, settled: boolean, seq: number, navGen: number): void {
    if (buf.byteLength + LIVE_BROWSER_BINARY_HEADER_BYTES > LIVE_BROWSER_MAX_BINARY_FRAME_BYTES) {
      return
    }
    const dims = readJpegDimensions(buf)
    const width = dims?.width ?? this.viewport.width
    const height = dims?.height ?? this.viewport.height
    const packet = encodeLiveBrowserFrame({
      seq,
      width: clampNum(width, 1, 65_535),
      height: clampNum(height, 1, 65_535),
      format: 'jpeg',
      settled,
      navGen,
      payload: buf,
    })
    try {
      this.ws.send(packet, { binary: true })
    } catch {}
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.closed) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) return
      if (this.ws.bufferedAmount >= MAX_BUFFERED_BYTES) {
        this.scheduleDrain()
        return
      }
      const pending = this.pendingBinary
      this.pendingBinary = null
      if (pending) this.sendBinaryNow(pending.buf, pending.settled, pending.seq, pending.navGen)
    }, 25)
  }

  private touchTakeoverActivity(gen: number): void {
    if (!this.isAlive(gen)) return
    this.deps.touchActivity(this.agentId)
    if (!this.ownsTakeoverLease) return
    const now = this.now()
    if (now - this.lastLeaseRenewAt >= TAKEOVER_TOUCH_THROTTLE_MS) {
      this.lastLeaseRenewAt = now
      const renewed = renewHumanTakeoverLease(this.stateDir, this.takeoverToken, {
        ttlMs: this.deps.takeoverTtlMs ?? DEFAULT_HUMAN_TAKEOVER_TTL_MS,
        now,
      })
      if (!renewed) {
        this.ownsTakeoverLease = false
        this.humanTakeover = false
        this.autoResumeWatcher.stop()
        if (this.leaseRenewTimer) {
          clearInterval(this.leaseRenewTimer)
          this.leaseRenewTimer = null
        }
        this.emitState()
      }
    }
  }

  private async setTakeover(
    active: boolean,
    gen: number,
    resumeWhen?: BrowserHandoffResumeWhen,
    watchId?: string,
  ): Promise<void> {
    if (!this.isAlive(gen)) return
    if (active) {
      if (this.deps.isAgentBusy(this.agentId)) {
        throw new LiveBrowserError(409, 'AGENT_RUNNING', '助手正在操作浏览器，请等待当前浏览器操作完成后再接管')
      }
      if (!this.isAlive(gen)) return
      const now = this.now()
      const leaseOpts = {
        token: this.takeoverToken,
        ttlMs: this.deps.takeoverTtlMs ?? DEFAULT_HUMAN_TAKEOVER_TTL_MS,
        now,
      }
      // R2 #5 + OCV5-873: strictly mutually exclusive acquire under activity.lock when wired.
      if (this.deps.acquireTakeoverLease) {
        await this.deps.acquireTakeoverLease(this.agentId, leaseOpts)
      } else {
        acquireHumanTakeoverLease(this.stateDir, leaseOpts)
      }
      if (!this.isAlive(gen)) {
        releaseHumanTakeoverLease(this.stateDir, this.takeoverToken, this.now())
        return
      }
      this.lastLeaseRenewAt = this.now()
      this.ownsTakeoverLease = true
      this.humanTakeover = true
      if (resumeWhen !== undefined) {
        this.pendingResumeWhen = resumeWhen
      }
      if (watchId !== undefined) {
        this.pendingWatchId = watchId
      }
      if (this.pendingResumeWhen) {
        this.autoResumeWatcher.start(this.pendingResumeWhen, this.pendingWatchId)
      } else {
        this.autoResumeWatcher.stop()
      }
      if (!this.leaseRenewTimer) {
        this.leaseRenewTimer = setInterval(() => {
          if (!this.isAlive(gen) || !this.ownsTakeoverLease) return
          const t = this.now()
          this.lastLeaseRenewAt = t
          this.deps.touchActivity(this.agentId)
          const renewed = renewHumanTakeoverLease(this.stateDir, this.takeoverToken, {
            ttlMs: this.deps.takeoverTtlMs ?? DEFAULT_HUMAN_TAKEOVER_TTL_MS,
            now: t,
          })
          if (!renewed) {
            this.ownsTakeoverLease = false
            this.humanTakeover = false
            this.autoResumeWatcher.stop()
            if (this.leaseRenewTimer) {
              clearInterval(this.leaseRenewTimer)
              this.leaseRenewTimer = null
            }
            this.emitState()
          }
        }, TAKEOVER_RENEW_INTERVAL_MS)
        this.leaseRenewTimer.unref?.()
      }
    } else {
      this.autoResumeWatcher.stop()
      this.pendingResumeWhen = undefined
      this.pendingWatchId = undefined
      if (this.leaseRenewTimer) {
        clearInterval(this.leaseRenewTimer)
        this.leaseRenewTimer = null
      }
      releaseHumanTakeoverLease(this.stateDir, this.takeoverToken, this.now())
      this.ownsTakeoverLease = false
      this.humanTakeover = false
    }
    this.emitState()
  }

  private assertTakeoverOwned(gen: number, callerToken?: string): void {
    if (!this.isAlive(gen)) {
      throw new LiveBrowserError(409, 'SESSION_CLOSED', '连接已关闭')
    }
    const activeLease = readActiveHumanTakeoverLease(this.stateDir, this.now())
    if (
      typeof callerToken === 'string' &&
      callerToken.length > 0 &&
      (!activeLease || activeLease.token !== callerToken || callerToken !== this.takeoverToken)
    ) {
      throw new LiveBrowserError(409, 'TAKEOVER_TOKEN_MISMATCH', '接管租约已失效或已被其他连接持有')
    }
    if (activeLease && activeLease.token !== this.takeoverToken) {
      throw new LiveBrowserError(409, 'TAKEOVER_TOKEN_MISMATCH', '当前已由其他连接独占接管')
    }
    if (!this.ownsTakeoverLease || !activeLease || activeLease.token !== this.takeoverToken) {
      if (this.ownsTakeoverLease) {
        this.ownsTakeoverLease = false
        this.humanTakeover = false
        this.autoResumeWatcher.stop()
        this.emitState()
        throw new LiveBrowserError(409, 'TAKEOVER_TOKEN_MISMATCH', '接管租约已失效，请重新接管')
      }
      throw new LiveBrowserError(409, 'TAKEOVER_REQUIRED', '请先点击「接管」后再操作浏览器')
    }
  }

  private assertReadyForInput(
    gen: number,
    callerToken?: string,
  ): { cdp: LiveBrowserCdpTransport; sessionId: string } {
    if (!this.isAlive(gen)) {
      throw new LiveBrowserError(409, 'SESSION_CLOSED', '连接已关闭')
    }
    if (this.deps.isAgentBusy(this.agentId)) {
      throw new LiveBrowserError(409, 'AGENT_RUNNING', '助手正在操作浏览器，请等待当前浏览器操作完成后再操作')
    }
    // R2 #5 + OCV5-873: enforce active takeover ownership on every mutating input path.
    this.assertTakeoverOwned(gen, callerToken)
    if (!this.cdp || !this.pageSessionId) {
      throw new LiveBrowserError(409, 'BROWSER_NOT_ACTIVE', '云端浏览器尚未启动，请先打开网页')
    }
    this.touchTakeoverActivity(gen)
    return { cdp: this.cdp, sessionId: this.pageSessionId }
  }

  /** P1 #4 + R2 #4: verify expectedOrigin, expectedTargetId, and expectedNavGen before sensitive input. */
  private checkInputFence(msg: {
    expectedOrigin?: string
    expectedTargetId?: string
    expectedNavGen?: number
  }): boolean {
    if (
      typeof msg.expectedNavGen === 'number' &&
      Number.isInteger(msg.expectedNavGen) &&
      (msg.expectedNavGen & 0xffff) !== (this.navGen & 0xffff)
    ) {
      this.sendError('ORIGIN_MISMATCH', '页面已发生跳转，请确认新画面后再输入', false)
      this.emitState()
      return false
    }
    if (
      typeof msg.expectedTargetId === 'string' &&
      msg.expectedTargetId.length > 0 &&
      msg.expectedTargetId !== this.activeTargetId
    ) {
      this.sendError('ORIGIN_MISMATCH', '页面标签已切换，请确认后再输入', false)
      this.emitState()
      return false
    }
    if (typeof msg.expectedOrigin === 'string' && msg.expectedOrigin.length > 0) {
      const liveOrigin = extractHttpOrigin(this.url)
      if (!liveOrigin || liveOrigin !== msg.expectedOrigin) {
        this.sendError('ORIGIN_MISMATCH', '页面来源已变化，请确认后再输入', false)
        this.emitState()
        return false
      }
    }
    return true
  }

  private async ensureOpenedAndAttached(gen: number, url?: string): Promise<void> {
    if (!this.isAlive(gen)) return
    // R2 #6: distinguish 'attached' | 'not_running' | 'aborted' — never launch on 'aborted'.
    const first = await this.tryAttachCdp(gen)
    if (first === 'attached' || first === 'aborted') return
    if (!this.isAlive(gen)) return
    await this.deps.openBrowser(this.agentId, url)
    // Wait briefly for DevToolsActivePort to appear after browser launch.
    for (let attempt = 0; attempt < 15 && this.isAlive(gen); attempt += 1) {
      const status = await this.tryAttachCdp(gen)
      if (status === 'attached' || status === 'aborted') return
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  private async syncActiveTabToDaemon(gen: number): Promise<void> {
    if (!this.isAlive(gen) || !this.deps.syncDaemonTab || !this.activeTargetId) return
    const pages = this.targets.filter((t) => t.type === 'page')
    const idx = pages.findIndex((t) => t.targetId === this.activeTargetId)
    if (idx < 0) return
    const activePage = pages[idx]!
    const targetUrl = activePage.url || this.url
    let occurrenceIndex = 0
    for (let i = 0; i < idx; i += 1) {
      if (pages[i]!.url === targetUrl) occurrenceIndex += 1
    }
    try {
      await this.deps.syncDaemonTab(this.agentId, {
        index: idx,
        url: targetUrl,
        occurrenceIndex,
      })
    } catch {
      // Best-effort sync with Playwright daemon; CDP session remains authoritative for stream.
    }
  }

  private async handleMessage(raw: unknown, gen: number): Promise<void> {
    if (!this.isAlive(gen)) return
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.sendError('INVALID_MESSAGE', '消息格式无效', false)
      return
    }
    const msg = raw as Partial<LiveBrowserClientMessage>
    switch (msg.type) {
      case 'ping':
        this.send({ type: 'pong', ts: msg.ts, serverTs: this.now() })
        return

      case 'takeover': {
        const resumeWhen =
          msg.active === true && 'resumeWhen' in msg
            ? normalizeBrowserHandoffResumeWhen(msg.resumeWhen)
            : undefined
        const watchId =
          msg.active === true && typeof msg.watchId === 'string' && msg.watchId.trim()
            ? msg.watchId.trim().slice(0, 128)
            : undefined
        await this.setTakeover(msg.active === true, gen, resumeWhen, watchId)
        return
      }

      case 'handoff_watch': {
        const nextResumeWhen =
          msg.resumeWhen === null ? undefined : normalizeBrowserHandoffResumeWhen(msg.resumeWhen)
        const nextWatchId =
          typeof msg.watchId === 'string' && msg.watchId.trim()
            ? msg.watchId.trim().slice(0, 128)
            : undefined
        this.pendingResumeWhen = nextResumeWhen
        if (nextWatchId !== undefined || msg.resumeWhen === null) {
          this.pendingWatchId = nextWatchId
        }
        if (this.humanTakeover && this.ownsTakeoverLease) {
          if (nextResumeWhen) {
            if (this.autoResumeWatcher.isRunning()) {
              this.autoResumeWatcher.setResumeWhen(nextResumeWhen, this.pendingWatchId)
            } else {
              this.autoResumeWatcher.start(nextResumeWhen, this.pendingWatchId)
            }
          } else {
            this.autoResumeWatcher.stop()
          }
        }
        return
      }

      case 'open': {
        if (this.deps.isAgentBusy(this.agentId)) {
          throw new LiveBrowserError(409, 'AGENT_RUNNING', '助手正在操作浏览器，请等待当前浏览器操作完成后再启动')
        }
        const safeUrl =
          typeof msg.url === 'string' && msg.url.trim()
            ? await assertLiveBrowserUrlPublic(msg.url, {
                lookup: this.deps.dnsLookup,
              })
            : undefined
        if (!this.isAlive(gen)) return
        if (this.cdp && this.pageSessionId) {
          if (safeUrl) {
            this.assertTakeoverOwned(gen)
            this.loading = true
            this.emitState()
            await this.cdp.send('Page.navigate', { url: safeUrl }, this.pageSessionId)
            this.scheduleSettledScreenshot()
          } else {
            this.emitState()
          }
          return
        }
        await this.ensureOpenedAndAttached(gen, safeUrl)
        if (this.isAlive(gen)) this.emitState()
        return
      }

      case 'close_browser': {
        // P1 #7: refuse destroying browser while agent is actively running / operating browser.
        if (this.deps.isAgentBusy(this.agentId)) {
          throw new LiveBrowserError(409, 'AGENT_RUNNING', '助手正在操作浏览器，请等待当前浏览器操作完成后再关闭')
        }
        this.assertTakeoverOwned(gen)
        if (!this.isAlive(gen)) return
        const tok = this.takeoverToken
        this.detachCdpLocal()
        try {
          await this.deps.closeBrowser(this.agentId, tok)
        } finally {
          await this.setTakeover(false, gen)
        }
        if (this.isAlive(gen)) this.emitState()
        return
      }

      case 'navigate': {
        const safeUrl = await assertLiveBrowserUrlPublic(msg.url, {
          lookup: this.deps.dnsLookup,
        })
        if (!this.isAlive(gen)) return
        if (!this.cdp || !this.pageSessionId) {
          await this.ensureOpenedAndAttached(gen, safeUrl)
          if (this.isAlive(gen)) this.emitState()
          return
        }
        const { cdp, sessionId } = this.assertReadyForInput(gen)
        this.loading = true
        this.emitState()
        await cdp.send('Page.navigate', { url: safeUrl }, sessionId)
        this.scheduleSettledScreenshot()
        return
      }

      case 'history': {
        const { cdp, sessionId } = this.assertReadyForInput(gen)
        if (msg.action === 'stop') {
          await cdp.send('Page.stopLoading', {}, sessionId)
          this.loading = false
          this.emitState()
          return
        }
        if (msg.action === 'reload') {
          this.loading = true
          this.emitState()
          await cdp.send('Page.reload', {}, sessionId)
          this.scheduleSettledScreenshot()
          return
        }
        if (msg.action === 'back' || msg.action === 'forward') {
          const history = (await cdp.send('Page.getNavigationHistory', {}, sessionId)) as {
            currentIndex?: number
            entries?: Array<{ id?: number }>
          }
          if (!this.isAlive(gen)) return
          const idx = typeof history?.currentIndex === 'number' ? history.currentIndex : -1
          const entries = Array.isArray(history?.entries) ? history.entries : []
          const nextIdx = msg.action === 'back' ? idx - 1 : idx + 1
          const targetEntry = entries[nextIdx]
          if (targetEntry && typeof targetEntry.id === 'number') {
            this.loading = true
            this.emitState()
            await cdp.send(
              'Page.navigateToHistoryEntry',
              { entryId: targetEntry.id },
              sessionId,
            )
            this.scheduleSettledScreenshot()
          }
        }
        return
      }

      case 'pointer': {
        const { cdp, sessionId } = this.assertReadyForInput(gen, msg.takeoverToken)
        if (!this.checkInputFence(msg)) return
        const nx = clampNum(Number(msg.x), 0, 1)
        const ny = clampNum(Number(msg.y), 0, 1)
        const x = Math.round(nx * this.viewport.width)
        const y = Math.round(ny * this.viewport.height)
        const button: LiveBrowserMouseButton =
          msg.button === 'right' || msg.button === 'middle' ? msg.button : 'left'
        const modifiers = liveBrowserModifiersToBitmask(msg.modifiers)
        const mask = mouseButtonMask(button)

        if (msg.action === 'move') {
          await cdp.send(
            'Input.dispatchMouseEvent',
            { type: 'mouseMoved', x, y, buttons: this.pressedButtons, modifiers },
            sessionId,
          )
        } else if (msg.action === 'down') {
          this.pressedButtons |= mask
          await cdp.send(
            'Input.dispatchMouseEvent',
            {
              type: 'mousePressed',
              x,
              y,
              button,
              buttons: this.pressedButtons,
              clickCount: msg.clickCount ?? 1,
              modifiers,
            },
            sessionId,
          )
        } else if (msg.action === 'up') {
          this.pressedButtons &= ~mask
          await cdp.send(
            'Input.dispatchMouseEvent',
            {
              type: 'mouseReleased',
              x,
              y,
              button,
              buttons: this.pressedButtons,
              clickCount: msg.clickCount ?? 1,
              modifiers,
            },
            sessionId,
          )
          this.scheduleSettledScreenshot()
        } else if (msg.action === 'click' || msg.action === 'dblclick') {
          const clicks = msg.action === 'dblclick' ? 2 : 1
          await cdp.send(
            'Input.dispatchMouseEvent',
            { type: 'mouseMoved', x, y, buttons: 0, modifiers },
            sessionId,
          )
          for (let count = 1; count <= clicks; count += 1) {
            await cdp.send(
              'Input.dispatchMouseEvent',
              {
                type: 'mousePressed',
                x,
                y,
                button,
                buttons: mask,
                clickCount: count,
                modifiers,
              },
              sessionId,
            )
            await cdp.send(
              'Input.dispatchMouseEvent',
              {
                type: 'mouseReleased',
                x,
                y,
                button,
                buttons: 0,
                clickCount: count,
                modifiers,
              },
              sessionId,
            )
          }
          this.scheduleSettledScreenshot()
        }
        return
      }

      case 'wheel': {
        const { cdp, sessionId } = this.assertReadyForInput(gen, msg.takeoverToken)
        if (!this.checkInputFence(msg)) return
        const nx = msg.x === undefined ? 0.5 : clampNum(Number(msg.x), 0, 1)
        const ny = msg.y === undefined ? 0.5 : clampNum(Number(msg.y), 0, 1)
        const x = Math.round(nx * this.viewport.width)
        const y = Math.round(ny * this.viewport.height)
        const deltaX = clampNum(Number(msg.deltaX ?? 0), -4_000, 4_000)
        const deltaY = clampNum(Number(msg.deltaY ?? 0), -4_000, 4_000)
        const modifiers = liveBrowserModifiersToBitmask(msg.modifiers)
        await cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers },
          sessionId,
        )
        this.scheduleSettledScreenshot()
        return
      }

      case 'key': {
        const { cdp, sessionId } = this.assertReadyForInput(gen, msg.takeoverToken)
        if (!this.checkInputFence(msg)) return
        if (typeof msg.key !== 'string' || msg.key.length === 0 || msg.key.length > 64) {
          throw new LiveBrowserError(400, 'INVALID_KEY', '按键参数无效')
        }
        const { def, modifiers } = resolveLiveBrowserKeyEvent(
          msg.key,
          msg.code,
          msg.text,
          msg.modifiers,
        )
        const hasShortcutMod = (modifiers & (2 | 4)) !== 0 // Ctrl or Meta
        const text = hasShortcutMod ? undefined : def.text
        const downParams: Record<string, unknown> = {
          type: text ? 'keyDown' : 'rawKeyDown',
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.keyCode,
          nativeVirtualKeyCode: def.keyCode,
          modifiers,
          ...(text ? { text, unmodifiedText: text } : {}),
        }
        const upParams: Record<string, unknown> = {
          type: 'keyUp',
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.keyCode,
          nativeVirtualKeyCode: def.keyCode,
          modifiers,
        }
        if (msg.action === 'down') {
          await cdp.send('Input.dispatchKeyEvent', downParams, sessionId)
        } else if (msg.action === 'up') {
          await cdp.send('Input.dispatchKeyEvent', upParams, sessionId)
        } else {
          await cdp.send('Input.dispatchKeyEvent', downParams, sessionId)
          await cdp.send('Input.dispatchKeyEvent', upParams, sessionId)
          this.scheduleSettledScreenshot()
        }
        return
      }

      case 'insert_text': {
        const { cdp, sessionId } = this.assertReadyForInput(gen, msg.takeoverToken)
        if (!this.checkInputFence(msg)) return
        if (
          typeof msg.text !== 'string' ||
          msg.text.length === 0 ||
          msg.text.length > 8_192 ||
          msg.text.includes('\0')
        ) {
          throw new LiveBrowserError(400, 'INVALID_TEXT', '输入文本无效或超出长度上限')
        }
        await cdp.send('Input.insertText', { text: msg.text }, sessionId)
        this.scheduleSettledScreenshot()
        return
      }

      case 'tab': {
        const { cdp } = this.assertReadyForInput(gen)
        await this.refreshTargets()
        if (!this.isAlive(gen)) return
        const pages = this.targets.filter((t) => t.type === 'page')
        if (msg.action === 'new') {
          const safeUrl =
            typeof msg.url === 'string' && msg.url.trim()
              ? await assertLiveBrowserUrlPublic(msg.url, {
                  lookup: this.deps.dnsLookup,
                })
              : 'about:blank'
          if (!this.isAlive(gen)) return
          // R2 #3: ALWAYS create about:blank first -> attach + strict Fetch.enable -> ONLY then navigate.
          const created = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
            targetId?: unknown
          }
          if (!this.isAlive(gen)) return
          if (typeof created?.targetId === 'string' && created.targetId) {
            await this.refreshTargets()
            await cdp.send('Target.activateTarget', { targetId: created.targetId }).catch(() => {})
            await this.attachPageTarget(created.targetId, gen)
            if (!this.isAlive(gen) || !this.pageSessionId) return
            if (safeUrl !== 'about:blank') {
              this.loading = true
              this.emitState()
              await cdp.send('Page.navigate', { url: safeUrl }, this.pageSessionId)
              this.scheduleSettledScreenshot()
            }
            await this.syncActiveTabToDaemon(gen)
            if (this.isAlive(gen)) this.emitState()
          }
          return
        }

        const stableId =
          typeof msg.targetId === 'string' && msg.targetId
            ? msg.targetId
            : typeof msg.id === 'string' && msg.id
              ? msg.id
              : undefined

        // R2 #10: destructive tab/close STRICTLY requires a stable targetId (never mutable index).
        if (msg.action === 'close') {
          if (!stableId) {
            throw new LiveBrowserError(404, 'TAB_NOT_FOUND', '关闭标签页必须提供有效的 targetId')
          }
          const target = pages.find((t) => t.targetId === stableId)
          if (!target) {
            throw new LiveBrowserError(404, 'TAB_NOT_FOUND', '目标标签页不存在或已关闭')
          }
          await cdp.send('Target.closeTarget', { targetId: target.targetId })
          await this.refreshTargets()
          if (!this.isAlive(gen)) return
          if (target.targetId === this.activeTargetId) {
            this.activeTargetId = null
            this.pageSessionId = null
            const next = this.pickBestPageTarget()
            if (next) {
              await cdp.send('Target.activateTarget', { targetId: next.targetId }).catch(() => {})
              await this.attachPageTarget(next.targetId, gen)
              await this.syncActiveTabToDaemon(gen)
            }
          }
          if (this.isAlive(gen)) this.emitState()
          return
        }

        // P1 #18: prioritize stable targetId/id; reject with TAB_NOT_FOUND rather than falling back.
        let target: CdpTargetInfo | undefined
        if (stableId !== undefined) {
          target = pages.find((t) => t.targetId === stableId)
          if (!target) {
            throw new LiveBrowserError(404, 'TAB_NOT_FOUND', '目标标签页不存在或已关闭')
          }
        } else if (typeof msg.index === 'number' && Number.isInteger(msg.index)) {
          target = pages[msg.index]
          if (!target) {
            throw new LiveBrowserError(404, 'TAB_NOT_FOUND', '目标标签页索引无效')
          }
        } else {
          throw new LiveBrowserError(404, 'TAB_NOT_FOUND', '缺少有效的标签页标识')
        }

        if (msg.action === 'select') {
          await cdp.send('Target.activateTarget', { targetId: target.targetId }).catch(() => {})
          await this.attachPageTarget(target.targetId, gen)
          await this.syncActiveTabToDaemon(gen)
          if (this.isAlive(gen)) this.emitState()
          return
        }
        return
      }

      case 'resize': {
        const { cdp, sessionId } = this.assertReadyForInput(gen)
        const width = Math.round(clampNum(Number(msg.width), 320, 1920))
        const height = Math.round(clampNum(Number(msg.height), 240, 1200))
        const deviceScaleFactor = clampNum(Number(msg.deviceScaleFactor ?? 1), 1, 2)
        this.viewport = { width, height, deviceScaleFactor }
        await cdp
          .send(
            'Emulation.setDeviceMetricsOverride',
            { width, height, deviceScaleFactor, mobile: false },
            sessionId,
          )
          .catch(() => {})
        if (this.activeTargetId) {
          const win = (await cdp
            .send('Browser.getWindowForTarget', { targetId: this.activeTargetId })
            .catch(() => null)) as { windowId?: number } | null
          if (win && typeof win.windowId === 'number') {
            await cdp
              .send('Browser.setWindowBounds', {
                windowId: win.windowId,
                bounds: { width, height },
              })
              .catch(() => {})
          }
        }
        if (this.isAlive(gen)) {
          this.emitState()
          this.scheduleSettledScreenshot()
        }
        return
      }

      case 'dialog': {
        const { cdp, sessionId } = this.assertReadyForInput(gen)
        await cdp.send(
          'Page.handleJavaScriptDialog',
          {
            accept: msg.accept === true,
            ...(typeof msg.promptText === 'string' ? { promptText: msg.promptText } : {}),
          },
          sessionId,
        )
        this.dialog = null
        if (this.isAlive(gen)) {
          this.emitState()
          this.scheduleSettledScreenshot()
        }
        return
      }

      default:
        this.sendError('UNSUPPORTED_MESSAGE', `不支持的消息类型: ${String(msg.type ?? '')}`, false)
    }
  }

  async handleExternalDialog(accept: boolean, promptText?: string): Promise<boolean> {
    if (!this.cdp || !this.pageSessionId || this.closed) return false
    await this.cdp.send(
      'Page.handleJavaScriptDialog',
      {
        accept,
        ...(typeof promptText === 'string' ? { promptText } : {}),
      },
      this.pageSessionId,
    )
    this.dialog = null
    this.emitState()
    return true
  }

  async close(code = 1000, reason = 'closed'): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.sessionGen += 1
    this.autoResumeWatcher.stop()
    this.pendingResumeWhen = undefined
    this.controlQueue.length = 0
    if (this.motionTimer) clearTimeout(this.motionTimer)
    if (this.settledTimer) clearTimeout(this.settledTimer)
    if (this.drainTimer) clearTimeout(this.drainTimer)
    if (this.leaseRenewTimer) clearInterval(this.leaseRenewTimer)
    if (this.attachPollTimer) clearInterval(this.attachPollTimer)
    if (this.statusPollTimer) clearInterval(this.statusPollTimer)
    this.motionTimer = null
    this.settledTimer = null
    this.drainTimer = null
    this.leaseRenewTimer = null
    this.attachPollTimer = null
    this.statusPollTimer = null
    this.pendingMotion = null
    this.pendingBinary = null

    // Always attempt token-guarded release for THIS session's token only.
    releaseHumanTakeoverLease(this.stateDir, this.takeoverToken, this.now())
    this.ownsTakeoverLease = false
    this.humanTakeover = false

    const cdp = this.cdp
    const sessionId = this.pageSessionId
    if (cdp && sessionId) {
      await cdp.send('Page.stopScreencast', {}, sessionId).catch(() => {})
      await cdp.send('Fetch.disable', {}, sessionId).catch(() => {})
    }
    this.detachCdpLocal()

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.close(code, reason.slice(0, 120))
      } catch {}
    }
    this.onClosed(this)
  }
}

export class LiveBrowserStreamManager {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CONTROL_BYTES,
    perMessageDeflate: false,
  })
  private readonly sessions = new Map<string, LiveBrowserStreamSession>()
  private readonly consumedAssertions = new Map<string, number>()
  private checkHttpAuth?: (req: IncomingMessage) => boolean
  private isCommercialMaster = false
  private shuttingDown = false

  constructor(private readonly deps: LiveBrowserStreamManagerDeps) {
    this.checkHttpAuth = deps.checkHttpAuth
    this.isCommercialMaster = deps.isCommercialMaster === true
  }

  setUpgradeAuthCheck(fn: (req: IncomingMessage) => boolean): void {
    this.checkHttpAuth = fn
  }

  setCommercialMasterMode(enabled: boolean): void {
    this.isCommercialMaster = enabled
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private consumeAssertionOnce(sessionId: string, expiresAt: number): boolean {
    const now = this.now()
    for (const [id, exp] of this.consumedAssertions) {
      if (exp <= now) this.consumedAssertions.delete(id)
    }
    if (this.consumedAssertions.has(sessionId)) return false
    if (this.consumedAssertions.size >= ASSERTION_CACHE_CAP) {
      const oldest = this.consumedAssertions.keys().next().value
      if (oldest) this.consumedAssertions.delete(oldest)
    }
    this.consumedAssertions.set(sessionId, expiresAt)
    return true
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (safePathname(req.url) !== LIVE_BROWSER_INTERNAL_WS_PATH) return false
    if (this.shuttingDown) {
      writeHttpRejection(socket, '503 Service Unavailable')
      return true
    }

    let verified: VerifiedLiveBrowserUpgrade
    try {
      verified = verifyLiveBrowserUpgrade(req, this.deps.getEnv(), this.now(), {
        checkHttpAuth: this.checkHttpAuth,
        isCommercialMaster: this.isCommercialMaster,
      })
    } catch (err) {
      const status =
        err instanceof LiveBrowserUpgradeAuthError && err.status === 401
          ? '401 Unauthorized'
          : '403 Forbidden'
      writeHttpRejection(socket, status)
      return true
    }

    if (
      verified.sessionId &&
      verified.expiresAt !== undefined &&
      !this.consumeAssertionOnce(verified.sessionId, verified.expiresAt)
    ) {
      writeHttpRejection(socket, '403 Forbidden')
      return true
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const prev = this.sessions.get(verified.agentId)
      if (prev) {
        this.sessions.delete(verified.agentId)
        void prev.close(4001, 'replaced by newer live browser connection')
      }
      const session = new LiveBrowserStreamSession(verified.agentId, ws, this.deps, (closed) => {
        if (this.sessions.get(verified.agentId) === closed) {
          this.sessions.delete(verified.agentId)
        }
      })
      this.sessions.set(verified.agentId, session)
    })
    return true
  }

  hasActiveSession(agentId: string): boolean {
    return this.sessions.has(agentId)
  }

  async handleDialogViaActiveStream(
    agentId: string,
    accept: boolean,
    promptText?: string,
  ): Promise<boolean> {
    const session = this.sessions.get(agentId)
    if (!session) return false
    return session.handleExternalDialog(accept, promptText)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const active = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(active.map((s) => s.close(1001, 'gateway shutting down')))
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve())
    })
  }
}
