#!/usr/bin/env node
/**
 * Box ChatGPT Web Pro Interactive Runner Host (OCV5-551).
 *
 * Speaks V5 Route B stream-json over stdin/stdout (identical framing to cursorBoxCcBridge)
 * while driving a persistent real Google Chrome session on Box DISPLAY=:1 via CDP (127.0.0.1:9229).
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_CDP_PORT,
  DEFAULT_CHATGPT_ORIGIN,
  DEFAULT_CHROME_BIN,
  DEFAULT_DISPLAY,
  DEFAULT_PROFILE,
  SerialJobQueue,
  SseAccumulator,
  backendFetchTeeInitScript,
  buildChromeLaunchArgs,
  computeAdaptiveDeadline,
  extractAssistantFromMapping,
  extractUserTurnFromStdinFrame,
  formatStreamJsonAssistantMessage,
  formatStreamJsonResult,
  formatStreamJsonSystemInit,
  formatStreamJsonTextDelta,
  formatStreamJsonThinkingDelta,
  probeSessionState,
  profileDirFor,
  selectProTierInPage,
  typeMultilinePreservingAttachments,
  uploadAttachmentsToComposer,
  validateLocalOnlyProxy,
  withProfileFileLock,
} from './chatgptWebCore.mjs'

function parseCliArgs(argv) {
  const out = {
    model: 'gpt-6-astra-pro',
    catalogModel: 'box-gpt-6-astra-pro',
    sessionId: `gpt-web-pro-${Date.now()}`,
    profile: process.env.OC_BOX_GPT_WEB_PROFILE || DEFAULT_PROFILE,
    display: process.env.OC_BOX_GPT_WEB_DISPLAY || DEFAULT_DISPLAY,
    cdpPort: Number(process.env.OC_BOX_GPT_WEB_CDP_PORT || DEFAULT_CDP_PORT),
    proxyUrl: process.env.OC_BOX_GPT_WEB_PROXY || null,
    chromeBin: process.env.OC_BOX_GPT_WEB_CHROME_BIN || DEFAULT_CHROME_BIN,
    playwrightPath:
      process.env.OC_BOX_GPT_WEB_PLAYWRIGHT_PATH ||
      '/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/index.mjs',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model' && argv[i + 1]) {
      out.model = argv[++i]
    } else if ((a === '--session-id' || a === '--resume') && argv[i + 1]) {
      out.sessionId = argv[++i]
    } else if (a === '--profile' && argv[i + 1]) {
      out.profile = argv[++i]
    } else if (a === '--cdp-port' && argv[i + 1]) {
      out.cdpPort = Number(argv[++i])
    } else if (a === '--proxy' && argv[i + 1]) {
      out.proxyUrl = argv[++i]
    }
  }
  return out
}

function writeStdoutLine(line) {
  process.stdout.write(`${line}\n`)
}

function checkCdpAlive(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function ensureRealChromeOnCdp(cfg, profileDir) {
  const validatedProxy = validateLocalOnlyProxy(cfg.proxyUrl)
  if (await checkCdpAlive(cfg.cdpPort)) {
    return
  }
  const args = buildChromeLaunchArgs({
    profileDir,
    cdpPort: cfg.cdpPort,
    proxyUrl: validatedProxy,
    startUrl: `${DEFAULT_CHATGPT_ORIGIN}/`,
  })
  const child = spawn(cfg.chromeBin, args, {
    env: {
      ...process.env,
      DISPLAY: cfg.display,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await checkCdpAlive(cfg.cdpPort)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `BOX_GPT_WEB_CDP_UNREACHABLE: Chrome did not listen on 127.0.0.1:${cfg.cdpPort} (DISPLAY=${cfg.display}, profile=${profileDir})`,
  )
}

async function loadPlaywrightChromium(playwrightPath) {
  try {
    const mod = await import(pathToFileURL(playwrightPath).href)
    return mod.chromium || mod.default?.chromium
  } catch {
    const mod = await import('playwright-core')
    return mod.chromium || mod.default?.chromium
  }
}

async function acquireSingleChatGptPage(browser) {
  const contexts = browser.contexts()
  const context = contexts[0] || (await browser.newContext({ viewport: null }))
  await context.addInitScript(backendFetchTeeInitScript())

  const pages = context.pages()
  let target = pages.find((p) => p.url().startsWith(DEFAULT_CHATGPT_ORIGIN)) || pages[0]
  if (!target) {
    target = await context.newPage()
  }
  for (const p of pages) {
    if (p !== target && p.url().startsWith(DEFAULT_CHATGPT_ORIGIN)) {
      await p.close().catch(() => {})
    }
  }
  if (!target.url().startsWith(DEFAULT_CHATGPT_ORIGIN)) {
    await target.goto(`${DEFAULT_CHATGPT_ORIGIN}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
  }
  await target.evaluate(backendFetchTeeInitScript())
  return target
}

async function rescueFromDomOrMapping(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  const rescued = await page.evaluate(async () => {
    const m = location.pathname.match(/\/c\/([0-9a-f-]{20,})/i)
    if (m) {
      try {
        const r = await fetch(`/backend-api/conversation/${m[1]}`, { credentials: 'include' })
        if (r.ok) {
          const conv = await r.json()
          return { conv, domText: null }
        }
      } catch {}
    }
    const turns = document.querySelectorAll('[data-message-author-role="assistant"]')
    const last = turns.length > 0 ? turns[turns.length - 1] : null
    return { conv: null, domText: last ? (last.innerText || '').trim() : null }
  })
  if (rescued.conv) {
    const fromMap = extractAssistantFromMapping(rescued.conv)
    if (fromMap?.text) return fromMap.text
  }
  return rescued.domText || null
}

async function executeTurnOnBrowser(cfg, turn) {
  const profileDir = profileDirFor(cfg.profile, os.homedir())
  const lockPath = `${profileDir}.lock`

  return withProfileFileLock(lockPath, async () => {
    await ensureRealChromeOnCdp(cfg, profileDir)
    const chromium = await loadPlaywrightChromium(cfg.playwrightPath)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdpPort}`)
    const page = await acquireSingleChatGptPage(browser)

    const sessionProbe = await probeSessionState(page, {
      profileDir,
      display: cfg.display,
    })
    if (!sessionProbe.ok) {
      throw new Error(sessionProbe.message)
    }

    await selectProTierInPage(page, { requestedTier: 'pro' })

    if (turn.files && turn.files.length > 0) {
      await uploadAttachmentsToComposer(page, turn.files)
    }

    await page.evaluate(() => {
      window.__ocSseEvents = []
    })

    await typeMultilinePreservingAttachments(page, turn.text)

    const sendBtn = page.locator('[data-testid="send-button"]').first()
    await sendBtn.waitFor({ state: 'visible', timeout: 15_000 })
    await sendBtn.click()

    const acc = new SseAccumulator({
      onThinkingDelta: (delta) => {
        writeStdoutLine(formatStreamJsonThinkingDelta(delta))
      },
      onTextDelta: (delta) => {
        writeStdoutLine(formatStreamJsonTextDelta(delta))
      },
    })

    const startedAt = Date.now()
    let currentDeadline = startedAt + 600_000
    let stopGoneSince = null
    let readCursor = 0

    while (true) {
      const batch = await page.evaluate((fromIdx) => {
        const events = Array.isArray(window.__ocSseEvents) ? window.__ocSseEvents : []
        const slice = events.slice(fromIdx)
        const stopBtn = Boolean(
          document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"]'),
        )
        return { slice, nextIdx: events.length, stopBtn }
      }, readCursor)

      readCursor = batch.nextIdx
      for (const item of batch.slice) {
        if (item.data) {
          acc.feedDataLine(item.data)
        } else if (item.error) {
          acc.error = item.error
        }
      }

      if (acc.error) {
        throw new Error(`BOX_GPT_WEB_SSE_ERROR: ${acc.error}`)
      }
      if (acc.done && acc.finalText.length > 0) {
        return {
          text: acc.finalText,
          thinking: acc.thinkingText,
          messageId: acc.messageId || `msg_${Date.now()}`,
        }
      }

      const now = Date.now()
      if (batch.stopBtn) {
        stopGoneSince = null
      } else if (stopGoneSince === null && now - startedAt > 3_000) {
        stopGoneSince = now
      }

      const adaptive = computeAdaptiveDeadline({
        startedAt,
        now,
        lastActivityAt: acc.lastEventAt,
        stopVisible: batch.stopBtn,
        stopGoneSince,
        hasFinalText: acc.finalText.length > 0,
        currentDeadline,
      })
      currentDeadline = adaptive.deadline

      if (adaptive.shouldRescue) {
        const rescuedText = await rescueFromDomOrMapping(page)
        if (rescuedText) {
          if (rescuedText.length > acc.finalText.length) {
            const delta = rescuedText.slice(acc.finalText.length)
            writeStdoutLine(formatStreamJsonTextDelta(delta))
          }
          return {
            text: rescuedText,
            thinking: acc.thinkingText,
            messageId: acc.messageId || `msg_${Date.now()}`,
          }
        }
      }

      if (!batch.stopBtn && acc.done) {
        if (!acc.finalText) {
          const rescuedText = await rescueFromDomOrMapping(page)
          if (rescuedText) {
            writeStdoutLine(formatStreamJsonTextDelta(rescuedText))
            return {
              text: rescuedText,
              thinking: acc.thinkingText,
              messageId: acc.messageId || `msg_${Date.now()}`,
            }
          }
        }
        return {
          text: acc.finalText,
          thinking: acc.thinkingText,
          messageId: acc.messageId || `msg_${Date.now()}`,
        }
      }

      if (adaptive.expired) {
        throw new Error(
          `BOX_GPT_WEB_PRO_TIMEOUT: turn exceeded adaptive deadline (${Math.round((now - startedAt) / 1000)}s)`,
        )
      }

      await new Promise((r) => setTimeout(r, 250))
    }
  })
}

async function main() {
  const cfg = parseCliArgs(process.argv.slice(2))
  const queue = new SerialJobQueue()
  let initEmitted = false

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  for await (const line of rl) {
    const turn = extractUserTurnFromStdinFrame(line)
    if (!turn) continue

    await queue.enqueue(async () => {
      const turnStart = Date.now()
      if (!initEmitted) {
        initEmitted = true
        writeStdoutLine(
          formatStreamJsonSystemInit({
            sessionId: cfg.sessionId,
            model: cfg.catalogModel,
          }),
        )
      }
      try {
        const out = await executeTurnOnBrowser(cfg, turn)
        writeStdoutLine(
          formatStreamJsonAssistantMessage({
            messageId: out.messageId,
            model: cfg.catalogModel,
            text: out.text,
            thinking: out.thinking,
          }),
        )
        writeStdoutLine(
          formatStreamJsonResult({
            sessionId: cfg.sessionId,
            resultText: out.text,
            isError: false,
            durationMs: Date.now() - turnStart,
          }),
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        writeStdoutLine(
          formatStreamJsonAssistantMessage({
            messageId: `msg_err_${Date.now()}`,
            model: cfg.catalogModel,
            text: errMsg,
          }),
        )
        writeStdoutLine(
          formatStreamJsonResult({
            sessionId: cfg.sessionId,
            resultText: errMsg,
            isError: true,
            durationMs: Date.now() - turnStart,
          }),
        )
      }
    })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    process.stderr.write(
      `[box-gpt-web-host] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`,
    )
    process.exit(1)
  })
}
