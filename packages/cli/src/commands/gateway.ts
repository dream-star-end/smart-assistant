import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Gateway } from '@openclaude/gateway'
import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import { type OpenClaudeConfig, readAgentsConfig, readConfig } from '@openclaude/storage'

export async function gatewayCmd(_opts: { dev?: boolean }): Promise<void> {
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

  const gw = new Gateway({ config, agentsConfig, webRoot, channelFactories })
  await gw.start()
}
