import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { generateAccessToken } from '@openclaude/gateway'
import {
  type OpenClaudeConfig,
  paths,
  readConfig,
  writeAgentsConfig,
  writeConfig,
} from '@openclaude/storage'

interface OnboardOpts {
  nonInteractive?: boolean
  json?: boolean
  claudeCodePath?: string
  authMode?: 'subscription' | 'api_key' | 'custom_platform'
  port?: number
  bind?: string
  model?: string
}

export async function onboard(opts: OnboardOpts): Promise<void> {
  const existing = await readConfig()
  if (existing && !opts.nonInteractive) {
    console.log('Found existing config at', paths.config)
    console.log('Re-running will overwrite gateway settings but keep credentials.\n')
  }

  const rl = opts.nonInteractive ? null : createInterface({ input: stdin, output: stdout })
  const ask = async (q: string, def?: string): Promise<string> => {
    if (!rl) return def ?? ''
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim()
    return a || def || ''
  }

  // 1. Claude Code 路径
  const defaultCcb = resolve(process.cwd(), '..', 'claude-code-best')
  const claudeCodePath = opts.claudeCodePath ?? (await ask('Claude Code Best 项目路径', defaultCcb))
  if (!existsSync(claudeCodePath)) {
    console.error(`✗ 路径不存在: ${claudeCodePath}`)
    console.error('  请先 git clone https://github.com/dream-star-end/claude-code-best.git')
    process.exit(1)
  }
  const cliEntry = resolve(claudeCodePath, 'src/entrypoints/cli.tsx')
  if (!existsSync(cliEntry)) {
    console.error(`✗ 找不到 CCB 入口: ${cliEntry}`)
    process.exit(1)
  }
  console.log('✓ Claude Code Best 已找到')

  // 2. 登录方式
  let authMode = opts.authMode
  if (!authMode && rl) {
    console.log('\n登录方式三选一(底层都用 CCB,token 由 CCB 自己存):')
    console.log('  1) Sign in with Claude.ai (订阅 OAuth) ← 推荐')
    console.log('  2) Anthropic API key')
    console.log('  3) Custom Platform (第三方兼容网关 / 国产模型)')
    const a = await ask('选择 (1/2/3)', '1')
    authMode = a === '2' ? 'api_key' : a === '3' ? 'custom_platform' : 'subscription'
  }
  authMode ??= 'subscription'

  console.log('\n→ 接下来请在 Claude Code Best 里完成登录:')
  console.log(`  cd ${claudeCodePath} && bun run dev`)
  console.log('  然后输入 /login,选择对应方式完成授权')
  console.log(
    '  完成后 token 会被 CCB 存到它自己的 keychain/settings,后续 OpenClaude spawn 它时自动复用\n',
  )

  // 3. Gateway 端口
  const port = opts.port ?? Number((await ask('Gateway 端口', '18789')) || '18789')
  const bind = opts.bind ?? (await ask('Gateway 绑定地址', '127.0.0.1'))

  // 4. 默认模型
  const model = opts.model ?? (await ask('默认模型', 'claude-opus-4-6'))

  rl?.close()

  // 写配置
  const cfg: OpenClaudeConfig = {
    version: 1,
    gateway: {
      bind,
      port,
      accessToken: existing?.gateway.accessToken ?? generateAccessToken(),
    },
    auth: {
      mode: authMode,
      claudeCodePath: resolve(claudeCodePath),
      claudeCodeEntry: 'src/entrypoints/cli.tsx',
      claudeCodeRuntime: 'bun',
    },
    defaults: {
      model,
      permissionMode: 'acceptEdits',
    },
    channels: {
      webchat: { enabled: true },
    },
  }
  await mkdir(paths.home, { recursive: true })
  await writeConfig(cfg)

  // 默认 agents.yaml
  await writeAgentsConfig({
    agents: [{ id: 'main', model, persona: paths.agentClaudeMd('main') }],
    routes: [],
    default: 'main',
  })
  await mkdir(paths.agentDir('main'), { recursive: true })
  await mkdir(paths.agentSessionsDir('main'), { recursive: true })

  console.log('\n✓ OpenClaude 配置已写入', paths.config)
  console.log(`  Access token: ${cfg.gateway.accessToken}`)
  console.log(`  打开 http://${bind}:${port} 使用浏览器(粘贴上面的 token 即可)`)
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, config: paths.config, token: cfg.gateway.accessToken }))
  }
  console.log('\n下一步: bun run gateway')
}
