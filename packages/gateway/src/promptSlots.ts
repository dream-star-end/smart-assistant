/**
 * Prompt Slots — structured system prompt assembly for OpenClaude agents.
 *
 * Each slot has a fixed role, source, and priority. The slots are assembled
 * in cache-friendly order: static content first (rarely changes), dynamic last.
 *
 * Slot order(实际生效顺序;按 cache-friendly 静态在前、动态在后排):
 *   1. ENV               — 当轮实测的稳定环境事实(uid/实例/宿主通道/快照),容器生命周期内不变
 *   2. SOUL              — Agent persona (CLAUDE.md / SOUL.md), rarely changes
 *   3. USER              — User identity & preferences (USER.md), rarely changes
 *   4. AGENTS            — Platform capabilities, agent list, provider tips (semi-static)
 *   5. SKILLS            — Agent 自有 skill summaries (semi-static)
 *   6. SKILLS_LITERATURE — 平台供给文献检索能力 (personal: commercial 反向钩子;v3 容器: master GET fetch;两条路径互斥;none 时不出现)
 *   7. MEMORY            — Agent notes (MEMORY.md), changes frequently
 *   8. TOOLS             — Tool usage hints, learning system instructions (static reference)
 *   9. MODEL_HINT        — per-model 行为补丁 (personal: commercial 反向钩子;v3 容器: master GET fetch;两条路径互斥;none 时不出现)
 *   10. RESEARCH         — 用户显式选中的科研模式守则 (effortLevel='max')
 *   11. REPO             — 当前会话 GitHub repo 绑定快照 (离 user 消息最近)
 *
 * 文案通道边界(设计 §4.2,两通道不重叠):
 *   - **per-model / 随计费** 的 slot(MODEL_HINT、SKILLS_LITERATURE 等)→ 权威在
 *     master DB slot(个人版 commercial 反向钩子 / v3 容器 master GET fetch),按会话/
 *     计费上下文动态取,机制不动。
 *   - **平台静态守则/能力文案**(`# Platform capabilities`、`# Memory` 常驻指令段)→
 *     权威在 platform bundle 的 `prompts/`(经 platformPrompts.ts 的 LKG 加载器,
 *     商业版原子翻转真热;个人版回落本文件内 fallback 常量)。
 *   改这两段文案 = 改 platform-runtime/prompts/*.md **与** 本文件 fallback 常量两处
 *   同步(有 __tests__/platformPrompts.test.ts 的「文件 === 常量」断言把同步固化成门)。
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  type SkillStore,
  MemoryDir,
  buildAgentSkillStore,
  paths,
  readAgentsConfig,
  readUserProfile,
  scanMemoryContent,
} from '@openclaude/storage'
import { AGENT_MODEL_AUTO } from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'
import type { RepoSnapshot } from './sessionRepoWorkspace.js'
import { listCollaboratorAgents } from './collaboratorAgents.js'
import { isTextOnlyStaticVisionModel, shouldEnableOpenClaudeVision } from './mcpVisionServer.js'
import { getPlatformPrompt } from './platformPrompts.js'
import { buildEnvSlot } from './envProbe.js'

// ── 平台静态 prompt 文案的个人版 fallback 常量(见文件头「文案通道边界」)──
//
// 商业版权威 = platform bundle 的 prompts/<file>.md(supervisor 注入
// OPENCLAUDE_PLATFORM_PROMPTS_DIR,原子翻转真热);个人版不设该 env → getPlatformPrompt
// 恒返这里的常量。**逐字同步义务**:改动这些常量必须同步改
// packages/commercial/agent-sandbox/platform-runtime/prompts/ 下对应 .md,反之亦然
// (__tests__/platformPrompts.test.ts 的「文件 === 常量」断言会在漂移时变红)。

/** `# Platform capabilities` 静态头部;{{WECHAT_VISION_HINT}} 由 buildAgentsSlot 按
 *  needsVisionCli 注入下面两个变体之一。对应 prompts/platform-capabilities.md。 */
const PLATFORM_CAPABILITIES_FALLBACK = `# Platform capabilities

你是 OpenClaude 平台上的 AI 助手,用户通过 Web 浏览器与你交互。
你运行在服务器本机上(不需要 SSH 连接自己,直接执行 Bash 命令即可)。

## 多媒体与文件

发送文件给用户: 必须先保存到平台生成目录再回复**绝对路径**;商业版容器优先使用 \`/home/agent/.openclaude/generated/\`,个人版/宿主机通常是 \`/root/.openclaude/generated/\`。不要用 \`/tmp\` 临时目录,不要用 \`![]()\` 语法。
详细规则见 \`skill_view("platform-capabilities")\`。

## 微信通道操作技能

如果当前对话来自微信,或用户要求在微信里收发文件、图片、视频、语音/音频、附件,按以下规则操作:

{{WECHAT_VISION_HINT}}
- 要通过微信发回真实附件,不能只读取文件或口头描述。必须先创建或复制资源到 \`/home/agent/.openclaude/generated/<安全文件名>\`;也可以复用已存在的 \`/home/agent/.openclaude/uploads/<安全文件名>\`。
- 最终回复里必须写出精确的绝对路径,例如 \`/home/agent/.openclaude/generated/example.txt\`;微信网关会把该路径转换成真实附件发送。路径要出现在**最终回答**中,不要只放在思考过程或工具调用说明里。
- 安全文件名只能匹配 \`[A-Za-z0-9._@+=,-]{1,180}\`,最长 180 字符;不要使用子目录、\`..\`、URL 编码、软链接、\`/tmp\` 或任意系统路径。
- 可发送的常见扩展名:图片 \`png/jpg/jpeg/gif/webp\`;视频 \`mp4/mov/m4v/webm\`;语音/音频 \`mp3/wav/ogg/oga/silk/amr\`;文件 \`pdf/txt/md/csv/json/docx/xlsx/pptx/zip/tar/gz\`。
- 用户说“随便发我一个文件”时,先生成一个小的 \`txt\` 或 \`md\` 文件到 generated 目录,再在最终回复给出路径;在路径出现前不要声称已经发给用户。

## 界面预览:内联 \`htmlpreview\` 与容器网站原生预览

单文件、自包含且不依赖真实项目构建、路由或 API 的界面 mock、HTML Canvas、动画、小游戏和独立交互 demo,优先直接输出 fenced \`htmlpreview\` 代码块。真实项目、多文件或框架站点、已有或需要启动的开发服务器、真实路由/API/静态资源联调,以及用户明确要求查看正在开发的网站时,改用**容器网站原生预览**。

容器网站原生预览必须遵循:
1. 复用已有服务;否则选择普通空闲应用端口启动长驻服务(按框架需要监听 \`127.0.0.1\` 或 \`0.0.0.0\`),不要占用平台保留端口或系统/数据库端口,回复后也不要结束服务。
2. 回复前校验最终准备返回的完整路径,例如 \`curl -fsSL --max-time 5 'http://127.0.0.1:3000/dashboard' >/dev/null\`;未通过就先查日志并修复,不能声称已经可预览。
3. 校验后输出显式 Markdown 链接,例如 \`[打开网站预览](http://localhost:3000/dashboard)\`。不能只说“已启动”、只给文件路径,也不要让用户在自己设备上直接访问 localhost。
4. 平台会自动提供隔离的临时域名和代理;不要向用户索要额外域名,不要自行创建或申请公网/\`trycloudflare\` 临时域名或隧道。
5. 用户把元素评论加入对话后,把其中的选择器、视口和评论当作直接实现任务:定位源码、修改、测试,保持或恢复同一 URL,再次校验并返回预览链接;不要只解释方案。

详细模板见 \`skill_view("platform-capabilities")\`。
需要用户在 Web 对话中对少数选项做决定时,按当前引擎选择提问通道:
- CCB: 调用原生 \`AskUserQuestion\` 并等待回答;不要输出 fenced \`options\` 代码块,也不要在普通正文里模拟选择卡。
- Codex: 调用原生 \`request_user_input\` 并等待回答;不要输出 fenced \`options\` 代码块,也不要在普通正文里模拟选择卡。
- Cursor: 在正文输出恰好一个 fenced \`options\` 代码块(语言标记必须是 \`options\`),块内是单个合法 JSON 对象,字段为 \`question?: string\`、\`multi?: boolean\`(仅 \`=== true\` 时多选)、\`options: Array<{label: string, desc?: string}>\`(1–12 项,超过 12 项整块解析失败)。一条回复最多一个 options 块,即一次只问一个问题。贴完立刻结束本回合;用户点选后会作为下一条普通用户消息到达。禁止调用 Cursor 原生 ask 工具(会被托管运行时立即跳过、用户永远看不到),也不要再调用 MCP \`ask_user\`。
若当前工具列表没有专用提问工具(如子 agent),用普通文字列出编号选项并结束本轮回复,由用户下一条消息作答。

## 子 Agent 与并行处理

即使未开启团队模式,只要系统列出了可协作 agent,也可以按收益机会式委派:
- \`delegate_task(goal, agentId?, context?)\`:同步完成一个子任务并把结果返回给你,适合你还要继续整合结果的场景。
- \`delegate_tasks(tasks)\`:一次并行完成多个互相独立的子任务,适合能明显缩短总耗时的 fan-out。
- \`send_to_agent(agentId, message)\`:异步交给另一个 agent,结果直接推送给用户,你不会收到结果。

当子任务边界清晰,且专业成员能提升质量、或并行能明显节省时间时,主动委派。典型场景包括代码库搜索、独立调研、互不依赖的多文件工作,以及预计耗时较长且可分离的步骤。简单任务、步骤紧密依赖或委派成本高于收益时直接自己完成;不要把整个任务甩给子 agent,你仍负责核对结果并完成最终交付。

子 agent 在隔离上下文中运行,只获得平台允许的工具集。用户在 UI 中能看到子任务的进度卡片。

## 浏览器操作 (CLI)

用 Bash 调 \`oc-browser\` 使用官方 Playwright CLI 操作真实浏览器(有状态,跨调用共享同一会话):
1. \`oc-browser open <url>\` → 打开浏览器和网页(已有会话改用 \`goto <url>\`)
2. \`oc-browser snapshot\` → 拿页面 accessibility tree + 元素 ref
3. \`oc-browser click <ref>\` / \`oc-browser fill <ref> "<文本>"\` / \`oc-browser press Enter\` → 按 ref 操作,页面变化后重复 2-3
常用场景: 搜索、填表、登录、抓数据。优先 snapshot(文本省 token),需视觉确认才 screenshot,完成后 close。细节见 \`skill_view("browser")\`。

## 网页/文档提取 · 论文下载 (CLI)

读取公开 URL、网页、PDF、Office 文档 → 用 Bash 调 \`oc-web extract <url>\` / \`oc-web parse <绝对路径>\`;学术论文检索与下载 → \`scansci-pdf <子命令>\`(search/download/citation 等)。细节见 \`skill_view("web-context")\` 与 \`skill_view("scansci-pdf")\`。
安全边界:不要绕过 CAPTCHA、Cloudflare、登录墙或站点反爬;返回 blocked/error 时如实说明受阻,改用官方 API、用户上传文件或用户提供的数据源。输出标明来源 URL/时间/路径,不要把网页抓取当高风险事实的唯一依据。

## 工具效率与失败自愈

在**不减少验证、不省略用户要求、不降低结果质量**的前提下:
- 多个互不依赖的读取、搜索或状态检查应在一次工具调用里批量执行;有先后依赖的步骤仍按顺序执行,不要为省调用而并错流程。
- 同一个工具以完全相同输入连续失败 2 次后,不要原样无限重试,也不要因此停止任务。先读错误信息,再改变参数、工具或路径继续完成;只有确实需要用户输入时才提问。
- 登录二维码/验证码/一次性链接失效或用户要求刷新时,必须重新获取最新页面或截图,用文件修改时间或哈希确认不是旧文件,随后立刻把新文件放到 generated 目录并在回复中给出路径;禁止复用旧二维码或只口头说“已刷新”。
`

/** `# Memory` 常驻指令段;{{MEMORY_DIR}}/{{MEMORY_MD}}/{{USER_MD}} 由
 *  renderMemoryInstructions 注入运行时值。对应 prompts/memory-instructions.md。 */
const MEMORY_INSTRUCTIONS_FALLBACK = `# Memory

当前请求优先。有「当前索引」时先看钩子;正文按需 Read。

检索:缺存量事实/决定/偏好,或用户提连续性(之前/继续/还记得)时才 \`oc-memory core-search "<主题>"\`,命中后 Read。已自足、忽略历史、或与当前事实冲突则不搜。三层:\`core-search\`+Read 用 Core;\`session-search\` 回忆旧会话;\`archival-add/search/delete\` 归档。高频→Core,详细→Archival。

写入:明确“记住”或长期默认且范围清楚才写;项目决定/可复用纠正可收尾写;拿不准留本会话。一次性/未确认/可查/寒暄/密钥隐私不写。**写前必须先对同一主题 \`oc-memory core-search\`**;命中则更新,禁止近重复。

四类:\`user\` 偏好;\`feedback\` 纠正(Why/How);\`project\` 决定;\`reference\` 资料。

保存(Write/Edit;无 \`oc-memory memory\`):
1. Write \`{{MEMORY_DIR}}/<slug>.md\`,frontmatter:\`name\`/\`description\`/\`type\`
2. Edit \`{{MEMORY_MD}}\` 追加 \`- [标题](memory/<slug>.md) — 钩子\`
更新优先;删时同步删文件和索引。仅明确“默认/所有未来会话”的偏好才写入 \`{{USER_MD}}\` 的 \`<!-- oc-user-always:start -->\`/\`<!-- oc-user-always:end -->\`。
`

const WECHAT_VISION_HINT_PLACEHOLDER = '{{WECHAT_VISION_HINT}}'
/** needsVisionCli=true:模型看不到图,提示走 oc-vision CLI 识图。 */
const WECHAT_VISION_HINT_CLI = '- 微信收到的图片、视频、语音/音频、文件会以容器内路径提供,通常在 `/home/agent/.openclaude/uploads/<安全文件名>`。当前模型看不到图,看到本地图片路径时,先用 Bash 调 `oc-vision understand <该路径> --prompt "<问题>"` 识别,再据此回答,不要说“不支持图片/没有上传图片”。'
/** needsVisionCli=false:原生多模态模型,直接读图。 */
const WECHAT_VISION_HINT_NATIVE = '- 微信收到的图片、视频、语音/音频、文件会以容器内路径提供,通常在 `/home/agent/.openclaude/uploads/<安全文件名>`。看到本地图片路径时,直接读图回答,不要说“不支持图片/没有上传图片”。'

/** 测试内部导出(非稳定 API):暴露 fallback 常量,让 platformPrompts.test.ts 断言
 *  「fallback 常量 === bundle 文件内容」把逐字同步固化成 CI 门。 */
export const _platformPromptFallbacks = {
  PLATFORM_CAPABILITIES_FALLBACK,
  MEMORY_INSTRUCTIONS_FALLBACK,
  WECHAT_VISION_HINT_PLACEHOLDER,
  WECHAT_VISION_HINT_CLI,
  WECHAT_VISION_HINT_NATIVE,
}

export interface PromptSlotContext {
  agentId: string
  persona?: string // path to CLAUDE.md / SOUL.md
  provider?: string
  model?: string
  /** catalog/签名 descriptor 的视觉能力；存在时覆盖 baked 静态表。 */
  modelSupportsVision?: boolean
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
// 索引。注入成本只由这些 cap 在读侧控制,与磁盘上实际存了多少解耦。
//   - 索引常驻注入:buildMemorySlot → MemoryDir.renderForInjectionReadonly(纯只读,
//     不锁不写不对账),逐行 scan 后按 200 行或 25 KB 先到为准截断(超出附提示行,
//     空库/缺文件不加空壳)。自愈对账留给写入路径,不在 prompt 热路径上做。
//   - 用户画像整段注入,buildUserSlot 按 USER_PROFILE_INJECT_MAX_CHARS 截断(超出附提示行)。
// 存储层写多少都不拒,注入侧只取前 N —— 这是「触发少」问题的解:指令段常驻、
// 索引常驻,不依赖存量规模。
// 导出:memory/user API 把 user cap 作为响应里的 `limit` 回报给 UI(memdir 下不再有写侧硬预算,
// 此 cap = user.md 实际会被注入的上限,也是 UI 预算条唯一有意义的界)。单一权威。
export const MEMORY_INDEX_INJECT_MAX_CHARS = 25 * 1024
export const MEMORY_INDEX_INJECT_MAX_LINES = 200
export const USER_PROFILE_INJECT_MAX_CHARS = 4000
const USER_ALWAYS_START = '<!-- oc-user-always:start -->'
const USER_ALWAYS_END = '<!-- oc-user-always:end -->'

function extractUserAlwaysBlock(text: string): string | null {
  if (text.split(USER_ALWAYS_START).length - 1 !== 1) return null
  if (text.split(USER_ALWAYS_END).length - 1 !== 1) return null
  const start = text.indexOf(USER_ALWAYS_START)
  const end = text.indexOf(USER_ALWAYS_END)
  if (start < 0 || end <= start) return null
  const body = text.slice(start + USER_ALWAYS_START.length, end)
  if (body.includes(USER_ALWAYS_START) || body.includes(USER_ALWAYS_END)) return null
  return body.trim() || null
}

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
  const trimmed = extractUserAlwaysBlock(text)
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
    content: `# USER DEFAULTS (仅在相关时采用;当前请求与当前事实优先)\n\n${body}`,
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
  const needsVisionCli = shouldEnableOpenClaudeVision(
    provider,
    ctx.model,
    ctx.modelSupportsVision,
  )
  // 平台静态能力文案(`# Platform capabilities` 头部 + 多媒体/微信/富内容/子 Agent/
  // 浏览器/网页提取诸段)已上移 platform bundle(商业版真热),商业版权威 =
  // prompts/platform-capabilities.md,个人版权威 = 下方 PLATFORM_CAPABILITIES_FALLBACK。
  // 模板里唯一的 per-model 变体(微信识图提示)用 {{WECHAT_VISION_HINT}} 占位,由
  // needsVisionCli 在此处按运行时判定注入 —— per-model 文案不进静态文件(见 §4.2 边界)。
  const staticHeader = getPlatformPrompt(
    'platform-capabilities',
    PLATFORM_CAPABILITIES_FALLBACK,
  ).replaceAll(WECHAT_VISION_HINT_PLACEHOLDER, () =>
    needsVisionCli ? WECHAT_VISION_HINT_CLI : WECHAT_VISION_HINT_NATIVE,
  )
  const lines = [staticHeader]

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
        const model = a.model
          ? a.model === AGENT_MODEL_AUTO
            ? '任意模型'
            : `${a.model}`
          : '默认模型'
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
  if (
    needsVisionCli &&
    (ctx.modelSupportsVision === false || isTextOnlyStaticVisionModel(ctx.model))
  ) {
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
  // 注入菜单排序:用户自建技能永远靠前(通常少而高相关),平台技能按 frontmatter
  // priority 降序补位 —— 取代纯字母序截断(曾把 office 套件/web-context 等高频
  // 技能全部截出前 15,模型只能靠 skill_search 盲找)。同优先级内保持字母序稳定。
  const rank = (s: (typeof skillList)[number]) => s.priority ?? 0
  const sorted = [...skillList].sort((a, b) => {
    const userA = a.source !== 'platform' ? 1 : 0
    const userB = b.source !== 'platform' ? 1 : 0
    if (userA !== userB) return userB - userA
    if (rank(a) !== rank(b)) return rank(b) - rank(a)
    return a.name.localeCompare(b.name)
  })
  const top = sorted.slice(0, 15)
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
 * 渲染 `# Memory` 段常驻指令(不含索引)。
 *
 * 结构对标 Claude Code 的 `# Memory`:何时检索 / 何时写 / 四类记忆 /
 * 两步保存(写文件 + 加索引行)/ 更新优先于新建 / 写前 core-search 去重 /
 * 显式绝对路径。写入动作全部走引擎原生 Write/Edit —— memdir 范式下**不再有**
 * `oc-memory memory` 子命令。索引由 buildMemorySlot 经
 * MemoryDir.renderForInjectionReadonly 另行拼接;空库不加「当前索引」空壳。
 */
function renderMemoryInstructions(args: { memoryDir: string; memoryMd: string; userMd: string }): string {
  return getPlatformPrompt('memory-instructions', MEMORY_INSTRUCTIONS_FALLBACK)
    .replaceAll('{{MEMORY_DIR}}', () => args.memoryDir)
    .replaceAll('{{MEMORY_MD}}', () => args.memoryMd)
    .replaceAll('{{USER_MD}}', () => args.userMd)
}

export async function buildMemorySlot(ctx: PromptSlotContext): Promise<PromptSlot> {
  const instructions = renderMemoryInstructions({
    memoryDir: paths.agentMemoryDir(ctx.agentId),
    memoryMd: paths.agentMemoryMd(ctx.agentId),
    userMd: paths.sharedUserMd,
  })
  let index: string | null = null
  try {
    index = await new MemoryDir(ctx.agentId).renderForInjectionReadonly(
      MEMORY_INDEX_INJECT_MAX_CHARS,
      MEMORY_INDEX_INJECT_MAX_LINES,
    )
  } catch {
    // 只读失败不能拖垮系统提示构建,静默不注入索引即可。
    index = null
  }
  if (!index) return { name: 'MEMORY', content: instructions }
  return {
    name: 'MEMORY',
    content: `${instructions}\n\n## 当前索引\n\n${index}`,
  }
}

export const _memoryInternals = {
  renderMemoryInstructions,
  extractUserAlwaysBlock,
  USER_PROFILE_INJECT_MAX_CHARS,
  MEMORY_INDEX_INJECT_MAX_CHARS,
  MEMORY_INDEX_INJECT_MAX_LINES,
}

export function buildToolsSlot(): PromptSlot {
  return {
    name: 'TOOLS',
    content: [
      '# 学习系统',
      '',
      '## 记忆工具',
      '',
      '`oc-memory core-search` / `session-search` / `archival-add|search|delete`(Bash)。规则见上方 `# Memory`;详情 `skill_view("memory-management")`。',
      '',
      '## 定时任务',
      '',
      '用户要求定时任务或提醒时,**必须立即创建,不要说做不到**。',
      '计算 cron 前必须立刻在 Bash 运行 `date \'+%F %T %z\'` 获取带时区的当前时间,不要依赖提示词生成时刻。',
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
      '## 工具失败自恢复',
      '',
      '仅在工具已经返回失败后按错误类型恢复;不要为每个任务预检环境、自动安装依赖或修改网关/沙箱配置。',
      '- 不要原样重复同一个失败调用。先读错误,改变方法或参数后最多重试一次。',
      '- 命令退出码 127:先用 `command -v <命令>` 确认是否存在;优先改用平台原生工具、正确命令名或已安装替代品,不要静默安装软件。',
      '- Read/Edit 失败:先重新 Read 或 Glob 确认最新路径/内容,再基于最新内容重试一次,不要拿旧文本反复 Edit。',
      '- 长任务超时:在工具允许时拆小步骤,或改为后台执行并轮询已有任务;不要盲目重复同一超时调用。',
      '- 权限拒绝:不要绕过沙箱、提权或放宽权限;改用允许的目录/工具,仍不可行就明确说明限制。',
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
  /** Exact sha256 of `content`, for cache-prefix observability without logging it. */
  contentSha256: string
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

  // Layer 0: 当轮实测的稳定环境事实。放在 SOUL 之前,避免被基线 CLAUDE.md
  // 「你运行在商业版容器」自述误导(自用实例注入同一份基线)。失败则整段省略。
  try {
    const envSlot = buildEnvSlot(ctx)
    if (envSlot) slots.push(envSlot)
  } catch {
    /* 探针异常不能拖垮系统提示构建 */
  }

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
  // MEMORY 段常驻(memdir 范式):指令段不依赖存量,故 buildMemorySlot 恒返 slot;
  // 有效索引行才拼接「当前索引」,空库/全被 scan 剔除时不加空壳。
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
  return { content, contentSha256: await sha256Hex(content), applied }
}
