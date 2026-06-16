import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { resolveOfficialClaudePath } from '@openclaude/gateway'
import { paths, readAgentsConfig, readConfig } from '@openclaude/storage'

export async function doctor(): Promise<void> {
  console.log('OpenClaude doctor\n')
  const cfg = await readConfig()
  if (!cfg) {
    console.error('✗ 未找到配置 (', paths.config, ')')
    console.error('  → 运行 `openclaude onboard`')
    process.exit(1)
  }
  console.log('✓ 配置文件:', paths.config)

  // 官方 claude 二进制:config 覆盖优先,否则自动探测。绝对路径才校验存在。
  const claudeBin = cfg.auth.claudeCliPath?.trim() || resolveOfficialClaudePath()
  if (isAbsolute(claudeBin) && !existsSync(claudeBin)) {
    console.error('✗ 找不到官方 claude:', claudeBin)
    console.error(
      '  → 安装官方 Claude Code (https://docs.claude.com/claude-code) 或运行 `openclaude onboard`',
    )
    process.exit(1)
  }
  console.log('✓ 官方 claude:', claudeBin)

  const agents = await readAgentsConfig()
  console.log(`✓ Agents: ${agents.agents.map((a) => a.id).join(', ')} (default: ${agents.default})`)

  console.log('\n✓ all checks passed')
  console.log(`\nGateway: http://${cfg.gateway.bind}:${cfg.gateway.port}`)
  console.log(`Token:   ${cfg.gateway.accessToken}`)
}
