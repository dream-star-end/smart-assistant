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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PROFILE = 'default'
export const DEFAULT_DISPLAY = ':1'
export const DEFAULT_CDP_PORT = 9229
export const DEFAULT_CHROME_BIN = '/usr/bin/google-chrome-stable'
export const DEFAULT_CHATGPT_ORIGIN = 'https://chatgpt.com'
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
export async function withProfileFileLock(
  lockPath,
  fn,
  { timeoutMs = 60_000, pollMs = 150, staleMs = 1_500_000, pidAliveFn = isPidAlive } = {},
) {
  const deadline = Date.now() + timeoutMs
  let fd = null
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }))
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockPath)
          const ageMs = Date.now() - stat.mtimeMs
          let ownerDead = false
          if (ageMs >= 50) {
            try {
              const raw = fs.readFileSync(lockPath, 'utf8')
              const parsed = JSON.parse(raw)
              if (parsed && Number.isInteger(parsed.pid) && !pidAliveFn(parsed.pid)) {
                ownerDead = true
              }
            } catch {}
          }
          if (ownerDead || ageMs > staleMs) {
            fs.unlinkSync(lockPath)
            continue
          }
        } catch {}
        if (Date.now() >= deadline) {
          throw new Error(
            `BOX_GPT_WEB_LOCK_TIMEOUT: could not acquire ${lockPath} within ${timeoutMs}ms`,
          )
        }
        await new Promise((r) => setTimeout(r, pollMs))
        continue
      }
      throw err
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.closeSync(fd)
    } catch {}
    try {
      fs.unlinkSync(lockPath)
    } catch {}
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
      const el = document.querySelector(
        '#prompt-textarea, div.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]',
      )
      if (el) {
        if ('value' in el) el.value = ''
        el.textContent = ''
        el.innerHTML = ''
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
  const mappedConvId = sessionId && map[sessionId] ? map[sessionId] : null
  const currentUrl = page.url()
  const currentMatch = currentUrl.match(/\/c\/([a-z0-9_-]{8,128})/i)
  const currentConvId = currentMatch ? currentMatch[1] : null

  if (mappedConvId) {
    const needNav = currentConvId !== mappedConvId
    if (needNav) {
      await page.goto(`${DEFAULT_CHATGPT_ORIGIN}/c/${mappedConvId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
      if (initScript) await page.evaluate(initScript)
    }
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

  let switcher = page.locator('[data-testid="model-switcher-dropdown-button"]').first()
  if ((await switcher.count()) === 0) {
    const altLoc = page.locator('button[aria-label="Select ChatGPT model"]')
    if (altLoc && typeof altLoc.first === 'function') {
      switcher = altLoc.first()
      if (typeof switcher.waitFor === 'function') {
        await switcher.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
      }
    }
  }
  if ((await switcher.count()) === 0) {
    throw new Error(
      'BOX_GPT_WEB_SWITCHER_MISSING: [data-testid="model-switcher-dropdown-button"] not found',
    )
  }
  await switcher.click()

  const menu = page.locator('[role="menu"]').first()
  await menu.waitFor({ state: 'visible', timeout: 5_000 })

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
    selectedCaption = (await slider.getAttribute('aria-valuetext')) || LEVEL_SLIDER_PCT[targetCanon]
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
  let composer = page.locator('#prompt-textarea').first()
  if (typeof composer.count === 'function' && (await composer.count()) === 0) {
    const altComposer = page.locator(
      'div.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]',
    )
    if (altComposer && typeof altComposer.first === 'function') {
      composer = altComposer.first()
    }
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
export function extractAssistantFromMapping(conv) {
  if (!conv || !conv.mapping) return null
  let cur = conv.current_node
  const visited = new Set()
  while (cur && conv.mapping[cur] && !visited.has(cur)) {
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
        if (m.status && m.status !== 'finished_successfully') {
          return null
        }
        if (ct === 'text' || ct === 'multimodal_text') {
          const parts = (m.content.parts || [])
            .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
            .filter(Boolean)
          if (parts.length > 0) {
            return { text: parts.join(''), messageId: m.id || cur }
          }
        }
      }
    }
    cur = node.parent
  }
  return null
}

/**
 * Deterministic adaptive timeout & Stream-Rescue state machine for Pro long-thinking turns.
 */
export function computeAdaptiveDeadline({
  startedAt,
  now,
  lastActivityAt,
  stopVisible,
  stopGoneSince = null,
  hasFinalText = false,
  baseTimeoutMs = 600_000,
  stepExtendMs = 120_000,
  maxTimeoutMs = 1_200_000,
  stallWindowMs = 240_000,
  rescueAfterStopGoneMs = 90_000,
  currentDeadline = startedAt + baseTimeoutMs,
}) {
  const hardCeiling = startedAt + maxTimeoutMs
  let deadline = Math.min(currentDeadline, hardCeiling)
  let extended = false

  if (
    now >= deadline &&
    stopVisible &&
    now - lastActivityAt < stallWindowMs &&
    deadline < hardCeiling
  ) {
    deadline = Math.min(hardCeiling, deadline + stepExtendMs)
    extended = true
  }

  const shouldRescue =
    !stopVisible &&
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

export function formatStreamJsonTextDelta(text) {
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
  })
}

export function formatStreamJsonAssistantMessage({
  messageId = `msg_${Date.now()}`,
  model = 'box-gpt-6-astra-pro',
  text = '',
  thinking = '',
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
  })
}

export function formatStreamJsonResult({
  sessionId,
  resultText = '',
  isError = false,
  durationMs = 0,
}) {
  return JSON.stringify({
    type: 'result',
    subtype: isError ? 'error' : 'success',
    is_error: Boolean(isError),
    session_id: sessionId,
    result: String(resultText ?? ''),
    duration_ms: Math.max(0, Math.round(durationMs)),
    total_cost_usd: 0,
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
  return {
    kind: 'user',
    text: cleanText,
    files,
  }
}

export function extractUserTurnFromStdinFrame(line, opts = {}) {
  const frame = parseStdinFrame(line, opts)
  if (!frame || frame.kind !== 'user') return null
  return { text: frame.text, files: frame.files }
}
