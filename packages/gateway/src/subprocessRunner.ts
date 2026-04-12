import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { type McpServerConfig, type OpenClaudeConfig, paths } from '@openclaude/storage'
import { buildPromptContext } from './promptSlots.js'
import { type TerminalBackend, createBackend } from './terminalBackend.js'

// ───────────────────────────────────────────────
// SubprocessRunner
//
// 给单个 sessionKey 长驻一个 CCB 子进程。
// CCB 命令行:
//   <runtime> <ccb-entry> -p \
//     --input-format=stream-json \
//     --output-format=stream-json \
//     --include-partial-messages \
//     [--resume <sessionId>] \
//     [--system-prompt-file <persona>] \
//     [--add-dir <cwd>] \
//     [--permission-mode <mode>]
//
// 我们写入 stdin 一行 JSON(SDK user message),从 stdout 读流式 JSONL(SDK 消息流)。
// CCB 自己处理 auth(订阅 OAuth / API key)、工具循环、压缩、CLAUDE.md。
// ───────────────────────────────────────────────

export interface SubprocessRunnerOpts {
  sessionKey: string
  agentId: string
  cwd: string
  config: OpenClaudeConfig
  persona?: string // 注入 system prompt 的文件
  model?: string
  permissionMode?: string
  resumeSessionId?: string // 续上之前的 CCB session
  // Per-agent overrides
  agentProvider?: string // 覆盖 config.provider
  agentMcpServers?: McpServerConfig[] // agent 专属 MCP servers
  agentToolsets?: string[] // resolved toolsets for this agent (filters MCP servers)
  delegationDepth?: number // current delegation recursion depth (0 = top-level)
}

// CCB 输出的 SDK message 类型(简化):兼容 stream-json 输出
export interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      is_error?: boolean
    }>
    stop_reason?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
}

export class SubprocessRunner extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  private currentSessionId: string | null = null
  private starting = false
  private closed = false
  /** Timestamp of last stdout activity — used for liveness detection */
  public lastActivityAt: number = Date.now()

  constructor(private opts: SubprocessRunnerOpts) {
    super()
    this.currentSessionId = opts.resumeSessionId ?? null
  }

  get sessionId(): string | null {
    return this.currentSessionId
  }

  async start(): Promise<void> {
    if (this.proc || this.starting) return
    this.starting = true

    const { config } = this.opts
    const ccbDir = resolve(config.auth.claudeCodePath)
    if (!existsSync(ccbDir)) {
      throw new Error(
        `Claude Code path not found: ${ccbDir}. Set auth.claudeCodePath in ~/.openclaude/openclaude.json`,
      )
    }
    const entry = config.auth.claudeCodeEntry ?? 'src/entrypoints/cli.tsx'
    const runtime = config.auth.claudeCodeRuntime ?? 'bun'

    // ─── L1/L2/L3: prepare learning-loop context for the subprocess ───
    const learningContext = await this.buildLearningContext()

    const args = [
      runtime === 'bun' ? 'run' : '--experimental-strip-types',
      entry,
      '-p',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose',
    ]
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.permissionMode) {
      args.push('--permission-mode', this.opts.permissionMode)
      // bypassPermissions 需要配合 --dangerously-skip-permissions 才真正 放行所有工具
      if (this.opts.permissionMode === 'bypassPermissions') {
        args.push('--dangerously-skip-permissions')
      }
    }
    // Single merged prompt file: persona + identity + platform + skills + memory
    // (Cannot pass --append-system-prompt-file twice; Commander takes last value only)
    if (learningContext.extraPromptFile)
      args.push('--append-system-prompt-file', learningContext.extraPromptFile)
    // Wire up MCP memory/skills/search server
    if (learningContext.mcpConfigFile) args.push('--mcp-config', learningContext.mcpConfigFile)
    if (this.opts.cwd) args.push('--add-dir', this.opts.cwd)
    if (this.currentSessionId) args.push('--resume', this.currentSessionId)

    // 必须给一个 prompt placeholder,CCB stream-json 会从 stdin 接管
    args.push('')

    // Determine pending dir for guard.py relay.
    // Cron sessions have no live user — skip the relay and let guard directly deny.
    const isCron = this.opts.sessionKey.includes(':cron:')
    const pendingDir = isCron ? '' : resolve(tmpdir(), 'openclaude-pending', this.opts.agentId)
    if (pendingDir) {
      try {
        mkdirSync(pendingDir, { recursive: true })
      } catch {}
    }

    // ── Provider-aware auth injection ──
    // CCB auth priority: ANTHROPIC_AUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN > settings.json
    // We must inject the right env vars per provider so CCB routes to the correct API.
    const providerEnv: Record<string, string> = {}
    const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider

    if (effectiveProvider === 'claude-subscription') {
      // Claude subscription: inject OAuth token, clear any MiniMax/third-party env
      // CLAUDE_CODE_OAUTH_TOKEN tells CCB to use Anthropic OAuth (api.anthropic.com)
      if (this.opts.config.auth.claudeOAuth?.accessToken) {
        providerEnv.CLAUDE_CODE_OAUTH_TOKEN = this.opts.config.auth.claudeOAuth.accessToken
      }
      // Clear settings.json overrides so CCB uses its native Anthropic endpoint
      providerEnv.ANTHROPIC_BASE_URL = ''
      providerEnv.ANTHROPIC_AUTH_TOKEN = ''
      providerEnv.ANTHROPIC_MODEL = ''
    } else if (effectiveProvider === 'codex' || effectiveProvider === 'openai') {
      // OpenAI/Codex: use Codex OAuth token via OpenAI-compatible endpoint
      // CCB doesn't natively support OpenAI, but OpenAI provides an Anthropic-compatible
      // proxy at https://api.openai.com/anthropic/ (or use a local proxy like LiteLLM)
      if (this.opts.config.auth.codexOAuth?.accessToken) {
        providerEnv.ANTHROPIC_AUTH_TOKEN = this.opts.config.auth.codexOAuth.accessToken
        // Note: OpenAI doesn't have an Anthropic-compatible endpoint by default.
        // Users need to configure a proxy (LiteLLM/OneAPI) or this won't work.
        // Leave ANTHROPIC_BASE_URL unset to let settings.json or env provide it.
      }
      // Don't inject Claude OAuth — that would override the Codex token
    } else {
      // MiniMax / DeepSeek / custom provider: DON'T inject any OAuth token.
      // Let CCB fall through to settings.json (which has ANTHROPIC_BASE_URL +
      // ANTHROPIC_AUTH_TOKEN pointing to the provider's Anthropic-compatible endpoint).
      // This is the "default" path — settings.json controls routing.
    }

    const backend: TerminalBackend = createBackend(this.opts.config.terminal)
    const proc = backend.spawn({
      command: runtime,
      args,
      cwd: ccbDir,
      env: {
        ...process.env,
        ...providerEnv,
        OPENCLAUDE_SESSION_KEY: this.opts.sessionKey,
        OPENCLAUDE_AGENT_ID: this.opts.agentId,
        OPENCLAUDE_PENDING_DIR: pendingDir,
        IS_SANDBOX: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // create process group so shutdown() can kill all children
    })

    this.proc = proc as unknown as ChildProcessWithoutNullStreams

    proc.stdin.on('error', (err) => console.warn('[subprocessRunner] stdin error:', err.message))
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => this.handleStdout(chunk))

    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (chunk: string) => {
      this.emit('stderr', chunk)
    })

    proc.on('exit', (code, signal) => {
      this.emit('exit', { code, signal })
      this.proc = null
      this.closed = true
    })

    proc.on('error', (err) => {
      this.emit('error', err)
    })

    this.starting = false
  }

  private handleStdout(chunk: string): void {
    this.lastActivityAt = Date.now()
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as SdkMessage
        if (msg.session_id && !this.currentSessionId) {
          this.currentSessionId = msg.session_id
          this.emit('session_id', this.currentSessionId)
        }
        this.emit('message', msg)
      } catch (err) {
        this.emit('parse_error', { line, err })
      }
    }
  }

  // 发送一条 user message。CCB stream-json 输入格式:每行一个 SDK user message JSON
  // content 可以是单个字符串(全文本),也可以是完整的 Anthropic content block 数组(支持图片/多模态)
  async submit(
    userTextOrBlocks: string | Array<{ type: string; [key: string]: unknown }>,
  ): Promise<void> {
    if (!this.proc) await this.start()
    if (!this.proc) throw new Error('failed to start CCB subprocess')
    const content =
      typeof userTextOrBlocks === 'string'
        ? [{ type: 'text', text: userTextOrBlocks }]
        : userTextOrBlocks
    const userMsg = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    }
    try {
      this.proc.stdin.write(`${JSON.stringify(userMsg)}\n`)
    } catch (err: any) {
      console.warn('[subprocessRunner] stdin write failed:', err.message)
    }
  }

  // ─── Build per-session learning-loop context files ───
  // Writes temp files under /tmp/openclaude-<sessionKey>/:
  //   extra-prompt.md   — USER.md content + skill metadata digest
  //   mcp-config.json   — MCP server pointing at @openclaude/mcp-memory
  private async buildLearningContext(): Promise<{
    extraPromptFile?: string
    mcpConfigFile?: string
  }> {
    const out: { extraPromptFile?: string; mcpConfigFile?: string } = {}
    const sessionDir = resolve(tmpdir(), `openclaude-${this.opts.agentId}`)
    try {
      mkdirSync(sessionDir, { recursive: true })
    } catch {}

    // Build merged extra system prompt via structured prompt slots
    try {
      const promptContent = await buildPromptContext({
        agentId: this.opts.agentId,
        persona: this.opts.persona,
        provider: this.opts.agentProvider ?? this.opts.config.provider,
        model: this.opts.model,
      })
      if (promptContent) {
        const path = resolve(sessionDir, 'extra-prompt.md')
        writeFileSync(path, promptContent)
        out.extraPromptFile = path
      }
    } catch (err) {
      console.warn('[subprocessRunner] failed to build extra prompt:', err)
    }

    // Write MCP config pointing at the mcp-memory stdio server
    // and any user-configured MCP servers (vision / search / image-gen / …).
    try {
      const mcpServers: Record<string, any> = {}

      // ── Built-in: openclaude-memory (L1/L2/L3 learning loop) ──
      const mcpServerEntry = resolve(
        new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'),
        '../../mcp-memory/src/index.ts',
      )
      const candidates = [
        mcpServerEntry,
        resolve(process.cwd(), 'packages/mcp-memory/src/index.ts'),
        resolve(
          this.opts.config.auth.claudeCodePath,
          '..',
          'openclaude/packages/mcp-memory/src/index.ts',
        ),
      ]
      const mcpEntry = candidates.find((p) => existsSync(p))
      if (mcpEntry) {
        mcpServers['openclaude-memory'] = {
          type: 'stdio',
          command: 'npx',
          args: ['tsx', mcpEntry],
          env: {
            OPENCLAUDE_AGENT_ID: this.opts.agentId,
            OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME ?? '',
            OPENCLAUDE_GATEWAY_PORT: String(this.opts.config.gateway.port),
            OPENCLAUDE_GATEWAY_TOKEN: this.opts.config.gateway.accessToken,
            OPENCLAUDE_DELEGATION_DEPTH: String(this.opts.delegationDepth ?? 0),
          },
        }
      } else {
        console.warn('[subprocessRunner] mcp-memory entry not found, skipping built-in MCP')
      }

      // ── MCP servers: three-layer merge + toolset filtering ──
      // Layer 1: System shared tools (no provider field) — always included
      // Layer 2: Global provider-scoped MCPs (filtered by effectiveProvider)
      // Layer 3: Agent-specific MCPs (override same-id globals)
      // Toolset filter: if agent has toolsets configured, only include MCPs
      // whose id appears in at least one of the agent's toolset definitions.
      const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider

      // Resolve toolset → allowed MCP server IDs
      const toolsetDefs = this.opts.config.toolsets
      const agentToolsets = this.opts.agentToolsets
      let allowedMcpIds: Set<string> | null = null // null = no filtering (all allowed)
      if (agentToolsets && agentToolsets.length > 0 && toolsetDefs) {
        allowedMcpIds = new Set<string>()
        for (const ts of agentToolsets) {
          const ids = toolsetDefs[ts]
          if (ids) for (const id of ids) allowedMcpIds.add(id)
        }
        // Built-in 'openclaude-memory' is always allowed regardless of toolset
        allowedMcpIds.add('openclaude-memory')
      }

      // Layer 1 + 2: Global MCPs
      for (const srv of this.opts.config.mcpServers ?? []) {
        if (srv.enabled === false) continue
        if (srv.provider && srv.provider !== effectiveProvider) continue
        if (allowedMcpIds && !allowedMcpIds.has(srv.id)) continue
        mcpServers[srv.id] = {
          type: 'stdio',
          command: srv.command,
          args: srv.args ?? [],
          env: srv.env ?? {},
        }
      }

      // Layer 3: Agent-specific MCPs (override same id, bypass toolset filter)
      for (const srv of this.opts.agentMcpServers ?? []) {
        if (srv.enabled === false) continue
        mcpServers[srv.id] = {
          type: 'stdio',
          command: srv.command,
          args: srv.args ?? [],
          env: srv.env ?? {},
        }
      }

      if (Object.keys(mcpServers).length > 0) {
        const mcpPath = resolve(sessionDir, 'mcp-config.json')
        writeFileSync(mcpPath, JSON.stringify({ mcpServers }, null, 2))
        out.mcpConfigFile = mcpPath
      }
    } catch (err) {
      console.warn('[subprocessRunner] failed to write mcp config:', err)
    }

    return out
  }

  // 发送 interrupt control request — CCB 会中止当前 turn
  interrupt(): boolean {
    if (!this.proc) return false
    try {
      const req = {
        type: 'control_request',
        request_id: `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        request: { subtype: 'interrupt' },
      }
      this.proc.stdin.write(`${JSON.stringify(req)}\n`)
      return true
    } catch {
      return false
    }
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return
    try {
      this.proc.stdin.end()
    } catch {}
    const proc = this.proc
    const pid = proc.pid
    await new Promise<void>((res) => {
      const timer = setTimeout(() => {
        // Kill entire process group (including MCP subprocesses)
        try {
          if (pid) process.kill(-pid, 'SIGKILL') // negative pid = process group
        } catch {
          try {
            proc.kill('SIGKILL')
          } catch {}
        }
        res()
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(timer)
        res()
      })
    })
    this.proc = null
    this.closed = true
  }
}
