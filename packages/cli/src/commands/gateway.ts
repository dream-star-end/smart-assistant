import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Gateway, log } from '@openclaude/gateway'
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

  const config = await readConfig()
  if (!config) {
    console.error('未找到配置。请先运行 `openclaude onboard`')
    process.exit(1)
  }
  const agentsConfig = await readAgentsConfig()
  const here = fileURLToPath(new URL('.', import.meta.url))
  const webRoot = resolve(here, '../../../web/public')

  const channelFactories: Array<(deps: { config: OpenClaudeConfig }) => ChannelAdapter> = []

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

  gw = new Gateway({ config, agentsConfig, webRoot, channelFactories })
  await gw.start()
}
