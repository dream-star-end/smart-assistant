import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import {
  CHATGPT_MARKER_MAX_LEN,
  ChatgptCitationRenderer,
  DEFAULT_MAX_TIMEOUT_MS,
  SerialJobQueue,
  SseAccumulator,
  TierLimitError,
  TurnProgressStreamer,
  buildChromeLaunchArgs,
  cdpPortForProfile,
  classifyApprovalCard,
  clearActiveTurnState,
  collectChatgptCitationSources,
  computeAdaptiveDeadline,
  defaultGptWebSessionId,
  detectTierLimit,
  downloadTurnOutputArtifactsInPage,
  extractAssistantFromMapping,
  extractInboundDispatchAttachments,
  extractTurnOutputArtifactRefs,
  extractTurnProgressFromMapping,
  extractUserTurnFromStdinFrame,
  fetchConversationPayloadInPage,
  formatStreamJsonKeepalive,
  inspectAndHandleApprovalCardInPage,
  inspectExistingTurnInConversation,
  isChatGptOriginUrl,
  levelIndex,
  loadActiveTurnState,
  loadSessionConversationMap,
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
  stripTierCaption,
  syncPageToSessionConversation,
  typeMultilinePreservingAttachments,
  uploadAttachmentsToComposer,
  validateLocalOnlyProxy,
  withProfileFileLock,
} from '../../box-gpt-web-mod/chatgptWebCore.mjs'
import {
  CURSOR_SAND_BOX_CC_RESUME_PREFIX,
  cursorSandBoxCcResumeInnerId,
} from '../engine/cursorAdapter.js'
import {
  type BoxCcControl,
  type BoxCcExecRequest,
  type ExecFrame,
  boxCcFifoPath,
  cursorBoxCcFromMaster,
  isBoxClaudeCatalogModel,
  isBoxGptWebCatalogModel,
  isBoxInteractiveCatalogModel,
} from '../engine/cursorBoxCc.js'
import { BoxLoginSignalTap, runBoxCcBridge } from '../engine/cursorBoxCcBridge.js'
import {
  BOX_GPT_WEB_BUSY_MESSAGE,
  boxGptWebInteractiveLaunchExec,
  currentBoxGptWebTurnSlotOwner,
  inlineGptWebAttachmentsInUserLine,
  isBoxGptWebAllowedContainerUser,
  isBoxGptWebModelArgv,
  loadBoxGptWebMod,
  materializeGptWebOutputAttachmentsInStdoutLine,
  releaseBoxGptWebTurnSlot,
  remoteInteractiveGptWebArgs,
  stampGptWebTurnIdInUserLine,
  tryAcquireBoxGptWebTurnSlot,
  validateBoxGptWebLoopbackProxy,
} from '../engine/cursorBoxGptWeb.js'
import { masterBoxCredentialSelection } from '../engine/cursorCredentialSelection.js'
import { cursorVariantFor } from '../engine/cursorRoutingAdapter.js'
import { buildImageAttachmentHint } from '../imageAttachmentHint.js'

function encodeExecFrames(frames: ExecFrame[]): Uint8Array {
  const parts: Buffer[] = []
  for (const frame of frames) {
    const wire =
      frame.kind === 'stdout'
        ? { stdoutEvent: { data: frame.data ?? '' } }
        : frame.kind === 'stderr'
          ? { stderrEvent: { data: frame.data ?? '' } }
          : { exitEvent: { exitCode: frame.code ?? 0 } }
    const json = Buffer.from(JSON.stringify(wire), 'utf8')
    const header = Buffer.alloc(5)
    header[0] = 0
    header.writeUInt32BE(json.length, 1)
    parts.push(header, json)
  }
  return new Uint8Array(Buffer.concat(parts))
}

function streamExecOnHost(req: BoxCcExecRequest, signal?: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: { ...process.env, ...req.environment },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let closed = false
      const push = (frames: ExecFrame[]): void => {
        if (closed) return
        try {
          controller.enqueue(encodeExecFrames(frames))
        } catch {}
      }
      child.stdout.on('data', (chunk: Buffer) =>
        push([{ kind: 'stdout', data: chunk.toString('utf8') }]),
      )
      child.stderr.on('data', (chunk: Buffer) =>
        push([{ kind: 'stderr', data: chunk.toString('utf8') }]),
      )
      const onAbort = (): void => {
        child.kill('SIGTERM')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        push([{ kind: 'exit', code: code ?? 0 }])
        if (!closed) {
          closed = true
          try {
            controller.close()
          } catch {}
        }
      })
    },
  })
  return new Response(stream, { status: 200 })
}

describe('Box ChatGPT Web Pro prototype (OCV5-551)', () => {
  it('validates persistent profile paths, strict origin check, per-profile CDP ports, and loopback proxy rules', () => {
    assert.equal(profileDirFor('default', '/home/box'), '/home/box/.chatgpt-pro-default')
    assert.equal(profileDirFor('acct-2', '/home/box'), '/home/box/.chatgpt-pro-acct-2')
    assert.throws(() => profileDirFor('../escape', '/home/box'), /Invalid ChatGPT Web profile/)

    // Strict origin check prevents https://chatgpt.com.attacker.example/ spoofing
    assert.equal(isChatGptOriginUrl('https://chatgpt.com/'), true)
    assert.equal(isChatGptOriginUrl('https://chatgpt.com/c/1234-5678'), true)
    assert.equal(isChatGptOriginUrl('https://chatgpt.com.attacker.example/'), false)
    assert.equal(isChatGptOriginUrl('http://chatgpt.com/'), false)

    // Per-profile deterministic CDP ports prevent cross-profile port 9229 collisions
    assert.equal(cdpPortForProfile('default'), 9229)
    const acct2Port = cdpPortForProfile('acct-2')
    assert.notEqual(acct2Port, 9229)
    assert.ok(acct2Port >= 9230 && acct2Port < 9730)

    assert.equal(validateLocalOnlyProxy(null), null)
    assert.equal(validateLocalOnlyProxy(''), null)
    assert.equal(validateLocalOnlyProxy('http://127.0.0.1:18992'), 'http://127.0.0.1:18992')
    assert.equal(validateLocalOnlyProxy('socks5://localhost:18993'), 'socks5://localhost:18993')
    assert.equal(validateBoxGptWebLoopbackProxy('http://127.0.0.1:18992'), 'http://127.0.0.1:18992')

    // Reject non-loopback proxies and IPv6 [::1] (strictly 127.0.0.1 / localhost)
    assert.throws(
      () => validateLocalOnlyProxy('http://192.168.10.223:18992'),
      /BOX_GPT_WEB_PROXY_NOT_LOOPBACK/,
    )
    assert.throws(
      () => validateLocalOnlyProxy('http://[::1]:18992'),
      /BOX_GPT_WEB_PROXY_NOT_LOOPBACK/,
    )
    assert.throws(
      () => validateBoxGptWebLoopbackProxy('http://[::1]:18992'),
      /BOX_GPT_WEB_PROXY_NOT_LOOPBACK/,
    )
    assert.throws(
      () => validateBoxGptWebLoopbackProxy('http://10.0.0.1:8080'),
      /BOX_GPT_WEB_PROXY_NOT_LOOPBACK/,
    )

    // Reject kl-mirror ports 18991 and 19095
    assert.throws(
      () => validateLocalOnlyProxy('http://127.0.0.1:18991'),
      /BOX_GPT_WEB_PROXY_FORBIDDEN_PORT/,
    )
    assert.throws(
      () => validateLocalOnlyProxy('http://127.0.0.1:19095'),
      /BOX_GPT_WEB_PROXY_FORBIDDEN_PORT/,
    )
    assert.throws(
      () => validateBoxGptWebLoopbackProxy('http://127.0.0.1:18991'),
      /BOX_GPT_WEB_PROXY_FORBIDDEN_PORT/,
    )

    const defaultArgs = buildChromeLaunchArgs({
      profileDir: '/home/box/.chatgpt-pro-default',
      cdpPort: 9229,
    })
    assert.ok(defaultArgs.includes('--user-data-dir=/home/box/.chatgpt-pro-default'))
    assert.ok(defaultArgs.includes('--remote-debugging-address=127.0.0.1'))
    assert.ok(defaultArgs.includes('--remote-debugging-port=9229'))
    assert.ok(defaultArgs.includes('--disable-blink-features=AutomationControlled'))
    assert.equal(
      defaultArgs.some(
        (a: string) => a.includes('--enable-automation') || a.includes('--headless'),
      ),
      false,
    )

    const proxyArgs = buildChromeLaunchArgs({
      profileDir: '/home/box/.chatgpt-pro-default',
      cdpPort: 9229,
      proxyUrl: 'http://127.0.0.1:18992',
    })
    assert.ok(proxyArgs.includes('--proxy-server=http://127.0.0.1:18992'))
    assert.ok(proxyArgs.includes('--proxy-bypass-list=<-loopback>'))
  })

  it('serializes single-tab turns, reclaims dead-PID locks immediately, and binds sessionId to ChatGPT conversation URLs', async () => {
    const queue = new SerialJobQueue()
    const order: string[] = []
    let active = 0
    let maxActive = 0

    const job = (name: string, delayMs: number, shouldFail = false) =>
      queue.enqueue(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(`${name}:start`)
        await new Promise((r) => setTimeout(r, delayMs))
        order.push(`${name}:end`)
        active -= 1
        if (shouldFail) throw new Error(`${name}_boom`)
        return name
      })

    const [r1, r2, r3] = await Promise.allSettled([
      job('turn1', 20, false),
      job('turn2', 15, true),
      job('turn3', 10, false),
    ])

    assert.equal(maxActive, 1)
    assert.deepEqual(order, [
      'turn1:start',
      'turn1:end',
      'turn2:start',
      'turn2:end',
      'turn3:start',
      'turn3:end',
    ])
    assert.equal(r1.status, 'fulfilled')
    assert.equal(r2.status, 'rejected')
    assert.equal(r3.status, 'fulfilled')

    const dir = mkdtempSync(join(tmpdir(), 'oc-gpt-web-lock-'))
    const lockPath = join(dir, '.chatgpt-pro-default.lock')
    try {
      // Simulate a lock left behind by a killed process (PID 99999999 is not alive)
      writeFileSync(lockPath, JSON.stringify({ pid: 99999999, acquiredAt: Date.now() - 500 }))
      await new Promise((r) => setTimeout(r, 60))
      let acquiredAfterDeadPid = false
      await withProfileFileLock(
        lockPath,
        async () => {
          acquiredAfterDeadPid = true
        },
        { timeoutMs: 1_000, pollMs: 20 },
      )
      assert.equal(acquiredAfterDeadPid, true)

      // Verify SingletonLock owner inspection
      symlinkSync(`host-${process.pid}`, join(dir, 'SingletonLock'))
      const owner = readProfileSingletonOwner(dir)
      assert.equal(owner.locked, true)
      assert.equal(owner.pid, process.pid)

      // Verify sessionId <-> ChatGPT conversation binding prevents context bleed across sessions
      saveSessionConversationId(dir, 'sess-A', 'conv-11111111-2222-3333-4444')
      assert.equal(loadSessionConversationMap(dir)['sess-A'], 'conv-11111111-2222-3333-4444')

      let currentUrl = 'https://chatgpt.com/'
      const fakePage = {
        url: () => currentUrl,
        goto: async (u: string) => {
          currentUrl = u
        },
        evaluate: async () => {},
      }
      // Resuming sess-A navigates directly to /c/conv-11111111-2222-3333-4444
      const navA = await syncPageToSessionConversation(fakePage, {
        profileDir: dir,
        sessionId: 'sess-A',
      })
      assert.equal(navA.navigated, true)
      assert.equal(currentUrl, 'https://chatgpt.com/c/conv-11111111-2222-3333-4444')

      // Starting a brand-new session sess-B while tab is on sess-A's /c/... navigates back to https://chatgpt.com/
      const navB = await syncPageToSessionConversation(fakePage, {
        profileDir: dir,
        sessionId: 'sess-B',
      })
      assert.equal(navB.navigated, true)
      assert.equal(currentUrl, 'https://chatgpt.com/')

      // Starting another new session sess-C when already on https://chatgpt.com/ still navigates/resets composer draft
      const navC = await syncPageToSessionConversation(fakePage, {
        profileDir: dir,
        sessionId: 'sess-C',
      })
      assert.equal(navC.navigated, true)
      assert.equal(currentUrl, 'https://chatgpt.com/')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when browser session is not logged in, blank, or hits Cloudflare challenge', async () => {
    const loggedOutPage = {
      evaluate: async () => ({
        href: 'https://chatgpt.com/',
        title: 'ChatGPT',
        bodyText: 'Log in Sign up',
        hasLoginBtn: true,
        hasComposer: false,
        isCfChallenge: false,
      }),
    }
    const probeOut = await probeSessionState(loggedOutPage, {
      profileDir: '/home/box/.chatgpt-pro-default',
      display: ':1',
    })
    assert.equal(probeOut.ok, false)
    assert.equal(probeOut.code, 'NOT_LOGGED_IN')
    assert.match(probeOut.message, /\/home\/box\/\.chatgpt-pro-default/)

    // Blank page without composer must also fail closed (NOT_LOGGED_IN)
    const blankPage = {
      evaluate: async () => ({
        href: 'about:blank',
        title: '',
        bodyText: '',
        hasLoginBtn: false,
        hasComposer: false,
        isCfChallenge: false,
      }),
    }
    const probeBlank = await probeSessionState(blankPage)
    assert.equal(probeBlank.ok, false)
    assert.equal(probeBlank.code, 'NOT_LOGGED_IN')

    const cfPage = {
      evaluate: async () => ({
        href: 'https://chatgpt.com/',
        title: 'Just a moment...',
        bodyText: 'Verify you are human',
        hasLoginBtn: false,
        hasComposer: false,
        isCfChallenge: true,
      }),
    }
    const probeCf = await probeSessionState(cfPage)
    assert.equal(probeCf.ok, false)
    assert.equal(probeCf.code, 'CF_CHALLENGE')
    assert.match(probeCf.message, /127\.0\.0\.1:18992/)

    const readyPage = {
      evaluate: async () => ({
        href: 'https://chatgpt.com/',
        title: 'ChatGPT',
        bodyText: '',
        hasLoginBtn: false,
        hasComposer: true,
        isCfChallenge: false,
      }),
    }
    const probeReady = await probeSessionState(readyPage)
    assert.equal(probeReady.ok, true)
    assert.equal(probeReady.code, 'READY')
  })

  it('selects Pro tier on the 5-position Intelligence slider and detects Pro quota limit banners', async () => {
    assert.equal(levelIndex('pro'), 4)
    assert.equal(levelIndex('gpt-6-astra-pro'), 4)
    assert.equal(levelIndex('box-gpt-6-astra-pro'), 4)
    assert.equal(stripTierCaption('ChatGPT 6 Astra\nPro\nMax intelligence'), 'ChatGPT 6 Astra')

    const limitInfo = detectTierLimit(
      ["You've hit your Pro limit. Switch to Extended until your limit resets on Oct 22."],
      4,
    )
    assert.ok(limitInfo)
    assert.equal(limitInfo.blocked, true)
    assert.equal(limitInfo.hitLevel, 'Pro')
    assert.equal(limitInfo.fallbackLevel, 'Extended')

    let sliderVal = 1
    const pressedKeys: string[] = []
    let banners: string[] = []

    const mockSlider = {
      count: async () => 1,
      focus: async () => {},
      getAttribute: async (attr: string) => {
        if (attr === 'aria-valuenow') return String(sliderVal)
        if (attr === 'aria-valuetext') return sliderVal === 4 ? 'Pro - Max intelligence' : 'Medium'
        return null
      },
      boundingBox: async () => ({ x: 100, y: 200, width: 200, height: 20 }),
    }
    const mockMenu = {
      waitFor: async () => {},
      locator: (sel: string) => {
        if (sel === '[role="slider"]') return { first: () => mockSlider }
        return { first: () => ({ count: async () => 0 }) }
      },
    }
    const mockSwitcher = {
      count: async () => 1,
      click: async () => {},
      innerText: async () => 'ChatGPT 6 Astra\nPro\nMax intelligence',
    }
    const mockPage = {
      evaluate: async () => banners,
      locator: (sel: string) => {
        if (sel === '[data-testid="model-switcher-dropdown-button"]')
          return { first: () => mockSwitcher }
        if (sel === '[role="menu"]') return { first: () => mockMenu }
        return { first: () => ({ count: async () => 0 }) }
      },
      keyboard: {
        press: async (key: string) => {
          pressedKeys.push(key)
          if (key === 'ArrowRight' && sliderVal < 4) sliderVal += 1
        },
      },
      mouse: {
        click: async () => {},
      },
    }

    const res = await selectProTierInPage(mockPage, { requestedTier: 'pro' })
    assert.equal(res.sliderIndex, 4)
    assert.equal(res.tier, 'pro')
    assert.equal(res.modelLabel, 'ChatGPT 6 Astra')
    assert.ok(pressedKeys.includes('ArrowRight'))
    assert.ok(pressedKeys.includes('Escape'))

    banners = ["You've hit your Pro limit. Switch to Extended until your limit resets tomorrow."]
    await assert.rejects(
      () => selectProTierInPage(mockPage, { requestedTier: 'pro' }),
      (err: unknown) => err instanceof TierLimitError && err.code === 'TIER_LIMIT',
    )

    // When slider stays stuck at Extended (index 2) after key + click, fail closed with BOX_GPT_WEB_TIER_MISMATCH
    banners = []
    sliderVal = 2
    const stuckPage = {
      ...mockPage,
      keyboard: {
        press: async (key: string) => {
          pressedKeys.push(key)
        },
      },
      mouse: {
        click: async () => {},
      },
    }
    await assert.rejects(
      () => selectProTierInPage(stuckPage, { requestedTier: 'pro' }),
      /BOX_GPT_WEB_TIER_MISMATCH/,
    )
  })

  it('bridges inboundDispatch image attachment hints into Box file uploads and types multiline text with Shift+Enter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-gpt-web-upload-'))
    const sampleFile = join(dir, 'diagram.png')
    const sampleBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    writeFileSync(sampleFile, sampleBytes)

    try {
      // 1. Verify inboundDispatch buildImageAttachmentHint integration
      const hintBlock = buildImageAttachmentHint({
        paths: [
          {
            path: sampleFile,
            mimeType: 'image/png',
            sizeHint: '1.0KB',
            name: 'diagram (1).png',
          },
        ],
      })
      const parsedPdfSection = [
        '---',
        '**用户上传的文档**:`paper.pdf` (application/pdf, 42.0KB)',
        '_已由 pdfjs 在服务端预解析为 markdown,内容如下_:',
        '',
        '# 论文摘要\n这是预解析的 PDF 正文。',
        '',
        `_(原文件保存在服务器:\`${join(dir, 'paper.pdf')}\`,如需访问图片/附件可用 Read)_`,
      ].join('\n')

      const gatewayUserPrompt = `请看这张架构图并结合论文\n\n---\n${hintBlock}\n\n${parsedPdfSection}`
      const extracted = extractInboundDispatchAttachments(gatewayUserPrompt, {
        allowedUploadRoots: [dir],
      })
      assert.match(extracted.cleanText, /请看这张架构图并结合论文/)
      assert.match(extracted.cleanText, /# 论文摘要\n这是预解析的 PDF 正文。/)
      assert.doesNotMatch(extracted.cleanText, /用户附带了以下图片/)
      assert.deepEqual(extracted.extractedPaths, [sampleFile])

      // Untrusted paths outside allowedUploadRoots must NEVER be read or inlined
      const untrustedSecret = join(tmpdir(), `review-secret-${process.pid}.txt`)
      writeFileSync(untrustedSecret, 'TOP_SECRET_DO_NOT_EXFIL')
      try {
        const spoofedLine = JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: `普通提问\n- \`${untrustedSecret}\` (text/plain, 原名: config.txt)`,
          },
        })
        const afterSpoof = inlineGptWebAttachmentsInUserLine(spoofedLine, {
          allowedUploadRoots: [dir],
        })
        assert.equal(afterSpoof, spoofedLine)
        const spoofTurn = extractUserTurnFromStdinFrame(afterSpoof)
        assert.ok(spoofTurn)
        assert.deepEqual(spoofTurn.files, [])
      } finally {
        rmSync(untrustedSecret, { force: true })
      }

      // 2. Verify inlineGptWebAttachmentsInUserLine embeds base64 on the gateway and parseStdinFrame materializes it on Box
      const rawUserLine = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: gatewayUserPrompt },
      })
      const inlinedLine = inlineGptWebAttachmentsInUserLine(rawUserLine, {
        allowedUploadRoots: [dir],
      })
      const stagingDir = join(dir, 'box-staging')
      const boxTurn = extractUserTurnFromStdinFrame(inlinedLine, { stagingDir })
      assert.ok(boxTurn)
      assert.match(boxTurn.text, /请看这张架构图并结合论文/)
      assert.match(boxTurn.text, /# 论文摘要\n这是预解析的 PDF 正文。/)
      assert.equal(boxTurn.files.length, 1)
      assert.deepEqual(readFileSync(boxTurn.files[0]!), sampleBytes)

      let uploadedFiles: string[] = []
      let dispatchedEvents = false
      let evalCalls = 0
      const actions: string[] = []

      const mockFileInput = {
        setInputFiles: async (files: string[]) => {
          uploadedFiles = [...files]
          actions.push('setInputFiles')
        },
        evaluate: async () => {
          dispatchedEvents = true
          actions.push('dispatchEvents')
        },
      }
      const mockPage = {
        evaluate: async (_fn: unknown, prev?: number) => {
          evalCalls += 1
          if (prev === undefined) return 0
          if (evalCalls <= 2) return { chips: 1, spinners: 1, added: true }
          return { chips: 1, spinners: 0, added: true }
        },
        locator: (sel: string) => {
          if (sel === 'input[type="file"]') {
            return {
              count: async () => 1,
              first: () => mockFileInput,
            }
          }
          if (sel === '#prompt-textarea') {
            return {
              first: () => ({
                click: async () => {
                  actions.push('clickComposer')
                },
              }),
            }
          }
          return { count: async () => 0 }
        },
        keyboard: {
          insertText: async (txt: string) => {
            actions.push(`insert:${txt}`)
          },
          press: async (key: string) => {
            actions.push(`press:${key}`)
          },
        },
      }

      const up = await uploadAttachmentsToComposer(mockPage, boxTurn.files, {
        timeoutMs: 2_000,
        pollMs: 10,
      })
      assert.equal(up.uploadedCount, 1)
      assert.deepEqual(uploadedFiles, boxTurn.files)
      assert.equal(dispatchedEvents, true)

      await typeMultilinePreservingAttachments(mockPage, 'Line 1\nLine 2\nLine 3')
      assert.deepEqual(actions, [
        'setInputFiles',
        'dispatchEvents',
        'clickComposer',
        'insert:Line 1',
        'press:Shift+Enter',
        'insert:Line 2',
        'press:Shift+Enter',
        'insert:Line 3',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accumulates delta-encoded SSE frames and strictly enforces final channel and user turn boundary in mapping rescue', () => {
    const thinkingChunks: string[] = []
    const textChunks: string[] = []
    const acc = new SseAccumulator({
      onThinkingDelta: (d: string) => thinkingChunks.push(d),
      onTextDelta: (d: string) => textChunks.push(d),
    })

    acc.feedDataLine(
      JSON.stringify({
        v: {
          conversation_id: 'conv-pro-123',
          message: {
            id: 'msg-think-1',
            author: { role: 'assistant' },
            channel: 'thoughts',
            content: {
              content_type: 'thoughts',
              thoughts: [{ summary: 'Analyzing architecture... ' }],
            },
          },
        },
      }),
    )
    acc.feedDataLine(
      JSON.stringify({
        p: '/message/content/thoughts/0/content',
        o: 'append',
        v: 'Checking P3 layer invariants.',
      }),
    )

    acc.feedDataLine(
      JSON.stringify({
        v: {
          message: {
            id: 'msg-recap-1',
            author: { role: 'assistant' },
            channel: 'commentary',
            content: {
              content_type: 'reasoning_recap',
              content: 'Thought for 4m 12s',
            },
          },
        },
      }),
    )

    acc.feedDataLine(
      JSON.stringify({
        v: {
          message: {
            id: 'msg-final-1',
            author: { role: 'assistant' },
            channel: 'final',
            content: {
              content_type: 'text',
              parts: ['Hello '],
            },
          },
        },
      }),
    )
    acc.feedDataLine(
      JSON.stringify({
        p: '/message/content/parts/0',
        o: 'append',
        v: 'from GPT-6 ',
      }),
    )
    acc.feedDataLine(
      JSON.stringify({
        p: '',
        o: 'patch',
        v: [{ p: '/message/content/parts/0', o: 'append', v: 'Astra Pro!' }],
      }),
    )
    acc.feedDataLine('[DONE]')

    assert.equal(acc.conversationId, 'conv-pro-123')
    assert.equal(acc.done, true)

    // Verify Oct 2026 Pro stream_handoff envelope does not prematurely set done=true before final text
    const handoffAcc = new SseAccumulator()
    handoffAcc.feedDataLine('"v1"')
    handoffAcc.feedDataLine(
      JSON.stringify({
        type: 'stream_handoff',
        conversation_id: '6ad887d6-d9e0-83ec-81b0-ea7e9a178f2d',
        turn_exchange_id: '15373702-e393-454a-85c6-d8e3d8f651ba',
      }),
    )
    handoffAcc.feedDataLine('[DONE]')
    assert.equal(handoffAcc.streamHandoff, true)
    assert.equal(handoffAcc.conversationId, '6ad887d6-d9e0-83ec-81b0-ea7e9a178f2d')
    assert.equal(handoffAcc.done, false)
    assert.equal(acc.finalText, 'Hello from GPT-6 Astra Pro!')
    assert.deepEqual(textChunks, ['Hello ', 'from GPT-6 ', 'Astra Pro!'])
    assert.equal(
      thinkingChunks.join(''),
      'Analyzing architecture... Checking P3 layer invariants.Thought for 4m 12s',
    )

    // Mapping rescue skips analysis/commentary/thoughts and extracts final assistant text
    const extracted = extractAssistantFromMapping({
      current_node: 'node-4',
      mapping: {
        'node-1': {
          parent: null,
          message: {
            id: 'u1',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['Question 1'] },
          },
        },
        'node-2': {
          parent: 'node-1',
          message: {
            id: 'm1',
            author: { role: 'assistant' },
            channel: 'analysis',
            content: { content_type: 'text', parts: ['internal analysis text'] },
          },
        },
        'node-3': {
          parent: 'node-2',
          message: {
            id: 'm2',
            author: { role: 'assistant' },
            channel: 'final',
            content: { content_type: 'text', parts: ['Rescued final answer'] },
          },
        },
        'node-4': {
          parent: 'node-3',
          message: {
            id: 'm3',
            author: { role: 'assistant' },
            channel: 'commentary',
            content: { content_type: 'reasoning_recap', parts: ['Thought for 8m'] },
          },
        },
      },
    })
    assert.deepEqual(extracted, { text: 'Rescued final answer', messageId: 'm2' })

    // If current_node is a new unanswered user message (or only has analysis so far),
    // extractAssistantFromMapping MUST stop at the user boundary and return null instead of returning Turn 1's answer!
    const unanswered = extractAssistantFromMapping({
      current_node: 'node-6',
      mapping: {
        'node-3': {
          parent: null,
          message: {
            id: 'm2',
            author: { role: 'assistant' },
            channel: 'final',
            content: { content_type: 'text', parts: ['Turn 1 old answer'] },
          },
        },
        'node-5': {
          parent: 'node-3',
          message: {
            id: 'u2',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['Turn 2 question'] },
          },
        },
        'node-6': {
          parent: 'node-5',
          message: {
            id: 'm_analysis',
            author: { role: 'assistant' },
            channel: 'analysis',
            content: { content_type: 'text', parts: ['Still thinking...'] },
          },
        },
      },
    })
    assert.equal(unanswered, null)
  })

  it('extends adaptive deadline up to 6 hours while Pro is actively thinking and triggers Stream-Rescue when stop-button disappears without final text', () => {
    assert.equal(DEFAULT_MAX_TIMEOUT_MS, 21_600_000)
    const t0 = 1_000_000
    const step1 = computeAdaptiveDeadline({
      startedAt: t0,
      now: t0 + 600_000,
      lastActivityAt: t0 + 100_000,
      stopVisible: true,
      currentDeadline: t0 + 600_000,
    })
    assert.equal(step1.extended, true)
    assert.equal(step1.expired, false)
    assert.equal(step1.deadline, t0 + 720_000)

    // Even when stop-button is temporarily hidden during a subagent/tool step, activeThinkingVisible keeps extending up to 6h
    const stepSubagent = computeAdaptiveDeadline({
      startedAt: t0,
      now: t0 + 3_600_000,
      lastActivityAt: t0 + 2_000_000,
      stopVisible: false,
      activeThinkingVisible: true,
      currentDeadline: t0 + 3_600_000,
    })
    assert.equal(stepSubagent.extended, true)
    assert.equal(stepSubagent.expired, false)
    assert.equal(stepSubagent.deadline, t0 + 3_720_000)

    const stepCeiling = computeAdaptiveDeadline({
      startedAt: t0,
      now: t0 + DEFAULT_MAX_TIMEOUT_MS,
      lastActivityAt: t0 + DEFAULT_MAX_TIMEOUT_MS - 10_000,
      stopVisible: true,
      currentDeadline: t0 + DEFAULT_MAX_TIMEOUT_MS,
    })
    assert.equal(stepCeiling.extended, false)
    assert.equal(stepCeiling.expired, true)

    const rescueCheck = computeAdaptiveDeadline({
      startedAt: t0,
      now: t0 + 300_000,
      lastActivityAt: t0 + 200_000,
      stopVisible: false,
      stopGoneSince: t0 + 200_000,
      hasFinalText: false,
      currentDeadline: t0 + 600_000,
    })
    assert.equal(rescueCheck.shouldRescue, true)
    assert.equal(rescueCheck.expired, false)
  })

  it('routes box-gpt-6-astra-pro through cursorRoutingAdapter and handles control_request interrupt + FIFO stream-json in runBoxCcBridge', async () => {
    assert.equal(isBoxGptWebCatalogModel('box-gpt-6-astra-pro'), true)
    assert.equal(isBoxClaudeCatalogModel('box-gpt-6-astra-pro'), false)
    assert.equal(isBoxInteractiveCatalogModel('box-gpt-6-astra-pro'), true)
    assert.equal(isBoxGptWebModelArgv(['--model', 'box-gpt-6-astra-pro']), true)
    assert.deepEqual(
      remoteInteractiveGptWebArgs(['--model', 'box-gpt-6-astra-pro', '--resume', 'sess-42']),
      ['--model', 'gpt-6-astra-pro', '--resume', 'sess-42'],
    )

    const ctrlFrame = parseStdinFrame(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-int-1',
        request: { subtype: 'interrupt' },
      }),
    )
    assert.deepEqual(ctrlFrame, {
      kind: 'control_request',
      requestId: 'req-int-1',
      subtype: 'interrupt',
    })

    const env = {
      OC_CURSOR_SAND_BOX_CC: '1',
      OC_BOX_INTERACTIVE_MASTER: '1',
      ANTHROPIC_BASE_URL: 'http://172.31.0.1:4098',
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.31.0.1:4098',
    }
    assert.equal(cursorBoxCcFromMaster('box-gpt-6-astra-pro', false, env), true)
    assert.equal(
      cursorVariantFor('box-gpt-6-astra-pro', masterBoxCredentialSelection(), undefined, env),
      'sand-box-cc',
    )

    const dir = mkdtempSync(join(tmpdir(), 'oc-box-gpt-web-bridge-'))
    const fifo = boxCcFifoPath(`gpt-web-test-${Date.now()}`)
    const control: BoxCcControl = {
      execUrl: 'http://127.0.0.1:9999/exec',
      execToken: 'tok-exec',
      networkToken: 'tok-net',
      remoteClaude: '/home/box/.local/bin/claude',
      fifo,
      cwd: dir,
      accountId: 'selfhost-master',
    }

    const realMod = loadBoxGptWebMod()
    const fakeHostMjs = `
import readline from 'node:readline'
import {
  formatStreamJsonAssistantMessage,
  formatStreamJsonControlResponse,
  formatStreamJsonResult,
  formatStreamJsonSystemInit,
  formatStreamJsonTextDelta,
  formatStreamJsonThinkingDelta,
  parseStdinFrame,
} from './chatgptWebCore.mjs'

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let first = true
rl.on('line', (line) => {
  const frame = parseStdinFrame(line)
  if (!frame) return
  if (frame.kind === 'control_request') {
    process.stdout.write(formatStreamJsonControlResponse({ requestId: frame.requestId }) + '\\n')
    return
  }
  if (first) {
    first = false
    process.stdout.write(formatStreamJsonSystemInit({ sessionId: 'sess-gpt-web', model: 'box-gpt-6-astra-pro' }) + '\\n')
  }
  process.stdout.write(formatStreamJsonThinkingDelta('Deep Pro synthesis...') + '\\n')
  process.stdout.write(formatStreamJsonTextDelta('Answer: ' + frame.text) + '\\n')
  process.stdout.write(formatStreamJsonAssistantMessage({ messageId: 'm_ok', text: 'Answer: ' + frame.text, thinking: 'Deep Pro synthesis...' }) + '\\n')
  process.stdout.write(formatStreamJsonResult({ sessionId: 'sess-gpt-web', resultText: 'Answer: ' + frame.text, isError: false, durationMs: 45 }) + '\\n')
  process.exit(0)
})
`

    try {
      const launchReq = boxGptWebInteractiveLaunchExec(
        control,
        ['--model', 'gpt-6-astra-pro'],
        realMod,
        'default',
        { OC_BOX_GPT_WEB_PROXY: 'http://127.0.0.1:18992' },
      )
      assert.equal(launchReq.environment.OC_BOX_GPT_WEB_PROXY, 'http://127.0.0.1:18992')
      assert.equal(launchReq.environment.DISPLAY, ':1')

      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let outText = ''
      stdout.on('data', (c: Buffer) => {
        outText += c.toString('utf8')
      })

      const bridgePromise = runBoxCcBridge({
        control,
        args: ['--model', 'box-gpt-6-astra-pro', '--resume', 'sess-gpt-web'],
        stdin,
        stdout,
        stderr,
        gptWebMod: {
          ...realMod,
          hostMjs: fakeHostMjs,
        },
        env: {
          OC_USER_ID: '3',
          OC_BOX_LOGIN_URL: 'http://172.31.0.1:4098/internal/box/login',
        },
        loginStateDir: dir,
        fetchImpl: async (_url, init) => {
          const req = JSON.parse(
            Buffer.from(init.body as Uint8Array)
              .subarray(5)
              .toString('utf8'),
          ) as BoxCcExecRequest
          return streamExecOnHost(req, init.signal ?? undefined)
        },
      })

      stdin.write(
        `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Solve Riemann hypothesis' },
        })}\n`,
      )
      const exitCode = await bridgePromise
      assert.equal(exitCode, 0)

      const frames = outText
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      assert.equal(frames[0].type, 'system')
      assert.equal(frames[0].model, 'box-gpt-6-astra-pro')
      assert.equal(frames[1].event.delta.type, 'thinking_delta')
      assert.equal(frames[1].event.delta.thinking, 'Deep Pro synthesis...')
      assert.equal(frames[2].event.delta.type, 'text_delta')
      assert.equal(frames[2].event.delta.text, 'Answer: Solve Riemann hypothesis')
      assert.equal(frames[3].type, 'assistant')
      assert.equal(frames[4].type, 'result')
      assert.equal(frames[4].is_error, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces user_id=3 container gate and global concurrency=1 turn slot', async () => {
    assert.equal(isBoxGptWebAllowedContainerUser({ OC_USER_ID: '3' }), true)
    assert.equal(isBoxGptWebAllowedContainerUser({ OC_USER_ID: ' 3 ' }), true)
    assert.equal(isBoxGptWebAllowedContainerUser({ OC_USER_ID: '765' }), false)
    assert.equal(isBoxGptWebAllowedContainerUser({ OC_USER_ID: '2' }), false)
    assert.equal(isBoxGptWebAllowedContainerUser({ OC_CONTAINER_ID: '1150' }), false)

    const baseEnv = {
      OC_CURSOR_SAND_BOX_CC: '1',
      OC_BOX_INTERACTIVE_MASTER: '1',
      ANTHROPIC_BASE_URL: 'http://172.31.0.1:4098',
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.31.0.1:4098',
    }
    assert.equal(
      cursorBoxCcFromMaster('box-gpt-6-astra-pro', false, { ...baseEnv, OC_USER_ID: '3' }),
      true,
    )
    assert.equal(
      cursorBoxCcFromMaster('box-gpt-6-astra-pro', false, { ...baseEnv, OC_USER_ID: '765' }),
      false,
    )
    assert.equal(
      cursorBoxCcFromMaster('box-gpt-6-astra-pro', false, { ...baseEnv, OC_USER_ID: '2' }),
      false,
    )

    const control: BoxCcControl = {
      execUrl: 'https://127.0.0.1:8443/anyrun.v1.ExecService/Exec',
      execToken: 'test-exec-token',
      networkToken: 'test-net-token',
      remoteClaude: '/usr/local/bin/claude',
      fifo: '/tmp/oc-box-cc-test.fifo',
      cwd: '/home/box',
      accountId: '1001',
    }
    assert.throws(
      () =>
        boxGptWebInteractiveLaunchExec(
          control,
          ['--model', 'gpt-6-astra-pro'],
          loadBoxGptWebMod(),
          'default',
          { OC_USER_ID: '765' },
        ),
      /BOX_GPT_WEB_FORBIDDEN_USER/,
    )

    releaseBoxGptWebTurnSlot()
    assert.equal(currentBoxGptWebTurnSlotOwner(), null)
    assert.equal(tryAcquireBoxGptWebTurnSlot('turn-1'), true)
    assert.equal(currentBoxGptWebTurnSlotOwner(), 'turn-1')
    assert.equal(tryAcquireBoxGptWebTurnSlot('turn-2'), false)
    releaseBoxGptWebTurnSlot('turn-2')
    assert.equal(currentBoxGptWebTurnSlotOwner(), 'turn-1')
    releaseBoxGptWebTurnSlot('turn-1')
    assert.equal(currentBoxGptWebTurnSlotOwner(), null)
    assert.equal(tryAcquireBoxGptWebTurnSlot('turn-2'), true)
    releaseBoxGptWebTurnSlot('turn-2')

    const dir = mkdtempSync(join(tmpdir(), 'oc-box-gpt-web-busy-'))
    try {
      const lockPath = join(dir, 'profile.lock')
      await assert.rejects(
        withProfileFileLock(lockPath, async () => {
          await withProfileFileLock(lockPath, async () => 'unexpected', {
            timeoutMs: 0,
            busyMessage: BOX_GPT_WEB_BUSY_MESSAGE,
          })
        }),
        /Pro 通道忙/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    // Concurrent contenders reclaiming a dead-PID lock must preserve mutual exclusion
    const raceDir = mkdtempSync(join(tmpdir(), 'oc-box-gpt-web-race-'))
    try {
      const raceLock = join(raceDir, 'profile.lock')
      writeFileSync(raceLock, JSON.stringify({ pid: 99999999, acquiredAt: Date.now() - 5_000 }))
      let inCritical = 0
      let maxInCritical = 0
      const contender = (id: string) =>
        withProfileFileLock(
          raceLock,
          async () => {
            inCritical += 1
            maxInCritical = Math.max(maxInCritical, inCritical)
            await new Promise((r) => setTimeout(r, 40))
            inCritical -= 1
            return id
          },
          { timeoutMs: 0, busyMessage: BOX_GPT_WEB_BUSY_MESSAGE },
        )
      const settled = await Promise.allSettled([contender('A'), contender('B')])
      assert.equal(maxInCritical, 1)
      const fulfilled = settled.filter((r) => r.status === 'fulfilled')
      const rejected = settled.filter((r) => r.status === 'rejected')
      assert.equal(fulfilled.length, 1)
      assert.equal(rejected.length, 1)

      // Crash recovery when a previous reclaimer was SIGKILLed leaving .reclaim behind
      writeFileSync(raceLock, JSON.stringify({ pid: 99999999, acquiredAt: Date.now() - 5_000 }))
      writeFileSync(`${raceLock}.reclaim`, '')
      const recovered = await withProfileFileLock(raceLock, async () => 'recovered-ok', {
        timeoutMs: 0,
        busyMessage: BOX_GPT_WEB_BUSY_MESSAGE,
      })
      assert.equal(recovered, 'recovered-ok')

      // Live .reclaim holder with timeoutMs: 0 must not busy-spin; must reject with busyMessage
      writeFileSync(raceLock, JSON.stringify({ pid: 99999999, acquiredAt: Date.now() - 5_000 }))
      writeFileSync(
        `${raceLock}.reclaim`,
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      )
      await assert.rejects(
        withProfileFileLock(raceLock, async () => 'unexpected', {
          timeoutMs: 0,
          busyMessage: BOX_GPT_WEB_BUSY_MESSAGE,
        }),
        /Pro 通道忙/,
      )
    } finally {
      rmSync(raceDir, { recursive: true, force: true })
    }

    const keepaliveLine = formatStreamJsonKeepalive({ sessionId: 'sess-ka', elapsedMs: 32_000 })
    const keepaliveObj = JSON.parse(keepaliveLine.trim())
    assert.equal(keepaliveObj.type, 'system')
    assert.equal(keepaliveObj.subtype, 'keepalive')
    assert.equal(keepaliveObj.session_id, 'sess-ka')
    assert.equal(keepaliveObj.elapsed_ms, 32_000)
  })

  it('auto-handles Codex approval cards by always clicking Allow for this chat (never Allow all relevant sites or Deny) and announcing the allowed site', async () => {
    const loopbackPreview = classifyApprovalCard({
      text: 'Sites\nAllow ChatGPT to preview your site?\nAllow ChatGPT to access 127.0.0.1:8765 using the cloud browser?',
      buttons: ['Deny', 'Allow all relevant sites', 'Allow for this chat'],
    })
    assert.equal(loopbackPreview.decision, 'allow_this_chat')
    assert.equal(loopbackPreview.buttonLabel, 'Allow for this chat')
    assert.equal(loopbackPreview.buttonIndex, 2)
    assert.equal(loopbackPreview.targetHost, '127.0.0.1:8765')
    assert.match(loopbackPreview.announcement, /127\.0\.0\.1:8765/)
    assert.match(loopbackPreview.announcement, /Allow for this chat/)

    const zhLoopbackPreview = classifyApprovalCard({
      text: '网站\n是否允许 ChatGPT 预览您的网站？\n是否允许 ChatGPT 使用云浏览器访问 localhost:3000？',
      buttons: ['拒绝', '允许所有相关网站', '允许此聊天'],
    })
    assert.equal(zhLoopbackPreview.decision, 'allow_this_chat')
    assert.equal(zhLoopbackPreview.buttonLabel, '允许此聊天')
    assert.equal(zhLoopbackPreview.buttonIndex, 2)
    assert.equal(zhLoopbackPreview.targetHost, 'localhost:3000')
    assert.match(zhLoopbackPreview.announcement, /localhost:3000/)
    assert.match(zhLoopbackPreview.announcement, /允许此聊天/)

    // All approval cards (including Auto-review and external domains) auto-click "Allow for this chat" / "允许此聊天"
    const autoReviewCard = classifyApprovalCard({
      text: 'Auto-review 阻止公开暴露工作区文件\n127.0.0.1:8765',
      buttons: ['拒绝', '允许此聊天'],
    })
    assert.equal(autoReviewCard.decision, 'allow_this_chat')
    assert.equal(autoReviewCard.buttonLabel, '允许此聊天')
    assert.equal(autoReviewCard.buttonIndex, 1)
    assert.equal(autoReviewCard.targetHost, '127.0.0.1:8765')
    assert.match(autoReviewCard.announcement, /127\.0\.0\.1:8765/)
    assert.match(autoReviewCard.announcement, /已自动点击「允许此聊天」/)

    const externalSiteCard = classifyApprovalCard({
      text: 'Sites\nAllow ChatGPT to preview your site?\nAllow ChatGPT to access example.com:8080 using the cloud browser?',
      buttons: ['Deny', 'Allow all relevant sites', 'Allow for this chat'],
    })
    assert.equal(externalSiteCard.decision, 'allow_this_chat')
    assert.equal(externalSiteCard.buttonLabel, 'Allow for this chat')
    assert.equal(externalSiteCard.buttonIndex, 2)
    assert.equal(externalSiteCard.targetHost, 'example.com:8080')
    assert.match(externalSiteCard.announcement, /example\.com:8080/)
    assert.match(externalSiteCard.announcement, /Allow for this chat/)

    // Never clicks "Allow all relevant sites" or "Deny" when single-chat allow is absent
    const multiSiteOnlyCard = classifyApprovalCard({
      text: 'Sites\nAllow ChatGPT to access example.com:8080?',
      buttons: ['Deny', 'Allow all relevant sites'],
    })
    assert.equal(multiSiteOnlyCard.decision, 'skip')
    assert.equal(multiSiteOnlyCard.buttonIndex, null)

    // Verify inspectAndHandleApprovalCardInPage never clicks "Allow all relevant sites" (index 1) or "Deny" (index 0)
    const clickedIndices: number[] = []
    const fakePage = {
      evaluate: async (_fn: unknown, btnIdx?: number) => {
        if (btnIdx === undefined) {
          return {
            text: 'Sites\nAllow ChatGPT to preview your site?\nAllow ChatGPT to access example.com:8080 using the cloud browser?',
            buttons: [
              { index: 0, label: 'Deny' },
              { index: 1, label: 'Allow all relevant sites' },
              { index: 2, label: 'Allow for this chat' },
            ],
          }
        }
        clickedIndices.push(btnIdx)
        return true
      },
      keyboard: {
        press: async () => {},
      },
    }
    const handled = await inspectAndHandleApprovalCardInPage(fakePage)
    assert.equal(handled.handled, true)
    assert.equal(handled.decision, 'allow_this_chat')
    assert.equal(handled.buttonLabel, 'Allow for this chat')
    assert.equal(handled.targetHost, 'example.com:8080')
    assert.deepEqual(clickedIndices, [2])
  })

  it('streams intermediate commentary, subagent/tool steps, and incremental final text while holding back sandbox:/ links until finalFlush', () => {
    const conv = {
      current_node: 'node-5',
      mapping: {
        'node-1': {
          parent: null,
          message: {
            id: 'u-1',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['Build wormhole demo'] },
          },
        },
        'node-2': {
          parent: 'node-1',
          message: {
            id: 'a-think',
            author: { role: 'assistant' },
            channel: 'thoughts',
            content: {
              content_type: 'thoughts',
              thoughts: [{ summary: 'Designing WebGL shader', content: 'Setting up raymarching' }],
            },
          },
        },
        'node-3': {
          parent: 'node-2',
          message: {
            id: 'a-comm',
            author: { role: 'assistant' },
            channel: 'commentary',
            recipient: 'all',
            content: {
              content_type: 'text',
              parts: ['我将创建一个单文件 HTML 虫洞穿越演示。'],
            },
          },
        },
        'node-4': {
          parent: 'node-3',
          message: {
            id: 'a-tool',
            author: { role: 'assistant' },
            channel: 'commentary',
            recipient: 'bash',
            content: {
              content_type: 'code',
              text: 'python3 -m http.server 8765',
            },
          },
        },
        'node-5': {
          parent: 'node-4',
          message: {
            id: 'a-final',
            author: { role: 'assistant' },
            channel: 'final',
            status: 'in_progress',
            content: {
              content_type: 'text',
              parts: [
                '演示已生成：[下载 ellis-wormhole.html](sandbox:/mnt/data/ellis-wormhole.html)',
              ],
            },
          },
        },
      },
    }

    const progress = extractTurnProgressFromMapping(conv)
    assert.equal(progress.currentNode, 'node-5')
    assert.equal(progress.finishedFinal, null)
    assert.equal(progress.thinkingSteps.length, 3)
    assert.match(progress.thinkingSteps[0]!.text, /Designing WebGL shader/)
    assert.match(progress.thinkingSteps[1]!.text, /我将创建一个单文件 HTML 虫洞穿越演示/)
    assert.match(progress.thinkingSteps[2]!.text, /\[工具 bash\]/)

    const streamer = new TurnProgressStreamer()
    const mapRes = streamer.ingestMappingProgress(progress)
    const domRes = streamer.ingestDomProgress({
      stopBtn: true,
      activeThinking: true,
      statusLines: [
        'Working for 3m 12s',
        'Subagents: 2/2 completed',
        'Ran command: python3 -m http.server 8765',
      ],
    })

    const combinedThinking = [...mapRes.thinkingDeltas, ...domRes.thinkingDeltas].join('')
    assert.ok(combinedThinking.includes('Working for 3m 12s'))
    assert.ok(combinedThinking.includes('我将创建一个单文件 HTML 虫洞穿越演示'))
    assert.ok(combinedThinking.includes('Subagents: 2/2 completed'))
    // Must hold back raw sandbox:/ link before finalFlush so it can be rewritten to /api/media/...
    assert.equal(mapRes.textDeltas.join(''), '演示已生成：')

    const tailDelta = streamer.consumeIncrementalFinalText(progress.liveFinalText, {
      finalFlush: true,
    })
    assert.equal(
      mapRes.textDeltas.join('') + tailDelta,
      '演示已生成：[下载 ellis-wormhole.html](sandbox:/mnt/data/ellis-wormhole.html)',
    )
  })

  it('extracts sandbox artifacts via read-only download APIs and materializes downloadable links in V5 output', async () => {
    const conv = {
      current_node: 'node-2',
      mapping: {
        'node-1': {
          parent: null,
          message: {
            id: 'u-1',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['Generate demo'] },
          },
        },
        'node-2': {
          parent: 'node-1',
          message: {
            id: 'msg-final-99',
            author: { role: 'assistant' },
            channel: 'final',
            status: 'finished_successfully',
            content: {
              content_type: 'multimodal_text',
              parts: [
                '点击下载：[demo.html](sandbox:/mnt/data/demo.html)',
                {
                  content_type: 'image_asset_pointer',
                  asset_pointer: 'sediment://file_00000000abcd1234',
                  metadata: { file_name: 'preview.png' },
                },
              ],
            },
          },
        },
      },
    }

    const refs = extractTurnOutputArtifactRefs({ conv, finalMessageId: 'msg-final-99' })
    assert.equal(refs.length, 2)
    assert.deepEqual(refs[0], {
      name: 'demo.html',
      sandboxUrl: 'sandbox:/mnt/data/demo.html',
      sandboxPath: '/mnt/data/demo.html',
      messageId: 'msg-final-99',
    })
    assert.deepEqual(refs[1], {
      name: 'preview.png',
      fileId: 'file_00000000abcd1234',
      mimeType: 'image/png',
      messageId: 'msg-final-99',
    })

    const htmlBytes = Buffer.from('<!doctype html><html><body>Demo</body></html>', 'utf8')
    const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex')
    const fakePage = {
      evaluate: async (
        _fn: unknown,
        arg: { targetRef: { sandboxPath?: string; fileId?: string } },
      ) => {
        if (arg.targetRef.sandboxPath) {
          return {
            ok: true,
            name: 'demo.html',
            mimeType: 'text/html',
            size: htmlBytes.byteLength,
            base64: htmlBytes.toString('base64'),
          }
        }
        return {
          ok: true,
          name: 'preview.png',
          mimeType: 'image/png',
          size: pngBytes.byteLength,
          base64: pngBytes.toString('base64'),
        }
      },
    }

    const downloaded = await downloadTurnOutputArtifactsInPage(fakePage, {
      convId: 'conv-demo-1',
      finalMessageId: 'msg-final-99',
      artifactRefs: refs,
    })
    assert.equal(downloaded.length, 2)
    assert.equal(downloaded[0]!.sandboxUrl, 'sandbox:/mnt/data/demo.html')
    assert.equal(downloaded[0]!.sandboxPath, '/mnt/data/demo.html')
    assert.equal(downloaded[1]!.fileId, 'file_00000000abcd1234')

    const outDir = mkdtempSync(join(tmpdir(), 'oc-gpt-web-output-'))
    const uploadsDir = join(outDir, 'uploads')
    const generatedDir = join(outDir, 'generated')
    try {
      const textDeltaFrame = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: {
            type: 'text_delta',
            text: '点击下载：[demo.html](sandbox:/mnt/data/demo.html)',
          },
        },
        outputAttachments: downloaded,
      })

      const rewrittenLine = materializeGptWebOutputAttachmentsInStdoutLine(textDeltaFrame, {
        uploadsDir,
        generatedDir,
      })
      const parsed = JSON.parse(rewrittenLine)
      assert.equal(parsed.outputAttachments, undefined)
      const deltaText: string = parsed.event.delta.text
      assert.doesNotMatch(deltaText, /sandbox:\/mnt\/data\/demo\.html/)
      assert.match(deltaText, /\/api\/media\/[0-9a-f]{64}\.html/)
      assert.match(deltaText, /!\[preview\.png\]\(\/api\/media\/[0-9a-f]{64}\.png\)/)
      assert.match(deltaText, /demo\.html.*\/generated\/demo\.html/)
      assert.equal(
        readFileSync(join(generatedDir, 'demo.html'), 'utf8'),
        '<!doctype html><html><body>Demo</body></html>',
      )
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('persists active turn state and reconnects mid-turn in runBoxCcBridge when stream drops before result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-gpt-web-reconnect-'))
    try {
      saveActiveTurnState(dir, 'sess-long-1', {
        conversationId: 'conv-long-1',
        promptText: 'Build wormhole animation',
        startedAt: 1_700_000_000_000,
      })
      const loaded = loadActiveTurnState(dir, 'sess-long-1')
      assert.ok(loaded)
      assert.equal(loaded.conversationId, 'conv-long-1')

      const inspected = inspectExistingTurnInConversation(
        {
          current_node: 'node-2',
          mapping: {
            'node-1': {
              parent: null,
              message: {
                id: 'u-1',
                author: { role: 'user' },
                content: { content_type: 'text', parts: ['Build wormhole animation'] },
              },
            },
            'node-2': {
              parent: 'node-1',
              message: {
                id: 'a-1',
                author: { role: 'assistant' },
                channel: 'commentary',
                status: 'in_progress',
                content: { content_type: 'text', parts: ['Working on shaders...'] },
              },
            },
          },
        },
        { promptText: 'Build wormhole animation' },
      )
      assert.equal(inspected.status, 'in_progress')
      assert.equal(inspected.userNodeId, 'node-1')
      assert.equal(inspected.reply, null)

      clearActiveTurnState(dir, 'sess-long-1')
      assert.equal(loadActiveTurnState(dir, 'sess-long-1'), null)

      // Verify TurnProgressStreamer state export/restore prevents duplicate text_delta after reconnect
      const preCrashStreamer = new TurnProgressStreamer()
      assert.equal(
        preCrashStreamer.consumeIncrementalFinalText('Hello ', { finalFlush: false }),
        'Hello ',
      )
      const exportedState = preCrashStreamer.exportState()
      const postCrashStreamer = new TurnProgressStreamer()
      postCrashStreamer.restoreState(exportedState)
      assert.equal(
        postCrashStreamer.consumeIncrementalFinalText('Hello world', { finalFlush: true }),
        'world',
      )

      // Verify BoxLoginSignalTap detects result even when >256KiB base64 outputAttachments arrive in 64KiB chunks
      const tap = new BoxLoginSignalTap()
      const hugeResultLine = `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sess-huge',
        result: 'ok',
        outputAttachments: [{ name: 'big.bin', base64: 'A'.repeat(320_000) }],
      })}\n`
      const allEnds = []
      for (let offset = 0; offset < hugeResultLine.length; offset += 65_536) {
        allEnds.push(...tap.push(hugeResultLine.slice(offset, offset + 65_536)))
      }
      assert.equal(allEnds.length, 1)

      // Verify stampGptWebTurnIdInUserLine stamps a stable ocTurnId across retries
      const rawUserLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } })}\n`
      const stamped1 = stampGptWebTurnIdInUserLine(rawUserLine)
      const stamped2 = stampGptWebTurnIdInUserLine(stamped1)
      assert.equal(stamped1, stamped2)
      const parsedFrame = parseStdinFrame(stamped1)
      assert.equal(parsedFrame?.kind, 'user')
      assert.ok(parsedFrame?.turnId)

      // Simulate mid-turn stream disconnect on attempt 1 followed by seamless resume on attempt 2
      const fifo = boxCcFifoPath(`gpt-web-reconnect-${Date.now()}`)
      const control: BoxCcControl = {
        execUrl: 'http://127.0.0.1:9999/exec',
        execToken: 'tok-exec',
        networkToken: 'tok-net',
        remoteClaude: '/home/box/.local/bin/claude',
        fifo,
        cwd: dir,
        accountId: 'selfhost-master',
      }
      const realMod = loadBoxGptWebMod()
      let interactiveExecCount = 0
      const seenTurnIds: string[] = []
      const reconnectHostMjs = `
import readline from 'node:readline'
import {
  TurnProgressStreamer,
  formatStreamJsonAssistantMessage,
  formatStreamJsonResult,
  formatStreamJsonSystemInit,
  formatStreamJsonTextDelta,
  formatStreamJsonThinkingDelta,
  parseStdinFrame,
} from './chatgptWebCore.mjs'

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const frame = parseStdinFrame(line)
  if (!frame || frame.kind !== 'user') return
  process.stderr.write('SEEN_TURN_ID:' + (frame.turnId || 'none') + '\\n')
  const streamer = new TurnProgressStreamer({ initialEmittedFinalText: frame.deliveredText || '' })
  process.stdout.write(formatStreamJsonSystemInit({ sessionId: 'sess-reconnect', model: 'box-gpt-6-astra-pro' }) + '\\n')
  if (process.env.FAKE_ATTEMPT === '1') {
    process.stdout.write(formatStreamJsonThinkingDelta('Still running in Chrome...') + '\\n')
    const d1 = streamer.consumeIncrementalFinalText('Recovered ', { finalFlush: false })
    process.stdout.write(formatStreamJsonTextDelta(d1) + '\\n')
    process.exit(1)
  }
  const tail = streamer.consumeIncrementalFinalText('Recovered final answer', { finalFlush: true })
  process.stdout.write(formatStreamJsonTextDelta(tail) + '\\n')
  process.stdout.write(formatStreamJsonAssistantMessage({ messageId: 'm_rec', text: 'Recovered final answer', thinking: '' }) + '\\n')
  process.stdout.write(formatStreamJsonResult({ sessionId: 'sess-reconnect', resultText: 'Recovered final answer', isError: false, durationMs: 120 }) + '\\n')
  process.exit(0)
})
`
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let outText = ''
      stdout.on('data', (c: Buffer) => {
        outText += c.toString('utf8')
      })
      stderr.on('data', (c: Buffer) => {
        for (const m of c.toString('utf8').matchAll(/SEEN_TURN_ID:([^\s]+)/g)) {
          seenTurnIds.push(m[1]!)
        }
      })

      const bridgePromise = runBoxCcBridge({
        control,
        args: ['--model', 'box-gpt-6-astra-pro', '--resume', 'sess-reconnect'],
        stdin,
        stdout,
        stderr,
        gptWebMod: {
          ...realMod,
          hostMjs: reconnectHostMjs,
        },
        env: {
          OC_USER_ID: '3',
          OC_BOX_LOGIN_URL: 'http://172.31.0.1:4098/internal/box/login',
        },
        loginStateDir: dir,
        fetchImpl: async (_url, init) => {
          const req = JSON.parse(
            Buffer.from(init.body as Uint8Array)
              .subarray(5)
              .toString('utf8'),
          ) as BoxCcExecRequest
          if (req.args.some((a) => a.includes('mkfifo'))) {
            interactiveExecCount += 1
            req.environment = {
              ...req.environment,
              FAKE_ATTEMPT: String(interactiveExecCount),
            }
          }
          return streamExecOnHost(req, init.signal ?? undefined)
        },
      })

      stdin.write(
        `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Long running task' },
        })}\n`,
      )
      const code = await bridgePromise
      assert.equal(code, 0)
      assert.equal(interactiveExecCount, 2)
      assert.equal(seenTurnIds.length, 2)
      assert.notEqual(seenTurnIds[0], 'none')
      assert.equal(seenTurnIds[0], seenTurnIds[1])
      assert.match(outText, /Still running in Chrome\.\.\./)
      const combinedTextDeltas = outText
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((f) => f.type === 'stream_event' && f.event?.delta?.type === 'text_delta')
        .map((f) => f.event.delta.text)
        .join('')
      assert.equal(combinedTextDeltas, 'Recovered final answer')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('mints UUID session ids accepted by cursorSandBoxCcResumeInnerId and preserves legacy gpt-web-pro ids', () => {
    const freshId = defaultGptWebSessionId()
    assert.match(freshId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.equal(
      cursorSandBoxCcResumeInnerId(`${CURSOR_SAND_BOX_CC_RESUME_PREFIX}${freshId}`),
      freshId,
    )
    assert.equal(
      cursorSandBoxCcResumeInnerId(`${CURSOR_SAND_BOX_CC_RESUME_PREFIX}gpt-web-pro-1792632309911`),
      'gpt-web-pro-1792632309911',
    )
    assert.equal(
      cursorSandBoxCcResumeInnerId(`${CURSOR_SAND_BOX_CC_RESUME_PREFIX}../evil`),
      undefined,
    )
  })

  it('skips hidden 0x0 duplicate Select ChatGPT model button on /c/<convId> and clicks visible composer switcher', async () => {
    let hiddenClicked = false
    let visibleClicked = false

    const hiddenSwitcher = {
      count: async () => 1,
      isVisible: async () => false,
      click: async () => {
        hiddenClicked = true
        throw new Error('Wait for hidden element timed out')
      },
      innerText: async () => 'Thinking effortPro',
    }
    const visibleSwitcher = {
      count: async () => 1,
      isVisible: async () => true,
      click: async () => {
        visibleClicked = true
      },
      innerText: async () => 'Pro',
    }
    const slider = {
      count: async () => 1,
      focus: async () => {},
      getAttribute: async (attr: string) =>
        attr === 'aria-valuenow' ? '4' : 'Pro - Research-grade intelligence',
      boundingBox: async () => ({ x: 100, y: 100, width: 200, height: 20 }),
    }
    const menu = {
      count: async () => 1,
      isVisible: async () => true,
      waitFor: async () => {},
      locator: (sel: string) => {
        if (sel === '[role="slider"]') return { first: () => slider }
        return { filter: () => ({ first: () => ({ count: async () => 0 }) }) }
      },
    }
    const fakePage = {
      evaluate: async () => [] as string[],
      locator: (sel: string) => {
        if (sel === '[data-testid="model-switcher-dropdown-button"]') {
          const empty = { count: async () => 0, isVisible: async () => false }
          return {
            count: async () => 0,
            first: () => empty,
            nth: () => empty,
          }
        }
        if (sel === 'button[aria-label="Select ChatGPT model"]') {
          const items = [hiddenSwitcher, visibleSwitcher]
          return {
            count: async () => items.length,
            first: () => items[0],
            nth: (idx: number) => items[idx],
          }
        }
        if (sel === '[role="menu"]') {
          return {
            count: async () => 1,
            first: () => menu,
            nth: () => menu,
          }
        }
        throw new Error(`Unexpected selector: ${sel}`)
      },
      keyboard: {
        press: async () => {},
      },
      mouse: {
        click: async () => {},
      },
    }

    const resolved = await resolveVisibleLocator(
      fakePage,
      'button[aria-label="Select ChatGPT model"]',
    )
    assert.equal(resolved, visibleSwitcher)

    const out = await selectProTierInPage(fakePage, { requestedTier: 'pro' })
    assert.equal(hiddenClicked, false)
    assert.equal(visibleClicked, true)
    assert.equal(out.tier, 'pro')
    assert.equal(out.sliderIndex, 4)

    // Verify resetComposerDraftInPage clears <textarea> drafts where innerText/textContent are ""
    const textareaEl = {
      value: 'old draft',
      innerText: '',
      textContent: '',
      dispatched: false,
      dispatchEvent() {
        this.dispatched = true
      },
    }
    const emptyProseMirrorEl = {
      innerText: '\n',
      textContent: '',
      innerHTML: '<p><br class="ProseMirror-trailingBreak"></p>',
      dispatched: false,
      dispatchEvent() {
        this.dispatched = true
      },
    }
    await resetComposerDraftInPage({
      evaluate: async (fn: () => void) => {
        const prevDoc = (globalThis as any).document
        ;(globalThis as any).document = {
          querySelectorAll: (sel: string) => {
            if (sel.startsWith('button')) return []
            return [textareaEl, emptyProseMirrorEl]
          },
        }
        try {
          fn()
        } finally {
          ;(globalThis as any).document = prevDoc
        }
      },
    })
    assert.equal(textareaEl.value, '')
    assert.equal(textareaEl.dispatched, true)
    assert.equal(emptyProseMirrorEl.innerHTML, '<p><br class="ProseMirror-trailingBreak"></p>')
    assert.equal(emptyProseMirrorEl.dispatched, false)
  })

  it('prevents premature empty finalization after stream_handoff and caches /api/auth/session tokens across mapping polls', async () => {
    // 1. When stream_handoff sets accDone=true with accFinalText="" and Stop button disappears,
    // resolveTurnCompletionDecision must wait during the grace window instead of finalizing ""
    const waitDecision = resolveTurnCompletionDecision({
      accDone: true,
      accFinalText: '',
      rescued: null,
      latestProg: { liveFinalText: '', finishedFinal: null },
      emittedFinalText: '',
      stopVisible: false,
      activeThinkingVisible: false,
      stopGoneSince: 1_000,
      now: 10_000,
      emptyDoneGraceMs: 45_000,
    })
    assert.equal(waitDecision.action, 'wait_grace')

    // 2. When rescueFromDomOrMapping finds the finished reply (e.g. 8161-char TeX report), finalize immediately
    const rescuedDecision = resolveTurnCompletionDecision({
      accDone: true,
      accFinalText: '',
      rescued: {
        text: '已完成完整技术方案 [atmospheric_phase_alignment.tex](sandbox:/workspace/scratch/out.tex)',
        messageId: '71e55f98-6bd2-58aa-8870-8a170e11423d',
        convId: '6ad97fc0-692c-83ec-8fea-7008ad6060c3',
      },
      latestProg: null,
      emittedFinalText: '',
      stopVisible: false,
      activeThinkingVisible: false,
      stopGoneSince: 1_000,
      now: 2_000,
    })
    assert.equal(rescuedDecision.action, 'finalize')
    assert.equal(rescuedDecision.source, 'rescue')
    assert.equal(rescuedDecision.messageId, '71e55f98-6bd2-58aa-8870-8a170e11423d')

    // 3. If liveFinalText is still growing (lastFinalTextGrowthAt within emptyDoneGraceMs or null),
    // must return wait_grace even after stopGoneSince exceeds emptyDoneGraceMs (including adaptive shouldRescue)
    const growingDecision = resolveTurnCompletionDecision({
      accDone: false,
      shouldRescue: true,
      accFinalText: '',
      rescued: null,
      latestProg: {
        liveFinalText: 'Still streaming in_progress text...',
        finishedFinal: null,
      },
      emittedFinalText: '',
      stopVisible: false,
      activeThinkingVisible: false,
      stopGoneSince: 1_000,
      lastFinalTextGrowthAt: 100_000,
      now: 110_000,
      emptyDoneGraceMs: 45_000,
    })
    assert.equal(growingDecision.action, 'wait_grace')

    // After BOTH stopGoneSince and lastFinalTextGrowthAt exceed the grace window, fall back to liveFinalText
    const partialDecision = resolveTurnCompletionDecision({
      accDone: true,
      accFinalText: '',
      rescued: null,
      latestProg: {
        liveFinalText: 'Partial buffered text with sandbox:/workspace/a.tex',
        finishedFinal: null,
      },
      emittedFinalText: '',
      stopVisible: false,
      activeThinkingVisible: false,
      stopGoneSince: 1_000,
      lastFinalTextGrowthAt: 2_000,
      now: 50_000,
      emptyDoneGraceMs: 45_000,
    })
    assert.equal(partialDecision.action, 'finalize')
    assert.equal(partialDecision.source, 'partial_fallback')
    assert.match(partialDecision.text || '', /Partial buffered text/)

    const errorEmptyDecision = resolveTurnCompletionDecision({
      accDone: true,
      accFinalText: '',
      rescued: null,
      latestProg: { liveFinalText: '', finishedFinal: null },
      emittedFinalText: '',
      stopVisible: false,
      activeThinkingVisible: false,
      stopGoneSince: 1_000,
      now: 50_000,
      emptyDoneGraceMs: 45_000,
    })
    assert.equal(errorEmptyDecision.action, 'error_empty')

    // 4. extractAssistantFromMapping supports allowInProgress fallback for settled in_progress final node
    const inProgressConv = {
      current_node: 'node-final',
      mapping: {
        'node-user': {
          id: 'node-user',
          parent: null,
          message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['Q'] } },
        },
        'node-final': {
          id: 'node-final',
          parent: 'node-user',
          message: {
            id: 'msg-final',
            author: { role: 'assistant' },
            status: 'in_progress',
            channel: 'final',
            content: { content_type: 'text', parts: ['Final TeX plan'] },
          },
        },
      },
    }
    assert.equal(extractAssistantFromMapping(inProgressConv), null)
    const rescuedInProgress = extractAssistantFromMapping(inProgressConv, { allowInProgress: true })
    assert.equal(rescuedInProgress?.text, 'Final TeX plan')
    assert.equal(rescuedInProgress?.messageId, 'msg-final')

    // 5. fetchConversationPayloadInPage caches /api/auth/session token and retries when /backend-api/conversation returns 404 conversation_inaccessible
    let authCalls = 0
    let convCalls = 0
    const mockWin: Record<string, any> = {}
    const fakePage = {
      evaluate: async (fn: (arg: any) => Promise<any>, arg: any) => {
        const prevWin = (globalThis as any).window
        const prevLoc = (globalThis as any).location
        const prevFetch = (globalThis as any).fetch
        ;(globalThis as any).window = mockWin
        ;(globalThis as any).location = { pathname: '/c/6ad97fc0-692c-83ec-8fea-7008ad6060c3' }
        ;(globalThis as any).fetch = async (url: string, init?: any) => {
          if (url === '/api/auth/session') {
            authCalls += 1
            return {
              ok: true,
              status: 200,
              json: async () => ({ accessToken: `tok-${authCalls}` }),
            }
          }
          if (url.startsWith('/backend-api/conversation/')) {
            convCalls += 1
            const authHeader = init?.headers?.Authorization || ''
            // Simulate first conversation call failing with 404 conversation_inaccessible when token is stale
            if (convCalls === 1) {
              return {
                ok: false,
                status: 404,
                json: async () => ({ detail: { code: 'conversation_inaccessible' } }),
              }
            }
            assert.equal(authHeader, `Bearer tok-${authCalls}`)
            return {
              ok: true,
              status: 200,
              json: async () => ({ current_node: 'node-final', mapping: {} }),
            }
          }
          throw new Error(`Unexpected fetch URL: ${url}`)
        }
        try {
          return await fn(arg)
        } finally {
          ;(globalThis as any).window = prevWin
          ;(globalThis as any).location = prevLoc
          ;(globalThis as any).fetch = prevFetch
        }
      },
    }

    const firstFetch = await fetchConversationPayloadInPage(fakePage, null, {
      retries: 2,
      tokenTtlMs: 240_000,
    })
    assert.equal(firstFetch.conv?.current_node, 'node-final')
    assert.equal(authCalls, 2) // 1st fetch + 1 refresh after 404
    assert.equal(convCalls, 2)

    // Subsequent poll reuses cached token without calling /api/auth/session again
    const secondFetch = await fetchConversationPayloadInPage(fakePage, null, {
      retries: 2,
      tokenTtlMs: 240_000,
    })
    assert.equal(secondFetch.conv?.current_node, 'node-final')
    assert.equal(authCalls, 2)
    assert.equal(convCalls, 3)
  })
})

// OCV5-584: ChatGPT Web inline citation markers leaked into GPT-6 Astra Pro replies as private-use glyphs + JSON.
describe('Box ChatGPT Web citation markers (OCV5-584)', () => {
  const O = ''
  const C = ''
  const S = ''
  const PUA = /[-]/
  const genui = (citation: object) => `${O}genui${S}${JSON.stringify({ citation })}${C}`
  const ref = (turn: number, type: string, index: number) => ({ turn_index: turn, ref_type: type, ref_index: index })
  const contentReferences = [
    {
      matched_text: genui({ ref: 'turn27view0' }),
      refs: [ref(27, 'view', 0)],
      items: [{ url: 'https://www.topcon.example/ms05axii', title: 'Topcon MS05AXII' }],
    },
  ]
  const searchGroups = [
    { entries: [{ url: 'https://sokkia.example/net05', title: 'Sokkia NET05AXII', ref_id: ref(30, 'search', 23) }] },
  ]
  const answer =
    `拓普康 0.5 mm+1 ppm。${genui({ ref: 'turn27view0' })}\n` +
    `| 索佳 | 0.5 mm+1 ppm ${genui({ refs: ['turn30search23', 'turn30search0'] })} |\n` +
    `出自 ${O}entity${S}["company","Topcon","Japanese maker"]${C}。${O}cite${S}turn9search1${C}完`

  /** Feeds SSE frames the way host.mjs does and returns every text_delta plus the final display text. */
  function streamThroughHost(frames: object[]) {
    const streamer = new TurnProgressStreamer()
    const deltas: string[] = []
    const acc = new SseAccumulator({
      onTextDelta: () => {
        streamer.citations.addSources(acc.citationSources)
        const delta = streamer.consumeIncrementalFinalText(acc.finalText, { finalFlush: false })
        if (delta) deltas.push(delta)
      },
    })
    for (const frame of frames) acc.feedDataLine(JSON.stringify(frame))
    streamer.citations.addSources(acc.citationSources)
    const tail = streamer.consumeIncrementalFinalText(acc.finalText, { finalFlush: true })
    if (tail) deltas.push(tail)
    return { deltas, final: streamer.emittedFinalText }
  }
  const snapshot = {
    v: { message: { id: 'm1', author: { role: 'assistant' }, channel: 'final', content: { content_type: 'text', parts: [''] } } },
  }
  /** Splits the answer into small appends, cutting markers in the middle (also inside the JSON). */
  const appends = (text: string, size: number) =>
    Array.from({ length: Math.ceil(text.length / size) }, (_, n) => ({
      p: '/message/content/parts/0',
      o: 'append',
      v: text.slice(n * size, n * size + size),
    }))

  it('OCV5-584 a citation marker with a known source renders as a numbered link', () => {
    const sources = collectChatgptCitationSources({ content_references: contentReferences, search_result_groups: searchGroups })
    const out = new ChatgptCitationRenderer({ sources }).render(answer, { final: true })
    assert.equal(
      out,
      '拓普康 0.5 mm+1 ppm。[1](https://www.topcon.example/ms05axii)\n' +
        '| 索佳 | 0.5 mm+1 ppm [2](https://sokkia.example/net05) |\n' +
        '出自 Topcon。完',
    )
    // a URL that would break the markdown link is percent-encoded; non-http sources are ignored
    const odd = collectChatgptCitationSources({
      content_references: [
        { refs: ['turn1search0'], items: [{ url: 'https://x.example/a (b)' }, { url: 'javascript:alert(1)' }] },
      ],
    })
    assert.equal(
      new ChatgptCitationRenderer({ sources: odd }).render(`a${O}cite${S}turn1search0${C}`, { final: true }),
      'a[1](https://x.example/a%20%28b%29)',
    )
  })

  it('OCV5-584 an unresolved citation marker and stray marker characters are removed', () => {
    const out = new ChatgptCitationRenderer().render(
      `${answer}${O}image_group${S}{"query":["x"]}${C} 尾${S}${C}`,
      { final: true },
    )
    assert.equal(out, '拓普康 0.5 mm+1 ppm。\n| 索佳 | 0.5 mm+1 ppm  |\n出自 Topcon。完 尾')
    assert.ok(!PUA.test(out))
    assert.ok(!out.includes('citation'))
    // ordinary text passes through unchanged
    assert.equal(new ChatgptCitationRenderer().render('plain [link](https://a.example) 文本'), 'plain [link](https://a.example) 文本')
  })

  it('OCV5-584 a marker split across SSE frames never reaches a text delta', () => {
    for (const size of [1, 2, 3, 7, 16]) {
      const { deltas, final } = streamThroughHost([
        snapshot,
        { p: '/message/metadata', o: 'add', v: { content_references: contentReferences, search_result_groups: searchGroups } },
        ...appends(answer, size),
        { type: 'message_stream_complete' },
      ])
      for (const d of deltas) {
        assert.ok(!PUA.test(d), `size ${size}: delta leaked ${JSON.stringify(d)}`)
        assert.ok(!d.includes('"citation"'), `size ${size}: delta leaked ${JSON.stringify(d)}`)
      }
      assert.equal(deltas.join(''), final)
      assert.ok(final.includes('[1](https://www.topcon.example/ms05axii)'), final)
      assert.ok(final.includes('[2](https://sokkia.example/net05)'), final)
      assert.ok(!final.includes('来源'), final)
    }
  })

  it('OCV5-584 sources that arrive after the text are listed once at the end', () => {
    const { deltas, final } = streamThroughHost([
      snapshot,
      ...appends(answer, 5),
      { p: '/message/metadata/content_references', o: 'append', v: contentReferences },
      { p: '/message/metadata', o: 'patch', v: [{ p: '/message/metadata/search_result_groups', o: 'append', v: searchGroups }] },
      { type: 'message_stream_complete' },
    ])
    assert.equal(deltas.join(''), final, 'what was streamed is never rewritten')
    assert.ok(!PUA.test(final))
    assert.ok(
      final.endsWith(
        '\n\n来源：\n1. [Topcon MS05AXII](https://www.topcon.example/ms05axii)\n2. [Sokkia NET05AXII](https://sokkia.example/net05)',
      ),
      final,
    )
  })

  it('OCV5-584 an unterminated marker is held while streaming and dropped at the end', () => {
    const streamer = new TurnProgressStreamer()
    const head = `结论${O}genui${S}{"citation":{"ref":"turn3`
    assert.equal(streamer.consumeIncrementalFinalText(head), '结论')
    assert.equal(streamer.consumeIncrementalFinalText(`${head}view0"}}`), '')
    assert.equal(streamer.consumeIncrementalFinalText(`${head}view0"}}`, { finalFlush: true }), '')
    assert.equal(streamer.emittedFinalText, '结论')
    // something that only starts like a marker is released as text once it is too long to be one
    const long = `a${O}${'x'.repeat(CHATGPT_MARKER_MAX_LEN + 1)}`
    const released = new TurnProgressStreamer().consumeIncrementalFinalText(long)
    assert.equal(released, `a${'x'.repeat(CHATGPT_MARKER_MAX_LEN + 1)}`)
  })

  it('OCV5-584 mapping progress takes sources only from the current reply', () => {
    const msg = (id: string, role: string, text: string, metadata: object = {}) => ({
      id,
      message: { id, author: { role }, channel: 'final', status: 'finished_successfully', content: { content_type: 'text', parts: [text] }, metadata },
    })
    const old = { content_references: [{ refs: [ref(0, 'search', 0)], items: [{ url: 'https://old.example/' }] }] }
    const now = { content_references: [{ refs: [ref(0, 'search', 1)], items: [{ url: 'https://new.example/' }] }] }
    const conv = {
      current_node: 'a2',
      mapping: {
        u1: { ...msg('u1', 'user', 'q1'), parent: null },
        a1: { ...msg('a1', 'assistant', 'old', old), parent: 'u1' },
        u2: { ...msg('u2', 'user', 'q2'), parent: 'a1' },
        a2: { ...msg('a2', 'assistant', `新${O}cite${S}turn0search0${S}turn0search1${C}`, now), parent: 'u2' },
      },
    }
    const prog = extractTurnProgressFromMapping(conv, { baselineNodeId: 'a1' })
    assert.deepEqual([...prog.citationSources.keys()], ['turn0search1'])
    const streamer = new TurnProgressStreamer()
    const { textDeltas } = streamer.ingestMappingProgress(prog)
    assert.deepEqual(textDeltas, ['新[1](https://new.example/)'])
  })

  it('OCV5-584 a reconnect keeps what the previous host already delivered', () => {
    const sources = collectChatgptCitationSources({
      content_references: [
        { refs: ['turn0search0'], items: [{ url: 'https://s0.example/' }] },
        { refs: ['turn0search1'], items: [{ url: 'https://s1.example/' }] },
        { refs: ['turn0search9'], items: [{ url: 'https://z.example/' }] },
      ],
    })
    // delivered while the source was unknown: the stripped marker is not turned into a link afterwards
    const before = new TurnProgressStreamer()
    const raw = `结论${O}cite${S}turn0search0${C}。`
    assert.equal(before.consumeIncrementalFinalText(raw), '结论。')
    const after = new TurnProgressStreamer({ initialEmittedFinalText: before.emittedFinalText })
    after.citations.addSources(sources)
    const more = `${raw}后文${O}cite${S}turn0search1${C}`
    assert.equal(after.consumeIncrementalFinalText(more), '后文[1](https://s1.example/)')
    assert.equal(
      after.consumeIncrementalFinalText(more, { finalFlush: true }),
      '\n\n来源：\n2. [https://s0.example/](https://s0.example/)',
    )
    // delivered as links: kept with their numbers, the next citation continues the numbering
    const first = new TurnProgressStreamer()
    first.citations.addSources(sources)
    const linked = `x${O}cite${S}turn0search9${C}y${O}cite${S}turn0search0${C}`
    assert.equal(first.consumeIncrementalFinalText(linked), 'x[1](https://z.example/)y[2](https://s0.example/)')
    const resumed = new TurnProgressStreamer({ initialEmittedFinalText: first.emittedFinalText })
    assert.equal(
      resumed.consumeIncrementalFinalText(`${linked}z${O}cite${S}turn0search1${C}`, { finalFlush: true }),
      'z',
    )
  })

  it('OCV5-584 a citation marker longer than 4096 chars is still parsed, never leaked', () => {
    const refs = Array.from({ length: 300 }, (_, n) => `turn0search${n}`)
    const long = `前${genui({ refs })}后`
    assert.ok(long.length > 5000)
    const streamer = new TurnProgressStreamer()
    streamer.citations.addSources(
      collectChatgptCitationSources({ content_references: [{ refs: ['turn0search7'], items: [{ url: 'https://s7.example/' }] }] }),
    )
    const deltas: string[] = []
    for (let at = 11; at < long.length + 11; at += 11) deltas.push(streamer.consumeIncrementalFinalText(long.slice(0, at)))
    deltas.push(streamer.consumeIncrementalFinalText(long, { finalFlush: true }))
    for (const d of deltas) assert.ok(!PUA.test(d) && !d.includes('citation'), JSON.stringify(d))
    assert.equal(deltas.join(''), '前[1](https://s7.example/)后')
    // text that cannot be a marker head is released at once, without the private-use char
    assert.equal(new TurnProgressStreamer().consumeIncrementalFinalText(`a${O}not a marker`), 'anot a marker')
  })

  it('OCV5-584 adjacent citations delivered before a reconnect keep their own links', () => {
    const ab = collectChatgptCitationSources({
      content_references: [
        { refs: ['turn0search0'], items: [{ url: 'https://a.example/' }] },
        { refs: ['turn0search1'], items: [{ url: 'https://b.example/' }] },
      ],
    })
    const raw = `结论${O}cite${S}turn0search0${C}${O}cite${S}turn0search1${C}。`
    const first = new TurnProgressStreamer()
    first.citations.addSources(ab)
    assert.equal(first.consumeIncrementalFinalText(raw), '结论[1](https://a.example/)[2](https://b.example/)。')
    const more = `${raw}后文`
    // renderer state lost: each marker claims only its own links (sources known, or one per ref when not)
    for (const sources of [ab, null]) {
      const resumed = new TurnProgressStreamer({ initialEmittedFinalText: first.emittedFinalText })
      resumed.citations.addSources(sources)
      assert.equal(resumed.consumeIncrementalFinalText(more), '后文')
      assert.equal(resumed.consumeIncrementalFinalText(more, { finalFlush: true }), '')
    }
    // the persisted state (JSON, as host.mjs saves it with the active turn) restores the exact rendering
    const saved = JSON.parse(JSON.stringify(first.exportState().citations))
    const restored = new TurnProgressStreamer({ initialEmittedFinalText: first.emittedFinalText })
    restored.citations.restoreState(saved)
    restored.citations.addSources(ab)
    assert.equal(restored.consumeIncrementalFinalText(`${more}${O}cite${S}turn0search1${C}`, { finalFlush: true }), '后文[2](https://b.example/)')
  })
})
