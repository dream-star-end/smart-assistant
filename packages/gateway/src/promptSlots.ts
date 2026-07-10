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
import {
  MemoryDir,
  type SkillStore,
  buildAgentSkillStore,
  paths,
  readAgentsConfig,
  readUserProfile,
  scanMemoryContent,
} from '@openclaude/storage'
import { request as undiciRequest } from 'undici'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import { listCollaboratorAgents } from './collaboratorAgents.js'
import { isTextOnlyStaticVisionModel, shouldEnableOpenClaudeVision } from './mcpVisionServer.js'

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
  /** MCP tools that will actually be registered for this runner. Provider
   *  hints must not advertise tools that are disabled by env/toolset/entry
   *  resolution, or the model will try to call a non-existent tool. */
  availableMcpTools?: string[]
  /** Skill-eval 'without' arm:该技能对本会话完全不可见(与 mcp-memory 的
   *  OPENCLAUDE_SKILL_EVAL_EXCLUDE 配对;SKILLS 摘要漏滤会造成假基线)。 */
  skillEvalExclude?: string
  /** Skill-eval 'draft' arm:该技能在 SKILLS 摘要里用草稿描述(view 由 mcp 侧接管)。 */
  skillEvalDraft?: { name: string; dir: string }
}

export interface PromptSlot {
  name: string
  content: string
}

// ── 记忆注入预算(注入侧唯一权威,与存储写侧解耦)──
//
// memdir 范式下存储层不再有「Core 记忆字符硬预算」:每条记忆一个文件、MEMORY.md 只存
// 索引。注入成本只由这两个 cap 在读侧控制,与磁盘上实际存了多少解耦。
//   - 索引常驻注入,MemoryDir.renderForInjection 逐行 scan 后按此上限截断(超出附提示行)。
//   - 用户画像整段注入,buildUserSlot 按此上限截断(超出附提示行)。
// 存储层写多少都不拒,注入侧只取前 N 字符 —— 这是「触发少」问题的解:指令段常驻、
// 索引常驻,不依赖存量规模。
const MEMORY_INDEX_INJECT_MAX_CHARS = 6000
// 导出:memory/user API 把它作为响应里的 `limit` 回报给 UI(memdir 下不再有写侧硬预算,
// 此 cap = user.md 实际会被注入的上限,也是 UI 预算条唯一有意义的界)。单一权威。
export const USER_PROFILE_INJECT_MAX_CHARS = 4000

function buildPromptSkillStore(agentId: string): SkillStore {
  // Overlay (single wiring in @openclaude/storage): baseline(ro) > agent-seed(ro)
  // > shared(rw, all agents) > legacy(per-agent).
  return buildAgentSkillStore(agentId)
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
  // 用户画像 = 用户级共享 user.md(去 § 化后的纯 markdown)。readUserProfile 负责懒去 §,
  // 这里只做「注入侧兜底扫描 + cap 截断」。
  let text: string
  try {
    ;({ text } = await readUserProfile())
  } catch {
    // user.md 读/去§失败不能拖垮系统提示构建,静默不注入即可。
    return null
  }
  const trimmed = text.trim()
  if (!trimmed) return null
  // 读侧兜底扫描(注入唯一权威):模型可能用原生 Write 直接改 user.md,绕过 API 写侧 scan;
  // 命中注入类/外泄类模式 → 整段不注入,不做局部剔除(用户画像是单文档,一处脏就不信任整篇)。
  if (!scanMemoryContent(trimmed).ok) return null
  let body = trimmed
  if (body.length > USER_PROFILE_INJECT_MAX_CHARS) {
    body = `${body.slice(0, USER_PROFILE_INJECT_MAX_CHARS)}\n\n…(用户画像超出注入上限,已截断;完整内容仍在 user.md)`
  }
  return {
    name: 'USER',
    content: `# USER IDENTITY (重要 — 回答任何关于用户的问题时必须参考此节)\n\n${body}`,
  }
}

export async function buildAgentsSlot(ctx: PromptSlotContext): Promise<PromptSlot> {
  const provider = ctx.provider
  // 识图从 openclaude-vision MCP 迁到 oc-vision CLI(baseline skill)后,是否提示识图
  // 不再看"MCP 工具是否注入"(那个值已恒 false),而看**平台是否认定该模型需要识图兜底**。
  // 判定权威 = shouldEnableOpenClaudeVision —— 它正是迁移前决定注入 understand_image 的
  // 同一个函数(纯文本静态模型 supportsVision!==true,或 OPENCLAUDE_VISION_MCP_PROVIDERS
  // 显式 opt-in 的 provider),所以 `needsVisionCli` 与旧 `availableMcpTools.includes(
  // 'understand_image')` 语义完全等价。**原生多模态模型(gpt-5.5/claude 等)默认 false**,
  // 不会拿到误导性的"用 CLI 识图"提示(保持迁移前行为,不给它们加噪音)。
  const needsVisionCli = shouldEnableOpenClaudeVision(provider, ctx.model)
  const lines = [
    '# Platform capabilities',
    '',
    '你是 OpenClaude 平台上的 AI 助手,用户通过 Web 浏览器与你交互。',
    '你运行在服务器本机上(不需要 SSH 连接自己,直接执行 Bash 命令即可)。',
    '',
    '## 多媒体与文件',
    '',
    '发送文件给用户: 必须先保存到平台生成目录再回复**绝对路径**;商业版容器优先使用 `/home/agent/.openclaude/generated/`,个人版/宿主机通常是 `/root/.openclaude/generated/`。不要用 `/tmp` 临时目录,不要用 `![]()` 语法。',
    '详细规则见 `skill_view("platform-capabilities")`。',
    '',
    '## 微信通道操作技能',
    '',
    '如果当前对话来自微信,或用户要求在微信里收发文件、图片、视频、语音/音频、附件,按以下规则操作:',
    '',
    needsVisionCli
      ? '- 微信收到的图片、视频、语音/音频、文件会以容器内路径提供,通常在 `/home/agent/.openclaude/uploads/<安全文件名>`。当前模型看不到图,看到本地图片路径时,先用 Bash 调 `oc-vision understand <该路径> --prompt "<问题>"` 识别,再据此回答,不要说“不支持图片/没有上传图片”。'
      : '- 微信收到的图片、视频、语音/音频、文件会以容器内路径提供,通常在 `/home/agent/.openclaude/uploads/<安全文件名>`。看到本地图片路径时,直接读图回答,不要说“不支持图片/没有上传图片”。',
    '- 要通过微信发回真实附件,不能只读取文件或口头描述。必须先创建或复制资源到 `/home/agent/.openclaude/generated/<安全文件名>`;也可以复用已存在的 `/home/agent/.openclaude/uploads/<安全文件名>`。',
    '- 最终回复里必须写出精确的绝对路径,例如 `/home/agent/.openclaude/generated/example.txt`;微信网关会把该路径转换成真实附件发送。路径要出现在**最终回答**中,不要只放在思考过程或工具调用说明里。',
    '- 安全文件名只能匹配 `[A-Za-z0-9._@+=,-]{1,180}`,最长 180 字符;不要使用子目录、`..`、URL 编码、软链接、`/tmp` 或任意系统路径。',
    '- 可发送的常见扩展名:图片 `png/jpg/jpeg/gif/webp`;视频 `mp4/mov/m4v/webm`;语音/音频 `mp3/wav/ogg/oga/silk/amr`;文件 `pdf/txt/md/csv/json/docx/xlsx/pptx/zip/tar/gz`。',
    '- 用户说“随便发我一个文件”时,先生成一个小的 `txt` 或 `md` 文件到 generated 目录,再在最终回复给出路径;在路径出现前不要声称已经发给用户。',
    '',
    '## 内联富内容: `chart` / `mermaid` / `htmlpreview` 代码块',
    '',
    '用户要求界面预览、交互 demo、HTML Canvas、动画、小游戏、设计稿还原或可视化原型时,优先直接输出 fenced `htmlpreview` 代码块在对话里渲染,不要默认先生成 `.html` 文件。详细模板见 `skill_view("platform-capabilities")`。',
    '需要用户在少数几个选项里做决定时,输出 fenced `options` 代码块 —— 前端渲染为可点击选项卡,用户点一下即自动回复,无需打字:`{"question":"…?","multi":false,"options":[{"label":"选项A","desc":"说明"},{"label":"选项B"}]}`(多选设 multi:true;选项≤12;开放式问题仍用普通文字提问)。',
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
  ]

  // browser is now the stateful oc-browser daemon + thin CLI (retired from MCP);
  // always available via Bash, detail via the `browser` skill.
  lines.push(
    '',
    '## 浏览器操作 (CLI)',
    '',
    '用 Bash 调 `oc-browser` 操作真实浏览器(有状态,跨调用共享同一会话):',
    '1. `oc-browser navigate --url <url>` → 打开网页',
    '2. `oc-browser snapshot` → 拿页面 accessibility tree + 元素 ref',
    '3. `oc-browser click --ref <ref> --element "<描述>"` / `oc-browser type --ref <ref> --element "<描述>" --text "<文本>"` → 按 ref 操作,重复 2-3 直到完成',
    '常用场景: 搜索、填表、登录、抓数据。优先 snapshot(文本省 token),需视觉确认才 `oc-browser screenshot`。细节见 `skill_view("browser")`。',
  )

  // web-context + scansci-pdf 已从 MCP 工具迁到 CLI(始终可用,经 Bash 调用),
  // 细节走 skill 渐进披露,基线提示只放精简指针,避免臃肿。
  lines.push(
    '',
    '## 网页/文档提取 · 论文下载 (CLI)',
    '',
    '读取公开 URL、网页、PDF、Office 文档 → 用 Bash 调 `oc-web extract <url>` / `oc-web parse <绝对路径>`;学术论文检索与下载 → `scansci-pdf <子命令>`(search/download/citation 等)。细节见 `skill_view("web-context")` 与 `skill_view("scansci-pdf")`。',
    '安全边界:不要绕过 CAPTCHA、Cloudflare、登录墙或站点反爬;返回 blocked/error 时如实说明受阻,改用官方 API、用户上传文件或用户提供的数据源。输出标明来源 URL/时间/路径,不要把网页抓取当高风险事实的唯一依据。',
  )

  // Dynamically inject available agents list
  try {
    const agentsCfg = await readAgentsConfig()
    // 只列市场安装集(source==='marketplace')+ main,排除已退役的幽灵平台 seed。
    // 与 AgentPicker(master 市场安装权威)/队长组队引导同一权威,对 seed 漂移免疫。
    const otherAgents = listCollaboratorAgents(agentsCfg, {
      selfId: ctx.agentId,
      includeMain: true,
    })
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
  if (provider === 'minimax') {
    lines.push('')
    lines.push('## MiniMax MCP 参数提示')
    lines.push('')
    lines.push(
      '**text_to_audio**: 必须传 `model="speech-2.8-hd"` + `emotion="neutral"` (MCP 默认 speech-2.6-hd 不可用)',
    )
    lines.push('**text_to_image**: 默认 image-01 可用,传 `aspect_ratio` 控制比例')
    // MiniMax-M3 原生支持图像识别(2026-06-17 放开 strip):用户上传的图片会直接进入对话,
    // **无需** understand_image 工具,直接读图回答即可。
  }
  // 纯文本静态模型(deepseek/glm/qwen/kimi 等)的识图提示。判定权威 = protocol
  // staticKeyProviders 的 supportsVision(经 isTextOnlyStaticVisionModel 派生),与
  // mcpVisionServer 注入侧同源 —— 消掉此前逐字面量硬编码的第二权威源(新增静态
  // 模型忘同步就漏发提示的漂移)。
  if (needsVisionCli && isTextOnlyStaticVisionModel(ctx.model)) {
    lines.push('')
    lines.push('## 图片理解提示')
    lines.push('')
    lines.push(
      '当前模型按纯文本接入、看不到图。用户上传图片时,用 Bash 调 ' +
        '`oc-vision understand <图片绝对路径> --prompt "<问题>"`(路径从上传提示里取),' +
        '再基于命令返回的图片内容回答。细节见 `skill_view("oc-vision")`。',
    )
  }
  // GPT/Codex 路径的识图提示段。CodexAdapter 构造内核时强制 provider='codex-native'
  // (engine 路由后任意 agent 都可能落 codex 底座),model 前缀判定保留作 belt-and-braces。
  // 这些模型经常无法用普通文件工具"看到"图像内容,oc-vision 是可靠兜底。
  if (
    needsVisionCli &&
    (provider === 'codex-native' ||
      provider === 'codex' ||
      ctx.model?.startsWith('gpt-') ||
      ctx.model?.startsWith('codex-'))
  ) {
    lines.push('')
    lines.push('## GPT/Codex 图片理解提示')
    lines.push('')
    lines.push(
      '用户消息中出现本地图片路径、而你无法直接看到图像内容时,用 Bash 调 ' +
        '`oc-vision understand <图片绝对路径> --prompt "<问题>"`,再基于命令返回的内容回答。' +
        '不要声称用户没有上传图片。细节见 `skill_view("oc-vision")`。',
    )
  }

  return { name: 'AGENTS', content: lines.join('\n') }
}

export async function buildSkillsSlot(ctx: PromptSlotContext): Promise<PromptSlot | null> {
  const skillStore = buildPromptSkillStore(ctx.agentId)
  let skillList = await skillStore.list()
  // Skill-eval arm 控制:exclude 滤掉;draft 用草稿描述替换(内容 view 由 mcp 侧接管)。
  if (ctx.skillEvalExclude) skillList = skillList.filter((s) => s.name !== ctx.skillEvalExclude)
  if (ctx.skillEvalDraft) {
    try {
      const raw = readFileSync(`${ctx.skillEvalDraft.dir}/SKILL.md`, 'utf-8')
      const m = raw.match(/^description:\s*(.+)$/m)
      const desc = m ? m[1].trim().replace(/^"|"$/g, '') : null
      if (desc) {
        skillList = skillList.map((s) =>
          s.name === ctx.skillEvalDraft?.name ? { ...s, description: desc } : s,
        )
      }
    } catch {
      /* 草稿读不到 → 保持现版描述 */
    }
  }
  if (skillList.length === 0) return null
  const top = skillList.slice(0, 15)
  const lines = [
    `# Skills (${skillList.length})`,
    '',
    '可用 `skill_search(query)` 查找相关 skill,再用 `skill_view(name)` 加载完整指令:',
  ]
  for (const s of top) {
    const source = s.source === 'platform' ? 'platform' : 'user'
    lines.push(`- **${s.name}** [${source}] — ${s.description}`)
  }
  if (skillList.length > 15)
    lines.push(`- ... 还有 ${skillList.length - 15} 个 (用 skill_search/skill_list 查看全部)`)
  return { name: 'SKILLS', content: lines.join('\n') }
}

/**
 * 渲染 `# Memory` 段常驻指令 + 当前索引。
 *
 * 结构对标 Claude Code 的 `# Memory`:何时写 / 四类记忆各配示例 / 何时不写 /
 * 两步保存(写文件 + 加索引行)/ 更新优先于新建 / 删错误记忆 / 按需 Read 正文 /
 * 显式绝对路径。写入动作全部走引擎原生 Write/Edit —— memdir 范式下**不再有**
 * `oc-memory memory` 子命令。
 *
 * `index` 为 null(仅 marker / 空)时,指令段照样常驻,索引段落降级为「(空)」。
 * 这是「记忆触发少」问题的根治点:指令不依赖存量,永远在系统提示里。
 */
function renderMemoryInstructions(args: {
  memoryDir: string
  memoryMd: string
  index: string | null
}): string {
  const { memoryDir, memoryMd, index } = args
  const indexBlock = index && index.trim() ? index.trim() : '(空 —— 还没有任何记忆条目)'
  return [
    '# Memory',
    '',
    '你有一份跨会话持久的长期记忆:由「一个索引 + 若干记忆文件」组成。索引常驻在本段末尾,',
    '每条一行;记忆正文按需自己去读,不会自动进上下文。',
    '',
    '## 何时写',
    '',
    '**硬触发(命中即本轮就写,不等收尾、不等用户要求)**:',
    '- 用户明确陈述自己的身份/偏好/习惯(「我喜欢…」「我不喜欢/讨厌…」「我是…」「以后都…」)→ 写 `type: user`;',
    '- 用户明确纠正你的行为或结论(「不要这样」「你错了,应该…」)→ 写 `type: feedback`(带 Why / How to apply)。',
    '这两类写入是回复动作的一部分:先答后写、先写后答皆可,但**同一轮内必须完成**。',
    '',
    '软触发(对话或任务收尾时回顾):正在推进项目的关键事实与决定、踩坑与结论、值得留存的参考资料。',
    '流水账不记(见「何时不写」),但**用户亲口说出的偏好与纠正永远不算流水账**——拿不准时偏向写入,',
    '写错了下一轮还能删,漏掉了未来每一轮都在重复犯错。',
    '',
    '## 四类记忆(写文件时在 frontmatter 的 `type` 里标注,各配一例)',
    '',
    '- **user** — 用户是谁、长期偏好与风格。例:「用户是射电天文研究员,回答默认按同行水平、公式可保留」。',
    '- **feedback** — 用户对你的明确纠正/评价,必须附「为什么」与「下次怎么做」。例:「用户指出系统误差不能套 √N —— Why: 只有热噪声主导才成立;How to apply: 先分随机/系统误差再做 RSS 合成」。',
    '- **project** — 正在做的项目/任务的关键事实与决定。例:「X 项目部署在 kl-mirror,出站统一走 18991 订阅代理」。',
    '- **reference** — 稳定可复用的知识/资料/清单。例:「常用论文检索入口与各自的检索语法」。',
    '',
    '## 何时不写',
    '',
    '一次性的临时细节、当场能算出或查到的东西、纯寒暄,以及**任何密钥 / token / 密码 / 隐私原文**,',
    '都不要写进记忆。',
    '',
    '## 怎么保存(两步,直接用你的原生文件工具 —— 已经没有 `oc-memory memory` 命令了)',
    '',
    `1. **写记忆文件**:用 Write 在 \`${memoryDir}/\` 下新建 \`<slug>.md\`(slug 用小写中划线,如 \`user-radio-astronomer.md\`),文件顶部带 frontmatter:`,
    '   ```markdown',
    '   ---',
    '   name: <kebab-slug>',
    '   description: <一句话摘要,决定未来会话是否召回这条>',
    '   type: user | feedback | project | reference',
    '   ---',
    '   <正文;feedback / project 记得写清 Why 与 How to apply>',
    '   ```',
    `2. **加索引行**:用 Edit 往 \`${memoryMd}\` 追加一行:\`- [标题](memory/<slug>.md) — 一句话钩子\`(整行 ≤150 字符;钩子写清「什么情况下该翻开这条」)。`,
    '',
    '## 维护',
    '',
    '- **更新优先于新建**:同一主题已有文件,直接 Edit 那个文件,不要另建近似条目。',
    `- **发现错误 / 过时的记忆就删**:删掉 \`${memoryDir}/<slug>.md\`,并同步删掉 \`${memoryMd}\` 里对应那一行。`,
    `- 想看某条正文时,用 Read 打开索引里对应的 \`${memoryDir}/<slug>.md\`(只有索引常驻,正文不会自动进上下文)。`,
    '',
    '## 当前索引',
    '',
    indexBlock,
  ].join('\n')
}

/**
 * MEMORY slot —— memdir 范式。**始终返回**(指令段常驻,索引为空也注入),故返回类型
 * 不再是 `PromptSlot | null`。索引由 MemoryDir.renderForInjection 现算(内部含
 * ensureMigrated + reconcileIndex + 逐行 scan + cap 截断)。
 */
export async function buildMemorySlot(ctx: PromptSlotContext): Promise<PromptSlot> {
  const md = new MemoryDir(ctx.agentId)
  let index: string | null = null
  try {
    index = await md.renderForInjection(MEMORY_INDEX_INJECT_MAX_CHARS)
  } catch {
    // 索引读/对账失败不能拖垮系统提示:指令段仍常驻,索引段落降级为「(空)」。
    index = null
  }
  const memoryDir = paths.agentMemoryDir(ctx.agentId)
  const memoryMd = paths.agentMemoryMd(ctx.agentId)
  return { name: 'MEMORY', content: renderMemoryInstructions({ memoryDir, memoryMd, index }) }
}

/** 测试用内部导出(非稳定 API):暴露纯函数 renderMemoryInstructions 与两个注入 cap,
 *  让 # Memory 指令段渲染无需 storage MemoryDir 即可被单测覆盖。 */
export const _memoryInternals = {
  renderMemoryInstructions,
  MEMORY_INDEX_INJECT_MAX_CHARS,
  USER_PROFILE_INJECT_MAX_CHARS,
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
      '| 层级 | 怎么用 | 容量 | 何时用 |',
      '|------|------|------|--------|',
      '| Core | 直接用 Write/Edit 写记忆文件(详见上面 `# Memory` 段) | 索引常驻 | 高频事实、用户身份、明确反馈,每次对话自动可见 |',
      '| Recall | 在 Bash 里运行 `oc-memory session-search "<query>"` | 无限 | 回忆过去对话内容 |',
      '| Archival | 在 Bash 里运行 `oc-memory archival-add/archival-search/archival-delete` | 无限 | 详细知识、文档、代码模式(需搜索才可见) |',
      '',
      'Core 记忆**直接写文件**(见上面 `# Memory` 段),已经**没有** `oc-memory memory` 命令;',
      'Recall / Archival 仍是 `oc-memory` 命令行工具(在 Bash 里运行),不是独立工具调用。详见 `skill_view("memory-management")`。',
      '**原则**: 高频→Core(直接写文件), 详细→Archival, Core 里某条太长→迁到 Archival',
      '',
      '## 定时任务',
      '',
      `**当前服务器时间**: ${timeStr}`,
      '',
      '用户要求定时任务或提醒时,**必须立即创建,不要说做不到**。',
      '快速用法: `create_reminder(schedule="分 时 日 月 周", message="内容", oneshot=true)`;到点执行的任务(非播报提醒)加 `kind="task"`。',
      '查看/修改/删除: `list_reminders()` / `update_reminder(id, ...)` / `delete_reminder(id)`。这套工具与网页「管理中心 → 定时任务」是同一份数据,用户在页面上建的任务你也能看到。',
      '详细指南见 `skill_view("scheduled-tasks")`。',
      '',
      '## 技能自生成',
      '',
      '不要等用户要求才沉淀经验。完成 3+ 工具调用的复杂任务、修复一个反复出现的问题、或验证出可复用流程后,在最终答复前**立即**评估:',
      '1. 先用 `skill_search(query)` 搜索是否已有类似 skill;必要时再 `skill_list()` 浏览。',
      '2. 如果已有 skill 但步骤过时/缺关键坑点 → 用同名 `skill_save(...)` 更新它。',
      '3. 如果没有且模式可复用 → `skill_save(name, desc, body)` 创建新 skill。',
      '4. 好的 skill = 触发场景 + 前提条件 + 步骤 + 验证方式 + 常见坑 + 命令模板。',
      '',
      '创建/更新 skill 时保持泛化,不要把一次性用户隐私、token、短期路径、无复用价值的流水账写进去。',
      '结构与评测规范见 `skill_view("skill-authoring")`:原则进 SKILL.md(<500行),稳定知识进 references/,重复动作进 scripts/,素材进 assets/,验收用例进 evals/evals.json。',
      '',
      '## 联网检索纪律',
      '',
      '需要外部/实时事实(新闻、行情、政策、网页、文献、统计数字)时,**先真的去检索**,不要凭记忆直接作答。可用: `WebSearch`(联网搜索)、`WebFetch`(抓取单页并提炼)、Bash 里的 `oc-web extract <url>`(整页/文档转 Markdown)。',
      '- **中文主题优先中文检索**;命中结果必须标注来源 URL 与数据时间。',
      '- 一条路径失败就换另一条(搜索↔抓取)、换关键词或换语言再试。',
      '- **检索全部失败/返回不相关或空结果时,如实告诉用户"未能检索到可靠来源"**,并说明已尝试的路径。此时若要给出判断,必须显式标注"以下为基于既有知识的粗略判断,未经联网核实",**严禁**把记忆里的数字/统计/时效性结论当作已核实的调研结果输出,更不得伪造来源或编造链接。宁可少答、诚实标注,也不要用幻觉冒充调研。',
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
      const cid = typeof r.canonicalModelId === 'string' ? r.canonicalModelId : null
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
  //
  // Backend asymmetry — codex-native 子进程不注入此 slot:
  //   - literatureProxy 要求 `Authorization: Bearer $OPENCLAUDE_V3_CONTAINER_TOKEN`
  //     (verifyContainerIdentity 双因子,见 commercial/src/literatureProxy.ts:373)
  //   - codex 子进程 spawn env 由 buildCodexEnv() 构造,显式 scrub 所有
  //     `OPENCLAUDE_*` / `ANTHROPIC_*` / `CLAUDE_CODE_*` 前缀的 env(见
  //     engine/codexShared.ts `ENV_SCRUB_PREFIXES`)。container token 因此对
  //     codex 不可见,即使 prompt 告诉它走这个接口,调用也必然 401。
  //   - 让 codex 看到一个"会用,但调不通"的 endpoint 反而浪费 turn + 误导用户;
  //     直接不渲染该 slot,codex 会 fallback 到自身能力(web search 等)。
  //   - 这条 scrub 设计本身合理(防 codex 横向移动 OpenClaude 凭证),不应为
  //     literature 单个功能开洞。如未来要让 codex 也用 literature,需独立设计
  //     "codex 可用且与 OpenClaude 凭证隔离"的鉴权通道,与本 skip 正交。
  // M1a 复活(P1f 删):**安全 gate,必须在** —— codex 路径不注入 SKILLS_LITERATURE。
  // CodexAdapter 构造内核时强制 provider='codex-native'(engine 由 registry 按
  // 模型判定后,任意 provider 的 agent 都可能落到 codex 底座),保证本 gate 对
  // codex 恒命中;与 codexShared.buildCodexEnv 的 env scrub 成对(一个断凭证
  // env,一个断"会用但调不通"的提示注入),任何一侧松动都要过安全评审。
  if (ctx.provider !== 'codex-native') {
    if (remotePlatformSlots === null) {
      const literature = await buildLiteratureSkillSlot()
      if (literature) slots.push(literature)
    } else {
      const literature = remotePlatformSlots.find((s) => s.name === 'SKILLS_LITERATURE')
      if (literature) {
        slots.push({ name: 'SKILLS_LITERATURE', content: literature.content })
      }
    }
  }

  // Layer 3: Dynamic context
  // MEMORY 段常驻(memdir 范式):指令段不依赖存量,索引为空也注入,故 buildMemorySlot 恒返 slot。
  const memory = await buildMemorySlot(ctx)
  slots.push(memory)

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
    modelHint = remote?.canonicalModelId
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
