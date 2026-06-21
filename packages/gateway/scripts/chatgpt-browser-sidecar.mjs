// ChatGPT real-browser screencast sidecar.
//
// Runs a headful Chromium (under Xvfb) per user, egressing through the local
// sing-box proxy, and streams its screen to the gateway as binary JPEG frames
// over a loopback WebSocket while applying the user's mouse/keyboard back. A
// real browser is the only way to deliver login (OAuth + Arkose), WebSocket and
// every ChatGPT feature — the reverse proxy can't.
//
// Resolved from the runtime dir (/opt/openclaude/chatgpt-browser) where the
// supervisor copies this file, so `playwright`/`ws` resolve from the sibling
// node_modules. See setup-chatgpt-browser-sidecar.sh + chatgptBrowserSidecar.ts.
//
// Protocol (gateway <-> sidecar, both ways on 127.0.0.1):
//   connect:  ws://127.0.0.1:<port>/?token=<token>&user=<userId>
//   c->s text JSON:
//     {t:'mouse', kind:'move'|'down'|'up'|'wheel', x,y, button?, dx?, dy?}
//     {t:'key',   kind:'down'|'up', key}
//     {t:'text',  text}            // IME-composed / pasted text -> insertText
//     {t:'resize',w,h}
//     {t:'nav',   action:'reload'|'back'|'home'}
//     {t:'restart'} | {t:'clearLogin'}
//   s->c binary:  raw JPEG frame
//   s->c text JSON: {t:'status',state,message?} | {t:'url',url} | {t:'size',w,h}

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
const JPEG_QUALITY = Number(process.env.OC_CGB_JPEG_QUALITY || '60')
const PARENT_PID = Number(process.env.OC_CGB_PARENT_PID || '0')
// Drop frames toward a viewer whose socket is already backed up — newest frame
// wins, so a slow link degrades to a lower frame rate instead of lagging behind.
const BACKPRESSURE_BYTES = 1 << 20 // 1 MiB

// Top-level navigation is locked so this never becomes a general remote browser
// with a residential exit + persistent cookies. ChatGPT + the common login
// identity providers are allowed (so OAuth/SSO completes); login sub-resources
// (Arkose, CDNs) are sub-frames/requests and are not gated.
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
  // profile dir is derived from this — never let it escape PROFILE_BASE
  return /^[A-Za-z0-9._-]{1,128}$/.test(raw || '') ? raw : null
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj))
    } catch {}
  }
}

/**
 * One persistent headful browser per user, reused across reconnects. The object
 * stays in `sessions` for its lifetime; only the underlying browser is opened
 * (`ensure`) and closed (`closeBrowser`). A `gen` counter + launch/close
 * promises serialize launch vs close so we never run two persistent contexts on
 * the same profile dir (Playwright forbids it) during a teardown↔reconnect race.
 */
class BrowserSession {
  constructor(userId) {
    this.userId = userId
    this.profileDir = `${PROFILE_BASE}/${userId}`
    this.context = null
    this.page = null
    this.cdp = null
    this.viewers = new Set()
    this.latestFrame = null
    this.idleTimer = null
    this.launching = null
    this.closing = null
    this.gen = 0
    // Render size, mutable per the client viewport (portrait phone vs desktop).
    this.vw = VW
    this.vh = VH
    this.resizeSeq = 0
  }

  async ensure() {
    if (this.context) return
    if (this.launching) return this.launching
    this.launching = (async () => {
      // Wait for any in-flight close so the old context releases the profile lock.
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
      // Superseded by a close while launching — discard.
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
    if (!this.page) return
    const cdp = await this.context.newCDPSession(this.page)
    this.cdp = cdp
    cdp.on('Page.screencastFrame', (e) => {
      cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {})
      this.latestFrame = Buffer.from(e.data, 'base64')
      for (const ws of this.viewers) this._pushFrame(ws)
    })
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      maxWidth: this.vw,
      maxHeight: this.vh,
      everyNthFrame: 1,
    })
  }

  /** Resize the remote viewport to match the client (portrait phone, etc.) and
   *  restart the screencast at the new size. Clamped + no-op on no change. */
  async resize(w, h) {
    const vw = Math.max(320, Math.min(2048, Math.round(num(w))))
    const vh = Math.max(320, Math.min(2048, Math.round(num(h))))
    if (!this.page || (vw === this.vw && vh === this.vh)) return
    // latest-wins: a newer resize (orientation jitter) bumps the seq and any
    // older in-flight resize bails out, so we never settle on a stale size.
    const seq = ++this.resizeSeq
    this.vw = vw
    this.vh = vh
    try {
      await this.page.setViewportSize({ width: vw, height: vh })
      if (seq !== this.resizeSeq) return
      if (this.cdp) {
        await this.cdp.send('Page.stopScreencast').catch(() => {})
        if (seq !== this.resizeSeq) return
        await this.cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: JPEG_QUALITY,
          maxWidth: vw,
          maxHeight: vh,
          everyNthFrame: 1,
        })
      }
    } catch {}
    if (seq === this.resizeSeq) {
      for (const ws of this.viewers) sendJson(ws, { t: 'size', w: vw, h: vh })
    }
  }

  _pushFrame(ws) {
    if (ws.readyState !== ws.OPEN || !this.latestFrame) return
    if (ws.bufferedAmount > BACKPRESSURE_BYTES) return // slow link: skip, newest wins
    try {
      ws.send(this.latestFrame)
    } catch {}
  }

  attach(ws) {
    this.viewers.add(ws)
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    sendJson(ws, { t: 'size', w: this.vw, h: this.vh })
    if (this.page) sendJson(ws, { t: 'url', url: this.page.url() })
    sendJson(ws, { t: 'status', state: 'ready' })
    if (this.latestFrame) this._pushFrame(ws)
  }

  detach(ws) {
    this.viewers.delete(ws)
    if (this.viewers.size === 0 && !this.idleTimer && IDLE_TTL_MS > 0) {
      // Keep the login profile, just close the browser after a quiet period so a
      // reconnect resumes (and re-launches) cheaply.
      this.idleTimer = setTimeout(() => this.closeBrowser('idle'), IDLE_TTL_MS)
      this.idleTimer.unref?.()
    }
  }

  async handle(msg) {
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
        else if (msg.kind === 'wheel') await page.mouse.wheel(num(msg.dx), num(msg.dy))
      } else if (msg.t === 'key') {
        if (msg.kind === 'down') await page.keyboard.down(String(msg.key))
        else if (msg.kind === 'up') await page.keyboard.up(String(msg.key))
      } else if (msg.t === 'text') {
        if (typeof msg.text === 'string' && msg.text) await page.keyboard.insertText(msg.text)
      } else if (msg.t === 'resize') {
        await this.resize(msg.w, msg.h)
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

  /** Close the browser (keeping the session object + viewers). Idempotent. */
  closeBrowser(reason, wipeProfile = false) {
    const ctx = this.context
    this.gen++ // invalidate stale close handlers + supersede any in-flight launch
    this.context = null
    this.page = null
    this.cdp = null
    this.latestFrame = null
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    for (const ws of this.viewers) sendJson(ws, { t: 'status', state: 'closed', message: reason })
    this.closing = (async () => {
      if (ctx) {
        try {
          await ctx.close()
        } catch {}
      }
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

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, num(v)))
}
function mouseButton(b) {
  return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'
}

/** @type {Map<string, BrowserSession>} */
const sessions = new Map()

async function getSession(userId) {
  let s = sessions.get(userId)
  if (!s) {
    s = new BrowserSession(userId)
    sessions.set(userId, s)
  }
  await s.ensure()
  return s
}

if (!TOKEN) {
  console.error('[chatgpt-browser-sidecar] refusing to start without OC_CGB_TOKEN')
  process.exit(2)
}

// Parent-death watchdog: if the gateway dies without a clean stop (SIGKILL),
// exit so we don't orphan an X server + Chromium holding the fixed port.
if (PARENT_PID) {
  const t = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0)
    } catch {
      process.exit(0)
    }
  }, 3000)
  t.unref?.()
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
    if (isBinary) return
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }
    if (msg && typeof msg.t === 'string') session.handle(msg)
  })
  ws.on('close', () => session.detach(ws))
  ws.on('error', () => session.detach(ws))
})

wss.on('listening', () => {
  console.error(
    `[chatgpt-browser-sidecar] listening 127.0.0.1:${PORT} viewport=${VW}x${VH} proxy=${PROXY ? 'on' : 'off'}`,
  )
})

async function shutdown() {
  for (const s of [...sessions.values()]) {
    try {
      await s.closeBrowser('shutdown')
    } catch {}
  }
  try {
    wss.close()
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
