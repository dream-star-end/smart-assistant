import { readConfig, writeConfig } from '@openclaude/storage'

export async function pairingTelegramAdd(token: string, opts: { mentionRequired?: boolean }) {
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    console.error('Telegram bot token 格式不对。应该是 "123456:AA..."')
    process.exit(1)
  }
  const cfg = await readConfig()
  if (!cfg) {
    console.error('未找到配置。请先运行 `openclaude onboard`')
    process.exit(1)
  }
  cfg.channels = cfg.channels || { webchat: { enabled: true } }
  ;(cfg.channels as any).telegram = {
    enabled: true,
    botTokenRef: 'inline',
    botToken: token,
    mentionRequired: opts.mentionRequired !== false,
  }
  await writeConfig(cfg)
  console.log('✓ Telegram bot token 已保存到 config')
  console.log('  重启 gateway: systemctl restart openclaude (服务器) 或 bun run gateway (本地)')
}

export async function pairingTelegramRemove() {
  const cfg = await readConfig()
  if (!cfg) {
    console.error('未找到配置。')
    process.exit(1)
  }
  delete (cfg.channels as any).telegram
  await writeConfig(cfg)
  console.log('✓ 已移除 Telegram')
}

export async function pairingList() {
  const cfg = await readConfig()
  if (!cfg) {
    console.error('未找到配置。')
    process.exit(1)
  }
  console.log('Channels:')
  for (const [name, ch] of Object.entries(cfg.channels ?? {})) {
    const c = ch as any
    const enabled = c?.enabled ? '✓' : '✗'
    console.log(`  ${enabled} ${name}`)
  }
}
