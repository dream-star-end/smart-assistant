import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import {
  SerialJobQueue,
  SseAccumulator,
  TierLimitError,
  buildChromeLaunchArgs,
  computeAdaptiveDeadline,
  detectTierLimit,
  extractAssistantFromMapping,
  extractUserTurnFromStdinFrame,
  levelIndex,
  probeSessionState,
  profileDirFor,
  selectProTierInPage,
  stripTierCaption,
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
  isBoxGptWebModelArgv,
  loadBoxGptWebMod,
  remoteInteractiveGptWebArgs,
  validateBoxGptWebLoopbackProxy,
} from '../engine/cursorBoxGptWeb.js'
import { masterBoxCredentialSelection } from '../engine/cursorCredentialSelection.js'
import { cursorVariantFor } from '../engine/cursorRoutingAdapter.js'

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
  it('validates persistent profile paths, real Chrome launch args, and local-only proxy rules (rejecting 18991/19095)', () => {
    assert.equal(profileDirFor('default', '/home/box'), '/home/box/.chatgpt-pro-default')
    assert.equal(profileDirFor('acct-2', '/home/box'), '/home/box/.chatgpt-pro-acct-2')
    assert.throws(() => profileDirFor('../escape', '/home/box'), /Invalid ChatGPT Web profile/)

    assert.equal(validateLocalOnlyProxy(null), null)
    assert.equal(validateLocalOnlyProxy(''), null)
    assert.equal(validateLocalOnlyProxy('http://127.0.0.1:18992'), 'http://127.0.0.1:18992')
    assert.equal(validateLocalOnlyProxy('socks5://localhost:18993'), 'socks5://localhost:18993')
    assert.equal(validateBoxGptWebLoopbackProxy('http://127.0.0.1:18992'), 'http://127.0.0.1:18992')

    // Reject non-loopback proxies
    assert.throws(
      () => validateLocalOnlyProxy('http://192.168.10.223:18992'),
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
    assert.equal(
      defaultArgs.some((a: string) => a.startsWith('--proxy-server=')),
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

  it('serializes single-tab turns via SerialJobQueue and cross-process file lock', async () => {
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
      job('turn1', 25, false),
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
      const lockEvents: string[] = []
      await Promise.all([
        withProfileFileLock(lockPath, async () => {
          lockEvents.push('a:in')
          await new Promise((r) => setTimeout(r, 30))
          lockEvents.push('a:out')
        }),
        withProfileFileLock(lockPath, async () => {
          lockEvents.push('b:in')
          lockEvents.push('b:out')
        }),
      ])
      assert.deepEqual(lockEvents, ['a:in', 'a:out', 'b:in', 'b:out'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when browser session is not logged in or hits Cloudflare challenge', async () => {
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
    assert.match(probeOut.message, /noVNC port 6080/)

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

  it('uploads attachments atomically and types multiline text with Shift+Enter without clearing attachments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-gpt-web-upload-'))
    const sampleFile = join(dir, 'diagram.png')
    writeFileSync(sampleFile, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))

    try {
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
          // First poll has spinner=1, second poll has spinner=0 and chips=1
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

      const up = await uploadAttachmentsToComposer(mockPage, [sampleFile], {
        timeoutMs: 2_000,
        pollMs: 10,
      })
      assert.equal(up.uploadedCount, 1)
      assert.deepEqual(uploadedFiles, [sampleFile])
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

  it('accumulates delta-encoded SSE frames and strictly separates thoughts/reasoning_recap from final text', () => {
    const thinkingChunks: string[] = []
    const textChunks: string[] = []
    const acc = new SseAccumulator({
      onThinkingDelta: (d: string) => thinkingChunks.push(d),
      onTextDelta: (d: string) => textChunks.push(d),
    })

    // 1. Reasoning thoughts message snapshot + delta append
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

    // 2. Reasoning recap (must not leak into finalText)
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

    // 3. Final assistant message snapshot + delta JSON-Patch appends
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
    assert.equal(acc.finalText, 'Hello from GPT-6 Astra Pro!')
    assert.deepEqual(textChunks, ['Hello ', 'from GPT-6 ', 'Astra Pro!'])
    assert.equal(
      thinkingChunks.join(''),
      'Analyzing architecture... Checking P3 layer invariants.Thought for 4m 12s',
    )

    // Verify mapping tree fallback skips thoughts/recap and extracts final assistant text
    const extracted = extractAssistantFromMapping({
      current_node: 'node-3',
      mapping: {
        'node-1': {
          parent: null,
          message: {
            id: 'm1',
            author: { role: 'assistant' },
            channel: 'thoughts',
            content: { content_type: 'thoughts', parts: ['secret thought'] },
          },
        },
        'node-2': {
          parent: 'node-1',
          message: {
            id: 'm2',
            author: { role: 'assistant' },
            channel: 'final',
            content: { content_type: 'text', parts: ['Rescued final answer'] },
          },
        },
        'node-3': {
          parent: 'node-2',
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
  })

  it('extends adaptive deadline up to 20m while Pro is actively thinking and triggers Stream-Rescue when stop-button disappears without final text', () => {
    const t0 = 1_000_000
    // At 10m (600s), stop button is still visible and SSE activity happened 30s ago -> extend by +120s
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

    // At 20m (1200s) hard ceiling -> no further extension, expired = true
    const stepCeiling = computeAdaptiveDeadline({
      startedAt: t0,
      now: t0 + 1_200_000,
      lastActivityAt: t0 + 1_190_000,
      stopVisible: true,
      currentDeadline: t0 + 1_200_000,
    })
    assert.equal(stepCeiling.extended, false)
    assert.equal(stepCeiling.expired, true)

    // Stop button disappeared 95s ago without final text -> triggers Stream-Rescue
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

  it('routes box-gpt-6-astra-pro through cursorRoutingAdapter and runBoxCcBridge over FIFO stream-json', async () => {
    assert.equal(isBoxGptWebCatalogModel('box-gpt-6-astra-pro'), true)
    assert.equal(isBoxClaudeCatalogModel('box-gpt-6-astra-pro'), false)
    assert.equal(isBoxInteractiveCatalogModel('box-gpt-6-astra-pro'), true)
    assert.equal(isBoxGptWebModelArgv(['--model', 'box-gpt-6-astra-pro']), true)
    assert.deepEqual(
      remoteInteractiveGptWebArgs(['--model', 'box-gpt-6-astra-pro', '--resume', 'sess-42']),
      ['--model', 'gpt-6-astra-pro', '--resume', 'sess-42'],
    )

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

    // Parse user turn with attachments from Route B stdin frame
    const parsedTurn = extractUserTurnFromStdinFrame(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this diagram' },
            { type: 'image', path: '/tmp/arch.png' },
          ],
        },
      }),
    )
    assert.deepEqual(parsedTurn, {
      text: 'Analyze this diagram',
      files: ['/tmp/arch.png'],
    })

    // End-to-end runBoxCcBridge test using real BOX_GPT_WEB_INTERACTIVE_LAUNCH_SCRIPT
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
  extractUserTurnFromStdinFrame,
  formatStreamJsonAssistantMessage,
  formatStreamJsonResult,
  formatStreamJsonSystemInit,
  formatStreamJsonTextDelta,
  formatStreamJsonThinkingDelta,
} from './chatgptWebCore.mjs'

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let first = true
for await (const line of rl) {
  const turn = extractUserTurnFromStdinFrame(line)
  if (!turn) continue
  if (first) {
    first = false
    process.stdout.write(formatStreamJsonSystemInit({ sessionId: 'sess-gpt-web', model: 'box-gpt-6-astra-pro' }) + '\\n')
  }
  if (turn.text === 'PROBE_LOGGED_OUT') {
    const msg = '[box-gpt-6-astra-pro] ChatGPT Pro session is not logged in inside Box profile /home/box/.chatgpt-pro-default (DISPLAY=:1).'
    process.stdout.write(formatStreamJsonAssistantMessage({ messageId: 'm_err', text: msg }) + '\\n')
    process.stdout.write(formatStreamJsonResult({ sessionId: 'sess-gpt-web', resultText: msg, isError: true, durationMs: 12 }) + '\\n')
    process.exit(0)
  }
  process.stdout.write(formatStreamJsonThinkingDelta('Deep Pro synthesis...') + '\\n')
  process.stdout.write(formatStreamJsonTextDelta('Answer: ' + turn.text) + '\\n')
  process.stdout.write(formatStreamJsonAssistantMessage({ messageId: 'm_ok', text: 'Answer: ' + turn.text, thinking: 'Deep Pro synthesis...' }) + '\\n')
  process.stdout.write(formatStreamJsonResult({ sessionId: 'sess-gpt-web', resultText: 'Answer: ' + turn.text, isError: false, durationMs: 45 }) + '\\n')
  process.exit(0)
}
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
