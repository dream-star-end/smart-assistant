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
  /** CCB effort level — 'xhigh' / 'max' 触发科研守则 slot,其它值(含 undefined)不触发。
   *  仅在 Opus 4.7 + 用户选了"科研模式"pill 时会是 xhigh/max。 */
  effortLevel?: string
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

// ── 科研模式 slot ──
// 仅在 effortLevel = 'xhigh' / 'max' 时注入,驱动 agent 在涉及数值/公式/跨领域
// 表达时更严谨。这不是对话 preamble(不注入 user text),而是 extra-prompt 里
// 一条常驻守则,下一次 CCB 启动(effort 切换本来就会 recycle runner)自动生效。
//
// 设计原则:只写 agent 能直接执行的行为规则,不写空泛倡导。alice(科研用户)
// 历史对话里暴露的 6 类问题是这条 slot 的直接动机 —— 参见 memory
// `feedback_scientific_numbers` 及 alice 5 条会话的真实痛点。
//
// 触发条件**仅** effortLevel === 'max'(UI 上叫"科研模式")。xhigh 是"编码模式",
// 它也需要高 effort 但语义不同,不应继承这套科学严谨度守则(否则用户在
// 编码模式下也会被"数值保守 / 公式前提 / 误差分类"污染)。
// 未来如果要把"模式"和"effort"解耦,应在 PromptSlotContext 里新增
// conversationMode 字段,不复用 effortLevel。
const RESEARCH_EFFORT_LEVELS = new Set(['max'])

export function buildResearchSlot(ctx: PromptSlotContext): PromptSlot | null {
  if (!ctx.effortLevel || !RESEARCH_EFFORT_LEVELS.has(ctx.effortLevel)) return null
  return {
    name: 'RESEARCH',
    content: [
      '# 科研模式守则',
      '',
      '当前会话已由用户切到高思考档位,按**科研严谨度**标准作答。以下守则对本会话的',
      '所有数值结论、公式推导、跨领域表达生效。不要在回答里复述这段守则,只执行。',
      '',
      '## 1. 数值结论默认保守',
      '',
      '- 给出范围或 1σ 不确定度,而不是单点乐观值。',
      '- 若问题性质允许,按**保守 / 中位 / 乐观**三档列出,并明示取用哪档的前提。',
      '- 关键数字(设备指标、精度、传播参数等)若来自经验估算而非已核实文献,',
      '  在数字后用 `[需核查]` 标记,方便用户回查。',
      '',
      '## 2. 误差传播必须分类',
      '',
      '- 明确区分**随机误差**(按 √N 衰减,N 为独立观测量)与**系统误差**(与 N 无关)。',
      '- 禁止对系统性误差套用 √N 缩减。禁止把"观测量减少 k 倍 → 精度退化 √k 倍"',
      '  当作普适结论:它只在纯热噪声主导时成立。',
      '- 涉及多项误差合成时,默认按平方和开方(RSS),并注明是否考虑相关性。',
      '',
      '## 3. 公式/关系用完后自检前提',
      '',
      '- 引用 $\\sigma \\propto 1/\\sqrt{N}$、$N(N-1)/2$、GDOP、Fisher 矩阵等关系时,',
      '  一行注明前提("假设独立、同方差、线性化后 ..."),若该前提在问题中不成立,',
      '  显式指出并给出修正量级。',
      '- 避免"按比例外推"式推理(例如时间缩短 12 倍 → 精度退化 √12 倍)未经',
      '  几何/耦合分析的单独使用 —— 几何(GDOP)和大气-高程相关耦合应单独计入。',
      '',
      '## 4. 专业缩写首次出现给全称',
      '',
      '- GDOP / EOP / VLBI / ZWD / WVR / SEFD / ICRF 等缩写在**每条回答内的首次**',
      '  出现后,用括号给中文或英文全称一次,后续可省略。',
      '- 用户若要求"给其它领域人看",全部缩写展开并加一句人话解释。',
      '',
      '## 5. 单位与符号一致',
      '',
      '- 同一条回答里不要混用 ps/ns、mm/mrad、度/°、km/m。统一到最适合量级的那个,',
      '  换算一次即可。',
      '- LaTeX 公式里的变量与正文叙述里的符号保持一致,避免同一量用两种记号。',
      '',
      '## 6. 多轮参数方案对照',
      '',
      '- 用户连续改参数(观测时长、站数、频带、基线)迭代方案时,在合适的回合',
      '  维护一张**方案对照表**,一行一个方案,列出与本轮相关的 5~8 个关键列,',
      '  差分高亮"本轮改了哪些"。避免每次重画完整表格。',
      '',
      '## 7. 浓缩请求的结构模板',
      '',
      '用户要求"一页纸"/"半页纸"/"摘要"时,统一按以下四段结构:',
      '**背景 → 核心问题 → 关键数据(1 张小表) → 结论**。不要保留详细推导。',
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

  // Layer 4: 用户显式选中的模式(科研模式等)。放最后,离 user 消息最近,
  // 提升 agent 对"本会话约束"的遵循度。不选就不注入。
  const research = buildResearchSlot(ctx)
  if (research) slots.push(research)

  return slots.map((s) => s.content).join(SEPARATOR)
}
