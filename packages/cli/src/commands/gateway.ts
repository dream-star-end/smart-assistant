import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Gateway,
  log,
  makeV3WechatOutboundAdapter,
  readV3WechatOutboundConfig,
  type CommercialHook,
} from '@openclaude/gateway'
import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import { type OpenClaudeConfig, readAgentsConfig, readConfig } from '@openclaude/storage'

export async function gatewayCmd(_opts: { dev?: boolean }): Promise<void> {
  let gw: Gateway | null = null
  let emergencyActive = false

  // Hard-deadline for emergency shutdown. Clamped to [500ms, 30s].
  const rawTimeout = Number(process.env.OPENCLAUDE_FATAL_SHUTDOWN_TIMEOUT_MS)
  const fatalShutdownTimeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.max(rawTimeout, 500), 30_000)
      : 3_000

  // Fatal crash handler: structured log, best-effort graceful shutdown, then exit(1).
  // A hard-deadline timer guarantees we exit even if shutdown hangs.
  const emergencyExit = (
    kind: 'uncaughtException' | 'unhandledRejection',
    err: unknown,
  ): void => {
    // Ensure any natural event-loop drain after this point yields exit code 1.
    process.exitCode = 1

    if (emergencyActive) {
      try {
        log.error(`additional ${kind} during emergency shutdown`, undefined, err)
      } catch {
        console.error(`[FATAL] additional ${kind} during emergency shutdown:`, err)
      }
      process.exit(1)
    }
    emergencyActive = true
    try {
      log.error(`fatal ${kind}`, undefined, err)
    } catch {
      console.error(`[FATAL] ${kind}:`, err)
    }
    // Hard deadline so we never hang if shutdown misbehaves. Intentionally
    // NOT unref'd: we want this timer to keep the event loop alive so the
    // fatal exit(1) actually fires even if all other handles closed.
    setTimeout(() => {
      try {
        log.error('emergency shutdown timeout, force exit')
      } catch {
        console.error('[FATAL] emergency shutdown timeout, force exit')
      }
      process.exit(1)
    }, fatalShutdownTimeoutMs)

    const finish = () => process.exit(1)
    const g = gw
    if (g) {
      // exit=false so we control the final exit code (1, not 0)
      g.shutdown(false)
        .catch((shutdownErr) => {
          try {
            log.error('error during emergency shutdown', undefined, shutdownErr)
          } catch {}
        })
        .finally(finish)
    } else {
      finish()
    }
  }

  // Install handlers BEFORE any async work so bootstrap failures are caught too
  process.on('uncaughtException', (err) => emergencyExit('uncaughtException', err))
  process.on('unhandledRejection', (reason) => emergencyExit('unhandledRejection', reason))

  // Route Node's native fetch() through HTTP_PROXY when set so gateway-internal
  // OAuth token exchange / refresh (handleOAuthCallback / _refreshToken hits
  // platform.claude.com / auth.openai.com) goes through the residential proxy.
  // CCB and MCP subprocesses already pick up HTTP_PROXY via env inheritance and
  // their own proxy-aware HTTP clients; this closes the gap for the gateway
  // process itself, since Node fetch() does NOT auto-read HTTP_PROXY.
  // EnvHttpProxyAgent reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY (and lowercase)
  // itself; with no proxy env it is effectively a normal Agent.
  if (
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
  ) {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import('undici')
    setGlobalDispatcher(new EnvHttpProxyAgent())
    log.info('gateway: routing fetch via HTTP_PROXY (EnvHttpProxyAgent)')
  }

  const config = await readConfig()
  if (!config) {
    console.error('未找到配置。请先运行 `openclaude onboard`')
    process.exit(1)
  }
  const agentsConfig = await readAgentsConfig()
  const here = fileURLToPath(new URL('.', import.meta.url))
  // 静态前端按 runtime channel 分流(底层权威 = OC_RUNTIME_CHANNEL,与 commercial
  // getRuntimeChannel() 同源;此处只做"服务哪套产物 + 用哪种缓存语义"的纯路径决策,
  // 不引入 cli→commercial 结构耦合。fail-closed 的 v3|v5 校验在同进程的 commercial 侧)。
  //   - v5(Aurora): packages/web-react/dist(Vite bundler 产物)+ 'spa' 缓存模式。
  //   - 其它(默认 v3/personal): packages/web/public(vanilla)+ 'vanilla' 模式,行为不变。
  const isV5Channel = (process.env.OC_RUNTIME_CHANNEL?.trim() || 'v3') === 'v5'
  const webRoot = isV5Channel
    ? resolve(here, '../../../web-react/dist')
    : resolve(here, '../../../web/public')
  const legacyWebRoot = isV5Channel ? resolve(here, '../../../web/public') : undefined
  const staticMode: 'vanilla' | 'spa' = isV5Channel ? 'spa' : 'vanilla'

  const channelFactories: Array<(deps: { config: OpenClaudeConfig }) => ChannelAdapter> = []

  // V3 Phase 2 Task 2H: 仅当 COMMERCIAL_ENABLED=1 时挂商业化模块。
  // dynamic-import 是为了让 personal 部署不背负 commercial 包的副作用 import(pg/redis/dockerode)。
  //
  // P1.7 slice 7c — commercial 必须先于 wechatChannelFactory 完成 register,
  // 因为 wechat manager 的 `onInboundOverride` 需要把 `commercial.wechatBroker.onInbound`
  // 透传进去(broker 替代 ctx.dispatch 路径,见 RFC §4.1)。两者顺序倒过来就会
  // 出现"commercial 还未 ready 时 wechat worker 已开始长轮询"的窗口:这段时间
  // 的 inbound 会走 legacy ctx.dispatch 进 personal-OC session 命名空间,而不是
  // broker 的 wsess-* 命名空间 —— session 串场无法回退。
  let commercial: CommercialHook | undefined
  if (process.env.COMMERCIAL_ENABLED === '1') {
    try {
      const mod = await import('@openclaude/commercial')
      commercial = await mod.registerCommercial(null)
      console.log('[cli] commercial module registered (v3 mode)')
    } catch (err) {
      console.error('[cli] COMMERCIAL_ENABLED=1 但 registerCommercial 失败:', err)
      process.exit(1)
    }
  }

  // WeChat (iLink): enabled when channels.wechat.enabled = true.
  // Bindings are per-user and live in the wechat_bindings table — no static
  // config token. The manager picks them up on init() + reconcile interval.
  //
  // P1.7 slice 7c — commercial.wechatBroker 存在时,把 broker.onInbound 作为
  // override hook 注入 manager;由 broker 接管 inbound 并按 wsess-* 命名空间
  // 走自己的 dispatcher → container 链路。broker 未启用(WECHAT_BROKER_ENABLED!=1
  // / personal / commercial 未挂)时 override 为 undefined,manager 走 legacy
  // ctx.dispatch 原路径,行为不变。
  const wxCfg = (config.channels as any).wechat
  if (wxCfg?.enabled) {
    try {
      const mod = await import('@openclaude/channel-wechat')
      const broker = commercial?.wechatBroker
      channelFactories.push(() =>
        mod.wechatChannelFactory({
          onInboundOverride: broker ? (evt) => broker.onInbound(evt) : undefined,
        }),
      )
      console.log(
        broker
          ? '[cli] wechat (iLink) channel wired up (broker override active)'
          : '[cli] wechat (iLink) channel wired up',
      )
    } catch (err) {
      console.error('[cli] failed to load @openclaude/channel-wechat:', err)
    }
  }

  // Telegram (optional): enabled when channels.telegram.enabled = true AND token is provided
  const tgCfg = (config.channels as any).telegram
  if (tgCfg?.enabled) {
    const token = tgCfg.botToken || process.env.OPENCLAUDE_TELEGRAM_BOT_TOKEN
    if (!token) {
      console.warn(
        '[cli] telegram channel is enabled but no botToken found; skip. Run `openclaude pairing telegram add <token>` first.',
      )
    } else {
      try {
        const mod = await import('@openclaude/channel-telegram')
        channelFactories.push(() =>
          mod.telegramChannelFactory({
            botToken: token,
            mentionRequired: tgCfg.mentionRequired !== false,
          }),
        )
        console.log('[cli] telegram channel wired up')
      } catch (err) {
        console.error('[cli] failed to load @openclaude/channel-telegram:', err)
      }
    }
  }

  // P1.7 slice 7c — 容器侧 WeChat outbound 适配器。
  //
  // 仅当 OPENCLAUDE_V3_MASTER_BASE_URL + OPENCLAUDE_V3_CONTAINER_TOKEN 同时存在
  // (即本进程是 v3 commercial 容器)时挂载;此 adapter 把 ChannelMessage.channel='wechat'
  // 的 OutboundMessage 通过 POST /internal/v3/wechat-outbound 回传给 master broker,
  // master 再走 manager.send → iLink。
  //
  // personal / dev / master 进程缺这两个 env,readV3WechatOutboundConfig 返回 null,
  // 不挂载;adapter id = "v3-wechat-outbound",与 master 侧 wechatChannelFactory 的
  // "wechat" 共存不冲突(channel 字段决定路由,但 master 容器内同时只有一个)。
  const v3WxOut = readV3WechatOutboundConfig(process.env)
  if (v3WxOut) {
    channelFactories.push(() => makeV3WechatOutboundAdapter({ config: v3WxOut }))
    console.log('[cli] v3 wechat outbound adapter wired (container mode)')
  }

  gw = new Gateway({ config, agentsConfig, webRoot, legacyWebRoot, staticMode, channelFactories, commercial })
  await gw.start()
}
