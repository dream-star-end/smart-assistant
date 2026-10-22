#!/usr/bin/env node
/**
 * Box ChatGPT Web Pro Interactive Runner Host (OCV5-551).
 *
 * Speaks V5 Route B stream-json over stdin/stdout (identical framing to cursorBoxCcBridge)
 * while driving a persistent real Google Chrome session on Box DISPLAY=:1 via CDP.
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  BOX_GPT_WEB_BUSY_MESSAGE,
  DEFAULT_CHATGPT_ORIGIN,
  DEFAULT_CHROME_BIN,
  DEFAULT_DISPLAY,
  DEFAULT_MAX_TIMEOUT_MS,
  DEFAULT_PROFILE,
  DEFAULT_STALL_WINDOW_MS,
  SerialJobQueue,
  SseAccumulator,
  TurnProgressStreamer,
  backendFetchTeeInitScript,
  buildChromeLaunchArgs,
  cdpPortForProfile,
  clearActiveTurnState,
  computeAdaptiveDeadline,
  defaultGptWebSessionId,
  downloadTurnOutputArtifactsInPage,
  extractAssistantFromMapping,
  extractLiveProgressFromDomInPage,
  extractTurnOutputArtifactRefs,
  extractTurnProgressFromMapping,
  fetchConversationPayloadInPage,
  formatStreamJsonAssistantMessage,
  formatStreamJsonContentBlockStop,
  formatStreamJsonControlResponse,
  formatStreamJsonKeepalive,
  formatStreamJsonMessageStart,
  formatStreamJsonResult,
  formatStreamJsonSystemInit,
  formatStreamJsonTextDelta,
  formatStreamJsonThinkingBlockStart,
  formatStreamJsonThinkingDelta,
  inspectAndHandleApprovalCardInPage,
  inspectExistingTurnInConversation,
  isChatGptOriginUrl,
  isPidAlive,
  loadActiveTurnState,
  parseStdinFrame,
  probeSessionState,
  profileDirFor,
  readProfileSingletonOwner,
  resetComposerDraftInPage,
  resolveTurnCompletionDecision,
  resolveVisibleLocator,
  saveActiveTurnState,
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
  const rawMaxTimeout = Number(process.env.OC_BOX_GPT_WEB_MAX_TIMEOUT_MS)
  const rawStallTimeout = Number(process.env.OC_BOX_GPT_WEB_STALL_TIMEOUT_MS)
  const out = {
    model: 'gpt-6-astra-pro',
    catalogModel: 'box-gpt-6-astra-pro',
    sessionId: defaultGptWebSessionId(),
    profile,
    display: process.env.OC_BOX_GPT_WEB_DISPLAY || DEFAULT_DISPLAY,
    cdpPort: cdpPortForProfile(profile, process.env.OC_BOX_GPT_WEB_CDP_PORT),
    proxyUrl: process.env.OC_BOX_GPT_WEB_PROXY || null,
    chromeBin: process.env.OC_BOX_GPT_WEB_CHROME_BIN || DEFAULT_CHROME_BIN,
    playwrightPath:
      process.env.OC_BOX_GPT_WEB_PLAYWRIGHT_PATH ||
      '/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/index.mjs',
    maxTimeoutMs:
      Number.isFinite(rawMaxTimeout) && rawMaxTimeout >= 60_000
        ? rawMaxTimeout
        : DEFAULT_MAX_TIMEOUT_MS,
    stallWindowMs:
      Number.isFinite(rawStallTimeout) && rawStallTimeout >= 30_000
        ? rawStallTimeout
        : DEFAULT_STALL_WINDOW_MS,
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

let cachedCdpBrowser = null
let cachedCdpPort = null

async function getConnectedCdpBrowser(chromium, cdpPort) {
  if (
    cachedCdpBrowser &&
    cachedCdpPort === cdpPort &&
    typeof cachedCdpBrowser.isConnected === 'function' &&
    cachedCdpBrowser.isConnected()
  ) {
    return cachedCdpBrowser
  }
  cachedCdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  cachedCdpPort = cdpPort
  return cachedCdpBrowser
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

async function fetchConversationFromMappingInPage(
  page,
  fallbackConvId = null,
  { baselineNodeId = null } = {},
) {
  const fetched = await fetchConversationPayloadInPage(page, fallbackConvId)
  if (fetched?.conv) {
    const currentNode = fetched.conv.current_node || null
    const fromMap = extractAssistantFromMapping(fetched.conv, {
      baselineNodeId,
    })
    if (fromMap?.text) {
      return {
        text: fromMap.text,
        messageId: fromMap.messageId,
        convId: fetched.convId,
        currentNode,
        conv: fetched.conv,
      }
    }
    return {
      text: null,
      messageId: null,
      convId: fetched.convId,
      currentNode,
      conv: fetched.conv,
    }
  }
  return null
}

async function rescueFromDomOrMapping(
  page,
  fallbackConvId = null,
  { baselineNodeId = null, allowReload = false } = {},
) {
  let latest = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const direct = await fetchConversationFromMappingInPage(page, fallbackConvId, {
      baselineNodeId,
    })
    if (direct?.text) return direct
    if (direct) latest = direct
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 800))
    }
  }

  if (!allowReload) {
    return latest
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2_000))
  for (let attempt = 0; attempt < 2; attempt++) {
    const postReload = await fetchConversationFromMappingInPage(page, fallbackConvId, {
      baselineNodeId,
    })
    if (postReload?.text) return postReload
    if (postReload) latest = postReload
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  return latest
}

class DetachedTurnError extends Error {
  constructor(stage) {
    super(`BOX_GPT_WEB_DETACHED: host process detached (${stage})`)
    this.name = 'DetachedTurnError'
  }
}

async function stopActiveGenerationInPage(page) {
  if (!page) return
  try {
    const stopBtn = await resolveVisibleLocator(
      page,
      '[data-testid="stop-button"], button[aria-label*="Stop"]',
    )
    if ((await stopBtn.count()) > 0) {
      await stopBtn.click({ timeout: 2_000 }).catch(() => {})
    }
  } catch {}
}

async function executeTurnOnBrowser(cfg, turn, turnControl) {
  const profileDir = profileDirFor(cfg.profile, os.homedir())
  const profileLockPath = `${profileDir}.lock`
  const portLockPath = path.join(os.tmpdir(), `.chatgpt-pro-cdp-${cfg.cdpPort}.lock`)

  const rawLockTimeout = process.env.OC_BOX_GPT_WEB_LOCK_TIMEOUT_MS
  const lockTimeoutMs =
    rawLockTimeout !== undefined && rawLockTimeout !== '' && Number.isFinite(Number(rawLockTimeout))
      ? Number(rawLockTimeout)
      : 0
  const lockOpts = { timeoutMs: lockTimeoutMs, busyMessage: BOX_GPT_WEB_BUSY_MESSAGE }

  return withProfileFileLock(
    profileLockPath,
    () =>
      withProfileFileLock(
        portLockPath,
        async () => {
          if (turnControl.detached) {
            throw new DetachedTurnError('before launch')
          }
          if (turnControl.abort) {
            throw new Error('BOX_GPT_WEB_INTERRUPTED: turn aborted before launch')
          }

          let accumulatedThinking = ''
          const emitThinking = (delta) => {
            if (!delta) return
            accumulatedThinking += delta
            writeStdoutLine(formatStreamJsonThinkingDelta(delta))
          }
          const closeThinkingIfOpen = () => {
            if (!turnControl.thinkingBlockOpen) return
            turnControl.thinkingBlockOpen = false
            writeStdoutLine(formatStreamJsonContentBlockStop({ index: 0 }))
          }
          const streamer = new TurnProgressStreamer({
            initialEmittedFinalText:
              typeof turn.deliveredText === 'string' ? turn.deliveredText : '',
          })

          const turnAttachmentSignature = Array.isArray(turn.files)
            ? turn.files
                .map((filePath) => {
                  const raw = String(filePath ?? '')
                  try {
                    const buf = fs.readFileSync(raw)
                    const digest = crypto
                      .createHash('sha256')
                      .update(buf)
                      .digest('hex')
                      .slice(0, 16)
                    return `${path.basename(raw)}:${buf.byteLength}:${digest}`
                  } catch {
                    return path.basename(raw)
                  }
                })
                .join('|')
            : ''

          const activeTurnState = loadActiveTurnState(profileDir, cfg.sessionId)
          const sameAttachments =
            Boolean(activeTurnState) &&
            (activeTurnState.attachmentSignature ?? '') === turnAttachmentSignature
          const isSameTurn = Boolean(
            activeTurnState &&
              sameAttachments &&
              activeTurnState.promptText === turn.text &&
              (turn.turnId ? activeTurnState.turnId === turn.turnId : !activeTurnState.completedAt),
          )
          // Also allow recovering an already-completed ChatGPT reply when the user retries
          // the exact same prompt (with identical attachment signature) in the same session
          // after a prior empty/interrupted turn.
          const canRecoverSamePromptRetry = Boolean(
            activeTurnState &&
              sameAttachments &&
              activeTurnState.promptText === turn.text &&
              !activeTurnState.completedWithText,
          )
          if ((isSameTurn || canRecoverSamePromptRetry) && activeTurnState) {
            // Only restore stepTextByKey (thinking commentary deduplication) from disk;
            // emittedFinalText MUST come only from gateway-acknowledged `turn.deliveredText`
            // so an unacknowledged stdout write lost on a broken pipe is never skipped on reconnect.
            streamer.restoreState({
              stepTextByKey: activeTurnState.stepTextByKey,
            })
            if (isSameTurn && typeof activeTurnState.accumulatedThinking === 'string') {
              accumulatedThinking = activeTurnState.accumulatedThinking
            }
            // OCV5-584: how each already-streamed citation marker was rendered, so a reconnect keeps it.
            if (isSameTurn) streamer.citations.restoreState(activeTurnState.citationState)
          }

          let currentTurnState = {
            turnId: turn.turnId || activeTurnState?.turnId || null,
            conversationId: activeTurnState?.conversationId || null,
            baselineNodeId: isSameTurn ? (activeTurnState?.baselineNodeId ?? null) : null,
            promptText: turn.text,
            attachmentSignature: turnAttachmentSignature,
            startedAt:
              isSameTurn && Number.isFinite(activeTurnState?.startedAt)
                ? activeTurnState.startedAt
                : Date.now(),
            accumulatedThinking,
            stepTextByKey: Object.fromEntries(streamer.stepTextByKey),
          }

          const persistProgressState = (extra = {}) => {
            currentTurnState = {
              ...currentTurnState,
              ...extra,
              accumulatedThinking,
              stepTextByKey: Object.fromEntries(streamer.stepTextByKey),
              citationState: streamer.citations.exportState(),
            }
            saveActiveTurnState(profileDir, cfg.sessionId, currentTurnState)
          }

          await ensureRealChromeOnCdp(cfg, profileDir)
          const chromium = await loadPlaywrightChromium(cfg.playwrightPath)
          let browser = await getConnectedCdpBrowser(chromium, cfg.cdpPort)
          let page = await acquireSingleChatGptPage(browser)
          turnControl.page = page

          const abortIfRequested = async (stage) => {
            if (turnControl.detached) {
              throw new DetachedTurnError(stage)
            }
            if (turnControl.abort) {
              clearActiveTurnState(profileDir, cfg.sessionId)
              await stopActiveGenerationInPage(page)
              await resetComposerDraftInPage(page)
              throw new Error(`BOX_GPT_WEB_INTERRUPTED: turn aborted (${stage})`)
            }
          }

          const finalizeTurnOutput = async ({
            finalText,
            finalMessageId,
            convId,
            latestConv,
            baselineNodeId,
          }) => {
            await abortIfRequested('before finalizeTurnOutput')
            const msgId = finalMessageId || `msg_${Date.now()}`
            let outputAttachments = []
            try {
              let convForArtifacts = latestConv
              if (!convForArtifacts && convId) {
                const fetched = await fetchConversationPayloadInPage(page, convId)
                convForArtifacts = fetched?.conv || null
              }
              if (convForArtifacts) {
                // Current turn only: ChatGPT's turnNsearchM refs are numbered per reply.
                streamer.citations.addSources(
                  extractTurnProgressFromMapping(convForArtifacts, { baselineNodeId })
                    .citationSources,
                )
              }
              const artifactRefs = extractTurnOutputArtifactRefs({
                text: finalText,
                conv: convForArtifacts,
                baselineNodeId,
                finalMessageId: msgId,
              })
              if (artifactRefs.length > 0 && convId) {
                if (turnControl.thinkingBlockOpen) {
                  emitThinking(
                    `\n[Pro 文件取回] 检测到 ${artifactRefs.length} 个生成文件/图片，正在通过只读接口取回…\n`,
                  )
                }
                outputAttachments = await downloadTurnOutputArtifactsInPage(page, {
                  convId,
                  finalMessageId: msgId,
                  artifactRefs,
                })
              }
            } catch {}

            await abortIfRequested('after downloadTurnOutputArtifactsInPage')
            closeThinkingIfOpen()
            const tailDelta = streamer.consumeIncrementalFinalText(finalText, {
              finalFlush: true,
            })
            persistProgressState({
              conversationId: convId || currentTurnState.conversationId,
              baselineNodeId,
            })
            if (tailDelta || outputAttachments.length > 0) {
              writeStdoutLine(
                formatStreamJsonTextDelta(tailDelta, {
                  outputAttachments: outputAttachments.length > 0 ? outputAttachments : null,
                }),
              )
            }
            return {
              // Display text (citation markers rendered), identical to what was streamed.
              text: streamer.emittedFinalText,
              thinking: accumulatedThinking,
              messageId: msgId,
              outputAttachments: outputAttachments.length > 0 ? outputAttachments : null,
              turnState: currentTurnState,
            }
          }

          await abortIfRequested('after acquire page')

          // Wait briefly if the page is still rendering its initial DOM
          for (let i = 0; i < 15; i++) {
            const probe = await probeSessionState(page, { profileDir, display: cfg.display })
            if (probe.ok || probe.code === 'CF_CHALLENGE') break
            await new Promise((r) => setTimeout(r, 300))
          }

          let initialProbe = await probeSessionState(page, {
            profileDir,
            display: cfg.display,
          })
          // If a previous turn left the tab on a `/c/<id>` error banner ("Could not load this ChatGPT conversation"),
          // recover by navigating back to the ChatGPT home page before failing closed.
          if (!initialProbe.ok && initialProbe.code === 'DOM_DRIFT') {
            await page
              .goto(`${DEFAULT_CHATGPT_ORIGIN}/`, {
                waitUntil: 'domcontentloaded',
                timeout: 45_000,
              })
              .catch(() => {})
            await page.evaluate(backendFetchTeeInitScript()).catch(() => {})
            for (let i = 0; i < 20; i++) {
              const probe = await probeSessionState(page, { profileDir, display: cfg.display })
              if (probe.ok || probe.code === 'CF_CHALLENGE') break
              await new Promise((r) => setTimeout(r, 300))
            }
            initialProbe = await probeSessionState(page, {
              profileDir,
              display: cfg.display,
            })
          }
          if (!initialProbe.ok) {
            throw new Error(initialProbe.message)
          }

          const syncState = await syncPageToSessionConversation(page, {
            profileDir,
            sessionId: cfg.sessionId,
          })
          await abortIfRequested('after sync session')

          let baselineNodeId = null
          let resumedInProgress = false
          let latestConv = null

          if (syncState.conversationId) {
            let preConv = await fetchConversationPayloadInPage(page, syncState.conversationId)
            if (!preConv?.conv?.current_node) {
              await new Promise((r) => setTimeout(r, 800))
              preConv = await fetchConversationPayloadInPage(page, syncState.conversationId)
            }
            latestConv = preConv?.conv || null
            baselineNodeId = preConv?.conv?.current_node || null

            if ((isSameTurn || canRecoverSamePromptRetry) && preConv?.conv) {
              const existing = inspectExistingTurnInConversation(preConv.conv, {
                promptText: turn.text,
                baselineNodeId: activeTurnState.baselineNodeId ?? null,
              })
              if (existing.status === 'completed' && existing.reply?.text) {
                emitThinking('[Pro] 检测到重连前该回合已在网页端完成，正在同步最终结果…\n')
                return finalizeTurnOutput({
                  finalText: existing.reply.text,
                  finalMessageId: existing.reply.messageId,
                  convId: syncState.conversationId,
                  latestConv: preConv.conv,
                  baselineNodeId: existing.baselineNodeId,
                })
              }
              if (isSameTurn && existing.status === 'in_progress') {
                resumedInProgress = true
                baselineNodeId = existing.baselineNodeId
                emitThinking('[Pro] 已重新连接正在运行的 ChatGPT Pro 回合，继续同步实时进度…\n')
              }
            }
          }

          if (syncState.navigated && !resumedInProgress) {
            for (let i = 0; i < 25; i++) {
              const probe = await probeSessionState(page, { profileDir, display: cfg.display })
              if (probe.ok || probe.code === 'CF_CHALLENGE') break
              await new Promise((r) => setTimeout(r, 300))
            }
            let postNavProbe = await probeSessionState(page, {
              profileDir,
              display: cfg.display,
            })
            if (!postNavProbe.ok && postNavProbe.code === 'DOM_DRIFT') {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
              await page.evaluate(backendFetchTeeInitScript()).catch(() => {})
              for (let i = 0; i < 20; i++) {
                const probe = await probeSessionState(page, { profileDir, display: cfg.display })
                if (probe.ok || probe.code === 'CF_CHALLENGE') break
                await new Promise((r) => setTimeout(r, 300))
              }
              postNavProbe = await probeSessionState(page, {
                profileDir,
                display: cfg.display,
              })
            }
            if (!postNavProbe.ok) {
              throw new Error(postNavProbe.message)
            }
          }

          if (isSameTurn && !resumedInProgress) {
            const domLive = await extractLiveProgressFromDomInPage(page)
            if (domLive.stopBtn || domLive.activeThinking) {
              resumedInProgress = true
              baselineNodeId = activeTurnState?.baselineNodeId ?? baselineNodeId
              emitThinking('[Pro] 已重新连接正在运行的 ChatGPT Pro 回合，继续同步实时进度…\n')
            }
          }

          // On an existing conversation, we must have a valid pre-send baselineNodeId
          // so we never mistake a previous turn's finished message for the current turn's answer.
          const hasValidMappingBaseline =
            !syncState.conversationId || Boolean(baselineNodeId) || resumedInProgress

          if (!resumedInProgress) {
            await selectProTierInPage(page, { requestedTier: 'pro' })
            await abortIfRequested('after select pro tier')

            if (turn.files && turn.files.length > 0) {
              emitThinking(`[Pro] 正在上传 ${turn.files.length} 个附件…\n`)
              await uploadAttachmentsToComposer(page, turn.files)
              await abortIfRequested('after upload attachments')
            }

            await page.evaluate(() => {
              window.__ocSseEvents = []
            })

            await typeMultilinePreservingAttachments(page, turn.text)
            await abortIfRequested('before send')

            const sendBtn = await resolveVisibleLocator(
              page,
              '[data-testid="send-button"], button[aria-label="Send"], button[aria-label="Send prompt"]',
              { timeoutMs: 15_000 },
            )
            if (typeof sendBtn.waitFor === 'function') {
              await sendBtn.waitFor({ state: 'visible', timeout: 15_000 })
            }
            await abortIfRequested('before click send')
            persistProgressState({
              conversationId: syncState.conversationId || null,
              baselineNodeId,
              startedAt: Date.now(),
            })
            await sendBtn.click()
            emitThinking('[Pro] 已选中 Pro 档位并提交请求，等待 ChatGPT Pro 思考与执行…\n')
          }

          const startedAt =
            resumedInProgress && Number.isFinite(activeTurnState?.startedAt)
              ? activeTurnState.startedAt
              : Date.now()
          let lastActivityAt = Date.now()

          const acc = new SseAccumulator({
            onThinkingDelta: (delta) => {
              lastActivityAt = Date.now()
              emitThinking(delta)
            },
            onTextDelta: () => {
              lastActivityAt = Date.now()
              streamer.citations.addSources(acc.citationSources)
              const safeDelta = streamer.consumeIncrementalFinalText(acc.finalText, {
                finalFlush: false,
              })
              if (safeDelta) {
                closeThinkingIfOpen()
                persistProgressState({
                  conversationId: acc.conversationId || syncState.conversationId || null,
                  baselineNodeId,
                })
                writeStdoutLine(formatStreamJsonTextDelta(safeDelta))
              }
            },
          })

          let currentDeadline = Date.now() + 600_000
          let stopGoneSince = null
          let sawStopBtn = resumedInProgress
          let lastDomPollAt = 0
          let lastMappingPollAt = 0
          let lastRescueAttemptAt = 0
          let lastDomActiveThinking = false
          let lastObservedNodeId = baselineNodeId
          let lastObservedLiveFinalText = ''
          let lastFinalTextGrowthAt = null
          let latestProg = null
          let readCursor = 0

          while (true) {
            await abortIfRequested('during generation')

            let batch
            try {
              batch = await page.evaluate((fromIdx) => {
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
            } catch {
              if (turnControl.detached || turnControl.abort) {
                await abortIfRequested('during cdp reconnect')
              }
              // Transient CDP / page navigation hiccup during a multi-hour turn: reconnect and continue
              await new Promise((r) => setTimeout(r, 1_000))
              await ensureRealChromeOnCdp(cfg, profileDir)
              browser = await getConnectedCdpBrowser(chromium, cfg.cdpPort)
              page = await acquireSingleChatGptPage(browser)
              turnControl.page = page
              continue
            }

            readCursor = batch.nextIdx
            for (const item of batch.slice) {
              if (item.data) {
                acc.feedDataLine(item.data)
              } else if (item.error) {
                acc.error = item.error
              }
            }

            const resolvedConvId =
              acc.conversationId || batch.urlConvId || syncState.conversationId || null
            if (resolvedConvId) {
              saveSessionConversationId(profileDir, cfg.sessionId, resolvedConvId)
            }

            if (acc.error) {
              clearActiveTurnState(profileDir, cfg.sessionId)
              throw new Error(`BOX_GPT_WEB_SSE_ERROR: ${acc.error}`)
            }
            if (acc.done && acc.finalText.length > 0) {
              streamer.citations.addSources(acc.citationSources)
              let finalConvId = resolvedConvId
              if (!finalConvId) {
                const m = page.url().match(/\/c\/([a-z0-9_-]{8,128})/i)
                if (m) {
                  finalConvId = m[1]
                  saveSessionConversationId(profileDir, cfg.sessionId, finalConvId)
                }
              }
              return finalizeTurnOutput({
                finalText: acc.finalText,
                finalMessageId: acc.messageId || `msg_${Date.now()}`,
                convId: finalConvId,
                latestConv,
                baselineNodeId,
              })
            }

            const now = Date.now()
            if (batch.stopBtn) {
              sawStopBtn = true
              stopGoneSince = null
              lastActivityAt = now
            } else if (stopGoneSince === null && (sawStopBtn || now - startedAt > 3_000)) {
              stopGoneSince = now
            }

            // Poll DOM every 1s for approval cards (auto-allow for this chat) and live status/subagents/commands
            if (now - lastDomPollAt >= 1_000) {
              lastDomPollAt = now
              const approval = await inspectAndHandleApprovalCardInPage(page)
              if (approval?.handled) {
                lastActivityAt = now
                if (approval.announcement && turnControl.thinkingBlockOpen) {
                  emitThinking(approval.announcement)
                }
              }
              const domProg = await extractLiveProgressFromDomInPage(page)
              lastDomActiveThinking = Boolean(domProg.stopBtn || domProg.activeThinking)
              if (lastDomActiveThinking) {
                lastActivityAt = now
                stopGoneSince = null
              }
              if (turnControl.thinkingBlockOpen) {
                const { thinkingDeltas } = streamer.ingestDomProgress(domProg, {
                  now,
                  startedAt,
                })
                for (const td of thinkingDeltas) {
                  emitThinking(td)
                }
              }
            }

            // Poll conversation mapping every 2s for intermediate commentary/thoughts/tools and final text
            if (
              hasValidMappingBaseline &&
              resolvedConvId &&
              (acc.streamHandoff ||
                resumedInProgress ||
                sawStopBtn ||
                lastDomActiveThinking ||
                acc.done ||
                now - startedAt >= 2_000) &&
              now - lastMappingPollAt >= 2_000
            ) {
              lastMappingPollAt = now
              const payload = await fetchConversationPayloadInPage(page, resolvedConvId)
              if (payload?.conv) {
                latestConv = payload.conv
                const prog = extractTurnProgressFromMapping(payload.conv, { baselineNodeId })
                latestProg = prog
                if (prog.currentNode && prog.currentNode !== lastObservedNodeId) {
                  lastObservedNodeId = prog.currentNode
                  lastActivityAt = now
                }
                if (prog.liveFinalText && prog.liveFinalText !== lastObservedLiveFinalText) {
                  lastObservedLiveFinalText = prog.liveFinalText
                  lastFinalTextGrowthAt = now
                  lastActivityAt = now
                }
                const { thinkingDeltas, textDeltas } = streamer.ingestMappingProgress(prog)
                for (const td of thinkingDeltas) {
                  lastActivityAt = now
                  if (turnControl.thinkingBlockOpen) {
                    emitThinking(td)
                  }
                }
                if (thinkingDeltas.length > 0 || textDeltas.length > 0) {
                  persistProgressState({
                    conversationId: payload.convId || resolvedConvId,
                    baselineNodeId,
                  })
                }
                for (const txd of textDeltas) {
                  lastActivityAt = now
                  closeThinkingIfOpen()
                  writeStdoutLine(formatStreamJsonTextDelta(txd))
                }
                if (prog.finishedFinal?.text) {
                  const finalConvId = payload.convId || resolvedConvId
                  if (finalConvId) {
                    saveSessionConversationId(profileDir, cfg.sessionId, finalConvId)
                  }
                  return finalizeTurnOutput({
                    finalText: prog.finishedFinal.text,
                    finalMessageId: prog.finishedFinal.messageId,
                    convId: finalConvId,
                    latestConv: payload.conv,
                    baselineNodeId,
                  })
                }
              }
            }

            const adaptive = computeAdaptiveDeadline({
              startedAt,
              now,
              lastActivityAt: Math.max(lastActivityAt, acc.lastEventAt),
              stopVisible: batch.stopBtn,
              activeThinkingVisible: lastDomActiveThinking,
              stopGoneSince,
              hasFinalText: Boolean(acc.finalText || streamer.emittedFinalText),
              maxTimeoutMs: cfg.maxTimeoutMs,
              stallWindowMs: cfg.stallWindowMs,
              currentDeadline,
            })
            currentDeadline = adaptive.deadline

            if (!batch.stopBtn && !lastDomActiveThinking && (acc.done || adaptive.shouldRescue)) {
              let rescued = null
              if (!acc.finalText && hasValidMappingBaseline && now - lastRescueAttemptAt >= 2_500) {
                lastRescueAttemptAt = now
                const stopGoneElapsed = stopGoneSince !== null ? now - stopGoneSince : 0
                rescued = await rescueFromDomOrMapping(page, resolvedConvId, {
                  baselineNodeId,
                  allowReload: stopGoneElapsed >= 15_000,
                })
                if (rescued?.conv) {
                  latestConv = rescued.conv
                  const rescuedProg = extractTurnProgressFromMapping(rescued.conv, {
                    baselineNodeId,
                  })
                  latestProg = rescuedProg
                  if (
                    rescuedProg.liveFinalText &&
                    rescuedProg.liveFinalText !== lastObservedLiveFinalText
                  ) {
                    lastObservedLiveFinalText = rescuedProg.liveFinalText
                    lastFinalTextGrowthAt = now
                    lastActivityAt = now
                  }
                }
              }
              const decision = resolveTurnCompletionDecision({
                accDone: acc.done,
                shouldRescue: adaptive.shouldRescue,
                accFinalText: acc.finalText,
                rescued,
                latestProg,
                emittedFinalText: streamer.emittedFinalText,
                stopVisible: batch.stopBtn,
                activeThinkingVisible: lastDomActiveThinking,
                stopGoneSince,
                lastFinalTextGrowthAt,
                now,
              })
              if (decision.action === 'finalize' && decision.text) {
                const finalConvId = decision.convId || resolvedConvId
                if (finalConvId) {
                  saveSessionConversationId(profileDir, cfg.sessionId, finalConvId)
                }
                return finalizeTurnOutput({
                  finalText: decision.text,
                  finalMessageId: decision.messageId || acc.messageId || `msg_${Date.now()}`,
                  convId: finalConvId,
                  latestConv: decision.conv || latestConv,
                  baselineNodeId,
                })
              }
              if (decision.action === 'error_empty') {
                throw new Error(
                  'BOX_GPT_WEB_EMPTY_RESPONSE: ChatGPT Pro turn finished without producing assistant text',
                )
              }
            }

            if (adaptive.expired) {
              clearActiveTurnState(profileDir, cfg.sessionId)
              await stopActiveGenerationInPage(page)
              throw new Error(
                `BOX_GPT_WEB_PRO_TIMEOUT: turn exceeded adaptive deadline (${Math.round((now - startedAt) / 1000)}s)`,
              )
            }

            await new Promise((r) => setTimeout(r, 250))
          }
        },
        lockOpts,
      ),
    lockOpts,
  )
}

async function main() {
  const cfg = parseCliArgs(process.argv.slice(2))
  const profileDir = profileDirFor(cfg.profile, os.homedir())
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
    // When SIGTERM/SIGINT arrives (e.g. exec stream disconnect or bridge reconnect reap),
    // detach cleanly WITHOUT clicking the page's Stop button and WITHOUT clearing activeTurnState,
    // so the running ChatGPT Pro turn continues undisturbed and the reconnecting host can resume it.
    for (const tc of pendingTurnControls) {
      tc.detached = true
    }
    setTimeout(() => {
      process.exit(0)
    }, 300).unref?.()
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
          clearActiveTurnState(profileDir, cfg.sessionId)
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

    if (queue.size > 0) {
      if (!initEmitted) {
        initEmitted = true
        writeStdoutLine(
          formatStreamJsonSystemInit({
            sessionId: cfg.sessionId,
            model: cfg.catalogModel,
          }),
        )
      }
      writeStdoutLine(formatStreamJsonTextDelta(BOX_GPT_WEB_BUSY_MESSAGE))
      writeStdoutLine(
        formatStreamJsonAssistantMessage({
          messageId: `msg_busy_${Date.now()}`,
          model: cfg.catalogModel,
          text: BOX_GPT_WEB_BUSY_MESSAGE,
        }),
      )
      writeStdoutLine(
        formatStreamJsonResult({
          sessionId: cfg.sessionId,
          resultText: BOX_GPT_WEB_BUSY_MESSAGE,
          isError: true,
          durationMs: 0,
        }),
      )
      return
    }

    // Synchronously register turnControl before enqueueing so an interrupt frame
    // arriving in the same stdin chunk cancels this queued turn before it starts.
    const turnControl = { abort: false, detached: false, page: null, thinkingBlockOpen: false }
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
      // Immediately exit Personal Edition's "正在启动引擎" startup phase and open the live Thinking panel
      const provisionalMsgId = `msg_${turnStart}`
      writeStdoutLine(
        formatStreamJsonMessageStart({
          messageId: provisionalMsgId,
          model: cfg.catalogModel,
        }),
      )
      writeStdoutLine(formatStreamJsonThinkingBlockStart({ index: 0 }))
      turnControl.thinkingBlockOpen = true
      writeStdoutLine(formatStreamJsonThinkingDelta('[Pro] 正在连接浏览器会话并准备提交请求…\n'))

      const keepaliveTimer = setInterval(() => {
        writeStdoutLine(
          formatStreamJsonKeepalive({
            sessionId: cfg.sessionId,
            elapsedMs: Date.now() - turnStart,
          }),
        )
      }, 10_000)
      keepaliveTimer.unref?.()

      try {
        const out = await executeTurnOnBrowser(cfg, frame, turnControl)
        if (turnControl.detached) return
        if (turnControl.thinkingBlockOpen) {
          turnControl.thinkingBlockOpen = false
          writeStdoutLine(formatStreamJsonContentBlockStop({ index: 0 }))
        }
        writeStdoutLine(
          formatStreamJsonAssistantMessage({
            messageId: out.messageId,
            model: cfg.catalogModel,
            text: out.text,
            thinking: out.thinking,
            outputAttachments: out.outputAttachments,
          }),
        )
        writeStdoutLine(
          formatStreamJsonResult({
            sessionId: cfg.sessionId,
            resultText: out.text,
            isError: false,
            durationMs: Date.now() - turnStart,
            outputAttachments: out.outputAttachments,
          }),
        )
        if (!turnControl.detached && !turnControl.abort) {
          if (frame.turnId) {
            saveActiveTurnState(profileDir, cfg.sessionId, {
              ...out.turnState,
              completedAt: Date.now(),
              completedWithText: Boolean(out.text && out.text.trim().length > 0),
            })
          } else {
            clearActiveTurnState(profileDir, cfg.sessionId)
          }
        }
      } catch (err) {
        if (err instanceof DetachedTurnError || turnControl.detached) {
          return
        }
        const errMsg = err instanceof Error ? err.message : String(err)
        if (turnControl.thinkingBlockOpen) {
          turnControl.thinkingBlockOpen = false
          writeStdoutLine(formatStreamJsonContentBlockStop({ index: 0 }))
        }
        writeStdoutLine(formatStreamJsonTextDelta(errMsg))
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
        clearInterval(keepaliveTimer)
        pendingTurnControls.delete(turnControl)
        if (shuttingDown && pendingTurnControls.size === 0) {
          process.exit(0)
        }
      }
    })
  })
}

main().catch((err) => {
  process.stderr.write(`[box-gpt-web-host] fatal: ${err?.stack || err}\n`)
  process.exit(1)
})
