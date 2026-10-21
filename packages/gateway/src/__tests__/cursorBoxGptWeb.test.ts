import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import {
  SerialJobQueue,
  SseAccumulator,
  TierLimitError,
  buildChromeLaunchArgs,
  cdpPortForProfile,
  computeAdaptiveDeadline,
  detectTierLimit,
  extractAssistantFromMapping,
  extractInboundDispatchAttachments,
  extractUserTurnFromStdinFrame,
  isChatGptOriginUrl,
  levelIndex,
  loadSessionConversationMap,
  parseStdinFrame,
  probeSessionState,
  profileDirFor,
  readProfileSingletonOwner,
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
  type BoxCcControl,
  type BoxCcExecRequest,
  type ExecFrame,
  boxCcFifoPath,
  cursorBoxCcFromMaster,
  isBoxClaudeCatalogModel,
  isBoxGptWebCatalogModel,
  isBoxInteractiveCatalogModel,
} from '../engine/cursorBoxCc.js'
import { runBoxCcBridge } from '../engine/cursorBoxCcBridge.js'
import {
  boxGptWebInteractiveLaunchExec,
  inlineGptWebAttachmentsInUserLine,
  isBoxGptWebModelArgv,
  loadBoxGptWebMod,
  remoteInteractiveGptWebArgs,
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

  it('extends adaptive deadline up to 20m while Pro is actively thinking and triggers Stream-Rescue when stop-button disappears without final text', () => {
    const t0 = 1_000_000
    const step1 = computeAdaptiveDeadline({
      startedAt: t0,
      now: t0 + 600_000,
      lastActivityAt: t0 + 570_000,
      stopVisible: true,
      currentDeadline: t0 + 600_000,
    })
    assert.equal(step1.extended, true)
    assert.equal(step1.expired, false)
    assert.equal(step1.deadline, t0 + 720_000)

    const stepCeiling = computeAdaptiveDeadline({
      startedAt: t0,
      now: t0 + 1_200_000,
      lastActivityAt: t0 + 1_190_000,
      stopVisible: true,
      currentDeadline: t0 + 1_200_000,
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
        env: {},
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
})
