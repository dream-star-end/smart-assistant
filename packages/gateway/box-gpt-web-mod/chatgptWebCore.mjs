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
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
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
 * serialize cleanly instead of colliding on the same tab.
 */
export async function withProfileFileLock(
  lockPath,
  fn,
  { timeoutMs = 60_000, pollMs = 150, staleMs = 1_500_000 } = {},
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
          if (Date.now() - stat.mtimeMs > staleMs) {
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
 * Fail-closed session state probe.
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
      document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="model-switcher-dropdown-button"]'),
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

  if (
    info.hasLoginBtn ||
    info.href.includes('/auth/login') ||
    (!info.hasComposer && /log in|sign up/i.test(info.bodyText))
  ) {
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

  const switcher = page.locator('[data-testid="model-switcher-dropdown-button"]').first()
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
  const composer = page.locator('#prompt-textarea').first()
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
              window.__ocSseEvents.push({ seq, ts: Date.now(), error: String(err && err.message || err) });
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
    this.error = null
    this.lastEventAt = nowFn()
  }

  feedDataLine(raw) {
    const trimmed = String(raw ?? '').trim()
    if (!trimmed) return
    this.lastEventAt = this.nowFn()
    if (trimmed === '[DONE]') {
      this.done = true
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
      this.channel === 'thoughts'
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
 */
export function extractAssistantFromMapping(conv) {
  if (!conv || !conv.mapping) return null
  let cur = conv.current_node
  const visited = new Set()
  while (cur && conv.mapping[cur] && !visited.has(cur)) {
    visited.add(cur)
    const node = conv.mapping[cur]
    const m = node.message
    if (m && m.author?.role === 'assistant') {
      const ct = m.content?.content_type
      const ch = m.channel
      if (
        ct === 'thoughts' ||
        ct === 'reasoning_recap' ||
        ch === 'commentary' ||
        ch === 'thoughts'
      ) {
        cur = node.parent
        continue
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

export function extractUserTurnFromStdinFrame(line) {
  const trimmed = String(line ?? '').trim()
  if (!trimmed) return null
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { text: trimmed, files: [] }
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.type && parsed.type !== 'user') return null

  const msg = parsed.message || parsed
  const content = msg.content ?? parsed.prompt ?? ''
  const files = Array.isArray(parsed.files) ? [...parsed.files] : []

  if (typeof content === 'string') {
    return { text: content, files }
  }
  if (Array.isArray(content)) {
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
    return { text: texts.join('\n'), files }
  }
  return { text: String(content || ''), files }
}
