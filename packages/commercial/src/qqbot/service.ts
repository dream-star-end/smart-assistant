import { createHash } from 'node:crypto'
import { QQBot, type QQBotInboundMessage, type ReplyTarget } from '@tencent-connect/qqbot-nodejs'
import type { Pool } from 'pg'

import { type Logger, rootLogger } from '../logging/logger.js'
import type {
  InboundDispatcher,
  InboundDispatcherDeps,
  InboundEvent,
} from '../wechat/inboundDispatcher.js'
import type { QqBotConfig } from './config.js'
import { type QqOutboxWorker, startQqOutboxWorker } from './outbox.js'
import {
  deleteQqSessionPointer,
  getCurrentQqSessionId,
  getCurrentQqSessionPointer,
  listRunningQqSessions,
  markRunningQqSession,
  setCurrentQqSessionId,
} from './sessionPointer.js'
import { consumeBindCode, resolveQqBindingByOpenid, touchQqBinding } from './store.js'

const QQ_CONTEXT_HINT = [
  '',
  '---',
  '【OpenClaude QQ 通道系统提示】',
  '当前这一轮用户正在 QQ 私聊里与你对话；平台会把最终文字回复完整分片发回 QQ。',
  '完整执行过程也会持久化到同一个 OpenClaude 网页会话中。',
  'QQ 通道当前只支持文字；如果结果包含文件，请说明用户可在网页会话中查看和下载。',
].join('\n')

export interface QqBotService {
  start(): Promise<void>
  stop(): Promise<void>
  kickOutbox(): void
}

export function qqInboundChannelProfile(): NonNullable<InboundDispatcherDeps['channel']> {
  return {
    id: 'qqbot',
    originChannel: 'qqbot',
    inboundPath: '/internal/v3/qq-inbound',
    compensatePath: '/internal/v3/qq-inbound-compensate',
    stopPath: '/internal/v3/qq-stop',
    defaultSessionTitle: 'QQ 会话',
    decorateInboundText: (text) => appendReserved(text, QQ_CONTEXT_HINT),
    getCurrentSessionId: getCurrentQqSessionId,
    getCurrentSessionPointer: getCurrentQqSessionPointer,
    setCurrentSessionId: setCurrentQqSessionId,
    markRunningSession: markRunningQqSession,
    listRunningSessions: listRunningQqSessions,
  }
}

export function makeQqBotService(args: {
  pool: Pool
  config: QqBotConfig
  dispatcher: InboundDispatcher
  logger?: Logger
}): QqBotService {
  const log = (args.logger ?? rootLogger).child({ subsys: 'qqBot' })
  let bot: QQBot | null = null
  let worker: QqOutboxWorker | null = null
  let runPromise: Promise<void> | null = null
  let accepting = false

  const onMessage = async (_ctx: unknown, message: QQBotInboundMessage) => {
    if (!accepting) return
    try {
      await handleMessage(args.pool, args.config, args.dispatcher, bot!, message, log)
    } catch (err) {
      log.error('inbound_failed', {
        messageIdHash: shortHash(message.messageId),
        errMessage: err instanceof Error ? err.message : String(err),
      })
      await safeReply(bot!, message.replyTarget, '消息处理暂时失败，请稍后重试。', log)
    }
  }

  return {
    async start() {
      if (bot) return
      const instance = new QQBot({
        appId: args.config.appId,
        appSecret: args.config.appSecret,
        accountId: 'openclaude-v5',
        tokenPrefetch: 'sync',
        logger: {
          info: (message) => log.info('sdk', { message }),
          warn: (message) => log.warn('sdk', { message }),
          error: (message) => log.error('sdk', { message }),
        },
      })
      bot = instance
      let ready = false
      let settleReady!: () => void
      let rejectReady!: (err: Error) => void
      const readyPromise = new Promise<void>((resolve, reject) => {
        settleReady = resolve
        rejectReady = reject
      })
      instance.on('ready', () => {
        ready = true
        settleReady()
      })
      instance.on('error', (err) => {
        if (!ready) rejectReady(err)
        else log.error('gateway_error', { errMessage: err.message })
      })
      instance.on('message', onMessage)
      runPromise = instance.start().catch((err) => {
        if (!ready) rejectReady(err instanceof Error ? err : new Error(String(err)))
        else
          log.error('gateway_stopped_unexpectedly', {
            errMessage: err instanceof Error ? err.message : String(err),
          })
      })
      try {
        await withTimeout(readyPromise, 30_000, 'QQ gateway ready timeout')
      } catch (err) {
        instance.off('message', onMessage)
        instance.stop()
        const running = runPromise
        runPromise = null
        if (running)
          await withTimeout(running, 10_000, 'QQ gateway failed-start cleanup timeout').catch(
            () => {},
          )
        bot = null
        throw err
      }
      accepting = true
      worker = startQqOutboxWorker({
        pool: args.pool,
        sendText: async (openid, text) => {
          await instance.sendText({ scope: 'c2c', targetId: openid }, text)
        },
        onError: (message, meta) => log.error(message, meta),
      })
      log.info('started')
    },

    async stop() {
      const instance = bot
      if (!instance) return
      accepting = false
      instance.off('message', onMessage)
      const activeWorker = worker
      worker = null
      if (activeWorker) await activeWorker.stop()
      instance.stop()
      const running = runPromise
      runPromise = null
      if (running) await withTimeout(running, 10_000, 'QQ gateway stop timeout')
      bot = null
      log.info('stopped')
    },

    kickOutbox() {
      worker?.kick()
    },
  }
}

async function handleMessage(
  pool: Pool,
  config: QqBotConfig,
  dispatcher: InboundDispatcher,
  bot: QQBot,
  message: QQBotInboundMessage,
  log: Logger,
): Promise<void> {
  if (message.kind !== 'c2c' || message.replyTarget.scope !== 'c2c') return
  const openid = message.senderId
  const text = message.content.trim()
  const bindMatch = text.match(/^\/?bind(?:\s+|：|:)([A-Za-z0-9 -]+)$/i)
  if (bindMatch) {
    const result = await consumeBindCode(pool, bindMatch[1]!, openid, config.bindingHmacSecret)
    switch (result.kind) {
      case 'bound':
        await safeReply(
          bot,
          message.replyTarget,
          '绑定成功。现在直接发消息即可与 OpenClaude 对话；定时任务和提醒也可以主动发到这里。',
          log,
        )
        return
      case 'rate_limited':
        await safeReply(
          bot,
          message.replyTarget,
          `绑定尝试过于频繁，请约 ${Math.ceil(result.retryAfterMs / 60_000)} 分钟后再试。`,
          log,
        )
        return
      case 'already_bound_elsewhere':
        await safeReply(
          bot,
          message.replyTarget,
          '这个 QQ 已绑定其他 OpenClaude 账号，请先在原账号设置中解绑。',
          log,
        )
        return
      case 'invalid':
        await safeReply(
          bot,
          message.replyTarget,
          '绑定码无效或已过期。请回 OpenClaude 设置页重新生成。',
          log,
        )
        return
    }
  }

  const binding = await resolveQqBindingByOpenid(pool, openid)
  if (!binding) {
    await safeReply(
      bot,
      message.replyTarget,
      '还没有绑定 OpenClaude。请在 OpenClaude「设置 → 偏好」生成绑定码，然后发送：/bind 绑定码',
      log,
    )
    return
  }
  await touchQqBinding(pool, binding.userId, binding.bindingVersion)

  const command = text.toLowerCase()
  if (command === '/help' || command === '帮助') {
    await safeReply(
      bot,
      message.replyTarget,
      '直接发送文字即可对话。\n/new 新建会话\n/stop 停止当前任务\n/help 查看帮助',
      log,
    )
    return
  }
  if (command === '/new' || command === '新对话') {
    await deleteQqSessionPointer(pool, binding.userId)
    await safeReply(bot, message.replyTarget, '已切换到新会话，下一条消息会开启新的上下文。', log)
    return
  }
  const evt = buildInboundEvent(binding.userId, openid, text, message)
  if (command === '/stop' || command === '停止') {
    const outcome = await dispatcher.stop(evt)
    await safeReply(bot, message.replyTarget, outcome.reply.replaceAll('微信', 'QQ'), log)
    return
  }
  if (text.startsWith('/')) {
    await safeReply(
      bot,
      message.replyTarget,
      '不支持这个命令。发送 /help 查看可用命令，或直接发送问题。',
      log,
    )
    return
  }
  if (!text) {
    await safeReply(
      bot,
      message.replyTarget,
      message.attachments?.length
        ? 'QQ 图片和附件接入还未开放，请先发送文字，或在 OpenClaude 网页端上传附件。'
        : '请输入要发送的文字。',
      log,
    )
    return
  }
  const outcome = await dispatcher.dispatch(evt)
  switch (outcome.kind) {
    case 'dispatched':
      log.info('inbound_dispatched', {
        uid: binding.userId,
        sessionId: outcome.sessionId,
        messageIdHash: shortHash(message.messageId),
      })
      return
    case 'cold_start':
      await safeReply(bot, message.replyTarget, outcome.coldStartReply, log)
      return
    case 'command_echo':
      await safeReply(bot, message.replyTarget, outcome.reply.replaceAll('微信', 'QQ'), log)
      return
    default:
      await safeReply(bot, message.replyTarget, '消息暂时未能送达 OpenClaude，请稍后重试。', log)
  }
}

function buildInboundEvent(
  userId: string,
  openid: string,
  text: string,
  message: QQBotInboundMessage,
): InboundEvent {
  return {
    bindingUserId: userId,
    accountId: 'openclaude-v5',
    senderId: openid,
    text,
    messageId: shortHash(message.messageId),
    itemTypes: message.attachments?.length ? 'text,attachment' : 'text',
    idempotencyKey: `qq:${createHash('sha256').update(message.messageId).digest('hex')}`,
    agentId: 'main',
    receivedAt: Date.parse(message.timestamp) || Date.now(),
  }
}

async function safeReply(
  bot: QQBot,
  target: ReplyTarget,
  text: string,
  log: Logger,
): Promise<void> {
  try {
    await bot.sendText(target, text)
  } catch (err) {
    log.error('passive_reply_failed', {
      errMessage: err instanceof Error ? err.message : String(err),
    })
  }
}

function appendReserved(text: string, suffix: string): string {
  return `${text}${suffix}`
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
