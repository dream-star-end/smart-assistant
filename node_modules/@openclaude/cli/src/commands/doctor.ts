import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
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

  const ccbDir = resolve(cfg.auth.claudeCodePath)
  if (!existsSync(ccbDir)) {
    console.error('✗ Claude Code Best 路径不存在:', ccbDir)
    process.exit(1)
  }
  console.log('✓ CCB 路径:', ccbDir)

  const entry = resolve(ccbDir, cfg.auth.claudeCodeEntry ?? 'src/entrypoints/cli.tsx')
  if (!existsSync(entry)) {
    console.error('✗ CCB 入口不存在:', entry)
    process.exit(1)
  }
  console.log('✓ CCB 入口:', entry)

  const agents = await readAgentsConfig()
  console.log(`✓ Agents: ${agents.agents.map((a) => a.id).join(', ')} (default: ${agents.default})`)

  console.log('\n✓ all checks passed')
  console.log(`\nGateway: http://${cfg.gateway.bind}:${cfg.gateway.port}`)
  console.log(`Token:   ${cfg.gateway.accessToken}`)
}
