/**
 * Prompt Slots — structured system prompt assembly for OpenClaude agents.
 *
 * Each slot has a fixed role, source, and priority. The slots are assembled
 * in cache-friendly order: static content first (rarely changes), dynamic last.
 *
 * Slot order(实际生效顺序;按 cache-friendly 静态在前、动态在后排):
 *   1. SOUL              — Agent persona (CLAUDE.md / SOUL.md), rarely changes
 *   2. USER              — User identity & preferences (USER.md), rarely changes
 *   3. AGENTS            — Platform capabilities, agent list, provider tips (semi-static)
 *   4. SKILLS            — Agent 自有 skill summaries (semi-static)
 *   5. SKILLS_LITERATURE — 平台供给文献检索能力 (personal: commercial 反向钩子;v3 容器: master GET fetch;两条路径互斥;none 时不出现)
 *   6. MEMORY            — Agent notes (MEMORY.md), changes frequently
 *   7. TOOLS             — Tool usage hints, learning system instructions (static reference)
 *   8. MODEL_HINT        — per-model 行为补丁 (personal: commercial 反向钩子;v3 容器: master GET fetch;两条路径互斥;none 时不出现)
 *   9. RESEARCH          — 用户显式选中的科研模式守则 (effortLevel='max')
 *   10. REPO             — 当前会话 GitHub repo 绑定快照 (离 user 消息最近)
 */
import { existsSync, readFileSync } from 'node:fs'
import { request as undiciRequest } from 'undici'
import { MemoryStore, SkillStore, paths, readAgentsConfig } from '@openclaude/storage'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'

export interface PromptSlotContext {
  agentId: string
  persona?: string // path to CLAUDE.md / SOUL.md
  provider?: string
  model?: string
  /** CCB effort level — 'xhigh' / 'max' 触发科研守则 slot,其它值(含 undefined)不触发。
   *  仅在 Opus 4.7 + 用户在"思考深度"菜单里选到 xhigh/max 档位时才会是这两个值
   *  (UI 入口见 packages/web/public/modules/effortMode.js)。 */
  effortLevel?: string
  /** Phase 5 — 当前会话的 GitHub repo 绑定快照(来自 SessionRepoWorkspaceManager.getRepoSnapshot(sessionId))。
   *  null = 没绑定;否则按 status 三态生成 repo slot。 */
  repoSnapshot?: RepoSnapshot | null
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

// ── 科研严谨度 slot ──
// 仅在 effortLevel = 'max' 时注入,驱动 agent 在涉及数值/公式/跨领域表达时
// 更严谨。这不是对话 preamble(不注入 user text),而是 extra-prompt 里一条
// 常驻守则,下一次 CCB 启动(effort 切换本来就会 recycle runner)自动生效。
//
// 设计原则:只写 agent 能直接执行的行为规则,不写空泛倡导。alice(科研用户)
// 历史对话里暴露的 6 类问题是这条 slot 的直接动机 —— 参见 memory
// `feedback_scientific_numbers` 及 alice 5 条会话的真实痛点。
//
// 触发条件**仅** effortLevel === 'max'(即"思考深度"菜单里的"最高"档位)。
// xhigh("更高"档,偏长链路编码)不继承这套科学严谨度守则 —— 否则用户在编码
// 任务里也会被"数值保守 / 公式前提 / 误差分类"污染。
// 2026-04-22 重构:前端把原来的"科研模式 pill"合并进统一的"思考深度"菜单,
// 此处的 slot 触发条件不变 —— 仍然只认 effortLevel === 'max'。
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
      '## 5. 单位与符号一致(单位守卫)',
      '',
      '- 同一条回答里不要混用 ps/ns、mm/mrad、度/°、km/m。统一到最适合量级的那个,',
      '  换算一次即可。',
      '- LaTeX 公式里的变量与正文叙述里的符号保持一致,避免同一量用两种记号。',
      '- **涉及物理/工程量的数值必须带单位**(如距离、时间、角度、频率、功率、SEFD、',
      '  信噪比的绝对量、通量等)。以下场景**不需要**强加单位:年号/日期/版本号/',
      '  序号/索引/页码/计数、百分比(带 % 自己就够)、无量纲比值、参数个数、',
      '  章节编号、表格行号。',
      '- 回答即将结束前,对**物理/工程量**扫一遍:漏单位的补上,混用的改统一,',
      '  换算明显错的就改(不要留给用户自己发现)。这一步不必复述,直接改正即可。',
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
      '',
      '## 8. 默认受众与自检(无需用户提示)',
      '',
      '- **默认受众=同行**:可保留专业缩写与公式表述,缩写按 §4 给一次全称即可。',
      '  仅当用户明确表示受众变化(如"给跨领域看"/"给老板/PI 听"/"给新同学讲"/',
      '  "摘要给非专业人"/"过会用"等)时,切到对应受众模式。',
      '- 回答收尾前,**主动**做两项快扫,不需要用户点按钮、不必输出"已检查"字样,',
      '  发现问题就在正文里改掉:',
      '  1. **单位/量纲**:照 §5 标准,漏单位补、混用统一、换算明显错就改。',
      '  2. **来源/数字**:对外部声明、数值、公式来源,按 §1 标 `[需核查]`,或在',
      '     回答末尾用一个简短"来源/出处"列表(2~6 行,DOI/arXiv/年份/可信度三档:',
      '     已核实 / 待核实 / 凭印象)。无外部声明就省略。',
      '- 公式推导若 §3 的前提自检失败,回答里直接给出修正,不要假装通过。',
    ].join('\n'),
  }
}

// ── Phase 5: Session GitHub repo slot ──
//
// 三态(none → 不进 slots[]):
//   - cloning: 克隆中,提示不要写 repo 内文件
//   - ready:  workspaceDir + headSha 给 CCB,提示 Bash cwd 已就位
//   - failed: errorCode + 中性化文本(不指挥用户怎么做,只陈述事实)
//
// 注入位置:在 RESEARCH slot 之后(=最后一段),离 user 消息最近,提升 agent 对
// "本会话仓库约束"的遵循度。
export function buildRepoSlot(ctx: PromptSlotContext): PromptSlot | null {
  const snap = ctx.repoSnapshot
  if (!snap) return null
  const { owner, repo, branch, status } = snap

  if (status === 'cloning' || status === 'pending') {
    return {
      name: 'REPO',
      content: [
        '# 当前会话 GitHub 仓库',
        '',
        `仓库:\`${owner}/${repo}\` 分支 \`${branch}\``,
        '状态:正在克隆,工作目录尚未就绪。本轮回答中**不要**对仓库内文件执行写操作。',
      ].join('\n'),
    }
  }

  if (status === 'ready' && snap.workspaceDir) {
    const headShort = snap.headSha ? snap.headSha.slice(0, 7) : '?'
    return {
      name: 'REPO',
      content: [
        '# 当前会话 GitHub 仓库',
        '',
        `仓库:\`${owner}/${repo}\` 分支 \`${branch}\` HEAD \`${headShort}\``,
        `本地工作目录:\`${snap.workspaceDir}\``,
        'Bash 工具默认 cwd 已指向该目录;`git status` / `git diff` / `git push` 均可使用,',
        'push 时 git credential helper 会自动用 GitHub token 鉴权。',
      ].join('\n'),
    }
  }

  if (status === 'failed') {
    return {
      name: 'REPO',
      content: [
        '# 当前会话 GitHub 仓库',
        '',
        `仓库:\`${owner}/${repo}\` 分支 \`${branch}\` 克隆失败:\`${snap.errorCode ?? 'unknown'}\``,
        '当前没有可用的仓库工作目录。',
      ].join('\n'),
    }
  }

  return null
}

// ── MODEL_HINT slot — per-model behavioral patch ──
//
// 设计要点:
// - 模型行为补丁(如 DeepSeek "完成一步不要早 yield")是模型层面属性,不是
//   runner 层面 — CCB 和 codex backend 走同一条 buildPromptContext,所以
//   都会被注入。某模型不需要补丁就在其 source 处返 null/空字串即可。
// - Gateway 对 commercial 包**零编译期依赖**:用模块级 provider 钩子注入。
//   commercial 启动时调 setModelHintProvider 注册查询函数;personal 不调
//   就 noop。不能在这里直接 import @openclaude/commercial。
// - Provider 抛错 / 返非法形状 → 当作 null,只 log warn,不让 prompt 构建失败。
// - 实际 source-of-truth 在 commercial 的 model_pricing.extra_system_prompt;
//   admin 改了 → PricingCache NOTIFY reload → 下次 spawn 立即生效。
//
// 返回 `{ id, text }`:
// - `text` 是要注入到 prompt 的文案
// - `id` 是 provider 已经做完归一化的 **canonical model id**(例:任意
//   `deepseek-v4-pro-XXX` 都返 'deepseek-v4-pro')。runner 用这个 id 作为
//   `oc_model_hint_applied_total` 的 label,基数严格受 model_pricing 表行数
//   约束;如果直接用 spawn 入参的 raw model 当 label,外部可控字符串能把
//   Prom counter cardinality 打爆,等同观测面 DoS。
export interface ModelHintResult {
  id: string
  text: string
}
export type ModelHintProvider = (modelId: string) => ModelHintResult | null | undefined

let _modelHintProvider: ModelHintProvider | null = null

/**
 * 注入/清除 model hint provider。
 * - commercial 启动时调一次注入;shutdown 时调 setModelHintProvider(null) 清理。
 * - 测试中务必在 afterEach 里 setModelHintProvider(null),避免 cross-test 污染。
 */
export function setModelHintProvider(p: ModelHintProvider | null): void {
  _modelHintProvider = p
}

/**
 * 内部用 — buildModelHintSlot 的返回带额外 `canonicalId`,供 buildPromptContext
 * 把 id 传入 PromptSlotApplied.meta。外部直接调 buildModelHintSlot 时也能拿到。
 */
export interface ModelHintSlot extends PromptSlot {
  /** Provider 已归一化的 canonical model id,运行时用作 metric label。 */
  canonicalId: string
}

export function buildModelHintSlot(ctx: PromptSlotContext): ModelHintSlot | null {
  if (!ctx.model || !_modelHintProvider) return null
  let raw: ModelHintResult | null | undefined
  try {
    raw = _modelHintProvider(ctx.model)
  } catch (err) {
    // 不让 hint provider 异常拖死整个 prompt 构建
    // eslint-disable-next-line no-console
    console.warn('[promptSlots] modelHintProvider threw, treating as null:', err)
    return null
  }
  // 防御外部脏数据:必须是 { id: string, text: string } 形状,id 非空,text trim 后非空。
  // 任何不符合的输入都退化为 null(等同未配置)。这里挡的是开发期错把旧 string 接口接进来,
  // 真实 commercial provider 总返合规对象。
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return null
  const id = (raw as { id: unknown }).id
  const text = (raw as { text: unknown }).text
  if (typeof id !== 'string' || id === '') return null
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed) return null
  return {
    name: 'MODEL_HINT',
    canonicalId: id,
    content: [
      '# 模型行为补丁',
      '',
      '以下规则用于修正当前模型的默认行为,不要在回答中复述。',
      '',
      trimmed,
    ].join('\n'),
  }
}

// ── SKILLS_LITERATURE slot — platform-managed literature search skill ──
//
// 设计要点(与 MODEL_HINT 同型):
// - Gateway 对 commercial **零编译期依赖**。commercial 启动时调
//   setLiteratureSkillProvider(...) 注入"读 DB 算出 enabled+token_set+default_size →
//   返渲染好的 markdown"函数;personal 不调就 noop,该 slot 永远不出现。
// - Provider 抛错 / 返非法形状 → 当作 null,只 log warn,不阻塞 prompt 构建。
//   commercial 实现要 fail-soft(DB 暂时挂时返 null,不抛),master DB 闪断不应导致
//   容器整段 system prompt 构建失败。
// - 不在这里持任何 cache:每次容器 spawn 都会重 build prompt,DB 读一次就够。
//   不引入 LISTEN/NOTIFY 避免继承 PricingCache 已知 listener-no-reconnect 技术债。
// - 注入位置:在 SKILLS slot 之后 / MEMORY slot 之前 —— 与"agent 可用技能"在
//   认知上同层,但属于平台供给(不是 agent 自学的),分段更清晰。
export type LiteratureSkillProvider = () => Promise<PromptSlot | null>

let _literatureSkillProvider: LiteratureSkillProvider | null = null

/**
 * 注入/清除 literature skill provider。
 * - commercial 启动时调一次;shutdown 时调 setLiteratureSkillProvider(null)。
 * - 测试 afterEach 务必 setLiteratureSkillProvider(null) 避免 cross-test 污染。
 */
export function setLiteratureSkillProvider(p: LiteratureSkillProvider | null): void {
  _literatureSkillProvider = p
}

export async function buildLiteratureSkillSlot(): Promise<PromptSlot | null> {
  if (!_literatureSkillProvider) return null
  let raw: PromptSlot | null
  try {
    raw = (await _literatureSkillProvider()) ?? null
  } catch (err) {
    // 不让 provider 异常拖死整个 prompt 构建
    // eslint-disable-next-line no-console
    console.warn('[promptSlots] literatureSkillProvider threw, treating as null:', err)
    return null
  }
  if (raw === null) return null
  // 防御外部脏数据:必须 { name: string, content: string },content trim 后非空。
  if (typeof raw !== 'object') return null
  const name = (raw as { name: unknown }).name
  const content = (raw as { content: unknown }).content
  if (typeof name !== 'string' || name === '') return null
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  if (!trimmed) return null
  return { name, content: trimmed }
}

// ── V3 commercial remote platform slot source ──
//
// 背景:v3 容器镜像 build 时 `--exclude='packages/commercial/'`,容器进程内没有
// commercial,setLiteratureSkillProvider / setModelHintProvider 永远不被调,模块级
// _literatureSkillProvider / _modelHintProvider 在容器进程内恒为 null。结果
// SKILLS_LITERATURE 与 MODEL_HINT 在容器里**结构性不出现**。
//
// 修法:v3 supervisor 已经在 spawn 容器时注入两个 env(`OPENCLAUDE_V3_MASTER_BASE_URL`
// + `OPENCLAUDE_V3_CONTAINER_TOKEN`,见 v3supervisor.ts:1661 — 原本给 v3MasterSink 用),
// 容器 gateway 在 buildPromptContext 时 GET master 的
// `/internal/v3/platform-prompt-slots`,拿到 master 现算的两个 slot,合并进
// extra-prompt.md。
//
// 两条路径互斥(env 决定):
//   - 两个 env 都齐 → 走 remote fetch(v3 容器场景),**完全跳过** provider hook
//     调用。这一点重要:即使将来某个意外把 commercial 误装进容器,也不会双重注入。
//   - 任一缺 → 走旧的 provider hook(personal 45.32 单进程场景)。
//
// fail-soft:env 齐但 fetch 失败 / shape 不合规 → 返 `[]`(两个 slot 都不出现),
// **不回退** provider hook —— 在 v3 容器里 hook 注定是 dead code,回退只会制造
// "某些异常环境双重注入" 的错觉。

export const PLATFORM_PROMPT_SLOTS_PATH = '/internal/v3/platform-prompt-slots'

/** v3 supervisor 注入的两个 env。命名故意与 v3MasterSink 一致 —— 是同一条出站通道。 */
const ENV_MASTER_URL = 'OPENCLAUDE_V3_MASTER_BASE_URL'
const ENV_CONTAINER_TOKEN = 'OPENCLAUDE_V3_CONTAINER_TOKEN'

/** Fetch master 时的超时上限。slot 失败用户不会有明显感知(extra-prompt.md 还是会写,
 *  只是少两个增强段),但 5s 已经能覆盖 GCE bridge 偶发抖动。比 v3MasterSink 短:
 *  那里是写路径不能丢消息,这里是 spawn 路径用户在等,fail 早一点更好。 */
const PLATFORM_SLOTS_TIMEOUT_MS = 5_000

/** 允许容器接受的 slot name 白名单。master 加新 slot 时,旧容器看到不识别的 name
 *  应静默忽略而不是错误地落到 SOUL/USER 之间。 */
const PLATFORM_SLOT_WHITELIST = new Set(['SKILLS_LITERATURE', 'MODEL_HINT'])

/**
 * 容器从 master fetch 回来的单个 slot。`canonicalModelId` 仅 MODEL_HINT 出现,
 * gateway 把它透传到 PromptSlotApplied.meta.model_id —— 保持
 * modelHintAppliedTotal 的 cardinality 受 master pricing 表行数约束这条不变量。
 */
export interface RemotePlatformSlot {
  name: string
  content: string
  canonicalModelId?: string
}

export interface FetchPlatformSlotsDeps {
  /** 测试用:覆盖 undici.request。生产走默认。 */
  fetcher?: typeof undiciRequest
  /** 测试用:覆盖 process.env。生产走默认。 */
  env?: NodeJS.ProcessEnv
  /** 测试用:覆盖超时。生产用 PLATFORM_SLOTS_TIMEOUT_MS。 */
  timeoutMs?: number
}

/**
 * 从 master 拉取平台级 prompt slot。
 *
 * 返回语义:
 *   - `null`         → env 不齐,personal 场景,**走 provider hook 路径**
 *   - `[]`           → env 齐但 fetch / 解析失败,**跳过两个 slot**(不回退 hook)
 *   - `[{name,..}]`  → master 返回的(已 trim、已过滤白名单)slot 列表
 *
 * 不抛错:外层 buildPromptContext 不能因为 master 不通就让整段 system prompt
 * 构建失败 —— 容器其他 slot 还得照样出。
 */
export async function fetchPlatformSlotsFromMaster(
  ctx: PromptSlotContext,
  deps: FetchPlatformSlotsDeps = {},
): Promise<RemotePlatformSlot[] | null> {
  const env = deps.env ?? process.env
  const baseUrl = env[ENV_MASTER_URL]
  const bearer = env[ENV_CONTAINER_TOKEN]
  if (!baseUrl || !bearer) return null
  const normalized = baseUrl.replace(/\/+$/, '')

  const fetcher = deps.fetcher ?? undiciRequest
  const timeoutMs = deps.timeoutMs ?? PLATFORM_SLOTS_TIMEOUT_MS

  let url = `${normalized}${PLATFORM_PROMPT_SLOTS_PATH}`
  if (ctx.model) {
    url += `?model=${encodeURIComponent(ctx.model)}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status: number
  let bodyText: string
  try {
    const res = await fetcher(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    })
    status = res.statusCode
    bodyText = await readBoundedText(res.body, 256 * 1024)
  } catch (err) {
    // 网络 / DNS / abort —— 容器 spawn 期间 master 出问题,fail-soft 返 [],
    // 主流程照常推进。warn 不 error:slot 缺席不影响功能正确性。
    // eslint-disable-next-line no-console
    console.warn(
      '[promptSlots] platform slot fetch failed, returning empty',
      err instanceof Error ? err.message : String(err),
    )
    return []
  } finally {
    clearTimeout(timer)
  }

  if (status !== 200) {
    // 401/403 = 容器 token 不对或 bound_ip 不匹配(env 注错 / 容器迁移),
    // 5xx = master 本身出问题。两种都不在 spawn 路径上做花式重试。
    // eslint-disable-next-line no-console
    console.warn('[promptSlots] platform slot fetch non-200', { status })
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[promptSlots] platform slot response JSON parse failed')
    return []
  }

  // 防御性 shape 校验:必须是 `{ slots: [...] }`。
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { slots: unknown }).slots)
  ) {
    return []
  }

  const out: RemotePlatformSlot[] = []
  for (const raw of (parsed as { slots: unknown[] }).slots) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name : null
    const content = typeof r.content === 'string' ? r.content : null
    if (!name || !PLATFORM_SLOT_WHITELIST.has(name)) continue
    if (content === null) continue
    const trimmed = content.trim()
    if (!trimmed) continue
    // MODEL_HINT 必须带 canonicalModelId(provider 已 canonicalize 的 model id),
    // 否则容器侧 metric label 防线会失效 —— 直接丢弃这条 slot 比注入但缺 meta 安全。
    if (name === 'MODEL_HINT') {
      const cid =
        typeof r.canonicalModelId === 'string' ? r.canonicalModelId : null
      if (!cid || cid.length === 0) continue
      out.push({ name, content: trimmed, canonicalModelId: cid })
    } else {
      out.push({ name, content: trimmed })
    }
  }
  return out
}

async function readBoundedText(
  body: { [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | Uint8Array | string> },
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    const buf =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf-8')
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk)
    total += buf.byteLength
    if (total > maxBytes) {
      // 超过 cap 直接丢全部 —— master 不会发这么大,继续读没意义
      return ''
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// ── Unified builder ──

const SEPARATOR = '\n\n---\n\n'

/**
 * 一个 slot 的"应用"摘要,供 caller 用作 observability(打 metric/log)。
 * 不包含原文 — 防止把可能的敏感引导写到日志里。
 */
export interface PromptSlotApplied {
  name: string
  /** UTF-8 字节长度 */
  bytes: number
  /** content 的 sha256(完整十六进制),caller 可截短 */
  sha256: string
  /**
   * 可选:供 caller 打 metric/log 用的 bounded label 集合。
   * 目前只 MODEL_HINT 用,带 `model_id`(canonical id,基数受 model_pricing 表行数约束),
   * 防止 raw 入参 model 被外部污染后撑爆 Prom counter cardinality。
   */
  meta?: Record<string, string>
}

export interface PromptContextResult {
  /** 拼好的 prompt 文本(写到 extra-prompt.md 的内容) */
  content: string
  /** 命中的 slot 列表(按拼装顺序) */
  applied: PromptSlotApplied[]
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s)
  const buf = await crypto.subtle.digest('SHA-256', data)
  const arr = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * Build the complete extra-prompt by assembling all slots in order.
 * Returns the merged string + per-slot applied metadata so callers can emit
 * observability without re-parsing the prompt.
 *
 * 两条 commercial-owned slot(SKILLS_LITERATURE / MODEL_HINT)的注入来源由
 * env 决定:
 *   - v3 容器场景(env 齐) → fetchPlatformSlotsFromMaster 拉 master,跳过 hook
 *   - personal 场景(env 缺) → 继续走 setLiteratureSkillProvider /
 *     setModelHintProvider 模块级 hook
 * 详见同文件 "V3 commercial remote platform slot source" 注释段。
 */
export async function buildPromptContext(ctx: PromptSlotContext): Promise<PromptContextResult> {
  const slots: PromptSlot[] = []

  // 在 build 早期就触发 remote fetch,放到与其他静态 slot 计算并行 —— 不阻塞
  // SOUL/USER 之类的本地 I/O,fetch 5s timeout 同时 SOUL/USER 5ms 内就好了,
  // 一般而言两者在 fetch 返回前都早完成。
  const remotePlatformSlotsPromise = fetchPlatformSlotsFromMaster(ctx)

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

  // 等 remote 决策。null = personal 路径,数组 = v3 路径(可空)。
  const remotePlatformSlots = await remotePlatformSlotsPromise

  // 平台级技能(SKILLS_LITERATURE):SKILLS 之后、MEMORY 之前。
  //   - remote 路径:在 master 返回的数组里找 name === 'SKILLS_LITERATURE'
  //   - hook 路径:调 setLiteratureSkillProvider 注册的 provider
  // 没找到 / hook 返 null → slot 不出现。
  if (remotePlatformSlots === null) {
    const literature = await buildLiteratureSkillSlot()
    if (literature) slots.push(literature)
  } else {
    const literature = remotePlatformSlots.find((s) => s.name === 'SKILLS_LITERATURE')
    if (literature) {
      slots.push({ name: 'SKILLS_LITERATURE', content: literature.content })
    }
  }

  // Layer 3: Dynamic context
  const memory = await buildMemorySlot(ctx)
  if (memory) slots.push(memory)

  const tools = buildToolsSlot()
  slots.push(tools)

  // Layer 4: per-model 行为补丁。位于 TOOLS 之后、RESEARCH 之前 —
  // 比工具说明更靠后(更"贴近"user message,不被工具说明稀释),
  // 但低于 RESEARCH(用户显式选择"科研模式"应优先级最高)。
  // ModelHintSlot 携带 canonicalId,稍后塞进 PromptSlotApplied.meta 给 runner 打 metric。
  //
  // 同样按 env 决定来源。remote 路径下 canonicalModelId 直接来自 master 的 pricing
  // row,fetchPlatformSlotsFromMaster 已确保 MODEL_HINT slot 必带该字段。
  let modelHint: ModelHintSlot | null
  if (remotePlatformSlots === null) {
    modelHint = buildModelHintSlot(ctx)
  } else {
    const remote = remotePlatformSlots.find((s) => s.name === 'MODEL_HINT')
    modelHint =
      remote && remote.canonicalModelId
        ? {
            name: 'MODEL_HINT',
            canonicalId: remote.canonicalModelId,
            content: remote.content,
          }
        : null
  }
  if (modelHint) slots.push(modelHint)

  // Layer 5: 用户显式选中的模式(科研模式等)。放在模型补丁之后,
  // 体现 user-explicit > model-default 的优先级。不选就不注入。
  const research = buildResearchSlot(ctx)
  if (research) slots.push(research)

  // Layer 6(Phase 5): 当前会话的 GitHub repo 绑定状态。放在 RESEARCH 之后,
  // 是离 user 消息最近的一段,确保 agent 能强感知 "Bash 工具的 cwd 在哪"。
  const repo = buildRepoSlot(ctx)
  if (repo) slots.push(repo)

  const content = slots.map((s) => s.content).join(SEPARATOR)
  const applied: PromptSlotApplied[] = await Promise.all(
    slots.map(async (s) => {
      const base: PromptSlotApplied = {
        name: s.name,
        bytes: Buffer.byteLength(s.content, 'utf-8'),
        sha256: await sha256Hex(s.content),
      }
      // MODEL_HINT slot 带 canonicalId(provider 已归一化),透传到 meta.model_id
      // 让 runner 用作 bounded Prom label。其它 slot 不需要 meta。
      if ((s as ModelHintSlot).canonicalId !== undefined) {
        base.meta = { model_id: (s as ModelHintSlot).canonicalId }
      }
      return base
    }),
  )
  return { content, applied }
}
