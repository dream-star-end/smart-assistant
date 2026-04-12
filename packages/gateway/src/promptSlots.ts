/**
 * Prompt Slots — structured system prompt assembly for OpenClaude agents.
 *
 * Each slot has a fixed role, source, and priority. The slots are assembled
 * in cache-friendly order: static content first (rarely changes), dynamic last.
 *
 * Slot order:
 *   1. SOUL    — Agent persona (CLAUDE.md / SOUL.md), rarely changes
 *   2. USER    — User identity & preferences (USER.md), rarely changes
 *   3. AGENTS  — Platform capabilities, agent list, provider tips (semi-static)
 *   4. SKILLS  — Skill summaries (semi-static, changes when skills are added)
 *   5. MEMORY  — Agent notes (MEMORY.md), changes frequently
 *   6. TOOLS   — Tool usage hints, learning system instructions (static reference)
 */
import { existsSync, readFileSync } from 'node:fs'
import { MemoryStore, SkillStore, paths, readAgentsConfig } from '@openclaude/storage'

export interface PromptSlotContext {
  agentId: string
  persona?: string // path to CLAUDE.md / SOUL.md
  provider?: string
  model?: string
}

export interface PromptSlot {
  name: string
  content: string
}

// ── Individual slot builders ──

export function buildSoulSlot(ctx: PromptSlotContext): PromptSlot | null {
  // Try SOUL.md first, then CLAUDE.md
  const soulPath = paths.agentDir(ctx.agentId) ? `${paths.agentDir(ctx.agentId)}/SOUL.md` : null
  let raw = ''
  if (soulPath && existsSync(soulPath)) {
    raw = readFileSync(soulPath, 'utf-8').trim()
  } else if (ctx.persona && existsSync(ctx.persona)) {
    raw = readFileSync(ctx.persona, 'utf-8').trim()
  }
  if (!raw) return null
  return { name: 'SOUL', content: `# WHO I AM (Agent Persona)\n\n${raw}` }
}

export async function buildUserSlot(ctx: PromptSlotContext): Promise<PromptSlot | null> {
  const memStore = new MemoryStore(ctx.agentId)
  await memStore.load()
  const block = memStore.formatForSystemPrompt('user')
  if (!block) return null
  return { name: 'USER', content: block }
}

export async function buildAgentsSlot(ctx: PromptSlotContext): Promise<PromptSlot> {
  const lines = [
    '# Platform capabilities',
    '',
    '你是 OpenClaude 平台上的 AI 助手,用户通过 Web 浏览器与你交互。',
    '你运行在服务器本机上(不需要 SSH 连接自己,直接执行 Bash 命令即可)。',
    '',
    '## 多媒体与文件',
    '',
    '发送文件给用户: 直接写**绝对路径**(如 `/root/.openclaude/generated/photo.png`),不要用 `![]()` 语法。',
    '详细规则见 `skill_view("platform-capabilities")`。',
    '',
    '## 内联富内容: `chart` / `mermaid` / `htmlpreview` 代码块',
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
  ]

  // Dynamically inject available agents list
  try {
    const agentsCfg = await readAgentsConfig()
    const otherAgents = agentsCfg.agents.filter((a) => a.id !== ctx.agentId)
    if (otherAgents.length > 0) {
      lines.push('')
      lines.push('## 多 Agent 协作')
      lines.push('')
      lines.push(`你当前是 \`${ctx.agentId}\`。系统中还有以下 agent 可以协作:`)
      lines.push('')
      for (const a of otherAgents) {
        const name = a.displayName || a.id
        const model = a.model ? `${a.model}` : '默认模型'
        const provider = a.provider || '继承全局'
        let capability = ''
        try {
          const personaPath = a.persona || paths.agentClaudeMd(a.id)
          if (existsSync(personaPath)) {
            const raw = readFileSync(personaPath, 'utf-8')
            const capLines = raw
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith('#'))
            if (capLines[0]) capability = ` — ${capLines[0].slice(0, 80)}`
          }
        } catch {}
        lines.push(`- **${name}** (\`${a.id}\`) [${model}, ${provider}]${capability}`)
      }
      lines.push('')
      lines.push('**异步**: `send_to_agent(agentId, message)` — 结果推送给用户,你不等待。')
      lines.push(
        '**同步**: `delegate_task(goal, agentId?, context?)` — 等待子 agent 完成,你直接收到结果。',
      )
      lines.push(
        '选择 agent 时考虑其模型和能力特长。需要用结果继续处理 → delegate_task,只需通知 → send_to_agent。',
      )
    }
  } catch {}

  // Provider-specific tips
  const provider = ctx.provider
  if (provider === 'minimax') {
    lines.push('')
    lines.push('## MiniMax MCP 参数提示')
    lines.push('')
    lines.push(
      '**text_to_audio**: 必须传 `model="speech-2.8-hd"` + `emotion="neutral"` (MCP 默认 speech-2.6-hd 不可用)',
    )
    lines.push('**text_to_image**: 默认 image-01 可用,传 `aspect_ratio` 控制比例')
    lines.push(
      '**understand_image**: 传 `image_file="绝对路径"` 或 `image_url="https://..."` (主模型不支持多模态)',
    )
  }

  return { name: 'AGENTS', content: lines.join('\n') }
}

export async function buildSkillsSlot(ctx: PromptSlotContext): Promise<PromptSlot | null> {
  const skillStore = new SkillStore(ctx.agentId)
  const skillList = await skillStore.list()
  if (skillList.length === 0) return null
  const top = skillList.slice(0, 15)
  const lines = [`# Skills (${skillList.length})`, '', '可用 `skill_view(name)` 加载完整指令:']
  for (const s of top) lines.push(`- **${s.name}** — ${s.description}`)
  if (skillList.length > 15)
    lines.push(`- ... 还有 ${skillList.length - 15} 个 (用 skill_list() 查看全部)`)
  return { name: 'SKILLS', content: lines.join('\n') }
}

export async function buildMemorySlot(ctx: PromptSlotContext): Promise<PromptSlot | null> {
  const memStore = new MemoryStore(ctx.agentId)
  await memStore.load()
  const block = memStore.formatForSystemPrompt('memory')
  if (!block) return null
  return { name: 'MEMORY', content: block }
}

export function buildToolsSlot(): PromptSlot {
  // Inject current server time so agents can compute cron expressions
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

  return {
    name: 'TOOLS',
    content: [
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
      '## 定时任务',
      '',
      `**当前服务器时间**: ${timeStr}`,
      '',
      '用户要求定时任务或提醒时,**必须立即创建,不要说做不到**。',
      '快速用法: `create_reminder(schedule="分 时 日 月 周", message="内容", oneshot=true)`',
      '详细指南见 `skill_view("scheduled-tasks")`。',
      '',
      '## 技能自生成',
      '',
      '完成 3+ 工具调用的复杂任务后,**立即**评估:',
      '1. `skill_list()` 检查是否已有类似 skill',
      '2. 如果没有且模式可复用 → `skill_save(name, desc, body)`',
      '3. 好的 skill = 步骤 + 注意事项 + 命令模板',
      '',
      '你是一个持久化、自进化的 agent。主动使用这些工具让自己越来越好。',
    ].join('\n'),
  }
}

// ── Unified builder ──

const SEPARATOR = '\n\n---\n\n'

/**
 * Build the complete extra-prompt by assembling all slots in order.
 * Returns the merged string ready to write to extra-prompt.md.
 */
export async function buildPromptContext(ctx: PromptSlotContext): Promise<string> {
  const slots: PromptSlot[] = []

  // Layer 1: Static identity
  const soul = buildSoulSlot(ctx)
  if (soul) slots.push(soul)

  const user = await buildUserSlot(ctx)
  if (user) slots.push(user)

  // Layer 2: Semi-static capabilities
  const agents = await buildAgentsSlot(ctx)
  slots.push(agents)

  const skills = await buildSkillsSlot(ctx)
  if (skills) slots.push(skills)

  // Layer 3: Dynamic context
  const memory = await buildMemorySlot(ctx)
  if (memory) slots.push(memory)

  const tools = buildToolsSlot()
  slots.push(tools)

  return slots.map((s) => s.content).join(SEPARATOR)
}
