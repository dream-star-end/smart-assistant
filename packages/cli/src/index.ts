#!/usr/bin/env bun
import { Command } from 'commander'
import { onboard } from './commands/onboard.js'
import { gatewayCmd } from './commands/gateway.js'
import { doctor } from './commands/doctor.js'
import { agentsAdd, agentsList } from './commands/agents.js'
import { pairingList, pairingTelegramAdd, pairingTelegramRemove } from './commands/pairing.js'

const program = new Command()
program
  .name('openclaude')
  .description('多渠道个人 AI 助理 — 基于 Claude Code Best')
  .version('0.1.0')

program
  .command('onboard')
  .description('引导式配置(首次)')
  .option('--non-interactive', '非交互模式')
  .option('--json', '输出 JSON 摘要')
  .option('--claude-code-path <path>', 'Claude Code Best 项目路径')
  .option('--port <port>', 'gateway 端口', (v) => Number(v))
  .option('--bind <addr>', 'gateway 绑定地址')
  .option('--model <model>', '默认模型 ID')
  .action((opts) => onboard(opts))

program
  .command('gateway')
  .description('启动 gateway')
  .option('--dev', '开发模式')
  .action((opts) => gatewayCmd(opts))

program.command('doctor').description('健康检查').action(doctor)

const agents = program.command('agents').description('agent 管理')
agents.command('list').action(agentsList)
agents
  .command('add <id>')
  .option('--model <model>', '模型 ID')
  .action((id, opts) => agentsAdd(id, opts))

const pairing = program.command('pairing').description('渠道配对')
pairing.command('list').description('显示已配置渠道').action(pairingList)
const pairingTg = pairing.command('telegram').description('Telegram bot')
pairingTg
  .command('add <token>')
  .option('--no-mention-required', '群聊中无需 @bot 即可响应')
  .action((token, opts) => pairingTelegramAdd(token, opts))
pairingTg.command('remove').action(pairingTelegramRemove)

program.parseAsync(process.argv).catch((err) => {
  console.error(err)
  process.exit(1)
})
