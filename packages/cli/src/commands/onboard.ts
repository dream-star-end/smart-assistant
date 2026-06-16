import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { generateAccessToken, resolveOfficialClaudePath } from '@openclaude/gateway'
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
  /** Optional override for the official `claude` binary path. */
  claudeCliPath?: string
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

  // 1. 官方 Claude Code 二进制
  const resolvedClaude = resolveOfficialClaudePath()
  const claudeCliPath = opts.claudeCliPath ?? (await ask('官方 claude 二进制路径', resolvedClaude))
  // 绝对路径才校验存在;裸 `claude` 走 PATH,无法用 existsSync 判断。
  if (isAbsolute(claudeCliPath) && !existsSync(claudeCliPath)) {
    console.error(`✗ 找不到官方 claude: ${claudeCliPath}`)
    console.error('  请先安装官方 Claude Code: https://docs.claude.com/claude-code')
    console.error('  (默认装在 ~/.local/bin/claude)')
    process.exit(1)
  }
  console.log(`✓ 官方 Claude Code: ${claudeCliPath}`)

  // 2. 登录方式
  let authMode = opts.authMode
  if (!authMode && rl) {
    console.log('\n登录方式三选一(底层都用官方 claude,token 由 claude 自己存):')
    console.log('  1) Sign in with Claude.ai (订阅 OAuth) ← 推荐')
    console.log('  2) Anthropic API key')
    console.log('  3) Custom Platform (第三方兼容网关 / 国产模型)')
    const a = await ask('选择 (1/2/3)', '1')
    authMode = a === '2' ? 'api_key' : a === '3' ? 'custom_platform' : 'subscription'
  }
  authMode ??= 'subscription'

  console.log('\n→ 接下来请用官方 claude 完成登录:')
  console.log('  claude            # 启动后输入 /login,选择对应方式授权')
  console.log('  claude setup-token  # 或生成长期 token')
  console.log(
    '  完成后 token 存到 ~/.claude/.credentials.json,OpenClaude spawn 官方 claude 时自动复用\n',
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
      // Only persist an explicit override; default resolution lives in
      // resolveOfficialClaudePath so installs that move the binary keep working.
      ...(opts.claudeCliPath ? { claudeCliPath } : {}),
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
