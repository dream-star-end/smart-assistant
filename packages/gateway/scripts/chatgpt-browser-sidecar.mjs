// ChatGPT real-browser sidecar.
//
// Runs one persistent headful Chromium per user and exposes two transports:
//   1. WebRTC video + data channels (preferred, direct and low latency).
//   2. JPEG frames + input over the authenticated loopback WebSocket (fallback).
//
// The gateway copies this file into /opt/openclaude/chatgpt-browser so bare
// imports resolve from that dedicated runtime. See setup-chatgpt-browser-sidecar.sh.

import { existsSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.OC_CGB_PORT || '18994')
const TOKEN = process.env.OC_CGB_TOKEN || ''
const PROXY = (process.env.OC_CGB_PROXY || '').trim()
const PROFILE_BASE = process.env.OC_CGB_PROFILE_DIR || '/root/.openclaude/chatgpt-browser'
const STEALTH_SCRIPT = process.env.OC_CGB_STEALTH_SCRIPT || ''
const HOME_URL = process.env.OC_CGB_HOME_URL || 'https://chatgpt.com/'
const [VW, VH] = (process.env.OC_CGB_VIEWPORT || '1280x800').split('x').map((n) => Number(n) || 0)
const IDLE_TTL_MS = Number(process.env.OC_CGB_IDLE_TTL_MS || String(20 * 60 * 1000))
const PARENT_PID = Number(process.env.OC_CGB_PARENT_PID || '0')
const WEBRTC_REQUESTED = process.env.OC_CGB_WEBRTC_ENABLED !== '0'
const WEBRTC_PORT_MIN = clampInt(process.env.OC_CGB_WEBRTC_PORT_MIN, 1024, 65535, 19000)
const WEBRTC_PORT_MAX = Math.max(
  WEBRTC_PORT_MIN,
  clampInt(process.env.OC_CGB_WEBRTC_PORT_MAX, WEBRTC_PORT_MIN, 65535, 19100),
)
const ICE_SERVERS = parseIceServers(process.env.OC_CGB_WEBRTC_ICE_SERVERS)

const BACKPRESSURE_BYTES = 1 << 20
const MAX_WEBRTC_PEERS = 2
const MAX_VIEWPORT = 2048
const MAX_CAPTURE_WIDTH = 3200
const MAX_CAPTURE_HEIGHT = 3200
const MAX_SIGNAL_BYTES = 128 * 1024
const MAX_INPUT_BYTES = 64 * 1024
const NEGOTIATION_TIMEOUT_MS = 10_000
const DISCONNECTED_GRACE_MS = 5_000
const QUALITY_MODES = new Set(['auto', 'fluent', 'clear'])

let wrtc = null
let sharp = null
if (WEBRTC_REQUESTED) {
  try {
    const [wrtcModule, sharpModule] = await Promise.all([import('@roamhq/wrtc'), import('sharp')])
    wrtc = wrtcModule.default ?? wrtcModule
    sharp = sharpModule.default ?? sharpModule
  } catch (err) {
    console.error('[chatgpt-browser-sidecar] WebRTC disabled:', err?.message || 'runtime missing')
  }
}
const WEBRTC_AVAILABLE = !!(
  wrtc?.RTCPeerConnection &&
  wrtc?.nonstandard?.RTCVideoSource &&
  wrtc?.nonstandard?.rgbaToI420 &&
  sharp
)

const ALLOWED_TOPLEVEL_ROOTS = [
  'chatgpt.com',
  'openai.com',
  'oaiusercontent.com',
  'oaistatic.com',
  'auth0.com',
  'google.com',
  'apple.com',
  'microsoftonline.com',
  'live.com',
  'github.com',
]

function topLevelAllowed(urlStr) {
  let u
  try {
    u = new URL(urlStr)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase()
  return ALLOWED_TOPLEVEL_ROOTS.some((r) => host === r || host.endsWith(`.${r}`))
}

function safeUserId(raw) {
  return /^[A-Za-z0-9._-]{1,128}$/.test(raw || '') ? raw : null
}

function sendJson(ws, obj) {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(JSON.stringify(obj))
  } catch {}
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, num(v)))
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback
}

function mouseButton(b) {
  return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'
}

function parseIceServers(raw) {
  let values = ['stun:stun.cloudflare.com:3478']
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) values = parsed
    } catch {}
  }
  return values
    .filter((v) => typeof v === 'string' && /^(?:stun|turn|turns):/i.test(v) && v.length <= 1024)
    .slice(0, 8)
    .map((urls) => ({ urls }))
}

function qualitySettings(mode, requestedDpr, rtcActive, vw, vh) {
  const safeMode = QUALITY_MODES.has(mode) ? mode : 'auto'
  const dpr = clampNum(requestedDpr, 1, 3) || 1
  let scale = 1
  let quality = 60
  let maxFps = 30
  if (safeMode === 'clear') {
    scale = Math.min(dpr, 2)
    quality = 82
    maxFps = rtcActive ? 20 : 12
  } else if (safeMode === 'auto') {
    scale = Math.min(dpr, rtcActive ? 2 : 1)
    quality = rtcActive ? 82 : 74
    maxFps = rtcActive ? 18 : 12
  }
  scale = Math.max(
    1,
    Math.min(scale, MAX_CAPTURE_WIDTH / Math.max(1, vw), MAX_CAPTURE_HEIGHT / Math.max(1, vh)),
  )
  return { mode: safeMode, dpr, scale, quality, maxFps }
}

function normalizeInputMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return null
  if (msg.t === 'mouse') {
    if (!['move', 'down', 'up', 'wheel'].includes(msg.kind)) return null
    return {
      t: 'mouse',
      kind: msg.kind,
      x: num(msg.x),
      y: num(msg.y),
      button: clampInt(msg.button, 0, 2, 0),
      dx: clampNum(msg.dx, -4000, 4000),
      dy: clampNum(msg.dy, -4000, 4000),
    }
  }
  if (msg.t === 'key') {
    if (!['down', 'up'].includes(msg.kind) || typeof msg.key !== 'string' || !msg.key) return null
    return { t: 'key', kind: msg.kind, key: msg.key.slice(0, 64) }
  }
  if (msg.t === 'text') {
    if (typeof msg.text !== 'string' || !msg.text) return null
    return { t: 'text', text: msg.text.slice(0, 32 * 1024) }
  }
  if (msg.t === 'resize') {
    return {
      t: 'resize',
      w: clampInt(msg.w, 320, MAX_VIEWPORT, VW),
      h: clampInt(msg.h, 320, MAX_VIEWPORT, VH),
      dpr: clampNum(msg.dpr, 1, 3) || 1,
      mode: QUALITY_MODES.has(msg.mode) ? msg.mode : 'auto',
    }
  }
  if (msg.t === 'nav' && ['reload', 'back', 'home'].includes(msg.action)) {
    return { t: 'nav', action: msg.action }
  }
  if (msg.t === 'restart' || msg.t === 'clearLogin') return { t: msg.t }
  return null
}

function isFastInput(msg) {
  return msg?.t === 'mouse' && (msg.kind === 'move' || msg.kind === 'wheel')
}

class BrowserSession {
  constructor(userId) {
    this.userId = userId
    this.profileDir = `${PROFILE_BASE}/${userId}`
    this.context = null
    this.page = null
    this.cdp = null
    this.viewers = new Set()
    this.viewerRates = new Map()
    this.latestFrame = null
    this.idleTimer = null
    this.launching = null
    this.closing = null
    this.gen = 0
    this.vw = VW
    this.vh = VH
    this.requestedDpr = 1
    this.qualityMode = 'auto'
    this.renderScale = 1
    this.captureQuality = 74
    this.captureMaxFps = 12
    this.resizeSeq = 0
    this.resizeApplying = Promise.resolve()
    this.resizing = false
    this.captureEpoch = 0
    this.captureBusy = false
    this.captureDirty = false
    this.captureTimer = null
    this.lastCaptureAt = 0
    this.captureX = 0
    this.captureY = 0
    this.rtcPeers = new Map()
    this.rtcActiveViewers = new Set()
    this.videoSource = null
    this.videoTrack = null
    this.rtcMediaGen = 0
    this.rtcDecodeBusy = false
    this.rtcPendingFrame = null
  }

  async ensure() {
    if (this.context) return
    if (this.launching) return this.launching
    this.launching = (async () => {
      if (this.closing) {
        try {
          await this.closing
        } catch {}
      }
      await this._launch()
    })().finally(() => {
      this.launching = null
    })
    return this.launching
  }

  async _launch() {
    const myGen = ++this.gen
    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      proxy: PROXY ? { server: PROXY } : undefined,
      viewport: { width: this.vw, height: this.vh },
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    })
    if (myGen !== this.gen) {
      await context.close().catch(() => {})
      return
    }
    if (STEALTH_SCRIPT && existsSync(STEALTH_SCRIPT)) {
      try {
        await context.addInitScript({ path: STEALTH_SCRIPT })
      } catch {}
    }
    const page = context.pages()[0] || (await context.newPage())
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const url = frame.url()
      if (url && url !== 'about:blank' && !topLevelAllowed(url)) {
        page.goto(HOME_URL).catch(() => {})
      }
    })
    const onClosed = () => {
      if (this.gen === myGen) this.closeBrowser('browser closed')
    }
    page.on('close', onClosed)
    context.on('close', onClosed)

    this.context = context
    this.page = page
    try {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } catch {}
    await this._startScreencast()
  }

  async _startScreencast() {
    if (!this.page || !this.context) return
    const cdp = await this.context.newCDPSession(this.page)
    this.cdp = cdp
    cdp.on('Page.screencastFrame', (e) => {
      cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {})
      this.captureX = Math.max(0, num(e.metadata?.scrollOffsetX))
      this.captureY = Math.max(0, num(e.metadata?.scrollOffsetY))
      if (this.resizing) {
        // The event may belong to the screencast that is being stopped. Keep a
        // dirty bit, but never capture with its stale viewport metrics.
        this.captureDirty = true
        return
      }
      // Never publish e.data directly: an old screencast event can already be
      // queued when a resize completes. Treat every event only as a paint/dirty
      // signal, then capture the current viewport through the epoch-protected
      // latest-wins pipeline (including fluent mode).
      this._scheduleCapture()
    })
    await this._applyViewportMetrics()
    await this._restartDirtyScreencast()
  }

  async _applyViewportMetrics() {
    if (!this.page || !this.cdp) return
    await this.page.setViewportSize({ width: this.vw, height: this.vh })
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.vw,
      height: this.vh,
      deviceScaleFactor: this.renderScale,
      mobile: false,
      screenWidth: this.vw,
      screenHeight: this.vh,
      // Headful persistent Chromium otherwise keeps the launch surface's scale
      // after a dynamic viewport resize. Matching the emulation scale makes a
      // DPR=2 capture render at 2 physical pixels per CSS pixel.
      scale: this.renderScale,
    })
  }

  async _restartDirtyScreencast() {
    if (!this.cdp) return
    await this.cdp.send('Page.stopScreencast').catch(() => {})
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: this.vw,
      maxHeight: this.vh,
      everyNthFrame: 1,
    })
  }

  _scheduleCapture() {
    this.captureDirty = true
    if (!this.cdp || this.resizing || this.captureBusy || this.captureTimer) return
    const minInterval = 1000 / Math.max(1, this.captureMaxFps)
    const delay = Math.max(0, this.lastCaptureAt + minInterval - performance.now())
    if (delay > 1) {
      this.captureTimer = setTimeout(() => {
        this.captureTimer = null
        void this._captureLatest()
      }, delay)
      this.captureTimer.unref?.()
      return
    }
    void this._captureLatest()
  }

  async _captureLatest() {
    if (!this.cdp || this.resizing || !this.captureDirty || this.captureBusy) return
    const cdp = this.cdp
    const epoch = this.captureEpoch
    this.captureDirty = false
    this.captureBusy = true
    try {
      const result = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: this.captureQuality,
        fromSurface: true,
        captureBeyondViewport: false,
        // An explicit CSS-pixel clip makes dynamic viewport changes reliable
        // in headful persistent contexts. deviceScaleFactor supplies the HiDPI
        // output pixels (clip scale must stay 1 or DPR would be applied twice).
        clip: {
          x: this.captureX,
          y: this.captureY,
          width: this.vw,
          height: this.vh,
          scale: 1,
        },
      })
      if (this.cdp === cdp && epoch === this.captureEpoch) {
        this.lastCaptureAt = performance.now()
        this._publishFrame(Buffer.from(result.data, 'base64'))
      }
    } catch {}
    this.captureBusy = false
    if (this.captureDirty) this._scheduleCapture()
  }

  _publishFrame(frame) {
    this.latestFrame = frame
    for (const ws of this.viewers) this._pushFrame(ws)
    this._queueRtcFrame(frame)
  }

  _pushFrame(ws) {
    if (
      ws.readyState !== ws.OPEN ||
      !this.latestFrame ||
      this.rtcActiveViewers.has(ws) ||
      ws.bufferedAmount > BACKPRESSURE_BYTES
    ) {
      return
    }
    try {
      ws.send(this.latestFrame)
    } catch {}
  }

  async resize(w, h, requestedDpr = 1, mode = 'auto') {
    if (!this.page) return
    const vw = clampInt(w, 320, MAX_VIEWPORT, this.vw)
    const vh = clampInt(h, 320, MAX_VIEWPORT, this.vh)
    const settings = qualitySettings(mode, requestedDpr, this.rtcActiveViewers.size > 0, vw, vh)
    const unchanged =
      vw === this.vw &&
      vh === this.vh &&
      settings.dpr === this.requestedDpr &&
      settings.mode === this.qualityMode &&
      settings.scale === this.renderScale &&
      settings.quality === this.captureQuality
    if (unchanged) return
    const seq = ++this.resizeSeq
    this.captureEpoch++
    this.resizing = true
    this.vw = vw
    this.vh = vh
    this.requestedDpr = settings.dpr
    this.qualityMode = settings.mode
    this.renderScale = settings.scale
    this.captureQuality = settings.quality
    this.captureMaxFps = settings.maxFps
    const apply = this.resizeApplying.then(async () => {
      if (seq !== this.resizeSeq) return
      try {
        while (this.captureBusy && seq === this.resizeSeq) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        if (seq !== this.resizeSeq) return
        await this._applyViewportMetrics()
        if (seq !== this.resizeSeq) return
        await this._restartDirtyScreencast()
      } finally {
        if (seq === this.resizeSeq) {
          this.resizing = false
          this._scheduleCapture()
        }
      }
    })
    this.resizeApplying = apply.catch(() => {})
    await apply.catch(() => {})
    if (seq !== this.resizeSeq) return
    for (const ws of this.viewers) {
      sendJson(ws, {
        t: 'size',
        w: vw,
        h: vh,
        scale: this.renderScale,
        mode: this.qualityMode,
        quality: this.captureQuality,
      })
    }
  }

  attach(ws) {
    this.viewers.add(ws)
    this.viewerRates.set(ws, { second: 0, fast: 0, control: 0 })
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    sendJson(ws, {
      t: 'size',
      w: this.vw,
      h: this.vh,
      scale: this.renderScale,
      mode: this.qualityMode,
      quality: this.captureQuality,
    })
    if (this.page) sendJson(ws, { t: 'url', url: this.page.url() })
    sendJson(ws, { t: 'status', state: 'ready', webrtc: WEBRTC_AVAILABLE })
    if (this.latestFrame) this._pushFrame(ws)
  }

  detach(ws) {
    this._closeRtcPeer(ws, false)
    this.viewers.delete(ws)
    this.viewerRates.delete(ws)
    this.rtcActiveViewers.delete(ws)
    if (this.viewers.size === 0 && !this.idleTimer && IDLE_TTL_MS > 0) {
      this.idleTimer = setTimeout(() => this.closeBrowser('idle'), IDLE_TTL_MS)
      this.idleTimer.unref?.()
    }
  }

  _allowInput(ws, fast) {
    const rate = this.viewerRates.get(ws)
    if (!rate) return false
    const second = Math.floor(Date.now() / 1000)
    if (rate.second !== second) {
      rate.second = second
      rate.fast = 0
      rate.control = 0
    }
    if (fast) return ++rate.fast <= 300
    return ++rate.control <= 120
  }

  async dispatchViewerMessage(ws, msg, source = 'ws') {
    if (!this.viewers.has(ws) || !msg || typeof msg.t !== 'string') return
    if (source === 'ws' && msg.t.startsWith('webrtc-')) {
      await this._handleRtcSignal(ws, msg)
      return
    }
    const clean = normalizeInputMessage(msg)
    if (!clean || !this._allowInput(ws, isFastInput(clean))) return
    if (source === 'fast' && !isFastInput(clean)) return
    if (source === 'control' && isFastInput(clean)) return
    await this._handleInput(clean)
  }

  async _handleInput(msg) {
    const page = this.page
    if (!page) return
    try {
      if (msg.t === 'mouse') {
        const x = clampNum(msg.x, 0, this.vw)
        const y = clampNum(msg.y, 0, this.vh)
        if (msg.kind === 'move') await page.mouse.move(x, y)
        else if (msg.kind === 'down') {
          await page.mouse.move(x, y)
          await page.mouse.down({ button: mouseButton(msg.button) })
        } else if (msg.kind === 'up') await page.mouse.up({ button: mouseButton(msg.button) })
        else if (msg.kind === 'wheel') await page.mouse.wheel(msg.dx, msg.dy)
      } else if (msg.t === 'key') {
        if (msg.kind === 'down') await page.keyboard.down(msg.key)
        else await page.keyboard.up(msg.key)
      } else if (msg.t === 'text') {
        await page.keyboard.insertText(msg.text)
      } else if (msg.t === 'resize') {
        await this.resize(msg.w, msg.h, msg.dpr, msg.mode)
      } else if (msg.t === 'nav') {
        if (msg.action === 'reload') await page.reload().catch(() => {})
        else if (msg.action === 'back') await page.goBack().catch(() => {})
        else if (msg.action === 'home') await page.goto(HOME_URL).catch(() => {})
      } else if (msg.t === 'restart') {
        await this.closeBrowser('restart')
      } else if (msg.t === 'clearLogin') {
        await this.closeBrowser('clear login', true)
      }
    } catch {}
  }

  async startWebRtc(ws) {
    if (!WEBRTC_AVAILABLE || !this.viewers.has(ws)) return
    if (this.rtcPeers.size >= MAX_WEBRTC_PEERS && !this.rtcPeers.has(ws)) {
      sendJson(ws, { t: 'webrtc-state', state: 'fallback', reason: 'capacity', retry: false })
      return
    }
    this._closeRtcPeer(ws, false)
    this._ensureRtcMedia()
    if (!this.videoTrack) return

    const pc = new wrtc.RTCPeerConnection({
      iceServers: ICE_SERVERS,
      portRange: { min: WEBRTC_PORT_MIN, max: WEBRTC_PORT_MAX },
    })
    const transceiver = pc.addTransceiver(this.videoTrack, { direction: 'sendonly' })
    this._preferScreenCodecs(transceiver)
    const fastChannel = pc.createDataChannel('cgb-fast', { ordered: false, maxRetransmits: 0 })
    const controlChannel = pc.createDataChannel('cgb-control')
    const peer = {
      pc,
      transceiver,
      fastChannel,
      controlChannel,
      offerSent: false,
      pendingCandidates: [],
      remoteDescriptionSet: false,
      pendingRemoteCandidates: [],
      negotiationTimer: null,
      disconnectedTimer: null,
      closing: false,
    }
    this.rtcPeers.set(ws, peer)

    this._bindDataChannel(ws, peer, fastChannel, 'fast')
    this._bindDataChannel(ws, peer, controlChannel, 'control')
    pc.onicecandidate = (event) => {
      if (!event.candidate || this.rtcPeers.get(ws) !== peer) return
      const candidate = event.candidate.toJSON?.() ?? event.candidate
      if (!peer.offerSent) peer.pendingCandidates.push(candidate)
      else sendJson(ws, { t: 'webrtc-candidate', candidate })
    }
    pc.onconnectionstatechange = () => this._onRtcConnectionState(ws, peer)
    peer.negotiationTimer = setTimeout(() => {
      if (this.rtcPeers.get(ws) === peer && pc.connectionState !== 'connected') {
        this._closeRtcPeer(ws, true, 'timeout')
      }
    }, NEGOTIATION_TIMEOUT_MS)
    peer.negotiationTimer.unref?.()

    try {
      const offer = await pc.createOffer()
      if (this.rtcPeers.get(ws) !== peer) return
      await pc.setLocalDescription(offer)
      if (this.rtcPeers.get(ws) !== peer) return
      sendJson(ws, {
        t: 'webrtc-offer',
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        iceServers: ICE_SERVERS,
      })
      peer.offerSent = true
      for (const candidate of peer.pendingCandidates.splice(0)) {
        sendJson(ws, { t: 'webrtc-candidate', candidate })
      }
      if (this.latestFrame) this._queueRtcFrame(this.latestFrame)
    } catch {
      this._closeRtcPeer(ws, true, 'offer-failed')
    }
  }

  _preferScreenCodecs(transceiver) {
    const codecs = wrtc.RTCRtpSender.getCapabilities?.('video')?.codecs ?? []
    if (!transceiver.setCodecPreferences || codecs.length === 0) return
    const priority = ['video/vp9', 'video/h264', 'video/vp8', 'video/av1']
    const ordered = []
    for (const mime of priority) {
      ordered.push(...codecs.filter((c) => c.mimeType?.toLowerCase() === mime))
    }
    ordered.push(...codecs.filter((c) => !priority.includes(c.mimeType?.toLowerCase())))
    try {
      transceiver.setCodecPreferences(ordered)
    } catch {}
  }

  _bindDataChannel(ws, peer, channel, source) {
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (event) => {
      if (this.rtcPeers.get(ws) !== peer || typeof event.data !== 'string') return
      if (Buffer.byteLength(event.data) > MAX_INPUT_BYTES) return
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      void this.dispatchViewerMessage(ws, msg, source)
    }
  }

  async _handleRtcSignal(ws, msg) {
    if (msg.t === 'webrtc-retry') {
      await this.startWebRtc(ws)
      return
    }
    if (msg.t === 'webrtc-active') {
      if (!this.rtcPeers.has(ws)) return
      this.rtcActiveViewers.add(ws)
      await this.resize(this.vw, this.vh, this.requestedDpr, this.qualityMode)
      return
    }
    if (msg.t === 'webrtc-fallback') {
      this._closeRtcPeer(ws, false)
      this._pushFrame(ws)
      await this.resize(this.vw, this.vh, this.requestedDpr, this.qualityMode)
      return
    }
    const peer = this.rtcPeers.get(ws)
    if (!peer) return
    if (msg.t === 'webrtc-answer') {
      const sdp = msg.sdp
      if (
        !sdp ||
        sdp.type !== 'answer' ||
        typeof sdp.sdp !== 'string' ||
        Buffer.byteLength(sdp.sdp) > MAX_SIGNAL_BYTES
      ) {
        return
      }
      try {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: sdp.sdp })
        if (this.rtcPeers.get(ws) !== peer) return
        peer.remoteDescriptionSet = true
        for (const candidate of peer.pendingRemoteCandidates.splice(0)) {
          await peer.pc.addIceCandidate(candidate).catch(() => {})
          if (this.rtcPeers.get(ws) !== peer) return
        }
      } catch {
        this._closeRtcPeer(ws, true, 'bad-answer')
      }
      return
    }
    if (msg.t === 'webrtc-candidate') {
      const c = msg.candidate
      if (!c || typeof c.candidate !== 'string' || c.candidate.length > 4096) return
      if (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 64)) return
      const candidate = {
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
        usernameFragment:
          typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : undefined,
      }
      if (!peer.remoteDescriptionSet) {
        if (peer.pendingRemoteCandidates.length < 128) peer.pendingRemoteCandidates.push(candidate)
        return
      }
      try {
        await peer.pc.addIceCandidate(candidate)
      } catch {}
    }
  }

  _onRtcConnectionState(ws, peer) {
    if (this.rtcPeers.get(ws) !== peer || peer.closing) return
    const state = peer.pc.connectionState
    sendJson(ws, { t: 'webrtc-state', state })
    if (state === 'connected') {
      if (peer.negotiationTimer) clearTimeout(peer.negotiationTimer)
      peer.negotiationTimer = null
      if (peer.disconnectedTimer) clearTimeout(peer.disconnectedTimer)
      peer.disconnectedTimer = null
      if (this.latestFrame) this._queueRtcFrame(this.latestFrame)
    } else if (state === 'disconnected') {
      if (!peer.disconnectedTimer) {
        peer.disconnectedTimer = setTimeout(() => {
          if (this.rtcPeers.get(ws) === peer && peer.pc.connectionState !== 'connected') {
            this._closeRtcPeer(ws, true, 'disconnected')
          }
        }, DISCONNECTED_GRACE_MS)
        peer.disconnectedTimer.unref?.()
      }
    } else if (state === 'failed' || state === 'closed') {
      this._closeRtcPeer(ws, true, state)
    }
  }

  _ensureRtcMedia() {
    if (!WEBRTC_AVAILABLE || this.videoTrack) return
    this.videoSource = new wrtc.nonstandard.RTCVideoSource({ isScreencast: true })
    this.videoTrack = this.videoSource.createTrack()
    this.rtcMediaGen++
  }

  _queueRtcFrame(frame) {
    if (!this.videoSource || this.rtcPeers.size === 0) return
    this.rtcPendingFrame = frame
    if (!this.rtcDecodeBusy) void this._pumpRtcFrame()
  }

  async _pumpRtcFrame() {
    if (this.rtcDecodeBusy || !this.rtcPendingFrame || !this.videoSource) return
    const frame = this.rtcPendingFrame
    const mediaGen = this.rtcMediaGen
    this.rtcPendingFrame = null
    this.rtcDecodeBusy = true
    try {
      const image = sharp(frame)
      const metadata = await image.metadata()
      const width = Math.max(2, (metadata.width || 2) & ~1)
      const height = Math.max(2, (metadata.height || 2) & ~1)
      const { data, info } = await image
        .resize(width, height, { fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (this.videoSource && mediaGen === this.rtcMediaGen && info.channels === 4) {
        const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
        const i420 = new Uint8ClampedArray((width * height * 3) / 2)
        wrtc.nonstandard.rgbaToI420({ width, height, data: rgba }, { width, height, data: i420 })
        this.videoSource.onFrame({ width, height, data: i420 })
      }
    } catch {
    } finally {
      this.rtcDecodeBusy = false
    }
    if (this.rtcPendingFrame) void this._pumpRtcFrame()
  }

  _closeRtcPeer(ws, notifyFallback, reason = 'fallback') {
    const peer = this.rtcPeers.get(ws)
    if (!peer) return
    this.rtcPeers.delete(ws)
    const wasActive = this.rtcActiveViewers.delete(ws)
    peer.closing = true
    if (peer.negotiationTimer) clearTimeout(peer.negotiationTimer)
    if (peer.disconnectedTimer) clearTimeout(peer.disconnectedTimer)
    try {
      peer.fastChannel.close()
    } catch {}
    try {
      peer.controlChannel.close()
    } catch {}
    try {
      peer.pc.close()
    } catch {}
    if (notifyFallback) sendJson(ws, { t: 'webrtc-state', state: 'fallback', reason })
    this._pushFrame(ws)
    if (this.rtcPeers.size === 0) this._releaseRtcMedia()
    if (wasActive && this.page) {
      void this.resize(this.vw, this.vh, this.requestedDpr, this.qualityMode)
    }
  }

  _releaseRtcMedia() {
    this.rtcMediaGen++
    this.rtcPendingFrame = null
    const track = this.videoTrack
    this.videoTrack = null
    this.videoSource = null
    try {
      track?.stop()
    } catch {}
  }

  _closeAllRtcPeers() {
    for (const ws of [...this.rtcPeers.keys()]) this._closeRtcPeer(ws, false)
    this._releaseRtcMedia()
  }

  closeBrowser(reason, wipeProfile = false) {
    const ctx = this.context
    this.gen++
    this.context = null
    this.page = null
    this.cdp = null
    this.latestFrame = null
    this.captureEpoch++
    this.captureDirty = false
    if (this.captureTimer) clearTimeout(this.captureTimer)
    this.captureTimer = null
    this._closeAllRtcPeers()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    for (const ws of this.viewers) sendJson(ws, { t: 'status', state: 'closed', message: reason })
    this.closing = (async () => {
      if (ctx) await ctx.close().catch(() => {})
      if (wipeProfile && existsSync(this.profileDir)) {
        try {
          rmSync(this.profileDir, { recursive: true, force: true })
        } catch {}
      }
    })().finally(() => {
      this.closing = null
    })
    return this.closing
  }
}

const sessions = new Map()

async function getSession(userId) {
  let session = sessions.get(userId)
  if (!session) {
    session = new BrowserSession(userId)
    sessions.set(userId, session)
  }
  await session.ensure()
  return session
}

if (!TOKEN) {
  console.error('[chatgpt-browser-sidecar] refusing to start without OC_CGB_TOKEN')
  process.exit(2)
}

if (PARENT_PID) {
  const timer = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0)
    } catch {
      process.exit(0)
    }
  }, 3000)
  timer.unref?.()
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: 256 * 1024 })
wss.on('error', (err) => {
  console.error('[chatgpt-browser-sidecar] wss error', err?.message)
  if (err?.code === 'EADDRINUSE') process.exit(1)
})

wss.on('connection', async (ws, req) => {
  let params
  try {
    params = new URL(req.url || '/', 'http://localhost').searchParams
  } catch {
    ws.close(1008, 'bad request')
    return
  }
  if (params.get('token') !== TOKEN) {
    ws.close(1008, 'unauthorized')
    return
  }
  const userId = safeUserId(params.get('user') || '')
  if (!userId) {
    ws.close(1008, 'bad user')
    return
  }

  sendJson(ws, { t: 'status', state: 'launching' })
  let session
  try {
    session = await getSession(userId)
  } catch (err) {
    sendJson(ws, { t: 'status', state: 'error', message: 'browser launch failed' })
    console.error('[chatgpt-browser-sidecar] launch failed', err?.message)
    ws.close(1011, 'launch failed')
    return
  }
  session.attach(ws)

  ws.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > MAX_SIGNAL_BYTES) return
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }
    void session.dispatchViewerMessage(ws, msg, 'ws')
  })
  ws.on('close', () => session.detach(ws))
  ws.on('error', () => session.detach(ws))
  void session.startWebRtc(ws)
})

wss.on('listening', () => {
  console.error(
    `[chatgpt-browser-sidecar] listening 127.0.0.1:${PORT} viewport=${VW}x${VH} proxy=${PROXY ? 'on' : 'off'} webrtc=${WEBRTC_AVAILABLE ? 'on' : 'fallback'}`,
  )
})

async function shutdown() {
  for (const session of [...sessions.values()]) {
    try {
      await session.closeBrowser('shutdown')
    } catch {}
  }
  try {
    wss.close()
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
