import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import type {
  QQBotInboundMessage,
  QQBotOptions,
  ReplyTarget,
} from '@tencent-connect/qqbot-nodejs'
import type { Pool } from 'pg'

import {
  QQ_GROUP_AND_C2C_INTENTS,
  makeQqBotService,
} from '../qqbot/service.js'
import type { startQqOutboxWorker } from '../qqbot/outbox.js'
import type { InboundDispatcher } from '../wechat/inboundDispatcher.js'

class FakeBot extends EventEmitter {
  terminal = false
  stopped = false
  readonly sentTexts: string[] = []
  readonly sentMedia: unknown[] = []
  private settleStart!: () => void
  private readonly running = new Promise<void>((resolve) => {
    this.settleStart = resolve
  })

  constructor(private readonly mode: 'ready' | 'error' | 'error-stuck' = 'ready') {
    super()
  }

  async start(): Promise<void> {
    queueMicrotask(() => {
      if (this.mode === 'ready') this.emit('ready', {})
      else this.emit('error', new Error('startup failed'))
    })
    return this.running
  }

  stop(): void {
    this.stopped = true
    if (this.mode !== 'error-stuck') this.settleStart()
  }

  async sendText(_target: ReplyTarget, text: string): Promise<unknown> {
    this.sentTexts.push(text)
    return {}
  }

  async sendMedia(options: unknown): Promise<unknown> {
    this.sentMedia.push(options)
    return {}
  }
}

test('QQ outbox adapter maps image, video, voice and file to SDK media uploads', async () => {
  const bot = new FakeBot()
  let workerArgs: Parameters<typeof startQqOutboxWorker>[0] | undefined
  const service = makeQqBotService({
    pool: {} as Pool,
    config: qqConfig(),
    dispatcher: {} as InboundDispatcher,
    botFactory: () => bot as unknown as import('@tencent-connect/qqbot-nodejs').QQBot,
    outboxWorkerFactory: (args) => {
      workerArgs = args
      return { kick() {}, async stop() {} }
    },
    gatewayTerminal: () => false,
  })

  await service.start()
  assert.ok(workerArgs?.sendMedia)
  for (const kind of ['image', 'video', 'voice', 'file'] as const) {
    await workerArgs.sendMedia('openid-1', {
      kind,
      filename: `${kind}.bin`,
      content: Buffer.from(kind),
    })
  }
  assert.deepEqual(
    bot.sentMedia.map((value) => {
      const item = value as {
        target: ReplyTarget
        fileType: number
        buffer: Buffer
        fileName: string
      }
      return {
        target: item.target,
        fileType: item.fileType,
        content: item.buffer.toString(),
        fileName: item.fileName,
      }
    }),
    [
      {
        target: { scope: 'c2c', targetId: 'openid-1' },
        fileType: 1,
        content: 'image',
        fileName: 'image.bin',
      },
      {
        target: { scope: 'c2c', targetId: 'openid-1' },
        fileType: 2,
        content: 'video',
        fileName: 'video.bin',
      },
      {
        target: { scope: 'c2c', targetId: 'openid-1' },
        fileType: 3,
        content: 'voice',
        fileName: 'voice.bin',
      },
      {
        target: { scope: 'c2c', targetId: 'openid-1' },
        fileType: 4,
        content: 'file',
        fileName: 'file.bin',
      },
    ],
  )
  await service.stop()
})

test('QQ gateway requests only C2C intent and fully recreates a terminal SDK generation', async () => {
  const options: QQBotOptions[] = []
  const bots: FakeBot[] = []
  const service = makeQqBotService({
    pool: {} as Pool,
    config: {
      appId: 'app',
      appSecret: 'secret',
      entryUrl: 'https://example.test/bot',
      bindingHmacSecret: 'binding-secret',
    },
    dispatcher: {} as InboundDispatcher,
    botFactory: (value) => {
      options.push(value)
      const bot = new FakeBot()
      bots.push(bot)
      return bot as unknown as import('@tencent-connect/qqbot-nodejs').QQBot
    },
    outboxWorkerFactory: () => ({
      kick() {},
      async stop() {},
    }),
    gatewayTerminal: (bot) => (bot as unknown as FakeBot).terminal,
    gatewayHealthPollMs: 5,
    restartDelayMs: 5,
    onFatal: (reason, err) => {
      throw new Error(`${reason}: ${String(err)}`)
    },
  })

  await service.start()
  assert.equal(options[0]?.intents, QQ_GROUP_AND_C2C_INTENTS)
  assert.equal(QQ_GROUP_AND_C2C_INTENTS, 1 << 25)

  bots[0]!.terminal = true
  await waitFor(() => bots.length === 2)
  assert.equal(bots[0]!.stopped, true)
  assert.equal(bots[1]!.stopped, false)
  assert.equal(options[1]?.intents, QQ_GROUP_AND_C2C_INTENTS)

  await service.stop()
  assert.equal(bots[1]!.stopped, true)
})

test('terminal generation cleanup timeout fail-stops without creating another generation', async () => {
  const bots: FakeBot[] = []
  const fatalReasons: string[] = []
  const service = makeQqBotService({
    pool: {} as Pool,
    config: {
      appId: 'app',
      appSecret: 'secret',
      entryUrl: 'https://example.test/bot',
      bindingHmacSecret: 'binding-secret',
    },
    dispatcher: {} as InboundDispatcher,
    botFactory: () => {
      const bot = new FakeBot()
      bots.push(bot)
      return bot as unknown as import('@tencent-connect/qqbot-nodejs').QQBot
    },
    outboxWorkerFactory: () => ({
      kick() {},
      stop: () => new Promise<void>(() => {}),
    }),
    gatewayTerminal: (bot) => (bot as unknown as FakeBot).terminal,
    gatewayHealthPollMs: 5,
    generationStopTimeoutMs: 20,
    onFatal: (reason) => fatalReasons.push(reason),
  })

  await service.start()
  bots[0]!.terminal = true
  await waitFor(() => fatalReasons.length === 1)
  assert.deepEqual(fatalReasons, ['qq_gateway_restart_cleanup_failed'])
  assert.equal(bots.length, 1)

  await service.stop()
})

test('failed-start cleanup timeout during scheduled retry fail-stops without a fourth generation', async () => {
  const bots: FakeBot[] = []
  const fatalReasons: string[] = []
  const service = makeQqBotService({
    pool: {} as Pool,
    config: {
      appId: 'app',
      appSecret: 'secret',
      entryUrl: 'https://example.test/bot',
      bindingHmacSecret: 'binding-secret',
    },
    dispatcher: {} as InboundDispatcher,
    botFactory: () => {
      const mode = bots.length === 0 ? 'ready' : bots.length === 1 ? 'error' : 'error-stuck'
      const bot = new FakeBot(mode)
      bots.push(bot)
      return bot as unknown as import('@tencent-connect/qqbot-nodejs').QQBot
    },
    outboxWorkerFactory: () => ({
      kick() {},
      async stop() {},
    }),
    gatewayTerminal: (bot) => (bot as unknown as FakeBot).terminal,
    gatewayHealthPollMs: 5,
    restartDelayMs: 5,
    generationStopTimeoutMs: 20,
    onFatal: (reason) => fatalReasons.push(reason),
  })

  await service.start()
  bots[0]!.terminal = true
  await waitFor(() => fatalReasons.length === 1)
  assert.deepEqual(fatalReasons, ['qq_gateway_retry_cleanup_failed'])
  assert.equal(bots.length, 3)

  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(bots.length, 3)
  await service.stop()
})

test('QQ /model is handled locally and does not dispatch an agent turn', async () => {
  const bot = new FakeBot()
  const modelCalls: Array<{ userId: string; text: string }> = []
  let dispatches = 0
  const service = makeQqBotService({
    pool: boundPool(),
    config: qqConfig(),
    dispatcher: {
      async dispatch() {
        dispatches += 1
        return { kind: 'dispatched', sessionId: 'wsess-test', newSession: false }
      },
      async stop() {
        throw new Error('not used')
      },
    } as InboundDispatcher,
    botFactory: () => bot as unknown as import('@tencent-connect/qqbot-nodejs').QQBot,
    outboxWorkerFactory: fakeOutbox,
    gatewayTerminal: () => false,
    handleModelCommand: async (userId, text) => {
      modelCalls.push({ userId, text })
      return '当前QQ可用模型:\n1. Claude'
    },
  })

  await service.start()
  bot.emit('message', {}, inboundMessage({ content: '/model' }))
  await waitFor(() => bot.sentTexts.length === 1)
  assert.deepEqual(modelCalls, [{ userId: '42', text: '/model' }])
  assert.equal(dispatches, 0)
  assert.match(bot.sentTexts[0]!, /当前QQ可用模型/)
  await service.stop()
})

test('QQ media-only message is prepared and dispatched with the enriched local-path prompt', async () => {
  const bot = new FakeBot()
  const prepared: Array<{ userId: string; text?: string; count: number }> = []
  const dispatchedTexts: string[] = []
  const service = makeQqBotService({
    pool: boundPool(),
    config: qqConfig(),
    dispatcher: {
      async dispatch(evt) {
        dispatchedTexts.push(evt.text)
        return { kind: 'dispatched', sessionId: 'wsess-test', newSession: false }
      },
      async stop() {
        throw new Error('not used')
      },
    } as InboundDispatcher,
    botFactory: () => bot as unknown as import('@tencent-connect/qqbot-nodejs').QQBot,
    outboxWorkerFactory: fakeOutbox,
    gatewayTerminal: () => false,
    prepareMedia: async ({ bindingUserId, attachments, text }) => {
      prepared.push({ userId: bindingUserId, text, count: attachments.length })
      return {
        promptText: '请处理图片\n`/home/agent/.openclaude/uploads/qq-image.png`',
        count: 1,
        media: [],
      }
    },
  })

  await service.start()
  bot.emit(
    'message',
    {},
    inboundMessage({
      content: '',
      attachments: [
        {
          content_type: 'image/png',
          url: 'https://cdn.qq.com/image',
          filename: 'image.png',
        },
      ],
    }),
  )
  await waitFor(() => dispatchedTexts.length === 1)
  assert.deepEqual(prepared, [{ userId: '42', text: undefined, count: 1 }])
  assert.match(dispatchedTexts[0]!, /\/home\/agent\/\.openclaude\/uploads/)
  assert.deepEqual(bot.sentTexts, [])
  await service.stop()
})

test('QQ media failure is explicit and never dispatches a partial message', async () => {
  const bot = new FakeBot()
  let dispatches = 0
  const service = makeQqBotService({
    pool: boundPool(),
    config: qqConfig(),
    dispatcher: {
      async dispatch() {
        dispatches += 1
        return { kind: 'dispatched', sessionId: 'wsess-test', newSession: false }
      },
      async stop() {
        throw new Error('not used')
      },
    } as InboundDispatcher,
    botFactory: () => bot as unknown as import('@tencent-connect/qqbot-nodejs').QQBot,
    outboxWorkerFactory: fakeOutbox,
    gatewayTerminal: () => false,
    prepareMedia: async () => {
      throw new Error('download timeout')
    },
  })

  await service.start()
  bot.emit(
    'message',
    {},
    inboundMessage({
      content: '看看',
      attachments: [
        {
          content_type: 'application/pdf',
          url: 'https://cdn.qq.com/file',
          filename: 'file.pdf',
        },
      ],
    }),
  )
  await waitFor(() => bot.sentTexts.length === 1)
  assert.equal(dispatches, 0)
  assert.match(bot.sentTexts[0]!, /未能接收完整/)
  await service.stop()
})

test('QQ plain text keeps the existing dispatch path without invoking media preparation', async () => {
  const bot = new FakeBot()
  const dispatchedTexts: string[] = []
  const service = makeQqBotService({
    pool: boundPool(),
    config: qqConfig(),
    dispatcher: {
      async dispatch(evt) {
        dispatchedTexts.push(evt.text)
        return { kind: 'dispatched', sessionId: 'wsess-test', newSession: false }
      },
      async stop() {
        throw new Error('not used')
      },
    } as InboundDispatcher,
    botFactory: () => bot as unknown as import('@tencent-connect/qqbot-nodejs').QQBot,
    outboxWorkerFactory: fakeOutbox,
    gatewayTerminal: () => false,
    prepareMedia: async () => {
      throw new Error('must not prepare text-only messages')
    },
  })

  await service.start()
  bot.emit('message', {}, inboundMessage({ content: '你好' }))
  await waitFor(() => dispatchedTexts.length === 1)
  assert.deepEqual(dispatchedTexts, ['你好'])
  assert.deepEqual(bot.sentTexts, [])
  await service.stop()
})

function qqConfig() {
  return {
    appId: 'app',
    appSecret: 'secret',
    entryUrl: 'https://example.test/bot',
    bindingHmacSecret: 'binding-secret',
  }
}

function fakeOutbox() {
  return {
    kick() {},
    async stop() {},
  }
}

function boundPool(): Pool {
  return {
    async query(text: string) {
      if (text.includes('WHERE bot_openid = $1')) {
        return {
          rows: [
            {
              user_id: '42',
              bot_openid: 'openid-1',
              binding_version: 'version-1',
              bound_at: '1',
              last_interaction_at: '1',
            },
          ],
        }
      }
      if (text.includes('UPDATE qq_bot_bindings')) return { rows: [] }
      throw new Error(`unexpected query: ${text}`)
    },
  } as unknown as Pool
}

function inboundMessage(
  overrides: Partial<QQBotInboundMessage> = {},
): QQBotInboundMessage {
  return {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId: 'openid-1',
    content: 'hello',
    messageId: `message-${Math.random()}`,
    timestamp: new Date().toISOString(),
    raw: {} as QQBotInboundMessage['raw'],
    replyTarget: { scope: 'c2c', targetId: 'openid-1' },
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
