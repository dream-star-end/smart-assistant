import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'

import { signJwt } from '../auth.js'
import {
  VOICE_WS_PATH,
  buildDeepgramListenUrl,
  createVoiceTranscribeHandler,
  joinTranscriptSegments,
  parseVoicePolishText,
  sanitizeVoiceStartPayload,
} from '../voiceTranscribe.js'

const SECRET = 'voice-test-secret-voice-test-secret-32'
const voiceSource = readFileSync(resolve(import.meta.dirname, '..', 'voiceTranscribe.ts'), 'utf-8')
const serverSource = readFileSync(resolve(import.meta.dirname, '..', 'server.ts'), 'utf-8')
const openHandlers: Array<{ shutdown(): Promise<void> }> = []
const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  while (openHandlers.length) await openHandlers.pop()!.shutdown()
  while (servers.length) {
    const s = servers.pop()!
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

function makeToken(userId = 'u123'): string {
  return signJwt({ userId, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)
}

async function listenWith(
  overrides: Partial<Parameters<typeof createVoiceTranscribeHandler>[0]> = {},
): Promise<string> {
  const server = createServer()
  servers.push(server)
  const handler = createVoiceTranscribeHandler({ accessToken: SECRET, ...overrides })
  openHandlers.push(handler)
  server.on('upgrade', (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  return `ws://127.0.0.1:${addr.port}`
}

function recvJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data))))
  })
}

function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(ctrl) {
        for (const chunk of chunks) ctrl.enqueue(enc.encode(chunk))
        ctrl.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('voiceTranscribe helpers', () => {
  test('sanitizes context and keyterms within bounded budgets', () => {
    const raw = {
      mimeType: 'audio/webm; codecs=opus',
      context: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        text: `消息${i} `.repeat(200),
      })),
      keyterms: ['OpenClaude', 'openclaude', 'DeepSeek V4 Flash', '\nVLBI\t', 'x'.repeat(200)],
    }
    const got = sanitizeVoiceStartPayload(raw)
    assert.equal(got.mimeType, 'audio/webm;codecs=opus')
    assert.ok(got.context.length <= 12)
    assert.ok(got.context.every((m) => m.text.length <= 1000))
    assert.deepEqual(got.keyterms.slice(0, 3), ['OpenClaude', 'DeepSeek V4 Flash', 'VLBI'])
    assert.equal(got.keyterms.at(-1)?.length, 80)
  })

  test('builds Deepgram Nova-3 URL with repeated keyterm and no raw-audio encoding params', () => {
    const url = new URL(
      buildDeepgramListenUrl({
        model: 'nova-3',
        language: 'zh-CN',
        keyterms: ['VieVS', 'GJBZ 171-2013'],
      }),
    )
    assert.equal(url.protocol, 'wss:')
    assert.equal(url.hostname, 'api.deepgram.com')
    assert.equal(url.searchParams.get('model'), 'nova-3')
    assert.equal(url.searchParams.get('language'), 'zh-CN')
    assert.deepEqual(url.searchParams.getAll('keyterm'), ['VieVS', 'GJBZ 171-2013'])
    assert.equal(url.searchParams.has('encoding'), false)
    assert.equal(url.searchParams.has('sample_rate'), false)
  })

  test('parses strict DeepSeek polish JSON and falls back on invalid output', () => {
    assert.deepEqual(
      parseVoicePolishText(
        '{"text":"OpenClaude worktree","changed":true,"confidence":0.92}',
        'raw',
      ),
      { text: 'OpenClaude worktree', changed: true, confidence: 0.92 },
    )
    assert.deepEqual(parseVoicePolishText('not json', 'raw text'), {
      text: 'raw text',
      changed: false,
      confidence: 0,
      skipped: true,
    })
  })

  test('joins final Deepgram segments without corrupting English or Chinese text', () => {
    assert.equal(joinTranscriptSegments(['hello', 'world']), 'hello world')
    assert.equal(joinTranscriptSegments(['改商业版', '把']), '改商业版把')
    assert.equal(joinTranscriptSegments(['DeepSeek', 'V4 Flash', '模型']), 'DeepSeek V4 Flash 模型')
    assert.equal(joinTranscriptSegments(['你好', '，', 'OpenClaude']), '你好，OpenClaude')
  })

  test('keeps the browser microphone permission enabled for same-origin WebChat', () => {
    assert.match(
      serverSource,
      /microphone=\(self\)/,
      'voice input needs same-origin microphone permission',
    )
    assert.doesNotMatch(
      serverSource,
      /microphone=\(\)/,
      'global permissions policy must not disable microphone access',
    )
  })

  test('guards prewarmed Deepgram sessions before first audio', () => {
    assert.match(
      voiceSource,
      /const DEFAULT_NO_AUDIO_TIMEOUT_MS = 20_000/,
      'prewarmed upstream sessions should have a bounded no-audio lifetime',
    )
    assert.match(
      voiceSource,
      /const noAudioTimeoutMs = clampInt\([\s\S]*deps\.noAudioTimeoutMs,[\s\S]*DEFAULT_NO_AUDIO_TIMEOUT_MS,[\s\S]*5_000,[\s\S]*60_000,[\s\S]*\)/,
      'no-audio timeout should be configurable but bounded',
    )
    assert.match(
      voiceSource,
      /noAudioTimer = setTimeout\(\(\) => \{[\s\S]*VOICE_NO_AUDIO_TIMEOUT/,
      'Deepgram ready should arm a no-audio timeout',
    )
    assert.match(
      voiceSource,
      /if \(!receivedAudio\) \{[\s\S]*startMaxTimer\(\)/,
      'recording max duration should start on the first audio frame',
    )
  })
})

describe('voiceTranscribe websocket', () => {
  test('coexists with the main /ws websocket path and rejects query-token auth', async () => {
    const server = createServer()
    servers.push(server)
    const chatWss = new WebSocketServer({ noServer: true })
    chatWss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'chat_ready' })))
    const h = createVoiceTranscribeHandler({ accessToken: SECRET })
    openHandlers.push(h)
    server.on('upgrade', (req, socket, head) => {
      if (h.handleUpgrade(req, socket, head)) return
      const pathname = new URL(req.url || '/', 'http://placeholder').pathname
      if (pathname === '/ws') {
        chatWss.handleUpgrade(req, socket, head, (ws) => chatWss.emit('connection', ws, req))
        return
      }
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    const base = `ws://127.0.0.1:${addr.port}`

    const chat = new WebSocket(`${base}/ws`, ['bearer', makeToken()])
    assert.equal((await recvJson(chat)).type, 'chat_ready')
    chat.close()

    const ws = new WebSocket(`${base}${VOICE_WS_PATH}?token=leaky`)
    const msg = await recvJson(ws)
    assert.equal(msg.type, 'error')
    assert.equal(msg.code, 'UNAUTHORIZED')
    chatWss.close()
  })

  test('authenticated start without Deepgram key returns VOICE_NOT_CONFIGURED', async () => {
    const base = await listenWith()
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ['bearer', makeToken()])
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'start', mimeType: 'audio/webm;codecs=opus' })),
    )
    const msg = await recvJson(ws)
    assert.equal(msg.type, 'error')
    assert.equal(msg.code, 'VOICE_NOT_CONFIGURED')
  })

  test('connects Deepgram with Authorization header and WebM content type', async () => {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    class FakeDeepgram extends EventEmitter {
      readyState: number = WebSocket.CONNECTING
      send() {}
      close() {
        this.readyState = WebSocket.CLOSED
        this.emit('close')
      }
    }
    let fake: FakeDeepgram
    const base = await listenWith({
      deepgramApiKey: 'dg_secret',
      deepseekApiKey: 'ds_secret',
      createDeepgramSocket: (url, options) => {
        capturedUrl = url
        capturedHeaders = options.headers
        fake = new FakeDeepgram()
        setImmediate(() => {
          fake.readyState = WebSocket.OPEN
          fake.emit('open')
        })
        return fake as unknown as WebSocket
      },
    })
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ['bearer', makeToken()])
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'start',
          mimeType: 'audio/webm;codecs=opus',
          keyterms: ['OpenClaude'],
        }),
      ),
    )
    const msg = await recvJson(ws)
    assert.equal(msg.type, 'ready')
    assert.equal(capturedHeaders.Authorization, 'Token dg_secret')
    assert.equal(capturedHeaders['Content-Type'], 'audio/webm;codecs=opus')
    const url = new URL(capturedUrl)
    assert.equal(url.searchParams.get('keyterm'), 'OpenClaude')
    assert.equal(url.searchParams.has('encoding'), false)
    ws.close()
  })

  test('closes prewarmed Deepgram sockets when no audio arrives', async () => {
    class FakeDeepgram extends EventEmitter {
      readyState: number = WebSocket.CONNECTING
      send() {}
      close() {
        if (this.readyState === WebSocket.CLOSED) return
        this.readyState = WebSocket.CLOSED
        this.emit('close')
      }
    }
    const base = await listenWith({
      deepgramApiKey: 'dg_secret',
      deepseekApiKey: 'ds_secret',
      noAudioTimeoutMs: 5_000,
      createDeepgramSocket: () => {
        const fake = new FakeDeepgram()
        setImmediate(() => {
          fake.readyState = WebSocket.OPEN
          fake.emit('open')
        })
        return fake as unknown as WebSocket
      },
    })
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ['bearer', makeToken()])
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'start', mimeType: 'audio/webm;codecs=opus' })),
    )
    assert.equal((await recvJson(ws)).type, 'ready')
    const msg = await recvJson(ws)
    assert.equal(msg.type, 'error')
    assert.equal(msg.code, 'VOICE_NO_AUDIO_TIMEOUT')
  })

  test('shutdown closes active voice connections and releases limiter slots', async () => {
    class FakeDeepgram extends EventEmitter {
      readyState: number = WebSocket.CONNECTING
      send() {}
      close() {
        if (this.readyState === WebSocket.CLOSED) return
        this.readyState = WebSocket.CLOSED
        this.emit('close')
      }
    }
    const server = createServer()
    servers.push(server)
    const h = createVoiceTranscribeHandler({
      accessToken: SECRET,
      deepgramApiKey: 'dg_secret',
      createDeepgramSocket: () => {
        const fake = new FakeDeepgram()
        setImmediate(() => {
          fake.readyState = WebSocket.OPEN
          fake.emit('open')
        })
        return fake as unknown as WebSocket
      },
    })
    openHandlers.push(h)
    server.on('upgrade', (req, socket, head) => {
      if (!h.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}${VOICE_WS_PATH}`, ['bearer', makeToken()])
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'start', mimeType: 'audio/webm;codecs=opus' })),
    )
    assert.equal((await recvJson(ws)).type, 'ready')
    assert.equal(h.activeCount(), 1)
    await h.shutdown('test shutdown')
    assert.equal(h.activeCount(), 0)
  })

  test('streams plain polish_delta frames before the final authoritative polish', async () => {
    class FakeDeepgram extends EventEmitter {
      readyState: number = WebSocket.CONNECTING
      send(data?: unknown) {
        if (typeof data !== 'string' || !data.includes('CloseStream')) return
        this.emit(
          'message',
          JSON.stringify({
            type: 'Results',
            is_final: true,
            speech_final: true,
            start: 0,
            channel: { alternatives: [{ transcript: '晚上好亚，你在干什么', confidence: 0.87 }] },
          }),
        )
        this.close()
      }
      close() {
        this.readyState = WebSocket.CLOSED
        this.emit('close')
      }
    }

    const base = await listenWith({
      deepgramApiKey: 'dg_secret',
      deepseekApiKey: 'ds_secret',
      createDeepgramSocket: () => {
        const fake = new FakeDeepgram()
        setImmediate(() => {
          fake.readyState = WebSocket.OPEN
          fake.emit('open')
        })
        return fake as unknown as WebSocket
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'))
        assert.equal(body.stream, true)
        assert.match(body.system, /不输出 JSON/)
        return streamResponse([
          `event: content_block_delta\r\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '晚上好呀' } })}\r\n\r\n`,
          `event: content_block_delta\r\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '，你在干什么？' } })}\r\n\r\n`,
          'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
        ])
      },
    })
    const ws = new WebSocket(`${base}${VOICE_WS_PATH}`, ['bearer', makeToken()])
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'start', mimeType: 'audio/webm;codecs=opus' })),
    )
    assert.equal((await recvJson(ws)).type, 'ready')
    const framesP = new Promise<Record<string, unknown>[]>((resolve) => {
      const frames: Record<string, unknown>[] = []
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>
        frames.push(msg)
        if (msg.type === 'polish') resolve(frames)
      })
    })
    ws.send(JSON.stringify({ type: 'stop' }))

    const frames = await framesP
    const deltas = frames.filter((m) => m.type === 'polish_delta')
    assert.ok(deltas.length >= 1, 'expected at least one streaming polish_delta frame')
    assert.equal(deltas.at(-1)?.text, '晚上好呀，你在干什么？')
    assert.doesNotMatch(
      String(deltas.at(-1)?.text),
      /[{}]/,
      'polish_delta must not expose JSON fragments',
    )
    const final = frames.at(-1)
    assert.equal(final?.type, 'polish')
    assert.equal(final?.text, '晚上好呀，你在干什么？')
    assert.equal(final?.changed, true)
  })
})
