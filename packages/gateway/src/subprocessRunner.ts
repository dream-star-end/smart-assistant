import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, SkillStore, paths, readAgentsConfig, type OpenClaudeConfig, type McpServerConfig } from '@openclaude/storage'

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
  agentProvider?: string  // 覆盖 config.provider
  agentMcpServers?: McpServerConfig[] // agent 专属 MCP servers
}

// CCB 输出的 SDK message 类型(简化):兼容 stream-json 输出
export interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  message?: {
    role?: string
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }>
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
      throw new Error(`Claude Code path not found: ${ccbDir}. Set auth.claudeCodePath in ~/.openclaude/openclaude.json`)
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
    if (learningContext.mcpConfigFile)
      args.push('--mcp-config', learningContext.mcpConfigFile)
    if (this.opts.cwd) args.push('--add-dir', this.opts.cwd)
    if (this.currentSessionId) args.push('--resume', this.currentSessionId)

    // 必须给一个 prompt placeholder,CCB stream-json 会从 stdin 接管
    args.push('')

    // Determine pending dir for guard.py relay.
    // Cron sessions have no live user — skip the relay and let guard directly deny.
    const isCron = this.opts.sessionKey.includes(':cron:')
    const pendingDir = isCron
      ? ''
      : resolve(tmpdir(), 'openclaude-pending', this.opts.agentId)
    if (pendingDir) {
      try { mkdirSync(pendingDir, { recursive: true }) } catch {}
    }

    // Inject Claude OAuth token if subscription mode is active
    const oauthEnv: Record<string, string> = {}
    if (this.opts.config.auth.mode === 'subscription' && this.opts.config.auth.claudeOAuth?.accessToken) {
      oauthEnv.CLAUDE_CODE_OAUTH_TOKEN = this.opts.config.auth.claudeOAuth.accessToken
    }

    const proc = spawn(runtime, args, {
      cwd: ccbDir,
      env: {
        ...process.env,
        ...oauthEnv,
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
    try { this.proc.stdin.write(`${JSON.stringify(userMsg)}\n`) } catch (err: any) {
      console.warn('[subprocessRunner] stdin write failed:', err.message)
    }
  }

  // ─── Build per-session learning-loop context files ───
  // Writes temp files under /tmp/openclaude-<sessionKey>/:
  //   extra-prompt.md   — USER.md content + skill metadata digest
  //   mcp-config.json   — MCP server pointing at @openclaude/mcp-memory
  private async buildLearningContext(): Promise<{ extraPromptFile?: string; mcpConfigFile?: string }> {
    const out: { extraPromptFile?: string; mcpConfigFile?: string } = {}
    const sessionDir = resolve(tmpdir(), `openclaude-${this.opts.agentId}`)
    try {
      mkdirSync(sessionDir, { recursive: true })
    } catch {}

    // Build the merged extra system prompt.
    // Layered for cache-friendliness: static/identity first, dynamic last.
    //
    // Layer 1 (STATIC - rarely changes, identity core):
    //   - Agent persona (CLAUDE.md)
    //   - User identity (USER.md)
    //
    // Layer 2 (SEMI-STATIC - changes when config/skills change):
    //   - Platform capabilities
    //   - Skills list summary
    //   - Provider-specific MCP tips
    //
    // Layer 3 (DYNAMIC - changes per session):
    //   - Memory notes (MEMORY.md)
    //   - Tool usage hints
    try {
      const memStore = new MemoryStore(this.opts.agentId)
      await memStore.load()
      const skillStore = new SkillStore(this.opts.agentId)
      const skillList = await skillStore.list()

      const parts: string[] = []

      // ═══════════ LAYER 1: IDENTITY (static, most important) ═══════════

      // Agent persona (CLAUDE.md) — WHO AM I
      let personaBlock = ''
      if (this.opts.persona && existsSync(this.opts.persona)) {
        const raw = readFileSync(this.opts.persona, 'utf-8').trim()
        if (raw) personaBlock = `# WHO I AM (Agent Persona)\n\n${raw}`
      }
      if (personaBlock) parts.push(personaBlock)

      // User identity (USER.md) — WHO IS THE USER
      const userBlock = memStore.formatForSystemPrompt('user')
      if (userBlock) parts.push(userBlock)

      // ═══════════ LAYER 2: CAPABILITIES (semi-static) ═══════════

      // Platform capabilities + sub-agent guidance
      parts.push([
        '# Platform capabilities',
        '',
        '你是 OpenClaude 平台上的 AI 助手,用户通过 Web 浏览器与你交互。',
        '你运行在服务器本机上(不需要 SSH 连接自己,直接执行 Bash 命令即可)。',
        '',
        '**文件分享**: 回复中写文件的绝对路径即可,前端自动渲染为内联媒体。不要建议 SCP/wget。',
        '**多媒体生成**: MCP 工具返回的 URL 或路径直接告诉用户,前端自动内联展示。',
        '',
        '## 内联富内容',
        '',
        '你的回复支持特殊代码块,前端会自动渲染为可视化内容:',
        '',
        '- **```chart** — Chart.js 图表(柱状图/折线图/饼图),写 JSON 配置即可',
        '- **```mermaid** — 流程图/时序图/甘特图/类图等',
        '- **```htmlpreview** — **完整 HTML+CSS+JS 沙盒**,支持 Canvas 动画、交互式 UI、游戏等',
        '',
        '当用户要求可视化内容时,**优先使用这些内联代码块**而不是写文件。',
        '示例: 用户说"画一个粒子动画" → 用 ```htmlpreview 写完整 HTML(含 <canvas> + JS),直接在聊天中渲染。',
        '示例: 用户说"画个柱状图" → 用 ```chart 写 Chart.js JSON 配置。',
        '**不要**把 HTML 写成文件再用浏览器打开,直接用 htmlpreview 代码块。',
        '',
        '## 子 Agent 与并行处理',
        '',
        '你可以使用 Agent 工具 spawn 子 agent 来并行处理独立的子任务。主动使用此能力:',
        '- **独立研究任务**: 搜索文件、分析代码结构、调研 → 用子 agent',
        '- **多文件并行操作**: 同时修改多个不相关文件 → 启动多个子 agent',
        '- **耗时操作**: 大规模搜索、批量处理 → 用子 agent 在后台执行',
        '- **保持响应**: 当任务可能超过 30 秒时,考虑用子 agent 异步处理',
        '',
        '子 agent 会继承你的全部工具和上下文。用户在 UI 中能看到子任务的进度卡片。',
        '',
        '## 浏览器操作',
        '',
        '你有内置 Playwright 浏览器工具,可以自主浏览和操作任何网页:',
        '',
        '1. `browser_navigate(url)` → 打开网页',
        '2. `browser_snapshot()` → 获取页面 accessibility tree + 元素 ref 编号',
        '3. `browser_click(ref="XX")` / `browser_type(ref="XX", text="...")` → 用 ref 操作',
        '4. 重复 2-3 直到完成',
        '',
        '常用场景: 搜索信息、填表单、登录网站、抓取数据。',
        '优先用 snapshot(文本,省token),只在需要视觉确认时用 screenshot。',
        '详细操作指南见 skill `browser-automation`。',
      ].join('\n'))

      // Skills summary (truncated to top 15 for budget)
      if (skillList.length > 0) {
        const top = skillList.slice(0, 15)
        const lines = [
          '# Skills (' + skillList.length + ')',
          '',
          '可用 `skill_view(name)` 加载完整指令:',
        ]
        for (const s of top) lines.push(`- **${s.name}** — ${s.description}`)
        if (skillList.length > 15) lines.push(`- ... 还有 ${skillList.length - 15} 个 (用 skill_list() 查看全部)`)
        parts.push(lines.join('\n'))
      }

      // Provider-specific MCP tips
      const provider = this.opts.agentProvider ?? this.opts.config.provider
      if (provider === 'minimax') {
        parts.push([
          '# MiniMax MCP 参数提示',
          '',
          '**text_to_audio**: 必须传 `model="speech-2.8-hd"` + `emotion="neutral"` (MCP 默认 speech-2.6-hd 不可用)',
          '**text_to_image**: 默认 image-01 可用,传 `aspect_ratio` 控制比例',
          '**understand_image**: 传 `image_file="绝对路径"` 或 `image_url="https://..."` (主模型不支持多模态)',
        ].join('\n'))
      }

      // ═══════════ LAYER 3: DYNAMIC (changes frequently) ═══════════

      // Memory notes (MEMORY.md)
      const memoryBlock = memStore.formatForSystemPrompt('memory')
      if (memoryBlock) parts.push(memoryBlock)

      // Tool usage hints — tiered memory + skill auto-generation
      parts.push([
        '# 学习系统',
        '',
        '## 三层记忆',
        '',
        '| 层级 | 工具 | 容量 | 何时用 |',
        '|------|------|------|--------|',
        '| Core | `memory(add/read, "user"/"memory")` | 2K+4K chars | 高频事实、用户身份,每次对话自动可见 |',
        '| Recall | `session_search(query)` | 无限 | 回忆过去对话内容 |',
        '| Archival | `archival_add/search/delete` | 无限 | 详细知识、文档、代码模式(需搜索才可见) |',
        '',
        '**原则**: 高频→Core, 详细→Archival, Core满了→迁移到Archival',
        '',
        '## 定时提醒',
        '',
        '用户说"X分钟后提醒我..."或"每天N点..."时,用 `create_reminder` 工具:',
        '用户要求定时提醒时,使用 `create_reminder` 工具(不要用其他定时工具):',
        '- `create_reminder(schedule="分 时 日 月 周", message="内容", oneshot=true)`',
        '- 时间用用户本地时区的 crontab 格式',
        '- 示例: 5分钟后 → 计算当前时间+5分钟 → `"M H D Mon *"`',
        '',
        '## 多 Agent 协作',
        '',
      ].join('\n'))

      // Dynamically inject available agents list
      try {
        const agentsCfg = await readAgentsConfig()
        const otherAgents = agentsCfg.agents.filter(a => a.id !== this.opts.agentId)
        if (otherAgents.length > 0) {
          const agentLines = ['你当前是 `' + this.opts.agentId + '`。系统中还有以下 agent 可以协作:', '']
          for (const a of otherAgents) {
            const name = a.displayName || a.id
            const model = a.model ? `${a.model}` : '默认模型'
            const provider = a.provider || '继承全局'
            // Read first meaningful line of persona as capability description
            let capability = ''
            try {
              const personaPath = a.persona || paths.agentClaudeMd(a.id)
              if (existsSync(personaPath)) {
                const raw = readFileSync(personaPath, 'utf-8')
                const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
                if (lines[0]) capability = ' — ' + lines[0].slice(0, 80)
              }
            } catch {}
            agentLines.push(`- **${name}** (\`${a.id}\`) [${model}, ${provider}]${capability}`)
          }
          agentLines.push('')
          agentLines.push('使用 `send_to_agent(agentId, message)` 向它们发送消息,结果异步推送给用户。')
          agentLines.push('选择 agent 时考虑其模型和能力特长。')
          parts.push(agentLines.join('\n'))
        }
      } catch {}

      parts.push([
        '## 技能自生成',
        '',
        '完成 3+ 工具调用的复杂任务后,**立即**评估:',
        '1. `skill_list()` 检查是否已有类似 skill',
        '2. 如果没有且模式可复用 → `skill_save(name, desc, body)`',
        '3. 好的 skill = 步骤 + 注意事项 + 命令模板',
        '',
        '你是一个持久化、自进化的 agent。主动使用这些工具让自己越来越好。',
      ].join('\n'))

      if (parts.length > 0) {
        const path = resolve(sessionDir, 'extra-prompt.md')
        writeFileSync(path, parts.join('\n\n---\n\n'))
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
        resolve(this.opts.config.auth.claudeCodePath, '..', 'openclaude/packages/mcp-memory/src/index.ts'),
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
          },
        }
      } else {
        console.warn('[subprocessRunner] mcp-memory entry not found, skipping built-in MCP')
      }

      // ── MCP servers: three-layer merge ──
      // Layer 1: System shared tools (no provider field) — always included
      // Layer 2: Global provider-scoped MCPs (filtered by effectiveProvider)
      // Layer 3: Agent-specific MCPs (override same-id globals)
      const effectiveProvider = this.opts.agentProvider ?? this.opts.config.provider

      // Layer 1 + 2: Global MCPs
      for (const srv of this.opts.config.mcpServers ?? []) {
        if (srv.enabled === false) continue
        if (srv.provider && srv.provider !== effectiveProvider) continue
        mcpServers[srv.id] = {
          type: 'stdio',
          command: srv.command,
          args: srv.args ?? [],
          env: srv.env ?? {},
        }
      }

      // Layer 3: Agent-specific MCPs (override same id)
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
          try { proc.kill('SIGKILL') } catch {}
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
