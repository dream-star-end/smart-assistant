#!/usr/bin/env node
/**
 * Box ChatGPT Web Pro Interactive Runner Host (OCV5-551).
 *
 * Speaks V5 Route B stream-json over stdin/stdout (identical framing to cursorBoxCcBridge)
 * while driving a persistent real Google Chrome session on Box DISPLAY=:1 via CDP.
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_CHATGPT_ORIGIN,
  DEFAULT_CHROME_BIN,
  DEFAULT_DISPLAY,
  DEFAULT_PROFILE,
  SerialJobQueue,
  SseAccumulator,
  backendFetchTeeInitScript,
  buildChromeLaunchArgs,
  cdpPortForProfile,
  computeAdaptiveDeadline,
  extractAssistantFromMapping,
  formatStreamJsonAssistantMessage,
  formatStreamJsonControlResponse,
  formatStreamJsonResult,
  formatStreamJsonSystemInit,
  formatStreamJsonTextDelta,
  formatStreamJsonThinkingDelta,
  isChatGptOriginUrl,
  isPidAlive,
  parseStdinFrame,
  probeSessionState,
  profileDirFor,
  readProfileSingletonOwner,
  resetComposerDraftInPage,
  saveSessionConversationId,
  selectProTierInPage,
  syncPageToSessionConversation,
  typeMultilinePreservingAttachments,
  uploadAttachmentsToComposer,
  validateLocalOnlyProxy,
  withProfileFileLock,
} from './chatgptWebCore.mjs'

function parseCliArgs(argv) {
  const profile = process.env.OC_BOX_GPT_WEB_PROFILE || DEFAULT_PROFILE
  const out = {
    model: 'gpt-6-astra-pro',
    catalogModel: 'box-gpt-6-astra-pro',
    sessionId: `gpt-web-pro-${Date.now()}`,
    profile,
    display: process.env.OC_BOX_GPT_WEB_DISPLAY || DEFAULT_DISPLAY,
    cdpPort: cdpPortForProfile(profile, process.env.OC_BOX_GPT_WEB_CDP_PORT),
    proxyUrl: process.env.OC_BOX_GPT_WEB_PROXY || null,
    chromeBin: process.env.OC_BOX_GPT_WEB_CHROME_BIN || DEFAULT_CHROME_BIN,
    playwrightPath:
      process.env.OC_BOX_GPT_WEB_PLAYWRIGHT_PATH ||
      '/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/index.mjs',
  }
  let explicitCdpPort = process.env.OC_BOX_GPT_WEB_CDP_PORT || null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model' && argv[i + 1]) {
      out.model = argv[++i]
    } else if ((a === '--session-id' || a === '--resume') && argv[i + 1]) {
      out.sessionId = argv[++i]
    } else if (a === '--profile' && argv[i + 1]) {
      out.profile = argv[++i]
    } else if (a === '--cdp-port' && argv[i + 1]) {
      explicitCdpPort = argv[++i]
    } else if (a === '--proxy' && argv[i + 1]) {
      out.proxyUrl = argv[++i]
    }
  }
  out.cdpPort = cdpPortForProfile(out.profile, explicitCdpPort)
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
  const owner = readProfileSingletonOwner(profileDir)

  if (await checkCdpAlive(cfg.cdpPort)) {
    if (!owner.locked || !owner.ownsProfile || owner.cdpPort !== cfg.cdpPort) {
      throw new Error(
        `BOX_GPT_WEB_CDP_PROFILE_MISMATCH: port 127.0.0.1:${cfg.cdpPort} is not owned by profile ${profileDir}`,
      )
    }
    return
  }

  // If the profile is currently held by a manually-launched Chrome without --remote-debugging-port,
  // gracefully send SIGTERM to that exact main PID so it flushes cookies/storage cleanly before we relaunch with CDP.
  if (owner.locked && owner.ownsProfile && owner.pid && owner.cdpPort !== cfg.cdpPort) {
    try {
      process.kill(owner.pid, 'SIGTERM')
    } catch {}
    const handoffDeadline = Date.now() + 8_000
    while (Date.now() < handoffDeadline) {
      if (!isPidAlive(owner.pid)) break
      await new Promise((r) => setTimeout(r, 150))
    }
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
  const candidates = [
    playwrightPath,
    '/usr/local/lib/pnpm/5/node_modules/playwright-core/index.mjs',
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const mod = await import(pathToFileURL(p).href)
      if (mod.chromium || mod.default?.chromium) return mod.chromium || mod.default?.chromium
    } catch {}
  }
  const mod = await import('playwright-core')
  return mod.chromium || mod.default?.chromium
}

async function acquireSingleChatGptPage(browser) {
  const contexts = browser.contexts()
  const context = contexts[0] || (await browser.newContext({ viewport: null }))
  await context.addInitScript(backendFetchTeeInitScript())

  const pages = context.pages()
  let target = pages.find((p) => isChatGptOriginUrl(p.url())) || pages[0]
  if (!target) {
    target = await context.newPage()
  }
  for (const p of pages) {
    if (p !== target) {
      await p.close().catch(() => {})
    }
  }
  if (!isChatGptOriginUrl(target.url())) {
    await target.goto(`${DEFAULT_CHATGPT_ORIGIN}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
  }
  await target.evaluate(backendFetchTeeInitScript())
  return target
}

async function fetchConversationFromMappingInPage(page, fallbackConvId = null) {
  const fetched = await page
    .evaluate(async (knownId) => {
      const m = location.pathname.match(/\/c\/([a-z0-9_-]{8,128})/i)
      const convId = (m && m[1]) || knownId || null
      if (!convId) return { conv: null, convId: null }
      try {
        let token = null
        try {
          const sessRes = await fetch('/api/auth/session', { credentials: 'include' })
          if (sessRes.ok) {
            const sess = await sessRes.json()
            token = sess?.accessToken || null
          }
        } catch {}
        const headers = token ? { Authorization: `Bearer ${token}` } : {}
        const r = await fetch(`/backend-api/conversation/${convId}`, {
          credentials: 'include',
          headers,
        })
        if (r.ok) {
          const conv = await r.json()
          return { conv, convId }
        }
      } catch {}
      return { conv: null, convId }
    }, fallbackConvId)
    .catch(() => ({ conv: null, convId: fallbackConvId }))

  if (fetched?.conv) {
    const fromMap = extractAssistantFromMapping(fetched.conv)
    if (fromMap?.text) {
      return {
        text: fromMap.text,
        messageId: fromMap.messageId,
        convId: fetched.convId,
      }
    }
  }
  return null
}

async function rescueFromDomOrMapping(page, fallbackConvId = null) {
  const direct = await fetchConversationFromMappingInPage(page, fallbackConvId)
  if (direct?.text) return direct

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  return fetchConversationFromMappingInPage(page, fallbackConvId)
}

async function stopActiveGenerationInPage(page) {
  if (!page) return
  try {
    const stopBtn = page.locator('[data-testid="stop-button"], button[aria-label*="Stop"]').first()
    if ((await stopBtn.count()) > 0) {
      await stopBtn.click({ timeout: 2_000 }).catch(() => {})
    }
  } catch {}
}

async function executeTurnOnBrowser(cfg, turn, turnControl) {
  const profileDir = profileDirFor(cfg.profile, os.homedir())
  const profileLockPath = `${profileDir}.lock`
  const portLockPath = path.join(os.tmpdir(), `.chatgpt-pro-cdp-${cfg.cdpPort}.lock`)

  return withProfileFileLock(profileLockPath, () =>
    withProfileFileLock(portLockPath, async () => {
      if (turnControl.abort) {
        throw new Error('BOX_GPT_WEB_INTERRUPTED: turn aborted before launch')
      }
      await ensureRealChromeOnCdp(cfg, profileDir)
      const chromium = await loadPlaywrightChromium(cfg.playwrightPath)
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdpPort}`)
      const page = await acquireSingleChatGptPage(browser)
      turnControl.page = page

      const abortIfRequested = async (stage) => {
        if (turnControl.abort) {
          await stopActiveGenerationInPage(page)
          await resetComposerDraftInPage(page)
          throw new Error(`BOX_GPT_WEB_INTERRUPTED: turn aborted (${stage})`)
        }
      }

      await abortIfRequested('after acquire page')

      await syncPageToSessionConversation(page, {
        profileDir,
        sessionId: cfg.sessionId,
      })
      await abortIfRequested('after sync session')

      // Wait briefly while the page renders its composer DOM after navigation
      for (let i = 0; i < 30; i++) {
        const probe = await probeSessionState(page, { profileDir, display: cfg.display })
        if (probe.ok || probe.code === 'CF_CHALLENGE') break
        await new Promise((r) => setTimeout(r, 300))
      }

      const sessionProbe = await probeSessionState(page, {
        profileDir,
        display: cfg.display,
      })
      if (!sessionProbe.ok) {
        throw new Error(sessionProbe.message)
      }

      await selectProTierInPage(page, { requestedTier: 'pro' })
      await abortIfRequested('after select pro tier')

      if (turn.files && turn.files.length > 0) {
        await uploadAttachmentsToComposer(page, turn.files)
        await abortIfRequested('after upload attachments')
      }

      await page.evaluate(() => {
        window.__ocSseEvents = []
      })

      await typeMultilinePreservingAttachments(page, turn.text)
      await abortIfRequested('before send')

      const sendBtn = page
        .locator(
          '[data-testid="send-button"], button[aria-label="Send"], button[aria-label="Send prompt"]',
        )
        .first()
      await sendBtn.waitFor({ state: 'visible', timeout: 15_000 })
      await abortIfRequested('before click send')
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
      let sawStopBtn = false
      let lastMappingPollAt = 0
      let readCursor = 0

      while (true) {
        await abortIfRequested('during generation')

        const batch = await page.evaluate((fromIdx) => {
          const events = Array.isArray(window.__ocSseEvents) ? window.__ocSseEvents : []
          const slice = events.slice(fromIdx)
          const stopBtn = Boolean(
            document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"]'),
          )
          const urlMatch = location.pathname.match(/\/c\/([a-z0-9_-]{8,128})/i)
          return {
            slice,
            nextIdx: events.length,
            stopBtn,
            urlConvId: urlMatch ? urlMatch[1] : null,
          }
        }, readCursor)

        readCursor = batch.nextIdx
        for (const item of batch.slice) {
          if (item.data) {
            acc.feedDataLine(item.data)
          } else if (item.error) {
            acc.error = item.error
          }
        }

        const resolvedConvId = acc.conversationId || batch.urlConvId
        if (resolvedConvId) {
          saveSessionConversationId(profileDir, cfg.sessionId, resolvedConvId)
        }

        if (acc.error) {
          throw new Error(`BOX_GPT_WEB_SSE_ERROR: ${acc.error}`)
        }
        if (acc.done && acc.finalText.length > 0) {
          if (!resolvedConvId) {
            const m = page.url().match(/\/c\/([a-z0-9_-]{8,128})/i)
            if (m) saveSessionConversationId(profileDir, cfg.sessionId, m[1])
          }
          return {
            text: acc.finalText,
            thinking: acc.thinkingText,
            messageId: acc.messageId || `msg_${Date.now()}`,
          }
        }

        const now = Date.now()
        if (batch.stopBtn) {
          sawStopBtn = true
          stopGoneSince = null
        } else if (stopGoneSince === null && (sawStopBtn || now - startedAt > 3_000)) {
          stopGoneSince = now
        }

        // In ChatGPT Web Pro (Oct 2026), POST /backend-api/f/conversation emits stream_handoff
        // and hands off token delivery to WebSocket. Once stop-button disappears (or every 2s
        // after stream_handoff when stop-button is gone), query /backend-api/conversation/<id>
        // with Bearer auth to collect the finished_successfully final assistant reply immediately.
        if (
          !batch.stopBtn &&
          !acc.finalText &&
          resolvedConvId &&
          (sawStopBtn || acc.streamHandoff || acc.done) &&
          now - lastMappingPollAt >= 1_500
        ) {
          lastMappingPollAt = now
          const mapped = await fetchConversationFromMappingInPage(page, resolvedConvId)
          if (mapped?.text) {
            if (mapped.convId) {
              saveSessionConversationId(profileDir, cfg.sessionId, mapped.convId)
            }
            writeStdoutLine(formatStreamJsonTextDelta(mapped.text))
            return {
              text: mapped.text,
              thinking: acc.thinkingText,
              messageId: mapped.messageId || acc.messageId || `msg_${Date.now()}`,
            }
          }
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
          const rescued = await rescueFromDomOrMapping(page, resolvedConvId)
          if (rescued?.text) {
            if (rescued.convId) {
              saveSessionConversationId(profileDir, cfg.sessionId, rescued.convId)
            }
            if (rescued.text.length > acc.finalText.length) {
              const delta = rescued.text.slice(acc.finalText.length)
              writeStdoutLine(formatStreamJsonTextDelta(delta))
            }
            return {
              text: rescued.text,
              thinking: acc.thinkingText,
              messageId: rescued.messageId || acc.messageId || `msg_${Date.now()}`,
            }
          }
        }

        if (!batch.stopBtn && acc.done) {
          if (!acc.finalText) {
            const rescued = await rescueFromDomOrMapping(page, resolvedConvId)
            if (rescued?.text) {
              if (rescued.convId) {
                saveSessionConversationId(profileDir, cfg.sessionId, rescued.convId)
              }
              writeStdoutLine(formatStreamJsonTextDelta(rescued.text))
              return {
                text: rescued.text,
                thinking: acc.thinkingText,
                messageId: rescued.messageId || acc.messageId || `msg_${Date.now()}`,
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
          await stopActiveGenerationInPage(page)
          throw new Error(
            `BOX_GPT_WEB_PRO_TIMEOUT: turn exceeded adaptive deadline (${Math.round((now - startedAt) / 1000)}s)`,
          )
        }

        await new Promise((r) => setTimeout(r, 250))
      }
    }),
  )
}

async function main() {
  const cfg = parseCliArgs(process.argv.slice(2))
  const queue = new SerialJobQueue()
  let initEmitted = false
  const pendingTurnControls = new Set()

  const abortAllPendingAndActiveTurns = async () => {
    const tasks = []
    for (const tc of pendingTurnControls) {
      tc.abort = true
      if (tc.page) {
        tasks.push(stopActiveGenerationInPage(tc.page))
        tasks.push(resetComposerDraftInPage(tc.page))
      }
    }
    if (tasks.length > 0) {
      await Promise.allSettled(tasks)
    }
  }

  let shuttingDown = false
  const onSignal = () => {
    if (shuttingDown) return
    shuttingDown = true
    void Promise.race([
      abortAllPendingAndActiveTurns(),
      new Promise((r) => setTimeout(r, 3_000)),
    ]).finally(() => {
      process.exit(0)
    })
  }

  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  rl.on('line', (line) => {
    const frame = parseStdinFrame(line)
    if (!frame) return

    if (frame.kind === 'control_request') {
      if (frame.subtype === 'interrupt') {
        for (const tc of pendingTurnControls) {
          tc.abort = true
        }
      }
      void (async () => {
        if (frame.subtype === 'interrupt') {
          await abortAllPendingAndActiveTurns()
        }
        writeStdoutLine(
          formatStreamJsonControlResponse({
            requestId: frame.requestId,
            subtype: 'success',
          }),
        )
      })()
      return
    }

    // Synchronously register turnControl before enqueueing so an interrupt frame
    // arriving in the same stdin chunk cancels this queued turn before it starts.
    const turnControl = { abort: false, page: null }
    pendingTurnControls.add(turnControl)

    void queue.enqueue(async () => {
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
        const out = await executeTurnOnBrowser(cfg, frame, turnControl)
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
      } finally {
        pendingTurnControls.delete(turnControl)
      }
    })
  })
}

main().catch((err) => {
  process.stderr.write(`[box-gpt-web-host] fatal: ${err?.stack || err}\n`)
  process.exit(1)
})
