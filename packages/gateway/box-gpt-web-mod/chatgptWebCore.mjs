/**
 * Box ChatGPT Web Pro Browser Core (OCV5-551).
 *
 * Portions of the DOM slider selection, composer file upload, and delta-encoding
 * SSE stream accumulator are adapted from stufently/gpt-web-gateway
 * (https://github.com/stufently/gpt-web-gateway, lib/browser.js & lib/chatgpt.js)
 * under the MIT License:
 *
 *   MIT License
 *   Copyright (c) 2026 stufently
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PROFILE = 'default'
export const DEFAULT_DISPLAY = ':1'
export const DEFAULT_CDP_PORT = 9229
export const DEFAULT_CHROME_BIN = '/usr/bin/google-chrome-stable'
export const DEFAULT_CHATGPT_ORIGIN = 'https://chatgpt.com'
export const BOX_GPT_WEB_BUSY_MESSAGE =
  'Pro 通道忙：当前已有 gpt-6-astra-pro 对话正在执行，一次只能运行一个 Pro 对话，请等待当前对话完成后再试。'
export const FORBIDDEN_PROXY_PORTS = new Set([18991, 19095])

// 5-position Intelligence slider on ChatGPT Web (GPT-6 Astra Pro = index 4 / 100%)
export const LEVEL_ORDER = ['instant', 'medium', 'high', 'veryhigh', 'pro']
export const LEVEL_ALIASES = {
  instant: 'instant',
  none: 'instant',
  minimal: 'instant',
  low: 'medium',
  light: 'medium',
  medium: 'medium',
  standard: 'high',
  high: 'high',
  extended: 'veryhigh',
  veryhigh: 'veryhigh',
  xhigh: 'veryhigh',
  pro: 'pro',
  max: 'pro',
  'astra-pro': 'pro',
  'gpt-6-astra-pro': 'pro',
  'box-gpt-6-astra-pro': 'pro',
}
export const LEVEL_SLIDER_PCT = {
  instant: '0%',
  medium: '25%',
  high: '50%',
  veryhigh: '75%',
  pro: '100%',
}

const VALID_PROFILE = /^[a-zA-Z0-9_-]{1,40}$/

/**
 * Generates a standard UUID v4 session identifier for Box ChatGPT Web sessions
 * so gateway resume-map validation (`sand-box-cc:<uuid>`) preserves native multi-turn continuation.
 */
export function defaultGptWebSessionId() {
  return randomUUID()
}

export function profileDirFor(profile = DEFAULT_PROFILE, home = os.homedir()) {
  const normalized = String(profile || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE
  if (!VALID_PROFILE.test(normalized)) {
    throw new Error(`Invalid ChatGPT Web profile name: ${JSON.stringify(profile)}`)
  }
  return path.join(home, `.chatgpt-pro-${normalized}`)
}

/**
 * Deterministic CDP port per profile so two profiles never collide on port 9229.
 */
export function cdpPortForProfile(profile = DEFAULT_PROFILE, explicitPort = null) {
  if (explicitPort !== null && explicitPort !== undefined && String(explicitPort).trim() !== '') {
    const p = Number(explicitPort)
    if (Number.isInteger(p) && p >= 1024 && p <= 65535 && !FORBIDDEN_PROXY_PORTS.has(p)) {
      return p
    }
  }
  const normalized = String(profile || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE
  if (normalized === DEFAULT_PROFILE) return DEFAULT_CDP_PORT
  let hash = 0
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0
  }
  const candidate = 9230 + (hash % 500)
  return FORBIDDEN_PROXY_PORTS.has(candidate) ? candidate + 1 : candidate
}

/**
 * Strict URL origin check against https://chatgpt.com (prevents prefix spoofing
 * such as https://chatgpt.com.attacker.example/).
 */
export function isChatGptOriginUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''))
    return parsed.origin === DEFAULT_CHATGPT_ORIGIN
  } catch {
    return false
  }
}

/**
 * Validates that an optional proxy URL is strictly loopback (127.0.0.1 / localhost)
 * and never touches kl-mirror's 18991 / 19095 ports.
 */
export function validateLocalOnlyProxy(proxyUrl) {
  if (proxyUrl == null) return null
  const raw = String(proxyUrl).trim()
  if (!raw) return null
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`BOX_GPT_WEB_PROXY_INVALID_URL: ${raw}`)
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    throw new Error(`BOX_GPT_WEB_PROXY_UNSUPPORTED_PROTOCOL: ${parsed.protocol}`)
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `BOX_GPT_WEB_PROXY_NOT_LOOPBACK: proxy must bind to 127.0.0.1/localhost only (got ${parsed.hostname})`,
    )
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BOX_GPT_WEB_PROXY_MISSING_PORT: explicit port required in ${raw}`)
  }
  if (FORBIDDEN_PROXY_PORTS.has(port)) {
    throw new Error(
      `BOX_GPT_WEB_PROXY_FORBIDDEN_PORT: port ${port} is reserved (kl-mirror) and must never be used`,
    )
  }
  return `${parsed.protocol}//${parsed.hostname}:${port}`
}

/**
 * Builds command-line flags for launching real Google Chrome on the Box Xvfb display (:1)
 * with a persistent profile directory and CDP remote debugging port, avoiding Playwright's
 * --enable-automation / HeadlessChrome fingerprint leaks.
 */
export function buildChromeLaunchArgs({
  profileDir = profileDirFor(DEFAULT_PROFILE),
  cdpPort = DEFAULT_CDP_PORT,
  proxyUrl = null,
  startUrl = `${DEFAULT_CHATGPT_ORIGIN}/`,
} = {}) {
  const validatedProxy = validateLocalOnlyProxy(proxyUrl)
  const port = Number(cdpPort)
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || FORBIDDEN_PROXY_PORTS.has(port)) {
    throw new Error(`BOX_GPT_WEB_INVALID_CDP_PORT: ${cdpPort}`)
  }
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
  ]
  if (validatedProxy) {
    args.push(`--proxy-server=${validatedProxy}`, '--proxy-bypass-list=<-loopback>')
  }
  if (startUrl) {
    args.push(startUrl)
  }
  return args
}

export function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

/**
 * Inspects `<profileDir>/SingletonLock` and `/proc/<pid>/cmdline` to determine which
 * Chrome main process currently holds `profileDir` and whether it has `--remote-debugging-port`.
 */
export function readProfileSingletonOwner(profileDir, procRoot = '/proc') {
  const lockPath = path.join(profileDir, 'SingletonLock')
  let target
  try {
    target = fs.readlinkSync(lockPath)
  } catch {
    return { locked: false, pid: null, cdpPort: null, ownsProfile: false }
  }
  const dashIdx = target.lastIndexOf('-')
  const pid = dashIdx >= 0 ? Number(target.slice(dashIdx + 1)) : Number.NaN
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
    return {
      locked: false,
      pid: Number.isInteger(pid) ? pid : null,
      cdpPort: null,
      ownsProfile: false,
      staleSingleton: true,
    }
  }
  let cmdline = ''
  try {
    cmdline = fs
      .readFileSync(path.join(procRoot, String(pid), 'cmdline'))
      .toString('utf8')
      .replace(/\0/g, ' ')
  } catch {
    return { locked: true, pid, cdpPort: null, ownsProfile: false }
  }
  const ownsProfile = cmdline.includes(`--user-data-dir=${profileDir}`)
  const portMatch = cmdline.match(/--remote-debugging-port=(\d+)/)
  const cdpPort = portMatch ? Number(portMatch[1]) : null
  return {
    locked: true,
    pid,
    cdpPort,
    ownsProfile,
    cmdline,
  }
}

/**
 * Single-tab in-process serial job queue (concurrency = 1).
 * Ensures concurrent turn submissions never race on the single ChatGPT Web tab.
 */
export class SerialJobQueue {
  #tail = Promise.resolve()
  #pending = 0

  get size() {
    return this.#pending
  }

  enqueue(fn, { timeoutMs = 0 } = {}) {
    this.#pending += 1
    const run = async () => {
      try {
        return await fn()
      } finally {
        this.#pending -= 1
      }
    }
    const taskPromise = this.#tail.then(run, run)
    this.#tail = taskPromise.catch(() => {})
    if (timeoutMs > 0) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`BOX_GPT_WEB_QUEUE_TIMEOUT after ${timeoutMs}ms`))
        }, timeoutMs)
        taskPromise.then(
          (val) => {
            clearTimeout(timer)
            resolve(val)
          },
          (err) => {
            clearTimeout(timer)
            reject(err)
          },
        )
      })
    }
    return taskPromise
  }
}

/**
 * Cross-process file lock for the persistent Chrome profile so two overlapping SSH runners
 * serialize cleanly instead of colliding on the same tab. Reclaims locks immediately if the
 * recorded owner PID is no longer alive.
 */
let localLockSeq = 0

export async function withProfileFileLock(
  lockPath,
  fn,
  {
    timeoutMs = 60_000,
    pollMs = 150,
    staleMs = 1_500_000,
    pidAliveFn = isPidAlive,
    busyMessage = null,
  } = {},
) {
  void staleMs
  const deadline = Date.now() + timeoutMs
  const holdersDir = `${lockPath}.holders`
  fs.mkdirSync(holdersDir, { recursive: true, mode: 0o700 })

  const invocationId = `${String(process.pid).padStart(10, '0')}-${process.hrtime.bigint().toString(36)}-${(++localLockSeq).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const enteringName = `entering-${invocationId}.json`
  const enteringPath = path.join(holdersDir, enteringName)
  let ticketName = null
  let ticketPath = null

  const writeJsonAtomically = (targetPath, obj) => {
    const tmp = `${targetPath}.tmp.${process.pid}.${++localLockSeq}`
    try {
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
      fs.renameSync(tmp, targetPath)
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  }

  const checkPayloadStatus = (filePath) => {
    let st
    try {
      st = fs.statSync(filePath)
    } catch {
      return 'missing'
    }
    if (!st.isFile()) return 'missing'
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || !Number.isInteger(parsed.pid)) {
        return 'dead'
      }
      if (!pidAliveFn(parsed.pid)) {
        return 'dead'
      }
      return 'alive'
    } catch {
      return 'dead'
    }
  }

  const parseTicketFile = (name) => {
    if (!name.startsWith('ticket-') || !name.endsWith('.json')) return null
    const body = name.slice('ticket-'.length, -'.json'.length)
    const dash = body.indexOf('-')
    if (dash <= 0) return null
    const num = Number(body.slice(0, dash))
    const id = body.slice(dash + 1)
    if (!Number.isFinite(num) || !id) return null
    return { num, id }
  }

  const parseEnteringFile = (name) => {
    if (!name.startsWith('entering-') || !name.endsWith('.json')) return null
    const id = name.slice('entering-'.length, -'.json'.length)
    return id || null
  }

  try {
    // Step 1: Announce entering in holdersDir using an invocation-unique filename
    writeJsonAtomically(enteringPath, {
      pid: process.pid,
      acquiredAt: Date.now(),
      id: invocationId,
    })

    // Step 2: Scan existing live tickets, pick max + 1, and publish our unique ticket file
    let maxTicketNum = 0
    for (const name of fs.readdirSync(holdersDir)) {
      const t = parseTicketFile(name)
      if (t && t.num > maxTicketNum) {
        maxTicketNum = t.num
      }
    }
    const myNumber = maxTicketNum + 1
    ticketName = `ticket-${String(myNumber).padStart(12, '0')}-${invocationId}.json`
    ticketPath = path.join(holdersDir, ticketName)
    writeJsonAtomically(ticketPath, {
      pid: process.pid,
      acquiredAt: Date.now(),
      number: myNumber,
      id: invocationId,
    })

    // Snapshot any entering-* files present at the moment our ticket is on disk
    const dirAfterTicket = fs.readdirSync(holdersDir)
    const ticketsAtSnapshot = new Set()
    for (const name of dirAfterTicket) {
      const t = parseTicketFile(name)
      if (t) ticketsAtSnapshot.add(t.id)
    }
    const preExistingEntering = new Set()
    for (const name of dirAfterTicket) {
      const entId = parseEnteringFile(name)
      if (entId && entId !== invocationId && !ticketsAtSnapshot.has(entId)) {
        preExistingEntering.add(entId)
      }
    }

    // Step 3: Remove our own entering marker now that our ticket is visible on disk
    try {
      fs.unlinkSync(enteringPath)
    } catch {}

    // Step 4: Wait until our ticket is at the head of the live queue.
    // Note: We NEVER unlink another process's file; dead-PID files are simply ignored,
    // which eliminates any SIGSTOP/SIGCONT unlink race across processes.
    while (true) {
      let blocked = false

      // Respect any externally-seeded live lockPath / .reclaim file; ignore if dead/corrupt
      for (const legacyPath of [lockPath, `${lockPath}.reclaim`]) {
        if (checkPayloadStatus(legacyPath) === 'alive') {
          blocked = true
          break
        }
      }

      // Pass 1: Wait for any pre-existing entering-* files to finish publishing their ticket
      if (!blocked && preExistingEntering.size > 0) {
        const curNames = fs.readdirSync(holdersDir)
        const curTickets = new Set()
        for (const name of curNames) {
          const t = parseTicketFile(name)
          if (t) curTickets.add(t.id)
        }
        for (const entId of [...preExistingEntering]) {
          if (curTickets.has(entId)) {
            preExistingEntering.delete(entId)
            continue
          }
          const full = path.join(holdersDir, `entering-${entId}.json`)
          const st = checkPayloadStatus(full)
          if (st === 'alive') {
            blocked = true
            break
          }
          preExistingEntering.delete(entId)
        }
      }

      // Pass 2: Fresh directory read to check if any live ticket is ordered before ours
      if (!blocked) {
        let sawSelf = false
        for (const name of fs.readdirSync(holdersDir)) {
          const t = parseTicketFile(name)
          if (!t) continue
          if (t.id === invocationId) {
            sawSelf = true
            continue
          }
          const full = path.join(holdersDir, name)
          if (checkPayloadStatus(full) === 'alive') {
            if (t.num < myNumber || (t.num === myNumber && t.id < invocationId)) {
              blocked = true
              break
            }
          }
        }
        if (!blocked && !sawSelf) {
          throw new Error(`BOX_GPT_WEB_LOCK_LOST: ticket ${ticketName} disappeared`)
        }
      }

      if (!blocked) {
        break
      }

      if (Date.now() >= deadline) {
        const msg = busyMessage
          ? `${busyMessage} (BOX_GPT_WEB_LOCK_TIMEOUT: could not acquire ${lockPath} within ${timeoutMs}ms)`
          : `BOX_GPT_WEB_LOCK_TIMEOUT: could not acquire ${lockPath} within ${timeoutMs}ms`
        throw new Error(msg)
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }

    return await fn()
  } finally {
    try {
      fs.unlinkSync(enteringPath)
    } catch {}
    if (ticketPath) {
      try {
        fs.unlinkSync(ticketPath)
      } catch {}
    }
  }
}

const SESSION_MAP_FILENAME = 'oc-session-conversations.json'
const CONV_ID_RE = /^[a-z0-9_-]{8,128}$/i

export function loadSessionConversationMap(profileDir) {
  try {
    const raw = fs.readFileSync(path.join(profileDir, SESSION_MAP_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function saveSessionConversationId(profileDir, sessionId, conversationId) {
  if (!sessionId || !conversationId || !CONV_ID_RE.test(conversationId)) return
  try {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    const map = loadSessionConversationMap(profileDir)
    map[sessionId] = conversationId
    const file = path.join(profileDir, SESSION_MAP_FILENAME)
    fs.writeFileSync(file, JSON.stringify(map, null, 2), { mode: 0o600 })
  } catch {}
}

const ACTIVE_TURNS_FILENAME = 'oc-active-turns.json'

export function loadActiveTurnState(profileDir, sessionId) {
  if (!profileDir || !sessionId) return null
  try {
    const raw = fs.readFileSync(path.join(profileDir, ACTIVE_TURNS_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const entry = parsed[sessionId]
    return entry && typeof entry === 'object' ? entry : null
  } catch {
    return null
  }
}

export function saveActiveTurnState(profileDir, sessionId, state) {
  if (!profileDir || !sessionId || !state || typeof state !== 'object') return
  try {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    const file = path.join(profileDir, ACTIVE_TURNS_FILENAME)
    let map = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed
    } catch {}
    map[sessionId] = {
      ...state,
      updatedAt: Date.now(),
    }
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {}
}

export function clearActiveTurnState(profileDir, sessionId) {
  if (!profileDir || !sessionId) return
  try {
    const file = path.join(profileDir, ACTIVE_TURNS_FILENAME)
    const raw = fs.readFileSync(file, 'utf8')
    const map = JSON.parse(raw)
    if (!map || typeof map !== 'object' || !(sessionId in map)) return
    delete map[sessionId]
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {}
}

/**
 * Ensures the browser tab is bound to the ChatGPT conversation belonging to `sessionId`.
 * - If `sessionId` has a recorded conversationId, navigates to `https://chatgpt.com/c/<convId>`.
 * - If `sessionId` is a new session and the tab is currently on another conversation `/c/...`,
 *   navigates back to `https://chatgpt.com/` so prompts never leak across sessions.
 */
/**
 * Clears any unsent draft text and removes any leftover attachment chips in the composer
 * so a cancelled or failed turn never leaks draft content into a subsequent turn or session.
 */
export async function resetComposerDraftInPage(page) {
  if (!page || typeof page.evaluate !== 'function') return
  await page
    .evaluate(() => {
      if (typeof document === 'undefined') return
      const removeBtns = document.querySelectorAll('button[aria-label^="Remove "]')
      for (const btn of removeBtns) {
        if (typeof btn.click === 'function') btn.click()
      }
      const candidates = Array.from(
        document.querySelectorAll(
          '#prompt-textarea, div.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]',
        ),
      )
      for (const el of candidates) {
        const rawVal = typeof el.value === 'string' ? el.value : ''
        const rawText = el.innerText || el.textContent || ''
        const currentText = (rawVal || rawText).trim()
        if (!currentText) continue
        if ('value' in el && typeof el.value === 'string') {
          el.value = ''
        }
        if (typeof el.focus === 'function' && typeof document.execCommand === 'function') {
          try {
            el.focus()
            document.execCommand('selectAll', false, null)
            document.execCommand('delete', false, null)
          } catch {}
        }
        if ((el.innerText ?? el.textContent ?? '').trim()) {
          el.textContent = ''
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    .catch(() => {})
}

export async function syncPageToSessionConversation(
  page,
  { profileDir, sessionId, initScript = backendFetchTeeInitScript() },
) {
  const map = loadSessionConversationMap(profileDir)
  let mappedConvId = sessionId && map[sessionId] ? map[sessionId] : null
  const currentUrl = page.url()
  const currentMatch = currentUrl.match(/\/c\/([a-z0-9_-]{8,128})/i)
  const currentConvId = currentMatch ? currentMatch[1] : null

  if (!mappedConvId && sessionId) {
    const activeTurn = loadActiveTurnState(profileDir, sessionId)
    if (activeTurn && !activeTurn.completedAt) {
      if (activeTurn.conversationId && CONV_ID_RE.test(activeTurn.conversationId)) {
        mappedConvId = activeTurn.conversationId
        saveSessionConversationId(profileDir, sessionId, mappedConvId)
      } else if (currentConvId && !Object.values(map).includes(currentConvId)) {
        mappedConvId = currentConvId
        saveSessionConversationId(profileDir, sessionId, mappedConvId)
      }
    }
  }

  if (mappedConvId) {
    const needNav = currentConvId !== mappedConvId
    if (needNav) {
      await page.goto(`${DEFAULT_CHATGPT_ORIGIN}/c/${mappedConvId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
    }
    if (initScript) await page.evaluate(initScript)
    await resetComposerDraftInPage(page)
    return { conversationId: mappedConvId, navigated: needNav }
  }

  // Brand-new session (no recorded conversationId): always navigate cleanly to https://chatgpt.com/
  // and reset the composer draft so an aborted prior session on "/" cannot leak its unsent draft.
  await page.goto(`${DEFAULT_CHATGPT_ORIGIN}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  })
  if (initScript) await page.evaluate(initScript)
  await resetComposerDraftInPage(page)
  return { conversationId: null, navigated: true }
}

export function levelIndex(raw) {
  if (!raw) return -1
  const k = String(raw).trim().toLowerCase()
  const canon = LEVEL_ALIASES[k]
  return canon ? LEVEL_ORDER.indexOf(canon) : -1
}

export function stripTierCaption(s) {
  return String(s || '')
    .replace(/\n(Instant|Light|Standard|Extended|Pro)(\n.*)?$/i, '')
    .trim()
}

export class TierLimitError extends Error {
  constructor(info) {
    super(info.message || `ChatGPT tier limit hit (${info.hitLevel || 'Pro'})`)
    this.name = 'TierLimitError'
    this.code = 'TIER_LIMIT'
    this.hitLevel = info.hitLevel || 'Pro'
    this.fallbackLevel = info.fallbackLevel || null
  }
}

/**
 * Parses ChatGPT Web's quota-exhausted banner text:
 *   "You've hit your Pro limit. Switch to Extended until your limit resets on ..."
 */
export function detectTierLimit(bannerTexts, targetIdx = 4) {
  const texts = Array.isArray(bannerTexts) ? bannerTexts : [String(bannerTexts || '')]
  for (const raw of texts) {
    const t = String(raw || '').trim()
    if (!t) continue
    const hitMatch = t.match(/hit your\s+(\w[\w\s-]*?)\s+limit/i)
    const switchMatch = t.match(/Switch to\s+(\w[\w\s-]*?)\s+until/i)
    const fallbackRaw = switchMatch ? switchMatch[1].trim() : null
    const hitRaw = hitMatch ? hitMatch[1].trim() : null
    const fallbackIdx = levelIndex(fallbackRaw)
    const hitIdx = levelIndex(hitRaw)
    if (fallbackIdx >= 0 && targetIdx > fallbackIdx) {
      return {
        blocked: true,
        hitLevel: hitRaw || 'Pro',
        fallbackLevel: fallbackRaw,
        message: t,
      }
    }
    if (hitIdx >= 0 && targetIdx >= hitIdx) {
      return {
        blocked: true,
        hitLevel: hitRaw,
        fallbackLevel: fallbackRaw,
        message: t,
      }
    }
  }
  return null
}

/**
 * Fail-closed session state probe. Requires positive composer readiness evidence (`hasComposer`).
 * NEVER auto-fills credentials, NEVER clicks login buttons, NEVER reads external cookies.
 */
export async function probeSessionState(
  page,
  { profileDir = profileDirFor(DEFAULT_PROFILE), display = DEFAULT_DISPLAY } = {},
) {
  const info = await page.evaluate(() => {
    const href = location.href || ''
    const title = document.title || ''
    const bodyText = (document.body?.innerText || '').slice(0, 2000)
    const hasLoginBtn = Boolean(
      document.querySelector('[data-testid="login-button"]') ||
        document.querySelector('[data-testid="welcome-login-button"]') ||
        document.querySelector('a[href*="/auth/login"]'),
    )
    const hasComposer = Boolean(
      document.querySelector(
        '#prompt-textarea, div.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]',
      ) ||
        document.querySelector(
          '[data-testid="model-switcher-dropdown-button"], button[aria-label="Select ChatGPT model"]',
        ),
    )
    const isCfChallenge =
      title.includes('Just a moment') ||
      Boolean(
        document.querySelector(
          '#challenge-running, #cf-challenge-running, iframe[src*="turnstile"]',
        ),
      )
    return { href, title, bodyText, hasLoginBtn, hasComposer, isCfChallenge }
  })

  if (info.isCfChallenge) {
    return {
      ok: false,
      code: 'CF_CHALLENGE',
      message: `[box-gpt-6-astra-pro] Cloudflare Turnstile challenge detected on Box browser (${display}, profile ${profileDir}). Please open the Box Desktop (noVNC :6080 / DISPLAY=:1) to pass the challenge or enable the local-only Box sing-box proxy (127.0.0.1:18992).`,
    }
  }

  if (info.hasLoginBtn || info.href.includes('/auth/login') || !info.hasComposer) {
    return {
      ok: false,
      code: 'NOT_LOGGED_IN',
      message: `[box-gpt-6-astra-pro] ChatGPT Pro session is not logged in inside Box profile ${profileDir} (DISPLAY=${display}). Automated login is disabled by policy. Please open Box Desktop (noVNC port 6080 / DISPLAY=:1) and manually sign in to https://chatgpt.com with your ChatGPT Pro account.`,
    }
  }

  return { ok: true, code: 'READY', message: 'Logged in and composer ready' }
}

/**
 * Selects the Pro tier (index 4 / 100% Max intelligence) on ChatGPT Web's
 * 5-position Intelligence slider and verifies no quota banner blocks Pro.
 */
/**
 * Resolves a Playwright locator matching `selector` that is currently visible (`isVisible() === true`).
 * ChatGPT Web conversation DOM (`/c/<convId>`) and SPA route transitions often keep a hidden `0x0`
 * duplicate of `button[aria-label="Select ChatGPT model"]` or `#prompt-textarea` at index 0 while
 * the active composer control is at index 1+. Iterates from the last matching node to the first so
 * the bottom composer control wins when multiple nodes exist, and stays backward-compatible with
 * lightweight unit-test mocks that only implement `.first()` / `.count()`.
 */
export async function resolveVisibleLocator(page, selector, { timeoutMs = 0, pollMs = 150 } = {}) {
  if (!page || typeof page.locator !== 'function') {
    throw new Error(`BOX_GPT_WEB_LOCATOR_UNAVAILABLE: invalid page for selector ${selector}`)
  }
  const base = page.locator(selector)
  const fallback = () => (base && typeof base.first === 'function' ? base.first() : base)
  if (!base || typeof base.count !== 'function') {
    return fallback()
  }

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  while (true) {
    const total = await base.count().catch(() => 0)
    if (total > 0) {
      if (typeof base.nth !== 'function') {
        return fallback()
      }
      for (let i = total - 1; i >= 0; i--) {
        const cand = base.nth(i)
        if (!cand || typeof cand.isVisible !== 'function') {
          return fallback()
        }
        const vis = await cand.isVisible().catch(() => false)
        if (vis) return cand
      }
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return fallback()
}

export async function selectProTierInPage(page, { requestedTier = 'pro' } = {}) {
  const targetCanon = LEVEL_ALIASES[String(requestedTier).toLowerCase()] || 'pro'
  const targetIdx = LEVEL_ORDER.indexOf(targetCanon)

  const readBanners = async () =>
    page.evaluate(() => {
      const candidates = document.querySelectorAll(
        '[role="alert"], [data-testid*="limit"], [data-testid*="banner"], main aside, main div',
      )
      const out = []
      for (const el of candidates) {
        const txt = (el.textContent || '').trim()
        if (txt && txt.length < 400 && /hit your .* limit/i.test(txt)) {
          out.push(txt)
        }
      }
      return out
    })

  const preLimit = detectTierLimit(await readBanners(), targetIdx)
  if (preLimit?.blocked) {
    throw new TierLimitError(preLimit)
  }

  let switcher = await resolveVisibleLocator(page, '[data-testid="model-switcher-dropdown-button"]')
  const primaryCount = typeof switcher.count === 'function' ? await switcher.count() : 0
  const primaryVisible =
    primaryCount > 0 &&
    (typeof switcher.isVisible !== 'function' || (await switcher.isVisible().catch(() => false)))
  if (!primaryVisible) {
    const altSwitcher = await resolveVisibleLocator(
      page,
      'button[aria-label="Select ChatGPT model"]',
      { timeoutMs: 15_000 },
    )
    if (typeof altSwitcher.count === 'function' && (await altSwitcher.count()) > 0) {
      switcher = altSwitcher
    }
  }
  if ((await switcher.count()) === 0) {
    throw new Error(
      'BOX_GPT_WEB_SWITCHER_MISSING: [data-testid="model-switcher-dropdown-button"] not found',
    )
  }
  if (
    typeof switcher.isVisible === 'function' &&
    !(await switcher.isVisible().catch(() => false))
  ) {
    throw new Error(
      'BOX_GPT_WEB_SWITCHER_NOT_VISIBLE: model switcher button is present in DOM but hidden',
    )
  }
  await switcher.click()

  const menu = await resolveVisibleLocator(page, '[role="menu"]', { timeoutMs: 5_000 })
  if (typeof menu.waitFor === 'function') {
    await menu.waitFor({ state: 'visible', timeout: 5_000 })
  }

  const slider = menu.locator('[role="slider"]').first()
  let selectedCaption = null
  if ((await slider.count()) > 0) {
    await slider.focus()
    for (let i = 0; i < 5; i++) {
      const nowVal = await slider.getAttribute('aria-valuenow')
      if (Number(nowVal) === targetIdx) break
      const key = Number(nowVal || 0) < targetIdx ? 'ArrowRight' : 'ArrowLeft'
      await page.keyboard.press(key)
    }
    const afterKeyVal = await slider.getAttribute('aria-valuenow')
    if (Number(afterKeyVal) !== targetIdx) {
      const box = await slider.boundingBox()
      if (box) {
        const ratio = targetIdx / (LEVEL_ORDER.length - 1)
        const targetX = box.x + Math.max(2, Math.min(box.width - 2, box.width * ratio))
        const targetY = box.y + box.height / 2
        await page.mouse.click(targetX, targetY)
      }
    }
    const finalValRaw = await slider.getAttribute('aria-valuenow')
    const finalValText = await slider.getAttribute('aria-valuetext')
    const finalValNum = finalValRaw !== null ? Number(finalValRaw) : Number.NaN
    const captionIdx = finalValText ? levelIndex(finalValText.split(/[-–—]/)[0].trim()) : -1
    if (finalValNum !== targetIdx && captionIdx !== targetIdx) {
      await page.keyboard.press('Escape').catch(() => {})
      const postClickLimit = detectTierLimit(await readBanners(), targetIdx)
      if (postClickLimit?.blocked) {
        throw new TierLimitError(postClickLimit)
      }
      throw new Error(
        `BOX_GPT_WEB_TIER_MISMATCH: requested ${targetCanon} (index ${targetIdx}) but slider remained at aria-valuenow=${String(finalValRaw)} aria-valuetext=${String(finalValText)}`,
      )
    }
    if (captionIdx !== -1 && captionIdx !== targetIdx) {
      await page.keyboard.press('Escape').catch(() => {})
      throw new Error(
        `BOX_GPT_WEB_TIER_MISMATCH: requested ${targetCanon} (index ${targetIdx}) but slider aria-valuetext=${String(finalValText)}`,
      )
    }
    selectedCaption = finalValText || LEVEL_SLIDER_PCT[targetCanon]
  } else {
    const proItem = menu
      .locator('[role="menuitem"], [role="menuitemradio"]')
      .filter({ hasText: /\bPro\b/i })
      .first()
    if ((await proItem.count()) > 0) {
      await proItem.click()
      selectedCaption = 'Pro'
    } else {
      await page.keyboard.press('Escape').catch(() => {})
      throw new Error(
        'BOX_GPT_WEB_PRO_SLIDER_NOT_FOUND: neither [role="slider"] nor Pro menuitem found in model switcher',
      )
    }
  }

  await page.keyboard.press('Escape').catch(() => {})

  const postLimit = detectTierLimit(await readBanners(), targetIdx)
  if (postLimit?.blocked) {
    throw new TierLimitError(postLimit)
  }

  const buttonLabel = stripTierCaption(await switcher.innerText().catch(() => 'ChatGPT'))
  return {
    modelLabel: buttonLabel,
    tier: targetCanon,
    sliderIndex: targetIdx,
    selectedCaption,
  }
}

/**
 * Uploads one or more local files/images into the ChatGPT composer atomically.
 * Dispatches synthetic input + change events after setInputFiles so React 19 / ProseMirror
 * commits the attachment state, and waits for attachment chips to finish uploading.
 */
export async function uploadAttachmentsToComposer(
  page,
  filePaths,
  { timeoutMs = 45_000, pollMs = 150 } = {},
) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return { uploadedCount: 0 }
  for (const fp of filePaths) {
    const stat = fs.statSync(fp)
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`BOX_GPT_WEB_INVALID_ATTACHMENT: ${fp} must be a non-empty file`)
    }
  }

  const countChips = () =>
    page.evaluate(() => {
      return document.querySelectorAll(
        'button[aria-label^="Remove "], [data-testid*="attachment-item"], [data-testid*="file-thumbnail"]',
      ).length
    })

  const beforeCount = await countChips()
  const fileInputs = page.locator('input[type="file"]')
  const inputCount = await fileInputs.count()
  if (inputCount === 0) {
    throw new Error('BOX_GPT_WEB_FILE_INPUT_MISSING: no input[type="file"] found in composer')
  }

  const targetInput = fileInputs.first()
  await targetInput.setInputFiles(filePaths)
  await targetInput.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await page.evaluate((prev) => {
      const chips = document.querySelectorAll(
        'button[aria-label^="Remove "], [data-testid*="attachment-item"], [data-testid*="file-thumbnail"]',
      ).length
      const spinners = document.querySelectorAll(
        '[role="progressbar"], [data-testid*="upload-progress"], svg.animate-spin',
      ).length
      return { chips, spinners, added: chips > prev }
    }, beforeCount)
    if (state.added && state.spinners === 0) {
      return { uploadedCount: state.chips - beforeCount }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    `BOX_GPT_WEB_UPLOAD_TIMEOUT: attachments did not finish uploading within ${timeoutMs}ms`,
  )
}

/**
 * Types multiline prompt text into #prompt-textarea without calling .fill()
 * (which would wipe ProseMirror attachment chips) and uses Shift+Enter for newlines
 * so Enter does not prematurely submit the turn.
 */
export async function typeMultilinePreservingAttachments(page, text) {
  let composer = await resolveVisibleLocator(page, '#prompt-textarea', { timeoutMs: 2_000 })
  const primaryCount = typeof composer.count === 'function' ? await composer.count() : 1
  const primaryVisible =
    primaryCount > 0 &&
    (typeof composer.isVisible !== 'function' || (await composer.isVisible().catch(() => false)))
  if (!primaryVisible) {
    const altComposer = await resolveVisibleLocator(
      page,
      'div.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]',
      { timeoutMs: 10_000 },
    )
    if (typeof altComposer.count !== 'function' || (await altComposer.count()) > 0) {
      composer = altComposer
    }
  }
  if (typeof composer.waitFor === 'function') {
    await composer.waitFor({ state: 'visible', timeout: 15_000 })
  }
  await composer.click()
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      await page.keyboard.insertText(lines[i])
    }
    if (i < lines.length - 1) {
      await page.keyboard.press('Shift+Enter')
    }
  }
}

/**
 * Init script injected into the page to tee /backend-api/f/conversation SSE frames
 * from window.fetch without altering ChatGPT's own ReadableStream consumption.
 */
export function backendFetchTeeInitScript() {
  return `(() => {
    if (window.__ocGptWebFetchHooked) return;
    window.__ocGptWebFetchHooked = true;
    window.__ocSseEvents = [];
    window.__ocActiveTurnSeq = 0;
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const req = args[0];
      const init = args[1] || {};
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      const method = (init.method || (req && req.method) || 'GET').toUpperCase();
      const isConvPost =
        method === 'POST' &&
        (url.includes('/backend-api/f/conversation') || url.includes('/backend-api/conversation')) &&
        !url.includes('/prepare');
      const res = await origFetch.apply(this, args);
      if (isConvPost && res && res.body) {
        const seq = ++window.__ocActiveTurnSeq;
        window.__ocSseEvents = [];
        try {
          const clone = res.clone();
          const reader = clone.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          (async () => {
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\\n')) >= 0) {
                  const line = buf.slice(0, idx).replace(/\\r$/, '');
                  buf = buf.slice(idx + 1);
                  if (line.startsWith('data: ')) {
                    window.__ocSseEvents.push({ seq, ts: Date.now(), data: line.slice(6) });
                  }
                }
              }
            } catch (err) {
              const msg = String((err && err.message) || err || '');
              if (err?.name !== 'AbortError' && !/aborted/i.test(msg)) {
                window.__ocSseEvents.push({ seq, ts: Date.now(), error: msg });
              }
            } finally {
              window.__ocSseEvents.push({ seq, ts: Date.now(), eof: true });
            }
          })();
        } catch {}
      }
      return res;
    };
  })();`
}

// ChatGPT Web inline markers (OCV5-584): U+E200 <kind> U+E202 <payload…> U+E201, e.g. cite + turn0search3 refs,
// genui + {"citation":{"ref":"turn27view0"}} or {"citation":{"refs":[…]}}, entity + ["company","Topcon",…].
// chatgpt.com renders them as source chips; passed through raw they leak as private-use glyphs plus JSON.
const CITE_OPEN = ''
const CITE_CLOSE = ''
const CITE_SEP = ''
const CITE_STRAY_RE = /[-]/g
const CITE_REF_RE = /^turn\d+[a-z_]+\d+$/i
const CITE_HEAD_RE = /^[a-z_]{1,32}/i
const CITE_HEAD_PREFIX_RE = /^[a-z_]{0,32}$/i
/** A marker head longer than this is not a marker: only its private-use chars are dropped. */
export const CHATGPT_MARKER_MAX_LEN = 65_536

function citationRefId(ref) {
  if (typeof ref === 'string') return CITE_REF_RE.test(ref) ? ref : null
  const { turn_index: turn, ref_type: type, ref_index: index } = ref && typeof ref === 'object' ? ref : {}
  if (!Number.isInteger(turn) || !Number.isInteger(index) || typeof type !== 'string') return null
  const id = `turn${turn}${type}${index}`
  return CITE_REF_RE.test(id) ? id : null
}

function citationSource(obj) {
  const url = obj && typeof obj === 'object' && typeof obj.url === 'string' ? obj.url.trim() : ''
  if (!/^https?:\/\/[^\s/]/i.test(url) || [...url].some((ch) => ch < ' ' || ch === '\x7f')) return null
  return { url, title: typeof obj.title === 'string' ? obj.title.trim() : '' }
}

function addCitationSource(into, key, src) {
  const list = into.get(key) || []
  if (!list.some((s) => s.url === src.url)) list.push(src)
  into.set(key, list)
}

/** Collects http(s) citation sources from any ChatGPT message metadata fragment into `into`
 * (Map<refId | `matched:${markerText}`, {url,title}[]>). A bounded generic walk, because the shape varies:
 * content_references[] {matched_text, refs[], items[]}, search_result_groups[].entries[] {url, title, ref_id}. */
export function collectChatgptCitationSources(value, into = new Map()) {
  let budget = 20_000
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 10 || budget-- <= 0) return
    if (Array.isArray(v)) return v.forEach((item) => walk(item, depth + 1))
    const own = citationSource(v)
    const refId = citationRefId(v.ref_id)
    if (own && refId) addCitationSource(into, refId, own)
    const items = (Array.isArray(v.items) ? v.items : []).map(citationSource).filter(Boolean)
    const sources = items.length > 0 ? items : own ? [own] : []
    if (typeof v.matched_text === 'string' && v.matched_text.includes(CITE_OPEN)) {
      for (const s of sources) addCitationSource(into, `matched:${v.matched_text}`, s)
    }
    const refs = (Array.isArray(v.refs) ? v.refs : []).map(citationRefId).filter(Boolean)
    refs.forEach((id, i) => {
      for (const s of refs.length === sources.length ? [sources[i]] : sources) addCitationSource(into, id, s)
    })
    for (const key of Object.keys(v)) walk(v[key], depth + 1)
  }
  walk(value, 0)
  return into
}

function markerJson(payload) {
  try {
    return JSON.parse(payload.join(CITE_SEP))
  } catch {
    return null
  }
}

function citationRefsOf(kind, payload) {
  if (kind !== 'genui') return payload.map((p) => p.trim()).filter((p) => CITE_REF_RE.test(p))
  const c = markerJson(payload)?.citation
  if (!c || typeof c !== 'object') return []
  return (Array.isArray(c.refs) ? c.refs : [c.ref]).map(citationRefId).filter(Boolean)
}

const markdownSafeUrl = (url) =>
  url.replace(/[\s()<>]/g, (ch) => encodeURIComponent(ch).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29')))

/** Raw ChatGPT final text → display text (OCV5-584). A citation marker with a known source becomes [n](url),
 * otherwise it goes; entity markers keep their name; stray marker chars never reach the output. An unterminated
 * marker is held while streaming (split SSE frames never leak) and dropped at the end. Prefix-stable: a marker
 * renders once (on reconnect, as the previous host delivered it); sources known only later go to a final 来源 list. */
export class ChatgptCitationRenderer {
  constructor({ sources = null } = {}) {
    this.sources = new Map()
    this.renderedByMarker = new Map()
    this.numberByUrl = new Map()
    this.nextNumber = 1
    this.pendingRefs = []
    this.addSources(sources)
  }

  addSources(sources) {
    for (const [key, list] of sources || []) for (const s of list) addCitationSource(this.sources, key, s)
  }

  exportState() {
    const { renderedByMarker: r, numberByUrl: n, nextNumber, pendingRefs } = this
    return { rendered: [...r], numbers: [...n], nextNumber, pendingRefs }
  }

  restoreState(state) {
    if (!Array.isArray(state?.rendered) || !Array.isArray(state.numbers)) return
    Object.assign(this, { renderedByMarker: new Map(state.rendered), numberByUrl: new Map(state.numbers),
      nextNumber: Number(state.nextNumber) || state.numbers.length + 1, pendingRefs: state.pendingRefs || [] })
  }

  #resolve(markerText, refs) {
    const found = new Map()
    for (const key of [`matched:${markerText}`, ...refs]) {
      for (const s of this.sources.get(key) || []) if (!found.has(s.url)) found.set(s.url, s)
    }
    return [...found.values()]
  }

  #numberFor(url) {
    const key = markdownSafeUrl(url)
    if (!this.numberByUrl.has(key)) this.numberByUrl.set(key, this.nextNumber++)
    return this.numberByUrl.get(key)
  }

  /** `delivered`: what a previous host already sent at this position (reconnect) — adopted, never contradicted. */
  #renderMarker(markerText, delivered) {
    const [kind, ...payload] = markerText.slice(1, -1).split(CITE_SEP)
    if (kind === 'entity') {
      const arr = markerJson(payload)
      return Array.isArray(arr) && typeof arr[1] === 'string' ? arr[1].replace(CITE_STRAY_RE, '') : ''
    }
    const refs = citationRefsOf(kind, payload)
    const found = refs.length > 0 ? this.#resolve(markerText, refs) : []
    if (delivered != null) {
      // Fallback when the renderer state was lost: claim only this marker's links (its own sources, or
      // at most one per ref when they are unknown) so an adjacent marker keeps its own.
      const safe = new Set(found.map((s) => markdownSafeUrl(s.url)))
      const mine = []
      for (const l of delivered.match(/^(?:\[\d+\]\([^)\s]+\))+/)?.[0].matchAll(/\[(\d+)\]\(([^)\s]+)\)/g) ?? []) {
        if (safe.size > 0 ? !safe.has(l[2]) : mine.length >= refs.length) break
        this.numberByUrl.set(l[2], Number(l[1]))
        this.nextNumber = Math.max(this.nextNumber, Number(l[1]) + 1)
        mine.push(l[0])
      }
      if (mine.length > 0) return mine.join('')
    }
    if (refs.length > 0 && (found.length === 0 || delivered != null)) this.pendingRefs.push({ markerText, refs })
    if (delivered != null) return ''
    return found.map((s) => `[${this.#numberFor(s.url)}](${markdownSafeUrl(s.url)})`).join('')
  }

  render(rawText, { final = false, delivered = '' } = {}) {
    const raw = String(rawText ?? '')
    let out = ''
    let i = 0
    while (i < raw.length) {
      const open = raw.indexOf(CITE_OPEN, i)
      out += raw.slice(i, open < 0 ? raw.length : open).replace(CITE_STRAY_RE, '')
      if (open < 0) break
      const close = raw.indexOf(CITE_CLOSE, open + 1)
      const reopen = raw.indexOf(CITE_OPEN, open + 1)
      const cut = reopen >= 0 && (close < 0 || reopen < close)
      const end = cut ? reopen : close < 0 ? raw.length : close + 1
      const seg = raw.slice(open, end)
      const head = seg.length <= CHATGPT_MARKER_MAX_LEN && CITE_HEAD_RE.test(seg)
      if (!cut && close >= 0 && head) {
        const key = `${open}:${seg}`
        const prior = delivered.length > out.length ? delivered.slice(out.length) : null
        if (!this.renderedByMarker.has(key)) this.renderedByMarker.set(key, this.#renderMarker(seg, prior))
        out += this.renderedByMarker.get(key)
        i = end
      } else if (!cut && close < 0 && (head || (seg.length <= 33 && CITE_HEAD_PREFIX_RE.test(seg)))) {
        // unterminated marker (maybe split across SSE frames): held while streaming, dropped at the end
        if (!final) return out
        break
      } else if (cut && head) {
        i = reopen // an abandoned marker head before the next marker
      } else {
        i = open + 1 // not a marker: only the private-use char goes
      }
    }
    return final ? out + this.#lateSourcesSection() : out
  }

  #lateSourcesSection() {
    const late = new Map()
    for (const { markerText, refs } of this.pendingRefs) for (const s of this.#resolve(markerText, refs)) late.set(s.url, s)
    const lines = [...late.values()].map((s) =>
      `${this.#numberFor(s.url)}. [${(s.title || s.url).replace(/[[\]\n\r]/g, ' ').trim()}](${markdownSafeUrl(s.url)})`)
    return lines.length > 0 ? `\n\n来源：\n${lines.join('\n')}` : ''
  }
}

/**
 * Stateful accumulator for ChatGPT Web's delta-encoded SSE frames (event: delta_encoding / v1).
 * Strictly separates internal reasoning (thoughts / reasoning_recap / commentary) from final
 * assistant text (channel === 'final' & content_type in ['text', 'multimodal_text']).
 */
export class SseAccumulator {
  constructor({ onThinkingDelta = null, onTextDelta = null, nowFn = () => Date.now() } = {}) {
    this.onThinkingDelta = onThinkingDelta
    this.onTextDelta = onTextDelta
    this.nowFn = nowFn
    this.conversationId = null
    this.messageId = null
    this.role = null
    this.channel = null
    this.contentType = null
    this.finalText = ''
    this.thinkingText = ''
    this.citationSources = new Map()
    this.done = false
    this.streamHandoff = false
    this.error = null
    this.lastEventAt = nowFn()
  }

  feedDataLine(raw) {
    const trimmed = String(raw ?? '').trim()
    if (!trimmed) return
    this.lastEventAt = this.nowFn()
    if (trimmed === '[DONE]') {
      if (!this.streamHandoff || this.finalText.length > 0) {
        this.done = true
      }
      return
    }
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!obj || typeof obj !== 'object') return

    if (typeof obj.conversation_id === 'string') {
      this.conversationId = obj.conversation_id
    }
    if (obj.v && typeof obj.v === 'object' && typeof obj.v.conversation_id === 'string') {
      this.conversationId = obj.v.conversation_id
    }
    if (obj.type === 'stream_handoff' || obj.type === 'resume_conversation_token') {
      if (obj.type === 'stream_handoff') {
        this.streamHandoff = true
      }
      return
    }
    if (obj.type === 'message_stream_complete') {
      this.done = true
      return
    }
    if (obj.error) {
      this.error =
        typeof obj.error === 'string' ? obj.error : obj.error.message || JSON.stringify(obj.error)
      return
    }

    const msg = obj.v?.message || obj.message
    if (msg && typeof msg === 'object') {
      this.#ingestMessageSnapshot(msg)
      return
    }

    if (typeof obj.o === 'string' || typeof obj.p === 'string') {
      this.#applyPatchOp(obj.p || '', obj.o || 'replace', obj.v)
    } else if (Array.isArray(obj.v)) {
      for (const op of obj.v) {
        if (op && typeof op === 'object') {
          this.#applyPatchOp(op.p || '', op.o || 'replace', op.v)
        }
      }
    }
  }

  #isFinalTextChannel() {
    if (this.role !== 'assistant') return false
    if (this.contentType !== 'text' && this.contentType !== 'multimodal_text') return false
    if (this.channel && this.channel !== 'final') return false
    return true
  }

  #isThinkingChannel() {
    if (this.role !== 'assistant') return false
    return (
      this.contentType === 'thoughts' ||
      this.contentType === 'reasoning_recap' ||
      this.channel === 'commentary' ||
      this.channel === 'thoughts' ||
      this.channel === 'analysis'
    )
  }

  #emitText(delta) {
    if (!delta) return
    this.finalText += delta
    if (typeof this.onTextDelta === 'function') {
      this.onTextDelta(delta)
    }
  }

  #emitThinking(delta) {
    if (!delta) return
    this.thinkingText += delta
    if (typeof this.onThinkingDelta === 'function') {
      this.onThinkingDelta(delta)
    }
  }

  #ingestMessageSnapshot(msg) {
    this.role = msg.author?.role || this.role
    this.channel = msg.channel ?? null
    this.contentType = msg.content?.content_type || null
    if (msg.id) this.messageId = msg.id
    if (msg.metadata && typeof msg.metadata === 'object') {
      collectChatgptCitationSources(msg.metadata, this.citationSources)
    }

    if (this.role !== 'assistant') return

    if (this.#isThinkingChannel()) {
      if (Array.isArray(msg.content?.thoughts)) {
        for (const t of msg.content.thoughts) {
          const piece = t?.content || t?.summary || ''
          if (piece) this.#emitThinking(piece)
        }
      } else if (typeof msg.content?.content === 'string' && msg.content.content) {
        this.#emitThinking(msg.content.content)
      }
      return
    }

    if (this.#isFinalTextChannel() && Array.isArray(msg.content?.parts)) {
      const joined = msg.content.parts
        .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
        .join('')
      if (joined.length > this.finalText.length && joined.startsWith(this.finalText)) {
        this.#emitText(joined.slice(this.finalText.length))
      } else if (!this.finalText && joined) {
        this.#emitText(joined)
      }
    }
  }

  #applyPatchOp(p, o, v) {
    if (o === 'patch' && Array.isArray(v)) {
      for (const sub of v) {
        if (sub && typeof sub === 'object') {
          this.#applyPatchOp(sub.p || p, sub.o || 'replace', sub.v)
        }
      }
      return
    }

    if (p === '/message/channel' && typeof v === 'string') {
      this.channel = v
      return
    }
    if (p.startsWith('/message/metadata')) {
      if (v && typeof v === 'object') collectChatgptCitationSources(v, this.citationSources)
      return
    }
    if (p === '/message/content/content_type' && typeof v === 'string') {
      this.contentType = v
      return
    }

    if (p.startsWith('/message/content/thoughts') || this.#isThinkingChannel()) {
      if (typeof v === 'string' && (o === 'append' || o === 'add' || o === 'replace')) {
        this.#emitThinking(v)
      } else if (v && typeof v === 'object') {
        const piece = v.content || v.summary || ''
        if (typeof piece === 'string' && piece) this.#emitThinking(piece)
      } else if (Array.isArray(v)) {
        for (const item of v) {
          const piece = item?.content || item?.summary || ''
          if (typeof piece === 'string' && piece) this.#emitThinking(piece)
        }
      }
      return
    }

    if (p.startsWith('/message/content/parts/') && this.#isFinalTextChannel()) {
      if (o === 'append' && typeof v === 'string') {
        this.#emitText(v)
      } else if ((o === 'replace' || o === 'add') && typeof v === 'string') {
        if (v.startsWith(this.finalText)) {
          this.#emitText(v.slice(this.finalText.length))
        } else {
          this.#emitText(v)
        }
      }
    }
  }
}

/**
 * Extracts the latest final assistant text from a /backend-api/conversation/<id>
 * mapping tree object (used during Stream-Rescue fallback).
 * Stops immediately if it encounters a user message before any final assistant message
 * (so it never returns an earlier turn's answer), and strictly requires channel === 'final' (or null).
 */
export function extractAssistantFromMapping(
  conv,
  { baselineNodeId = null, allowInProgress = false } = {},
) {
  if (!conv || !conv.mapping) return null
  let cur = conv.current_node
  const visited = new Set()
  while (cur && conv.mapping[cur] && !visited.has(cur)) {
    if (baselineNodeId && cur === baselineNodeId) {
      return null
    }
    visited.add(cur)
    const node = conv.mapping[cur]
    const m = node.message
    if (m) {
      const role = m.author?.role
      if (role === 'user') {
        // Reached the current turn's user message without seeing a final assistant reply.
        return null
      }
      if (role === 'assistant') {
        const ct = m.content?.content_type
        const ch = m.channel
        if (
          ct === 'thoughts' ||
          ct === 'reasoning_recap' ||
          (ch !== undefined && ch !== null && ch !== 'final')
        ) {
          cur = node.parent
          continue
        }
        if (!allowInProgress && m.status && m.status !== 'finished_successfully') {
          return null
        }
        if (ct === 'text' || ct === 'multimodal_text') {
          const parts = (m.content.parts || [])
            .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
            .filter(Boolean)
          if (parts.length > 0) {
            return {
              text: parts.join(''),
              messageId: m.id || cur,
            }
          }
        }
      }
    }
    cur = node.parent
  }
  return null
}

/**
 * Fetches `/backend-api/conversation/<convId>` inside the page with page-level `/api/auth/session`
 * bearer token caching (default TTL 4 minutes) and automatic token refresh + retry on 401/403/404/429/5xx.
 * Prevents `/api/auth/session` rate-limiting during 30+ minute Pro turns (which otherwise causes unauthenticated
 * `/backend-api/conversation/<id>` calls to fail with HTTP 404 `conversation_inaccessible`).
 */
export async function fetchConversationPayloadInPage(
  page,
  fallbackConvId = null,
  { retries = 2, tokenTtlMs = 240_000 } = {},
) {
  if (!page || typeof page.evaluate !== 'function') {
    return { conv: null, convId: fallbackConvId }
  }
  return page
    .evaluate(
      async ({ knownId, maxRetries, ttlMs }) => {
        const m = location.pathname.match(/\/c\/([a-z0-9_-]{8,128})/i)
        const convId = m?.[1] || knownId || null
        if (!convId) return { conv: null, convId: null }

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const getToken = async (forceRefresh = false) => {
          const now = Date.now()
          const cached = window.__ocAuthTokenCache
          if (
            !forceRefresh &&
            cached &&
            typeof cached.token === 'string' &&
            cached.token.length > 0 &&
            now < cached.expiresAt
          ) {
            return cached.token
          }
          for (let sAttempt = 0; sAttempt < 2; sAttempt++) {
            try {
              const sessRes = await fetch('/api/auth/session', { credentials: 'include' })
              if (sessRes.ok) {
                const sess = await sessRes.json()
                const tok = sess?.accessToken || null
                if (tok) {
                  window.__ocAuthTokenCache = {
                    token: tok,
                    expiresAt: Date.now() + ttlMs,
                  }
                  return tok
                }
              }
            } catch {}
            if (sAttempt === 0) await sleep(250)
          }
          return cached?.token || null
        }

        const attempts = Math.max(0, Number(maxRetries) || 0) + 1
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            const token = await getToken(attempt > 0)
            const headers = token ? { Authorization: `Bearer ${token}` } : {}
            const r = await fetch(`/backend-api/conversation/${convId}`, {
              credentials: 'include',
              headers,
            })
            if (r.ok) {
              const conv = await r.json()
              return { conv, convId, status: r.status }
            }
            window.__ocAuthTokenCache = null
          } catch {
            window.__ocAuthTokenCache = null
          }
          if (attempt + 1 < attempts) {
            await sleep(400 * (attempt + 1))
          }
        }
        return { conv: null, convId }
      },
      { knownId: fallbackConvId, maxRetries: retries, ttlMs: tokenTtlMs },
    )
    .catch(() => ({ conv: null, convId: fallbackConvId }))
}

/**
 * Deterministic adaptive timeout & Stream-Rescue state machine for Pro long-thinking turns.
 */
export const DEFAULT_BASE_TIMEOUT_MS = 600_000
export const DEFAULT_STEP_EXTEND_MS = 120_000
export const DEFAULT_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000 // 6 hours
export const DEFAULT_STALL_WINDOW_MS = 300_000 // 5 minutes without thinking indicator or progress

/**
 * Inspects a conversation mapping tree to determine if a turn with `promptText` was
 * already submitted (e.g. before a transient disconnect) and whether it is still in_progress
 * or already completed.
 */
export function inspectExistingTurnInConversation(
  conv,
  { promptText = '', baselineNodeId = null } = {},
) {
  const targetPrompt = String(promptText ?? '').trim()
  if (!conv || !conv.mapping || !targetPrompt) {
    return { status: 'not_found', baselineNodeId: null, userNodeId: null, reply: null }
  }
  let cur = conv.current_node
  const visited = new Set()
  let latestUserNode = null
  let latestUserNodeId = null
  while (cur && conv.mapping[cur] && !visited.has(cur)) {
    visited.add(cur)
    const node = conv.mapping[cur]
    const m = node.message
    if (m?.author?.role === 'user') {
      latestUserNode = node
      latestUserNodeId = cur
      break
    }
    if (baselineNodeId && cur === baselineNodeId) {
      break
    }
    cur = node.parent
  }
  if (!latestUserNode || !latestUserNodeId) {
    return { status: 'not_found', baselineNodeId: null, userNodeId: null, reply: null }
  }
  const userParts = (latestUserNode.message?.content?.parts || [])
    .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
    .join('\n')
    .trim()
  if (userParts !== targetPrompt) {
    return { status: 'not_found', baselineNodeId: null, userNodeId: null, reply: null }
  }
  const effectiveBaseline = latestUserNode.parent || null
  const reply = extractAssistantFromMapping(conv, { baselineNodeId: effectiveBaseline })
  if (reply?.text) {
    return {
      status: 'completed',
      baselineNodeId: effectiveBaseline,
      userNodeId: latestUserNodeId,
      reply,
    }
  }
  return {
    status: 'in_progress',
    baselineNodeId: effectiveBaseline,
    userNodeId: latestUserNodeId,
    reply: null,
  }
}

/**
 * Extracts chronological intermediate thinking/commentary/tool steps and any in-progress or
 * finished final assistant text from a /backend-api/conversation/<id> mapping object.
 */
export function extractTurnProgressFromMapping(conv, { baselineNodeId = null } = {}) {
  if (!conv || !conv.mapping) {
    return {
      thinkingSteps: [],
      liveFinalText: '',
      finishedFinal: null,
      citationSources: new Map(),
      currentNode: null,
    }
  }
  const chain = []
  let cur = conv.current_node
  const visited = new Set()
  while (cur && conv.mapping[cur] && !visited.has(cur)) {
    if (baselineNodeId && cur === baselineNodeId) break
    visited.add(cur)
    const node = conv.mapping[cur]
    const m = node.message
    if (m?.author?.role === 'user') break
    chain.push({ id: cur, node })
    cur = node.parent
  }
  chain.reverse()

  const thinkingSteps = []
  let liveFinalText = ''
  let finishedFinal = null
  const citationSources = new Map()

  for (const { id: nodeId, node } of chain) {
    const m = node.message
    if (!m) continue
    if (m.metadata && typeof m.metadata === 'object') {
      collectChatgptCitationSources(m.metadata, citationSources)
    }
    const role = m.author?.role
    const ct = m.content?.content_type
    const ch = m.channel
    const recipient = m.recipient

    if (role === 'assistant') {
      if (ct === 'thoughts' && Array.isArray(m.content?.thoughts)) {
        for (let i = 0; i < m.content.thoughts.length; i++) {
          const t = m.content.thoughts[i]
          const summary = String(t?.summary || '').trim()
          const body = String(t?.content || '').trim()
          const combined = summary && body ? `${summary}: ${body}` : summary || body
          if (combined) {
            thinkingSteps.push({ key: `${nodeId}:thought:${i}`, text: combined })
          }
        }
        continue
      }
      if (ct === 'reasoning_recap') {
        const recap = String(m.content?.content || (m.content?.parts || []).join('') || '').trim()
        if (recap) {
          thinkingSteps.push({ key: `${nodeId}:recap`, text: `[${recap}]` })
        }
        continue
      }
      if (
        ch === 'commentary' ||
        ch === 'analysis' ||
        ch === 'thoughts' ||
        (recipient && recipient !== 'all')
      ) {
        if (ct === 'code' || (recipient && recipient !== 'all')) {
          const rawCode = String(
            m.content?.text ||
              (m.content?.parts || [])
                .map((p) => (typeof p === 'string' ? p : p?.text || ''))
                .join('') ||
              '',
          ).trim()
          const firstLine = rawCode.split(/\r?\n/)[0]?.slice(0, 160) || ''
          const label = recipient && recipient !== 'all' ? `[工具 ${recipient}]` : '[执行命令]'
          thinkingSteps.push({
            key: `${nodeId}:code`,
            text: firstLine ? `${label} ${firstLine}` : label,
          })
        } else if (ct === 'text' || ct === 'multimodal_text') {
          const txt = (m.content?.parts || [])
            .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
            .join('')
            .trim()
          if (txt) {
            thinkingSteps.push({ key: `${nodeId}:commentary`, text: txt })
          }
        }
        continue
      }
      if ((!ch || ch === 'final') && (ct === 'text' || ct === 'multimodal_text')) {
        const txt = (m.content?.parts || [])
          .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
          .join('')
        if (txt) {
          liveFinalText = txt
          if (!m.status || m.status === 'finished_successfully') {
            finishedFinal = { text: txt, messageId: m.id || nodeId }
          }
        }
      }
    } else if (role === 'tool') {
      const toolName = String(m.author?.name || 'tool').trim()
      thinkingSteps.push({
        key: `${nodeId}:tool_done`,
        text: `[工具完成: ${toolName}]`,
      })
    }
  }

  return {
    thinkingSteps,
    liveFinalText,
    finishedFinal,
    citationSources,
    currentNode: conv.current_node || null,
  }
}

/**
 * Reads live thinking/working/subagent/command indicators from the ChatGPT Web DOM.
 */
export async function extractLiveProgressFromDomInPage(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return { stopBtn: false, activeThinking: false, statusLines: [] }
  }
  return page
    .evaluate(() => {
      if (typeof document === 'undefined') {
        return { stopBtn: false, activeThinking: false, statusLines: [] }
      }
      const stopBtn = Boolean(
        document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"]'),
      )
      const articles = document.querySelectorAll(
        'article[data-turn="assistant"], [data-message-author-role="assistant"]',
      )
      const scope =
        articles.length > 0 ? articles[articles.length - 1] : document.querySelector('main')
      const statusLines = []
      if (scope) {
        const candidates = scope.querySelectorAll(
          'button, summary, [data-testid*="thought"], [role="status"], span, div',
        )
        const statusRe =
          /^(Working(\s+for\b.*)?|Thinking(\b.*)?|Pro thinking(\b.*)?|Running command(\b.*)?|Ran command(\b.*)?|Subagents(\b.*)?|Searching(\b.*)?|Reading(\b.*)?|Browsing(\b.*)?|正在思考.*|正在运行.*)$/i
        const seen = new Set()
        for (const el of candidates) {
          if (el.children && el.children.length > 4) continue
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (!txt || txt.length > 140 || seen.has(txt)) continue
          if (statusRe.test(txt)) {
            seen.add(txt)
            statusLines.push(txt)
          }
        }
      }
      const activeThinking = Boolean(
        stopBtn || (statusLines.length > 0 && !statusLines.every((s) => /^Thought for\b/i.test(s))),
      )
      return { stopBtn, activeThinking, statusLines }
    })
    .catch(() => ({ stopBtn: false, activeThinking: false, statusLines: [] }))
}

/**
 * Computes how much of `text` can be safely streamed as `text_delta` before turn completion
 * without leaking a raw `sandbox:/...` link before output attachments are downloaded & rewritten.
 */
export function safeStreamableTextLength(text) {
  const s = String(text ?? '')
  if (!s) return 0
  const sandboxIdx = s.indexOf('sandbox:')
  if (sandboxIdx >= 0) {
    const before = s.slice(0, sandboxIdx)
    const openBracket = before.lastIndexOf('[')
    if (openBracket >= 0 && before.slice(openBracket).includes('](')) {
      return openBracket
    }
    const openParen = before.lastIndexOf('(')
    if (openParen >= 0 && sandboxIdx - openParen <= 2) {
      return openParen
    }
    return sandboxIdx
  }
  const tailBracket = s.lastIndexOf('[')
  if (tailBracket >= 0 && s.length - tailBracket < 240) {
    const tail = s.slice(tailBracket)
    if (!tail.includes(')')) {
      return tailBracket
    }
  }
  return s.length
}

/**
 * Stateful deduplicator that converts mapping & DOM snapshots into incremental
 * `thinking_delta` and `text_delta` strings.
 */
export class TurnProgressStreamer {
  constructor({
    nowFn = () => Date.now(),
    initialEmittedFinalText = '',
    initialStepTextByKey = null,
  } = {}) {
    this.nowFn = nowFn
    this.stepTextByKey = new Map(
      initialStepTextByKey && typeof initialStepTextByKey === 'object'
        ? Object.entries(initialStepTextByKey)
        : [],
    )
    this.seenDomPhaseKeys = new Set()
    this.emittedFinalText = String(initialEmittedFinalText ?? '')
    this.lastThinkingEmitAt = nowFn()
    this.citations = new ChatgptCitationRenderer()
  }

  restoreState(state) {
    if (!state || typeof state !== 'object') return
    if (typeof state.emittedFinalText === 'string') {
      this.emittedFinalText = state.emittedFinalText
    }
    if (state.stepTextByKey && typeof state.stepTextByKey === 'object') {
      for (const [k, v] of Object.entries(state.stepTextByKey)) {
        if (typeof v === 'string') {
          this.stepTextByKey.set(k, v)
        }
      }
    }
    this.citations.restoreState(state.citations)
  }

  exportState() {
    return {
      emittedFinalText: this.emittedFinalText,
      stepTextByKey: Object.fromEntries(this.stepTextByKey),
      citations: this.citations.exportState(),
    }
  }

  ingestMappingProgress(progress) {
    const thinkingDeltas = []
    const textDeltas = []
    if (!progress || typeof progress !== 'object') {
      return { thinkingDeltas, textDeltas }
    }
    for (const step of progress.thinkingSteps || []) {
      if (!step || !step.key || !step.text) continue
      const prev = this.stepTextByKey.get(step.key) || ''
      if (!prev) {
        this.stepTextByKey.set(step.key, step.text)
        thinkingDeltas.push(`${step.text}\n\n`)
        this.lastThinkingEmitAt = this.nowFn()
      } else if (step.text.length > prev.length && step.text.startsWith(prev)) {
        const suffix = step.text.slice(prev.length)
        this.stepTextByKey.set(step.key, step.text)
        thinkingDeltas.push(suffix)
        this.lastThinkingEmitAt = this.nowFn()
      }
    }
    this.citations.addSources(progress.citationSources)
    if (progress.liveFinalText) {
      const delta = this.consumeIncrementalFinalText(progress.liveFinalText, {
        finalFlush: Boolean(progress.finishedFinal),
      })
      if (delta) {
        textDeltas.push(delta)
      }
    }
    return { thinkingDeltas, textDeltas }
  }

  ingestDomProgress(
    domProgress,
    { now = this.nowFn(), startedAt = now, heartbeatIntervalMs = 25_000 } = {},
  ) {
    const thinkingDeltas = []
    if (!domProgress || typeof domProgress !== 'object') {
      return { thinkingDeltas }
    }
    for (const rawLine of domProgress.statusLines || []) {
      const line = String(rawLine || '').trim()
      if (!line) continue
      const isPureTimer = /^(Working(\s+for\b.*)?|Thinking|Pro thinking|正在思考.*)$/i.test(line)
      const phaseKey = isPureTimer ? 'phase:working' : `status:${line}`
      if (!this.seenDomPhaseKeys.has(phaseKey)) {
        this.seenDomPhaseKeys.add(phaseKey)
        thinkingDeltas.push(`[Pro 状态] ${line}\n`)
        this.lastThinkingEmitAt = now
      }
    }
    if (
      thinkingDeltas.length === 0 &&
      (domProgress.stopBtn || domProgress.activeThinking) &&
      now - this.lastThinkingEmitAt >= heartbeatIntervalMs
    ) {
      const elapsedSec = Math.max(1, Math.round((now - startedAt) / 1000))
      const mins = Math.floor(elapsedSec / 60)
      const secs = elapsedSec % 60
      const label = mins > 0 ? `${mins}m${String(secs).padStart(2, '0')}s` : `${secs}s`
      thinkingDeltas.push(`[Pro 仍在思考/执行中 · 已耗时 ${label}]\n`)
      this.lastThinkingEmitAt = now
    }
    return { thinkingDeltas }
  }

  /** `fullText` is ChatGPT's raw text; deltas and `emittedFinalText` are display text (OCV5-584). */
  consumeIncrementalFinalText(fullText, { finalFlush = false } = {}) {
    const text = this.citations.render(fullText, { final: finalFlush, delivered: this.emittedFinalText })
    if (!text) return ''
    if (!finalFlush) {
      const safeLen = safeStreamableTextLength(text)
      if (safeLen > this.emittedFinalText.length && text.startsWith(this.emittedFinalText)) {
        const delta = text.slice(this.emittedFinalText.length, safeLen)
        this.emittedFinalText = text.slice(0, safeLen)
        return delta
      }
      return ''
    }
    if (text.startsWith(this.emittedFinalText)) {
      const delta = text.slice(this.emittedFinalText.length)
      this.emittedFinalText = text
      return delta
    }
    this.emittedFinalText = text
    return text
  }
}

/**
 * Classifies a ChatGPT Web approval card ([data-codex-approval-surface="true"]):
 * - All approval cards automatically click "Allow for this chat" / "允许此聊天"
 *   (NEVER "Allow all relevant sites" / "允许所有相关网站", and never auto-deny).
 * - Extracts the requested site/host so host.mjs can announce which site was allowed in the thinking panel.
 */
const NON_HOST_FILE_EXT_RE =
  /\.(?:html?|m?js|cjs|tsx?|jsx?|py|sh|json|csv|txt|md|png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|css|wasm|yml|yaml|xml|sql|log)$/i

export function classifyApprovalCard({ text = '', buttons = [] } = {}) {
  const raw = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const summary = raw.slice(0, 140) || '未知授权卡片'

  const loopbackMatches = [
    ...raw.matchAll(/(?:https?:\/\/)?((?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?)/gi),
  ].map((m) => m[1])

  const schemeHostMatches = [...raw.matchAll(/https?:\/\/([^/\s:?#)"'`]+)/gi)].map((m) =>
    m[1].toLowerCase(),
  )

  const bareHostMatches = [
    ...raw.matchAll(/\b(((?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?)\b/gi),
  ]
    .map((m) => m[1].toLowerCase())
    .filter((candidate) => {
      if (/:\d{1,5}$/.test(candidate)) return true
      return !NON_HOST_FILE_EXT_RE.test(candidate)
    })

  const targetHost = loopbackMatches[0] || schemeHostMatches[0] || bareHostMatches[0] || null

  const normButtons = Array.isArray(buttons)
    ? buttons.map((b, i) => ({
        index: typeof b?.index === 'number' ? b.index : i,
        label: String(typeof b === 'string' ? b : (b?.label ?? ''))
          .replace(/\s+/g, ' ')
          .trim(),
      }))
    : []

  const isForbiddenMultiSiteAllow = (label) =>
    /(all relevant|所有相关|all sites|所有网站|always|始终)/i.test(label)
  const isDenyOrCancel = (label) =>
    /(Deny|Reject|Refuse|Block|Cancel|Dismiss|Close|拒绝|阻止|取消|关闭)/i.test(label)

  const allowChatBtn =
    normButtons.find(
      (b) =>
        /(Allow for this chat|允许此聊天|Allow once|仅允许本次)/i.test(b.label) &&
        !isForbiddenMultiSiteAllow(b.label) &&
        !isDenyOrCancel(b.label),
    ) ||
    normButtons.find(
      (b) =>
        /(Allow|允许|Approve|批准)/i.test(b.label) &&
        !isForbiddenMultiSiteAllow(b.label) &&
        !isDenyOrCancel(b.label),
    ) ||
    null

  if (allowChatBtn) {
    const siteLabel = targetHost || summary
    return {
      decision: 'allow_this_chat',
      buttonIndex: allowChatBtn.index,
      buttonLabel: allowChatBtn.label,
      targetHost,
      summary,
      announcement: `\n[Pro 授权卡片] 检测到授权请求（站点：${siteLabel}），已自动点击「${allowChatBtn.label}」。\n`,
    }
  }

  return {
    decision: 'skip',
    buttonIndex: null,
    buttonLabel: '',
    targetHost,
    summary,
    announcement: '',
  }
}

/**
 * Detects any visible [data-codex-approval-surface="true"] card in the page DOM,
 * clicks "Allow for this chat" / "允许此聊天" (never "Allow all relevant sites" and never "Deny"),
 * and returns the action taken so host.mjs can broadcast the allowed site to the thinking panel.
 */
export async function inspectAndHandleApprovalCardInPage(page) {
  if (!page || typeof page.evaluate !== 'function') return { handled: false }
  const card = await page
    .evaluate(() => {
      if (typeof document === 'undefined') return null
      const surface = document.querySelector('[data-codex-approval-surface="true"]')
      if (!surface) return null
      const lastClickedAt = Number(surface.getAttribute('data-oc-approval-clicked') || 0)
      if (lastClickedAt > 0 && Date.now() - lastClickedAt < 3_000) return null
      const text = (surface.innerText || surface.textContent || '').replace(/\s+/g, ' ').trim()
      const btnEls = Array.from(surface.querySelectorAll('button'))
      const buttons = btnEls
        .map((b, index) => ({
          index,
          label: (b.innerText || b.textContent || b.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim(),
        }))
        .filter((b) => b.label.length > 0)
      if (!text && buttons.length === 0) return null
      return { text, buttons }
    })
    .catch(() => null)

  if (!card) return { handled: false }
  const classified = classifyApprovalCard(card)
  if (classified.decision !== 'allow_this_chat' || classified.buttonIndex === null) {
    return {
      handled: false,
      ...classified,
    }
  }

  await page
    .evaluate((btnIdx) => {
      const surface = document.querySelector('[data-codex-approval-surface="true"]')
      if (!surface) return
      const btnEls = Array.from(surface.querySelectorAll('button'))
      const target = btnEls[btnIdx]
      if (target && typeof target.click === 'function') {
        surface.setAttribute('data-oc-approval-clicked', String(Date.now()))
        target.click()
      }
    }, classified.buttonIndex)
    .catch(() => {})

  return {
    handled: true,
    ...classified,
  }
}

/**
 * Extracts all sandbox:/ file references and generated image/file attachment references
 * from the current turn's assistant text and conversation mapping nodes.
 */
export function extractTurnOutputArtifactRefs({
  text = '',
  conv = null,
  baselineNodeId = null,
  finalMessageId = null,
  maxFiles = 5,
} = {}) {
  const refs = []
  const seenKeys = new Set()

  const addSandboxUrl = (rawUrl, msgId) => {
    const cleaned = String(rawUrl || '')
      .trim()
      .replace(/[.,;:!?。，、)\]}>]+$/u, '')
    if (!cleaned.startsWith('sandbox:/')) return
    const sandboxPath = cleaned.slice('sandbox:'.length)
    if (!sandboxPath.startsWith('/') || sandboxPath.includes('..')) return
    const key = `sandbox:${sandboxPath}`
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    const base = path.posix.basename(sandboxPath) || 'output.bin'
    refs.push({
      name: base,
      sandboxUrl: cleaned,
      sandboxPath,
      messageId: msgId || finalMessageId || null,
    })
  }

  const addFileId = (rawFileId, nameHint, mimeHint, msgId) => {
    const cleanId = String(rawFileId || '')
      .replace(/^(sediment|file-service):\/\//i, '')
      .trim()
    if (!cleanId || !/^(file[-_][a-zA-Z0-9_-]{4,128})$/.test(cleanId)) return
    const key = `file:${cleanId}`
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    const ext = mimeHint?.includes('png')
      ? '.png'
      : mimeHint && (mimeHint.includes('jpeg') || mimeHint.includes('jpg'))
        ? '.jpg'
        : mimeHint?.includes('webp')
          ? '.webp'
          : '.png'
    refs.push({
      name: nameHint || `${cleanId}${ext}`,
      fileId: cleanId,
      mimeType: mimeHint || undefined,
      messageId: msgId || finalMessageId || null,
    })
  }

  const scanSandboxLinks = (str, msgId) => {
    const s = String(str ?? '')
    const re = /sandbox:\/[^\s)"'`>\]]+/g
    let m = re.exec(s)
    while (m !== null) {
      addSandboxUrl(m[0], msgId)
      if (refs.length >= maxFiles) return
      m = re.exec(s)
    }
  }

  scanSandboxLinks(text, finalMessageId)

  if (conv?.mapping && refs.length < maxFiles) {
    let cur = conv.current_node
    const visited = new Set()
    const turnNodes = []
    while (cur && conv.mapping[cur] && !visited.has(cur)) {
      if (baselineNodeId && cur === baselineNodeId) break
      visited.add(cur)
      const node = conv.mapping[cur]
      if (node.message?.author?.role === 'user') break
      turnNodes.push({ id: cur, message: node.message })
      cur = node.parent
    }
    turnNodes.reverse()
    for (const { id: nodeId, message: m } of turnNodes) {
      if (!m) continue
      const role = m.author?.role
      if (role !== 'assistant' && role !== 'tool') continue
      const msgId = m.id || nodeId
      for (const p of m.content?.parts || []) {
        if (typeof p === 'string') {
          scanSandboxLinks(p, msgId)
        } else if (p && typeof p === 'object') {
          if (typeof p.asset_pointer === 'string') {
            addFileId(
              p.asset_pointer,
              p.metadata?.file_name || p.name || null,
              p.mime_type || p.metadata?.mime_type || 'image/png',
              msgId,
            )
          }
        }
        if (refs.length >= maxFiles) break
      }
      for (const att of m.metadata?.attachments || []) {
        if (refs.length >= maxFiles) break
        if (att && typeof att === 'object') {
          if (typeof att.sandbox_path === 'string' && att.sandbox_path.startsWith('/')) {
            addSandboxUrl(`sandbox:${att.sandbox_path}`, msgId)
          } else if (typeof att.id === 'string') {
            addFileId(att.id, att.name || null, att.mime_type || null, msgId)
          }
        }
      }
      if (refs.length >= maxFiles) break
    }
  }

  return refs.slice(0, maxFiles)
}

/**
 * Downloads Pro-generated sandbox files and image attachments using ONLY read-only
 * ChatGPT backend APIs (/backend-api/conversation/<id>/interpreter/download and
 * /backend-api/files/download/<fileId>). Never clicks any DOM link or button.
 */
export async function downloadTurnOutputArtifactsInPage(
  page,
  { convId, finalMessageId = null, artifactRefs = [], maxBytesPerFile = 25 * 1024 * 1024 } = {},
) {
  if (
    !page ||
    typeof page.evaluate !== 'function' ||
    !convId ||
    !Array.isArray(artifactRefs) ||
    artifactRefs.length === 0
  ) {
    return []
  }

  const results = []
  for (const ref of artifactRefs) {
    if (!ref || (!ref.sandboxPath && !ref.fileId)) continue
    const meta = await page
      .evaluate(
        async ({ targetConvId, targetRef, fallbackMsgId, maxBytes }) => {
          const toBase64 = (u8) => {
            let binary = ''
            const chunk = 0x8000
            for (let i = 0; i < u8.length; i += chunk) {
              binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk))
            }
            return btoa(binary)
          }
          let token = null
          try {
            const cached = window.__ocAuthTokenCache
            if (
              cached &&
              typeof cached.token === 'string' &&
              cached.token.length > 0 &&
              Date.now() < cached.expiresAt
            ) {
              token = cached.token
            } else {
              const sessRes = await fetch('/api/auth/session', { credentials: 'include' })
              if (sessRes.ok) {
                const sess = await sessRes.json()
                token = sess?.accessToken || null
                if (token) {
                  window.__ocAuthTokenCache = {
                    token,
                    expiresAt: Date.now() + 240_000,
                  }
                }
              }
            }
          } catch {}
          const headers = token ? { Authorization: `Bearer ${token}` } : {}

          const candidateUrls = []
          if (targetRef.sandboxPath) {
            const msgIds = [targetRef.messageId, fallbackMsgId].filter(Boolean)
            for (const mid of msgIds) {
              candidateUrls.push(
                `/backend-api/conversation/${encodeURIComponent(targetConvId)}/interpreter/download?message_id=${encodeURIComponent(mid)}&sandbox_path=${encodeURIComponent(targetRef.sandboxPath)}`,
              )
            }
            candidateUrls.push(
              `/backend-api/conversation/${encodeURIComponent(targetConvId)}/interpreter/download?sandbox_path=${encodeURIComponent(targetRef.sandboxPath)}`,
            )
          }
          if (targetRef.fileId) {
            candidateUrls.push(
              `/backend-api/files/download/${encodeURIComponent(targetRef.fileId)}?conversation_id=${encodeURIComponent(targetConvId)}&inline=false`,
            )
          }

          let downloadUrl = null
          let fileName = targetRef.name || 'output.bin'
          let mimeType = targetRef.mimeType || null
          let fileSize = null

          for (const apiUrl of candidateUrls) {
            try {
              const r = await fetch(apiUrl, { credentials: 'include', headers })
              if (!r.ok) continue
              const ct = (r.headers.get('content-type') || '').toLowerCase()
              if (ct.includes('application/json')) {
                const j = await r.json()
                if (j && typeof j.download_url === 'string' && j.download_url) {
                  downloadUrl = j.download_url
                  if (j.file_name) fileName = j.file_name
                  if (j.mime_type) mimeType = j.mime_type
                  if (typeof j.file_size_bytes === 'number') fileSize = j.file_size_bytes
                  break
                }
              } else {
                const ab = await r.arrayBuffer()
                if (ab.byteLength > 0 && ab.byteLength <= maxBytes) {
                  const u8 = new Uint8Array(ab)
                  return {
                    ok: true,
                    name: fileName,
                    mimeType: mimeType || ct || 'application/octet-stream',
                    size: u8.byteLength,
                    base64: toBase64(u8),
                  }
                }
              }
            } catch {}
          }

          if (!downloadUrl) return { ok: false }
          if (typeof fileSize === 'number' && fileSize > maxBytes) {
            return { ok: false, reason: 'too_large' }
          }

          try {
            const isSameOrigin =
              downloadUrl.startsWith('/') || downloadUrl.startsWith('https://chatgpt.com/')
            const dlRes = await fetch(
              downloadUrl,
              isSameOrigin ? { credentials: 'include', headers } : undefined,
            )
            if (dlRes.ok) {
              const ab = await dlRes.arrayBuffer()
              if (ab.byteLength > 0 && ab.byteLength <= maxBytes) {
                const u8 = new Uint8Array(ab)
                const dlMime = dlRes.headers.get('content-type')
                return {
                  ok: true,
                  name: fileName,
                  mimeType: mimeType || dlMime || 'application/octet-stream',
                  size: u8.byteLength,
                  base64: toBase64(u8),
                }
              }
            }
          } catch {}

          return {
            ok: false,
            downloadUrl,
            name: fileName,
            mimeType,
            size: fileSize,
          }
        },
        {
          targetConvId: convId,
          targetRef: ref,
          fallbackMsgId: finalMessageId,
          maxBytes: maxBytesPerFile,
        },
      )
      .catch(() => null)

    if (!meta) continue

    if (meta.ok && typeof meta.base64 === 'string' && meta.base64.length > 0) {
      results.push({
        name: meta.name || ref.name || 'output.bin',
        ...(ref.sandboxUrl ? { sandboxUrl: ref.sandboxUrl } : {}),
        ...(ref.sandboxPath ? { sandboxPath: ref.sandboxPath } : {}),
        ...(ref.fileId ? { fileId: ref.fileId } : {}),
        ...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
        size: meta.size || 0,
        base64: meta.base64,
      })
      continue
    }

    if (typeof meta.downloadUrl === 'string' && meta.downloadUrl.startsWith('https://')) {
      try {
        let buf = null
        const reqCtx = typeof page.context === 'function' ? page.context()?.request : null
        if (reqCtx && typeof reqCtx.get === 'function') {
          const resp = await reqCtx.get(meta.downloadUrl, { timeout: 30_000 })
          if (resp.ok()) {
            buf = Buffer.from(await resp.body())
          }
        } else if (typeof fetch === 'function') {
          const resp = await fetch(meta.downloadUrl)
          if (resp.ok) {
            buf = Buffer.from(await resp.arrayBuffer())
          }
        }
        if (buf && buf.byteLength > 0 && buf.byteLength <= maxBytesPerFile) {
          results.push({
            name: meta.name || ref.name || 'output.bin',
            ...(ref.sandboxUrl ? { sandboxUrl: ref.sandboxUrl } : {}),
            ...(ref.sandboxPath ? { sandboxPath: ref.sandboxPath } : {}),
            ...(ref.fileId ? { fileId: ref.fileId } : {}),
            ...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
            size: buf.byteLength,
            base64: buf.toString('base64'),
          })
        }
      } catch {}
    }
  }

  return results
}

/**
 * Deterministic adaptive timeout & Stream-Rescue state machine for Pro long-thinking turns.
 * Follows actual Pro progress up to maxTimeoutMs (default 6 hours = 21,600,000 ms).
 */
export function computeAdaptiveDeadline({
  startedAt,
  now,
  lastActivityAt,
  stopVisible,
  activeThinkingVisible = false,
  stopGoneSince = null,
  hasFinalText = false,
  baseTimeoutMs = DEFAULT_BASE_TIMEOUT_MS,
  stepExtendMs = DEFAULT_STEP_EXTEND_MS,
  maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
  stallWindowMs = DEFAULT_STALL_WINDOW_MS,
  rescueAfterStopGoneMs = 90_000,
  currentDeadline = startedAt + baseTimeoutMs,
}) {
  const hardCeiling = startedAt + maxTimeoutMs
  let deadline = Math.min(currentDeadline, hardCeiling)
  let extended = false
  const activelyThinking = Boolean(stopVisible || activeThinkingVisible)
  const hasRecentActivity = now - lastActivityAt < stallWindowMs

  if (now >= deadline && (activelyThinking || hasRecentActivity) && deadline < hardCeiling) {
    deadline = Math.min(hardCeiling, Math.max(now, deadline) + stepExtendMs)
    extended = true
  }

  const shouldRescue =
    !activelyThinking &&
    !hasFinalText &&
    stopGoneSince !== null &&
    now - stopGoneSince >= rescueAfterStopGoneMs

  const expired = now >= deadline
  return {
    deadline,
    extended,
    shouldRescue,
    expired,
  }
}

/**
 * Decides what to do when `acc.done` is true and neither Stop button nor active thinking is visible.
 * Prevents `stream_handoff` turns (where `acc.done` becomes true early with `acc.finalText === ""`)
 * from prematurely returning an empty string (`result: ""`) when `rescueFromDomOrMapping` hasn't yet
 * seen a `finished_successfully` final reply or during a brief Stop-button flicker between tool steps.
 */
export function resolveTurnCompletionDecision({
  accDone = false,
  shouldRescue = false,
  accFinalText = '',
  rescued = null,
  latestProg = null,
  emittedFinalText = '',
  stopVisible = false,
  activeThinkingVisible = false,
  stopGoneSince = null,
  lastFinalTextGrowthAt = null,
  now = Date.now(),
  emptyDoneGraceMs = 45_000,
} = {}) {
  if (stopVisible || activeThinkingVisible || (!accDone && !shouldRescue)) {
    return { action: 'continue' }
  }
  const sseText = String(accFinalText ?? '')
  if (sseText.length > 0) {
    return {
      action: 'finalize',
      text: sseText,
      messageId: null,
      convId: null,
      conv: null,
      source: 'sse',
    }
  }
  if (rescued?.text && String(rescued.text).length > 0) {
    return {
      action: 'finalize',
      text: String(rescued.text),
      messageId: rescued.messageId || null,
      convId: rescued.convId || null,
      conv: rescued.conv || null,
      source: 'rescue',
    }
  }
  if (latestProg?.finishedFinal?.text && String(latestProg.finishedFinal.text).length > 0) {
    return {
      action: 'finalize',
      text: String(latestProg.finishedFinal.text),
      messageId: latestProg.finishedFinal.messageId || null,
      convId: null,
      conv: null,
      source: 'mapping_finished',
    }
  }

  const hasInProgressLiveText = Boolean(
    latestProg?.liveFinalText && String(latestProg.liveFinalText).trim().length > 0,
  )

  // No finished reply yet: if stopGoneSince or recent liveFinalText growth is within the grace window,
  // keep polling instead of exiting empty or truncating a still-growing in_progress message.
  if (
    stopGoneSince === null ||
    now - stopGoneSince < emptyDoneGraceMs ||
    (hasInProgressLiveText &&
      (lastFinalTextGrowthAt === null || now - lastFinalTextGrowthAt < emptyDoneGraceMs))
  ) {
    return { action: 'wait_grace' }
  }

  const partial = String(latestProg?.liveFinalText || emittedFinalText || '')
  if (partial.trim().length > 0) {
    return {
      action: 'finalize',
      text: partial,
      messageId: null,
      convId: null,
      conv: null,
      source: 'partial_fallback',
    }
  }

  return { action: accDone ? 'error_empty' : 'wait_grace' }
}

export function formatStreamJsonSystemInit({
  sessionId,
  model = 'box-gpt-6-astra-pro',
  cwd = '/workspace',
}) {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    cwd,
    tools: [],
  })
}

export function formatStreamJsonMessageStart({
  messageId = `msg_${Date.now()}`,
  model = 'box-gpt-6-astra-pro',
} = {}) {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  })
}

export function formatStreamJsonThinkingBlockStart({ index = 0 } = {}) {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'thinking',
        thinking: '',
      },
    },
  })
}

export function formatStreamJsonContentBlockStop({ index = 0 } = {}) {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index,
    },
  })
}

export function formatStreamJsonThinkingDelta(thinking) {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'thinking_delta',
        thinking: String(thinking ?? ''),
      },
    },
  })
}

export function formatStreamJsonTextDelta(text, { outputAttachments = null } = {}) {
  return JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: String(text ?? ''),
      },
    },
    ...(Array.isArray(outputAttachments) && outputAttachments.length > 0
      ? { outputAttachments }
      : {}),
  })
}

export function formatStreamJsonAssistantMessage({
  messageId = `msg_${Date.now()}`,
  model = 'box-gpt-6-astra-pro',
  text = '',
  thinking = '',
  outputAttachments = null,
}) {
  const content = []
  if (thinking) {
    content.push({ type: 'thinking', thinking })
  }
  content.push({ type: 'text', text })
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 0,
        output_tokens: Math.max(1, Math.ceil(text.length / 4)),
      },
    },
    ...(Array.isArray(outputAttachments) && outputAttachments.length > 0
      ? { outputAttachments }
      : {}),
  })
}

export function formatStreamJsonResult({
  sessionId,
  resultText = '',
  isError = false,
  durationMs = 0,
  outputAttachments = null,
}) {
  return JSON.stringify({
    type: 'result',
    subtype: isError ? 'error' : 'success',
    is_error: Boolean(isError),
    session_id: sessionId,
    result: String(resultText ?? ''),
    duration_ms: Math.max(0, Math.round(durationMs)),
    total_cost_usd: 0,
    ...(Array.isArray(outputAttachments) && outputAttachments.length > 0
      ? { outputAttachments }
      : {}),
  })
}

export function formatStreamJsonControlResponse({ requestId, subtype = 'success' }) {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype,
      request_id: String(requestId ?? ''),
    },
  })
}

export function formatStreamJsonKeepalive({ sessionId, elapsedMs = 0 }) {
  return JSON.stringify({
    type: 'system',
    subtype: 'keepalive',
    session_id: String(sessionId ?? ''),
    elapsed_ms: Math.max(0, Math.round(elapsedMs)),
  })
}

/**
 * Resolves `filePath` to a canonical regular file strictly inside `allowedUploadRoots`.
 * Prevents arbitrary local file disclosure when user prompt text contains path-like strings.
 */
export function resolveTrustedAttachmentPath(filePath, allowedUploadRoots = []) {
  if (!filePath || !Array.isArray(allowedUploadRoots) || allowedUploadRoots.length === 0) {
    return null
  }
  let real
  try {
    real = fs.realpathSync(filePath)
  } catch {
    return null
  }
  for (const rootDir of allowedUploadRoots) {
    if (!rootDir) continue
    let rootReal
    try {
      rootReal = fs.realpathSync(rootDir)
    } catch {
      continue
    }
    const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`
    if (real.startsWith(prefix)) {
      try {
        if (fs.statSync(real).isFile()) return real
      } catch {}
    }
  }
  return null
}

const INBOUND_IMAGE_HINT_BLOCK_RE =
  /\n*---\n用户附带了以下图片\(已保存到服务器本地\):\n((?:- `\/[^`\r\n]+` \([^\r\n]*?原名: [^\r\n]+\)\r?\n?)+)\n如果需要看图片内容:\n1\. 用 Read 工具读图片路径\(原生多模态 provider 会直接看到图像\)。\n2\. 如果当前 provider 不支持图片识别,告诉用户。/g

const INBOUND_UNPARSED_DOC_BLOCK_RE =
  /\n*---\n用户还附带了以下文档\(已保存到服务器本地,gateway 没能预解析 ——\n可能因为格式不支持、解析失败或解析超时\):\n((?:- `\/[^`\r\n]+` \([^\r\n]*?原名: [^\r\n]+\)\r?\n?)+)\n可以用 Read 工具读取文档内容\(对纯文本、CSV、源码、PDF 等都有效\n—— 大 PDF 即便预解析超时,Read 也可能能拿到部分文本\)。\n若是 \.doc 老格式 Word 二进制,Read 会看到乱码 —— 礼貌地请用户转存为 \.docx 重传。/g

/**
 * Extracts attachment paths injected by Gateway's `inboundDispatch` (`buildImageAttachmentHint`
 * and unparsed document hints) ONLY when those paths resolve inside `allowedUploadRoots`,
 * and strips only the matched attachment block(s) without touching subsequent sections
 * (such as pre-parsed PDF markdown).
 */
export function extractInboundDispatchAttachments(
  rawText,
  { allowedUploadRoots = [], stripWithoutVerify = false } = {},
) {
  const text = String(rawText ?? '')
  const extractedPaths = []
  const bulletRe = /^-\s+`(\/[^`\r\n]+)`\s+\([^\r\n]*?原名:\s*([^\r\n]+)\)\s*$/gm

  const processBlock = (fullMatch, bulletSection) => {
    const blockPaths = []
    bulletRe.lastIndex = 0
    let m = bulletRe.exec(bulletSection)
    while (m !== null) {
      blockPaths.push(m[1])
      m = bulletRe.exec(bulletSection)
    }
    if (blockPaths.length === 0) return fullMatch
    if (stripWithoutVerify) {
      return ''
    }
    const verified = []
    for (const p of blockPaths) {
      const resolved = resolveTrustedAttachmentPath(p, allowedUploadRoots)
      if (!resolved) {
        return fullMatch
      }
      verified.push(resolved)
    }
    for (const vp of verified) {
      if (!extractedPaths.includes(vp)) {
        extractedPaths.push(vp)
      }
    }
    return ''
  }

  let cleaned = text.replace(INBOUND_IMAGE_HINT_BLOCK_RE, processBlock)
  cleaned = cleaned.replace(INBOUND_UNPARSED_DOC_BLOCK_RE, processBlock)

  if (extractedPaths.length === 0 && !stripWithoutVerify) {
    return { cleanText: text, extractedPaths: [] }
  }
  const trimmed = cleaned.trim()
  return {
    cleanText: trimmed || '请分析上传的附件。',
    extractedPaths,
  }
}

/**
 * Parses a Route B stdin JSON line into either a `control_request` (e.g. `interrupt`)
 * or a `user` turn (with extracted prompt text and attachment file paths).
 */
export function parseStdinFrame(line, { stagingDir = null, allowedUploadRoots = [] } = {}) {
  const trimmed = String(line ?? '').trim()
  if (!trimmed) return null
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const { cleanText, extractedPaths } = extractInboundDispatchAttachments(trimmed, {
      allowedUploadRoots,
    })
    return { kind: 'user', text: cleanText, files: extractedPaths }
  }
  if (!parsed || typeof parsed !== 'object') return null

  if (parsed.type === 'control_request') {
    return {
      kind: 'control_request',
      requestId: String(parsed.request_id || ''),
      subtype: String(parsed.request?.subtype || ''),
    }
  }
  if (parsed.type && parsed.type !== 'user') return null

  const msg = parsed.message || parsed
  const content = msg.content ?? parsed.prompt ?? ''
  const files = Array.isArray(parsed.files) ? [...parsed.files] : []
  const hasInlined = Array.isArray(parsed.inlineAttachments) && parsed.inlineAttachments.length > 0

  if (hasInlined) {
    const targetDir = stagingDir || fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gpt-web-att-'))
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 })
    for (let i = 0; i < parsed.inlineAttachments.length; i++) {
      const att = parsed.inlineAttachments[i]
      if (att && typeof att.base64 === 'string' && att.base64.length > 0) {
        const safeName = String(att.name || `upload-${i}.bin`).replace(/[^a-zA-Z0-9._-]/g, '_')
        const outPath = path.join(targetDir, `${i}-${safeName}`)
        fs.writeFileSync(outPath, Buffer.from(att.base64, 'base64'), { mode: 0o600 })
        files.push(outPath)
      }
    }
  }

  let rawText = ''
  if (typeof content === 'string') {
    rawText = content
  } else if (Array.isArray(content)) {
    const texts = []
    for (const block of content) {
      if (typeof block === 'string') {
        texts.push(block)
      } else if (block && typeof block === 'object') {
        if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        } else if (
          (block.type === 'file' || block.type === 'image') &&
          typeof block.path === 'string'
        ) {
          files.push(block.path)
        }
      }
    }
    rawText = texts.join('\n')
  } else {
    rawText = String(content || '')
  }

  const { cleanText, extractedPaths } = extractInboundDispatchAttachments(rawText, {
    allowedUploadRoots,
    stripWithoutVerify: hasInlined,
  })
  if (!hasInlined) {
    for (const p of extractedPaths) {
      if (!files.includes(p)) {
        files.push(p)
      }
    }
  }

  if (!cleanText && files.length === 0) return null
  const turnId =
    typeof parsed.ocTurnId === 'string' && parsed.ocTurnId.trim() ? parsed.ocTurnId.trim() : null
  const deliveredText = typeof parsed.ocDeliveredText === 'string' ? parsed.ocDeliveredText : ''
  return {
    kind: 'user',
    text: cleanText,
    files,
    ...(turnId ? { turnId } : {}),
    ...(deliveredText ? { deliveredText } : {}),
  }
}

export function extractUserTurnFromStdinFrame(line, opts = {}) {
  const frame = parseStdinFrame(line, opts)
  if (!frame || frame.kind !== 'user') return null
  return {
    text: frame.text,
    files: frame.files,
    ...(frame.turnId ? { turnId: frame.turnId } : {}),
    ...(frame.deliveredText ? { deliveredText: frame.deliveredText } : {}),
  }
}
