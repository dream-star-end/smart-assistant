import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { generateAccessToken, parseGatewayPortOverride } from '@openclaude/gateway'
import {
  AUTH_MODES,
  type AuthMode,
  DEFAULT_GATEWAY_BIND,
  DEFAULT_GATEWAY_PORT,
  type OpenClaudeConfig,
  SELFHOST_FALLBACK_MODEL,
  paths,
  readAgentsConfigWithWarnings,
  readConfig,
  writeAgentsConfig,
  writeConfig,
} from '@openclaude/storage'
import { maskAccessToken } from './doctor.js'

interface OnboardOpts {
  nonInteractive?: boolean
  json?: boolean
  claudeCodePath?: string
  authMode?: AuthMode | string
  port?: number | string
  bind?: string
  model?: string
  /** 明文打印 accessToken(默认脱敏,与 doctor 一致;首装且非 --json 时仍完整打印一次,见下)。 */
  showToken?: boolean
}

/** onboard 这一轮实际询问 / 接收到的字段 —— 只有这些会覆盖既有配置(CFG-01)。 */
export interface OnboardInput {
  claudeCodePath: string
  authMode: AuthMode
  port: number
  bind: string
  model: string
}

// 注:persona 仍写绝对路径 paths.agentClaudeMd('main')。改相对路径需要 promptSlots / handlePersona 等
// 读侧按 HOME 解析(现只有 identityCompatAssets.personaCandidate 这么做),那些读侧不在 config 子系统
// 范围内,记入 msc-config.md「遗留」(CFG-12 的相对 persona 项)。

export function isAuthMode(value: unknown): value is AuthMode {
  return (AUTH_MODES as readonly unknown[]).includes(value)
}

/**
 * 深合并:既有配置一字不丢(users / outboundRing / claudeOAuth / codexOAuth / provider / toolsets /
 * mcpServers / terminal / telegram …),只覆盖本次询问过的字段;`defaults.permissionMode` 既有则保留,
 * 首装才写 `acceptEdits`;accessToken 既有则保留。纯函数,便于单测。
 */
export function buildOnboardConfig(
  existing: OpenClaudeConfig | null,
  input: OnboardInput,
): OpenClaudeConfig {
  if (!existing) {
    return {
      version: 1,
      gateway: { bind: input.bind, port: input.port, accessToken: generateAccessToken() },
      auth: {
        mode: input.authMode,
        claudeCodePath: resolve(input.claudeCodePath),
        claudeCodeEntry: 'src/entrypoints/cli.tsx',
        claudeCodeRuntime: 'bun',
      },
      defaults: { model: input.model, permissionMode: 'acceptEdits' },
      channels: { webchat: { enabled: true } },
    }
  }
  return {
    ...existing,
    version: 1,
    gateway: {
      ...existing.gateway,
      bind: input.bind,
      port: input.port,
      accessToken: existing.gateway.accessToken || generateAccessToken(),
    },
    auth: {
      ...existing.auth,
      mode: input.authMode,
      claudeCodePath: resolve(input.claudeCodePath),
      claudeCodeEntry: existing.auth.claudeCodeEntry ?? 'src/entrypoints/cli.tsx',
      claudeCodeRuntime: existing.auth.claudeCodeRuntime ?? 'bun',
    },
    defaults: {
      ...existing.defaults,
      model: input.model,
      permissionMode: existing.defaults.permissionMode ?? 'acceptEdits',
    },
    channels: {
      ...existing.channels,
      webchat: existing.channels.webchat ?? { enabled: true },
    },
  }
}

/** 端口:与 gateway 的 OPENCLAUDE_GATEWAY_PORT 同一套校验(1..65535 整数),非法 → null。 */
export function parseOnboardPort(raw: number | string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_GATEWAY_PORT
  return parseGatewayPortOverride(String(raw))
}

export async function onboard(opts: OnboardOpts): Promise<void> {
  const existing = await readConfig()
  if (existing && !opts.nonInteractive) {
    console.log('Found existing config at', paths.config)
    console.log(
      'Re-running only updates the fields asked below; credentials, users, MCP servers and agents.yaml are kept.\n',
    )
  }

  const rl = opts.nonInteractive ? null : createInterface({ input: stdin, output: stdout })
  const ask = async (q: string, def?: string): Promise<string> => {
    if (!rl) return def ?? ''
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim()
    return a || def || ''
  }

  // 1. Claude Code 路径
  const defaultCcb =
    existing?.auth.claudeCodePath || resolve(process.cwd(), '..', 'claude-code-best')
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

  // 2. 登录方式(CLI 传入的值也要过枚举,CFG-12)
  let authMode: AuthMode | undefined
  if (opts.authMode !== undefined) {
    if (!isAuthMode(opts.authMode)) {
      console.error(`✗ --auth-mode 只能是 ${AUTH_MODES.join(' | ')},收到: ${String(opts.authMode)}`)
      process.exit(1)
    }
    authMode = opts.authMode
  } else if (rl) {
    console.log('\n登录方式三选一(底层都用 CCB,token 由 CCB 自己存):')
    console.log('  1) Sign in with Claude.ai (订阅 OAuth) ← 推荐')
    console.log('  2) Anthropic API key')
    console.log('  3) Custom Platform (第三方兼容网关 / 国产模型)')
    const a = await ask('选择 (1/2/3)', '1')
    authMode = a === '2' ? 'api_key' : a === '3' ? 'custom_platform' : 'subscription'
  }
  authMode ??= existing?.auth.mode ?? 'subscription'

  console.log('\n→ 接下来请在 Claude Code Best 里完成登录:')
  console.log(`  cd ${claudeCodePath} && bun run dev`)
  console.log('  然后输入 /login,选择对应方式完成授权')
  console.log(
    '  完成后 token 会被 CCB 存到它自己的 keychain/settings,后续 OpenClaude spawn 它时自动复用\n',
  )

  // 3. Gateway 端口 / 绑定
  const portRaw =
    opts.port ?? (await ask('Gateway 端口', String(existing?.gateway.port ?? DEFAULT_GATEWAY_PORT)))
  const port = parseOnboardPort(portRaw)
  if (port === null) {
    console.error(`✗ 端口必须是 1..65535 的整数,收到: ${String(portRaw)}`)
    process.exit(1)
  }
  const bind =
    opts.bind ?? (await ask('Gateway 绑定地址', existing?.gateway.bind ?? DEFAULT_GATEWAY_BIND))

  // 4. 默认模型(默认值与 sessionManager 兜底同源,selfhost 可路由,CFG-16)
  const model =
    opts.model ?? (await ask('默认模型', existing?.defaults.model ?? SELFHOST_FALLBACK_MODEL))

  rl?.close()

  const cfg = buildOnboardConfig(existing, { claudeCodePath, authMode, port, bind, model })
  await mkdir(paths.home, { recursive: true })
  await writeConfig(cfg)

  // agents.yaml:已存在则**不碰**(市场安装 agent / 自建 agent / routes 都在里面),只保证 main 的目录在。
  if (existsSync(paths.agentsYaml)) {
    const { config: agents } = await readAgentsConfigWithWarnings()
    console.log(
      `✓ agents.yaml 已存在,保留 ${agents.agents.length} 个 agent(default: ${agents.default})`,
    )
  } else {
    await writeAgentsConfig({
      agents: [{ id: 'main', model, persona: paths.agentClaudeMd('main') }],
      routes: [],
      default: 'main',
    })
  }
  await mkdir(paths.agentDir('main'), { recursive: true })
  await mkdir(paths.agentSessionsDir('main'), { recursive: true })

  console.log('\n✓ OpenClaude 配置已写入', paths.config)
  // 首装时用户必须拿到完整 token 才能登录,打印一次;重跑默认脱敏(token 常被整段复制进工单 / 截图)。
  const revealToken = opts.showToken || !existing
  console.log(
    `  Access token: ${revealToken ? cfg.gateway.accessToken : maskAccessToken(cfg.gateway.accessToken)}`,
  )
  if (!revealToken)
    console.log('  (已脱敏;用 --show-token 或 `openclaude doctor --show-token` 查看完整值)')
  console.log(`  打开 http://${bind}:${port} 使用浏览器(粘贴上面的 token 即可)`)
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, config: paths.config, token: cfg.gateway.accessToken }))
  }
  console.log('\n下一步: bun run gateway')
}
