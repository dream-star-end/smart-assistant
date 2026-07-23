import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import type { QQBotOptions, ReplyTarget } from '@tencent-connect/qqbot-nodejs'
import type { Pool } from 'pg'

import {
  QQ_GROUP_AND_C2C_INTENTS,
  makeQqBotService,
} from '../qqbot/service.js'
import type { InboundDispatcher } from '../wechat/inboundDispatcher.js'

class FakeBot extends EventEmitter {
  terminal = false
  stopped = false
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

  async sendText(_target: ReplyTarget, _text: string): Promise<unknown> {
    return {}
  }
}

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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
