import { createHash } from 'node:crypto'
import {
  QQ_INBOUND_CONTAINER_PATH,
  QQ_INBOUND_COMPENSATE_PATH,
  QQ_STOP_CONTAINER_PATH,
} from '@openclaude/protocol'
import {
  QQBot,
  type QQBotInboundMessage,
  type QQBotOptions,
  type ReplyTarget,
} from '@tencent-connect/qqbot-nodejs'
import type { Pool } from 'pg'

import { type Logger, rootLogger } from '../logging/logger.js'
import type {
  InboundDispatcher,
  InboundDispatcherDeps,
  InboundEvent,
} from '../wechat/inboundDispatcher.js'
import type { QqBotConfig } from './config.js'
import type { QqInboundAttachment, SaveQqMediaResult } from './mediaIngest.js'
import {
  type ResolveQqOutboundMediaPartFn,
  qqMediaFileType,
  qqUnsupportedMediaFormat,
} from './outboundMedia.js'
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
  '当前这一轮用户正在 QQ 私聊里与你对话；平台会把最终回复完整发回 QQ。',
  '完整执行过程也会持久化到同一个 OpenClaude 网页会话中。',
  '用户通过 QQ 发送的图片、语音和附件会保存到当前容器本地，路径会随消息一起提供。',
  '如果需要发送文件、图片、视频、语音或附件，请先把资源创建或复制到 `/home/agent/.openclaude/generated/<安全文件名.ext>`；也可以复用 `/home/agent/.openclaude/uploads/<安全文件名.ext>`。',
  '最终回复里必须单独写出这个绝对路径；QQ 网关会自动把路径转换成真实媒体或附件发送，不能只让用户去网页查看。',
  '安全文件名使用 `[A-Za-z0-9._@+=,-]{1,180}`，不要使用子目录。图片、视频和 wav/mp3/silk 会按原生媒体发送，其他安全扩展名按普通附件发送。',
].join('\n')

export const QQ_GROUP_AND_C2C_INTENTS = 1 << 25

export interface QqBotService {
  start(): Promise<void>
  stop(): Promise<void>
  kickOutbox(): void
}

interface QqBotGeneration {
  bot: QQBot
  worker: QqOutboxWorker | null
  runPromise: Promise<void>
  onMessage: (_ctx: unknown, message: QQBotInboundMessage) => Promise<void>
  accepting: boolean
  stopping: boolean
  runEnded: boolean
  restartRequested: boolean
  monitor: ReturnType<typeof setInterval> | null
}

interface ObservableSdkGateway {
  currentWs: unknown | null
  isConnecting: boolean
  reconnectTimer: unknown | null
  isAborted: boolean
  reconnect: { isExhausted(): boolean }
}

class QqGenerationCleanupError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options)
    this.name = 'QqGenerationCleanupError'
  }
}

/**
 * qqbot-nodejs 1.0.4 does not surface fatal close/reconnect exhaustion from start().
 * Keep the version-specific inspection isolated here: an unknown shape is terminal,
 * so an SDK upgrade cannot silently leave the required inbound channel half-alive.
 */
export function isQqSdkGatewayTerminal(bot: QQBot): boolean {
  const gateway = (bot as unknown as { gateway?: ObservableSdkGateway | null }).gateway
  if (
    !gateway ||
    typeof gateway.isConnecting !== 'boolean' ||
    typeof gateway.isAborted !== 'boolean' ||
    typeof gateway.reconnect?.isExhausted !== 'function'
  ) {
    return true
  }
  if (gateway.isAborted) return false
  return (
    gateway.reconnect.isExhausted() ||
    (!gateway.currentWs && !gateway.isConnecting && !gateway.reconnectTimer)
  )
}

export function qqInboundChannelProfile(): NonNullable<InboundDispatcherDeps['channel']> {
  return {
    id: 'qqbot',
    originChannel: 'qqbot',
    inboundPath: QQ_INBOUND_CONTAINER_PATH,
    compensatePath: QQ_INBOUND_COMPENSATE_PATH,
    stopPath: QQ_STOP_CONTAINER_PATH,
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
  botFactory?: (options: QQBotOptions) => QQBot
  outboxWorkerFactory?: typeof startQqOutboxWorker
  gatewayTerminal?: (bot: QQBot) => boolean
  gatewayHealthPollMs?: number
  restartDelayMs?: number
  generationStopTimeoutMs?: number
  prepareMedia?: (args: {
    bindingUserId: string
    attachments: QqInboundAttachment[]
    text?: string
  }) => Promise<SaveQqMediaResult>
  resolveOutboundMedia?: ResolveQqOutboundMediaPartFn
  handleModelCommand?: (bindingUserId: string, text: string) => Promise<string>
  onFatal?: (reason: string, err: unknown) => void
}): QqBotService {
  const log = (args.logger ?? rootLogger).child({ subsys: 'qqBot' })
  const botFactory = args.botFactory ?? ((options: QQBotOptions) => new QQBot(options))
  const outboxWorkerFactory = args.outboxWorkerFactory ?? startQqOutboxWorker
  const gatewayTerminal = args.gatewayTerminal ?? isQqSdkGatewayTerminal
  const healthPollMs = args.gatewayHealthPollMs ?? 5_000
  const restartDelayMs = args.restartDelayMs ?? 5_000
  const generationStopTimeoutMs = args.generationStopTimeoutMs ?? 10_000
  let desiredRunning = false
  let active: QqBotGeneration | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let opChain: Promise<unknown> = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = opChain.then(operation, operation)
    opChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function failStop(reason: string, err: unknown): void {
    log.error('required_gateway_fail_stop', {
      reason,
      errMessage: err instanceof Error ? err.message : String(err),
    })
    if (args.onFatal) {
      args.onFatal(reason, err)
      return
    }
    process.exit(1)
  }

  function requestRestart(generation: QqBotGeneration, reason: string): void {
    if (
      !desiredRunning ||
      active !== generation ||
      generation.stopping ||
      generation.restartRequested
    ) {
      return
    }
    generation.restartRequested = true
    if (generation.monitor) {
      clearInterval(generation.monitor)
      generation.monitor = null
    }
    void enqueue(() => restartGeneration(generation, reason)).catch((err) => {
      failStop('qq_gateway_restart_cleanup_failed', err)
    })
  }

  function armMonitor(generation: QqBotGeneration): void {
    generation.monitor = setInterval(() => {
      if (!desiredRunning || active !== generation || generation.stopping) return
      let terminal = false
      try {
        terminal = gatewayTerminal(generation.bot)
      } catch (err) {
        log.error('gateway_health_probe_failed', {
          errMessage: err instanceof Error ? err.message : String(err),
        })
        terminal = true
      }
      if (terminal) requestRestart(generation, 'gateway_terminal')
    }, healthPollMs)
    generation.monitor.unref?.()
  }

  function activate(generation: QqBotGeneration): void {
    active = generation
    armMonitor(generation)
    if (generation.runEnded) requestRestart(generation, 'gateway_start_returned')
  }

  async function startGeneration(): Promise<QqBotGeneration> {
    const instance = botFactory({
      appId: args.config.appId,
      appSecret: args.config.appSecret,
      accountId: 'openclaude-v5',
      tokenPrefetch: 'sync',
      intents: QQ_GROUP_AND_C2C_INTENTS,
      logger: {
        info: (message) => log.info('sdk', { message }),
        warn: (message) => log.warn('sdk', { message }),
        error: (message) => log.error('sdk', { message }),
      },
    })
    const generation: QqBotGeneration = {
      bot: instance,
      worker: null,
      runPromise: Promise.resolve(),
      onMessage: async (_ctx: unknown, message: QQBotInboundMessage) => {
        if (!generation.accepting) return
        try {
          await handleMessage(args.pool, args.config, args.dispatcher, instance, message, log, {
            prepareMedia: args.prepareMedia,
            handleModelCommand: args.handleModelCommand,
          })
        } catch (err) {
          log.error('inbound_failed', {
            messageIdHash: shortHash(message.messageId),
            errMessage: err instanceof Error ? err.message : String(err),
          })
          await safeReply(instance, message.replyTarget, '消息处理暂时失败，请稍后重试。', log)
        }
      },
      accepting: false,
      stopping: false,
      runEnded: false,
      restartRequested: false,
      monitor: null,
    }

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
    instance.on('message', generation.onMessage)
    generation.runPromise = instance.start().then(
      () => {
        generation.runEnded = true
        if (!generation.stopping) requestRestart(generation, 'gateway_start_returned')
      },
      (err) => {
        generation.runEnded = true
        const error = err instanceof Error ? err : new Error(String(err))
        if (!ready) rejectReady(error)
        else {
          log.error('gateway_stopped_unexpectedly', { errMessage: error.message })
          requestRestart(generation, 'gateway_start_rejected')
        }
      },
    )

    try {
      await withTimeout(readyPromise, 30_000, 'QQ gateway ready timeout')
      generation.accepting = true
      generation.worker = outboxWorkerFactory({
        pool: args.pool,
        sendText: async (openid, text) => {
          await instance.sendText({ scope: 'c2c', targetId: openid }, text)
        },
        sendMedia: async (openid, media) => {
          try {
            await instance.sendMedia({
              target: { scope: 'c2c', targetId: openid },
              fileType: qqMediaFileType(media.kind),
              buffer: media.content,
              fileName: media.filename,
            })
          } catch (err) {
            if (err instanceof Error && err.message.includes('富媒体文件格式不支持')) {
              throw qqUnsupportedMediaFormat(media.filename)
            }
            throw err
          }
        },
        resolveMediaPart: args.resolveOutboundMedia,
        onError: (message, meta) => log.error(message, meta),
      })
      log.info('started')
      return generation
    } catch (err) {
      generation.stopping = true
      instance.off('message', generation.onMessage)
      try {
        instance.stop()
        await withTimeout(
          generation.runPromise,
          generationStopTimeoutMs,
          'QQ gateway failed-start cleanup timeout',
        )
      } catch (cleanupErr) {
        throw new QqGenerationCleanupError('QQ gateway failed-start cleanup did not finish', {
          cause: cleanupErr,
        })
      }
      throw err
    }
  }

  async function stopGeneration(generation: QqBotGeneration): Promise<void> {
    generation.stopping = true
    generation.accepting = false
    if (generation.monitor) {
      clearInterval(generation.monitor)
      generation.monitor = null
    }
    generation.bot.off('message', generation.onMessage)
    const cleanup = async () => {
      if (generation.worker) {
        const worker = generation.worker
        generation.worker = null
        await worker.stop()
      }
      generation.bot.stop()
      await generation.runPromise
    }
    try {
      await withTimeout(cleanup(), generationStopTimeoutMs, 'QQ generation stop timeout')
    } catch (err) {
      throw new QqGenerationCleanupError('QQ generation did not stop cleanly', { cause: err })
    }
  }

  function scheduleRetry(): void {
    if (!desiredRunning || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void enqueue(async () => {
        if (!desiredRunning || active) return
        try {
          activate(await startGeneration())
        } catch (err) {
          if (err instanceof QqGenerationCleanupError) {
            failStop('qq_gateway_retry_cleanup_failed', err)
            return
          }
          log.error('gateway_restart_failed', {
            errMessage: err instanceof Error ? err.message : String(err),
          })
          scheduleRetry()
        }
      })
    }, restartDelayMs)
    retryTimer.unref?.()
  }

  async function restartGeneration(generation: QqBotGeneration, reason: string): Promise<void> {
    if (!desiredRunning || active !== generation) return
    active = null
    log.warn('gateway_restarting', { reason })
    await stopGeneration(generation)
    if (!desiredRunning) return
    try {
      activate(await startGeneration())
    } catch (err) {
      if (err instanceof QqGenerationCleanupError) throw err
      log.error('gateway_restart_failed', {
        reason,
        errMessage: err instanceof Error ? err.message : String(err),
      })
      scheduleRetry()
    }
  }

  return {
    async start() {
      await enqueue(async () => {
        if (desiredRunning) return
        desiredRunning = true
        try {
          activate(await startGeneration())
        } catch (err) {
          desiredRunning = false
          throw err
        }
      })
    },

    async stop() {
      await enqueue(async () => {
        if (!desiredRunning && !active) return
        desiredRunning = false
        if (retryTimer) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        const generation = active
        active = null
        if (generation) await stopGeneration(generation)
        log.info('stopped')
      })
    },

    kickOutbox() {
      active?.worker?.kick()
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
  ux: {
    prepareMedia?: (args: {
      bindingUserId: string
      attachments: QqInboundAttachment[]
      text?: string
    }) => Promise<SaveQqMediaResult>
    handleModelCommand?: (bindingUserId: string, text: string) => Promise<string>
  },
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
      '直接发送文字、图片、语音或附件即可对话。\n/model 查看或切换模型\n/new 新建会话\n/stop 停止当前任务\n/help 查看帮助',
      log,
    )
    return
  }
  if (command === '/new' || command === '新对话') {
    await deleteQqSessionPointer(pool, binding.userId)
    await safeReply(bot, message.replyTarget, '已切换到新会话，下一条消息会开启新的上下文。', log)
    return
  }
  if (/^\/model(?:\s|$)/i.test(text)) {
    if (!ux.handleModelCommand) {
      await safeReply(bot, message.replyTarget, '模型切换暂时不可用，请稍后重试。', log)
      return
    }
    try {
      await safeReply(
        bot,
        message.replyTarget,
        await ux.handleModelCommand(binding.userId, text),
        log,
      )
    } catch (err) {
      log.error('model_command_failed', {
        uid: binding.userId,
        errMessage: err instanceof Error ? err.message : String(err),
      })
      await safeReply(bot, message.replyTarget, '模型切换暂时失败，请稍后重试。', log)
    }
    return
  }
  if (command === '/stop' || command === '停止') {
    const outcome = await dispatcher.stop(buildInboundEvent(binding.userId, openid, text, message))
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
  let inboundText = text
  const attachments = message.attachments ?? []
  if (attachments.length > 0) {
    if (!ux.prepareMedia) {
      await safeReply(bot, message.replyTarget, 'QQ 附件处理暂时不可用，请稍后重试。', log)
      return
    }
    try {
      inboundText = (
        await ux.prepareMedia({
          bindingUserId: binding.userId,
          attachments,
          text: text || undefined,
        })
      ).promptText
    } catch (err) {
      log.error('media_ingest_failed', {
        uid: binding.userId,
        messageIdHash: shortHash(message.messageId),
        errMessage: err instanceof Error ? err.message : String(err),
      })
      await safeReply(
        bot,
        message.replyTarget,
        '这次图片、语音或附件未能接收完整，请稍后重试。',
        log,
      )
      return
    }
  }
  const evt = buildInboundEvent(binding.userId, openid, inboundText, message)
  if (!inboundText) {
    await safeReply(bot, message.replyTarget, '请输入要发送的文字。', log)
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
