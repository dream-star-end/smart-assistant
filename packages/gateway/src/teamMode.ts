/**
 * teamMode —— v5 团队模式的纯逻辑(可单测,不碰 Gateway 实例)。
 *
 * 2026-09-04 重构:团队模式从「一段协作 preamble + 审查员开关」变成**一个开关、两条策略**:
 *
 *   - **审议(deliberation)**:判断/研究/方案取舍/事实核查类任务。借 OpenRouter Fusion 的
 *     形态 —— 同一问题并行派给 **多个不同模型家族**(panel),再由审查员当 analyst 做
 *     结构化对比(共识 / 矛盾 / 部分覆盖 / 独有洞见 / 盲点),队长据此写终稿。
 *   - **执行(execution)**:代码/文档/数据等有唯一执行路径的交付类任务。沿用领域拆分:
 *     按成员领域委派,审查员当验收员,但**必须拿到证据**(成员产物路径 + 结果摘要)。
 *
 * 本文件只做四件事,全部纯函数:
 *   1. `pickDeliberationPanel` —— 从 catalog 投影按「家族多样性」挑 panel 型号;
 *   2. `pickReviewerModel` —— 审查员型号必须 ≠ 队长本轮型号(同模型审自己盲点重合);
 *   3. `buildTeamReviewContext` —— 两套审查任务书(执行验收 / 审议对比),都带成员证据;
 *   4. `buildTeamPreamble` —— 队长引导词(策略分类规则 + panel 名单 + 成本预告)。
 *
 * 不做:不做硬编排、不扣 final、不动委派闸(那些留在 server.ts,已有测试锁定)。
 */
import type { DurableAgentGroup } from '@openclaude/protocol'
import type { AgentDef } from '@openclaude/storage'

import type { LocalCatalogModel, LocalCatalogView } from './modelCatalogClient.js'

// ───────────────────────────────────────────────
// 审查模式词汇(单一权威;mcp-memory request_review / CLI request-review 透传同一字面)
// ───────────────────────────────────────────────
export const TEAM_REVIEW_MODES = ['execution', 'deliberation'] as const
export type TeamReviewMode = (typeof TEAM_REVIEW_MODES)[number]

export function parseTeamReviewMode(raw: unknown): TeamReviewMode {
  return raw === 'deliberation' ? 'deliberation' : 'execution'
}

// ───────────────────────────────────────────────
// 模型家族(多样性的判定单位)
// ───────────────────────────────────────────────
/**
 * 型号 → 家族。同家族(如 gpt-5.6-sol 与 gpt-5.6-terra)不算多样;panel 每家族至多取一个。
 * 只认 catalog 里现有的前缀形态;认不出来的按 model_id 自身当独立家族(宁可多算一家,
 * 不要把两个真不同的模型误合并)。
 */
export function modelFamily(modelId: string): string {
  const id = modelId.toLowerCase()
  if (id.startsWith('cursor-')) return 'cursor'
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4'))
    return 'openai'
  if (id.startsWith('glm-')) return 'zhipu'
  if (id.startsWith('grok')) return 'xai'
  if (id.startsWith('deepseek')) return 'deepseek'
  if (id.startsWith('kimi') || id.startsWith('k3') || id.startsWith('moonshot')) return 'moonshot'
  if (id.startsWith('minimax')) return 'minimax'
  if (id.startsWith('qwen')) return 'qwen'
  if (id.startsWith('claude')) return 'anthropic'
  return id
}

/** panel 默认规模(= Fusion 默认 3 模型 panel;delegate_tasks 单次上限 4,留 1 给余量)。 */
export const DELIBERATION_PANEL_SIZE_DEFAULT = 3
/**
 * 审议 panel 的优先顺序(Quality 档)。规则:每家族只取一个;按此表优先;表外可路由型号补位。
 * cursor-* 排除:那是另一条 CLI 链路,在 delegate 子会话里做 panel 成员既慢又贵,且与
 * grok-build 家族重叠(都是 xAI 路线)时反而降低多样性。
 */
export const DELIBERATION_PANEL_PREFERENCE = [
  'gpt-5.6-sol',
  'grok-build',
  'glm-5.3-zai',
  'deepseek-v4-pro',
  'kimi-k3',
  'qwen3.8-max',
  'MiniMax-M3',
] as const

export interface DeliberationPanelMember {
  modelId: string
  family: string
  displayName: string
  engine: LocalCatalogModel['engine']
}

function isPanelEligible(m: LocalCatalogModel): boolean {
  if (!m.available) return false
  if (m.engine === 'cursor') return false
  return true
}

/**
 * 从 catalog 投影挑 panel:先按优先表,再按投影里剩余可路由型号补齐,每家族最多一个。
 * `excludeModel`(通常 = 队长本轮型号)会被跳过 —— 队长自己已经是一份视角,panel 再放
 * 同一模型只是重复付费。投影里凑不够 N 个家族就返回能凑到的(调用方决定是否降级)。
 */
export function pickDeliberationPanel(
  view: Pick<LocalCatalogView, 'models' | 'canonicalize' | 'isRoutable' | 'resolve'>,
  opts: { size?: number; excludeModel?: string; requireLocalEngines?: boolean } = {},
): DeliberationPanelMember[] {
  const size = Math.max(1, Math.floor(opts.size ?? DELIBERATION_PANEL_SIZE_DEFAULT))
  const excluded = opts.excludeModel ? view.canonicalize(opts.excludeModel) : undefined
  const excludedFamily = excluded ? modelFamily(excluded) : undefined
  const out: DeliberationPanelMember[] = []
  const seenFamilies = new Set<string>()
  if (excludedFamily) seenFamilies.add(excludedFamily)

  const tryAdd = (raw: string): void => {
    if (out.length >= size) return
    const canonical = view.canonicalize(raw)
    if (canonical === excluded) return
    if (!view.isRoutable(canonical)) return
    const m = view.resolve(canonical)
    if (!m || !isPanelEligible(m)) return
    // 生产(非 selfhost 豁免)上 codex/grok 引擎不能在本地 delegate turn 跑;调用方按
    // isEngineLocalTurnExempt 决定是否只收 ccb。
    if (opts.requireLocalEngines && m.engine !== 'ccb') return
    const fam = modelFamily(canonical)
    if (seenFamilies.has(fam)) return
    seenFamilies.add(fam)
    out.push({
      modelId: canonical,
      family: fam,
      displayName: m.displayName || canonical,
      engine: m.engine,
    })
  }

  for (const pref of DELIBERATION_PANEL_PREFERENCE) tryAdd(pref)
  if (out.length < size) {
    // 补位:投影剩余型号按 model_id 字典序(稳定、可复现),跳过已选家族。
    const rest = [...view.models].map((m) => m.modelId).sort()
    for (const id of rest) tryAdd(id)
  }
  return out
}

/**
 * 审查员型号:必须与队长本轮型号 **不同家族**;优先表 = panel 优先表(强模型优先),
 * 都不可用时返回 undefined → 调用方沿用 agents.yaml 里 hidden-reviewer 的默认绑定
 * (可能与队长同模型 —— 这是降级,不是拒绝;审查有比没有好)。
 *
 * `avoidModels`:审议模式下 panel 成员也要避开 —— analyst 不该是自己刚答过题的那位。
 */
export function pickReviewerModel(
  view: Pick<LocalCatalogView, 'models' | 'canonicalize' | 'isRoutable' | 'resolve'>,
  opts: { leaderModel?: string; avoidModels?: readonly string[]; requireLocalEngines?: boolean },
): string | undefined {
  const avoidFamilies = new Set<string>()
  const avoidExact = new Set<string>()
  for (const raw of [opts.leaderModel, ...(opts.avoidModels ?? [])]) {
    if (typeof raw !== 'string' || raw === '') continue
    const c = view.canonicalize(raw)
    avoidExact.add(c)
    avoidFamilies.add(modelFamily(c))
  }
  // 候选 = 优先表(强模型优先)+ 投影其余型号(字典序补位,稳定可复现)。
  const candidates: string[] = [...DELIBERATION_PANEL_PREFERENCE]
  for (const id of [...view.models].map((m) => m.modelId).sort()) {
    if (!candidates.includes(id)) candidates.push(id)
  }
  // 两轮:先严格避开家族;凑不到再只避开精确型号(至少不是同一个模型审自己)。
  for (const strict of [true, false]) {
    for (const raw of candidates) {
      const c = view.canonicalize(raw)
      if (avoidExact.has(c)) continue
      if (strict && avoidFamilies.has(modelFamily(c))) continue
      if (!view.isRoutable(c)) continue
      const m = view.resolve(c)
      if (!m || !isPanelEligible(m)) continue
      if (opts.requireLocalEngines && m.engine !== 'ccb') continue
      return c
    }
  }
  return undefined
}

// ───────────────────────────────────────────────
// 成员证据(审查员不再盲审)
// ───────────────────────────────────────────────
/** 单条成员证据在任务书里的最大字符数;超出截断并标注,完整正文让审查员按 runId 读团队卡/文件。 */
export const REVIEW_EVIDENCE_ITEM_MAX_CHARS = 6000
/** 全部证据合计上限(防 panel 3 份长答案把审查员上下文撑爆)。 */
export const REVIEW_EVIDENCE_TOTAL_MAX_CHARS = 24000
/** 草稿本身的上限;超过则截断并**显式**标注(旧实现 16000 静默截断,审查员审的是半截)。 */
export const REVIEW_DRAFT_MAX_CHARS = 16000

const GENERATED_PATH_RE = /\/home\/agent\/\.openclaude\/generated\/[^\s`'")\]]+/g

/** 从成员回传里抓落盘产物路径(产物纪律要求成员回传「路径 + 摘要」)。 */
export function extractArtifactPaths(text: string | undefined): string[] {
  if (!text) return []
  const set = new Set<string>()
  for (const m of text.matchAll(GENERATED_PATH_RE)) set.add(m[0])
  return [...set]
}

export interface ReviewEvidenceItem {
  runId: string
  agentId: string
  /** panel 成员实际执行型号(审议模式区分视角用;执行模式可缺)。 */
  model?: string
  goal: string
  status: DurableAgentGroup['status']
  resultSummary?: string
}

function truncateMarked(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…(已截断,原文 ${text.length} 字;完整内容见团队卡/产物文件)`
}

/**
 * 把本 turn 已完成的成员委派整理成审查员可核对的证据块。
 * 输入取自队长会话 `_pendingAgentGroups`(server-authored 团队卡,turn 末才 drain,
 * 审查发生在 turn 内 → 此时正好全在),审查员自己的委派行(agentId=hidden-reviewer)剔除。
 */
export function formatReviewEvidence(items: readonly ReviewEvidenceItem[]): string {
  const visible = items.filter((it) => it.agentId !== 'hidden-reviewer')
  if (visible.length === 0) return '(本轮队长没有委派成员;审查只能基于草稿与用户需求。)'
  const perItemBudget = Math.max(
    800,
    Math.min(
      REVIEW_EVIDENCE_ITEM_MAX_CHARS,
      Math.floor(REVIEW_EVIDENCE_TOTAL_MAX_CHARS / visible.length),
    ),
  )
  const blocks = visible.map((it, i) => {
    const artifacts = extractArtifactPaths(it.resultSummary)
    const head = `### 成员 ${i + 1}:\`${it.agentId}\`${it.model ? `(型号 ${it.model})` : ''} · 状态 ${it.status} · runId ${it.runId}`
    const goal = `任务:${it.goal.replace(/\s+/g, ' ').trim().slice(0, 400)}`
    const art =
      artifacts.length > 0 ? `产物文件:\n${artifacts.map((p) => `- ${p}`).join('\n')}` : ''
    const body = it.resultSummary
      ? `回传:\n${truncateMarked(it.resultSummary.trim(), perItemBudget)}`
      : '回传:(无文本)'
    return [head, goal, art, body].filter(Boolean).join('\n')
  })
  return blocks.join('\n\n')
}

// ───────────────────────────────────────────────
// 审查任务书(两套模板)
// ───────────────────────────────────────────────
export function buildTeamReviewContext(args: {
  mode: TeamReviewMode
  userTask: string
  leaderDraft: string
  evidence: readonly ReviewEvidenceItem[]
}): string {
  const task = args.userTask.trim() || '(未提供)'
  const rawDraft = args.leaderDraft.trim()
  const draft = rawDraft
    ? truncateMarked(rawDraft, REVIEW_DRAFT_MAX_CHARS)
    : '(队长本轮没有产出文本草稿)'
  const evidence = formatReviewEvidence(args.evidence)
  const verdictLine =
    '审查完成后,按你的 persona 要求在最后单独一行输出结构化裁决:`VERDICT: PASS` 或 `VERDICT: NEEDS_FIX`。'

  if (args.mode === 'deliberation') {
    return [
      '【审议对比任务】队长把同一个问题并行派给了下面几位不同模型的成员,现在准备综合成给用户的最终答复。',
      '你是 analyst:**只比较,不合并,不自己重答**。产出必须按下面五段结构,每段都要点名是哪位成员说的:',
      '1. **共识**:全部或多数成员一致的结论(视为高置信;但若你有明确依据认为共识本身是错的,必须指出)。',
      '2. **矛盾**:成员之间直接冲突的判断,逐条列出双方主张与依据;能判断谁对就判断,不能就说明需要什么信息。',
      '3. **部分覆盖**:只有部分成员提到、其余成员遗漏的要点。',
      '4. **独有洞见**:某一位成员独有且有价值的观点。',
      '5. **盲点**:所有成员都没有触及、但对用户问题重要的方面。',
      '然后对照「队长待提交草稿」:草稿是否正确吸收了共识、如实呈现了矛盾、补上了盲点?',
      '草稿把矛盾写成定论、把单一成员观点当共识、或遗漏重要盲点 → NEEDS_FIX,并具体说明改哪里。',
      '',
      '## 用户原始需求',
      task,
      '',
      '## 成员各自的回答(panel)',
      evidence,
      '',
      '## 队长待提交草稿',
      draft,
      '',
      verdictLine,
    ].join('\n')
  }

  return [
    '【验收任务】队长在团队协作后准备把下面的草稿作为最终答复提交给用户。',
    '请独立验收:找事实错误、遗漏、过度承诺、执行风险、以及与用户需求的偏离。',
    '**不要盲审**:下面附有本轮每位成员的任务、状态、回传与落盘产物路径。',
    '- 草稿里的每一条「已完成 / 已验证 / 测试通过」都要能在成员回传或产物文件里找到对应证据;找不到就当作未验证,判 NEEDS_FIX 并指明缺哪条证据。',
    '- 成员状态是 failed / timeout 而草稿却当作成功引用其结果 → NEEDS_FIX。',
    '- 产物文件路径你可以用 Read 直接打开核对;不要只凭回传摘要下结论。',
    '- 只判阻塞问题;风格/微优化写成建议,不影响裁决。',
    '',
    '## 用户原始需求',
    task,
    '',
    '## 本轮成员委派证据',
    evidence,
    '',
    '## 队长待提交草稿',
    draft,
    '',
    verdictLine,
  ].join('\n')
}

// ───────────────────────────────────────────────
// 队长 preamble
// ───────────────────────────────────────────────
export interface TeamPreambleArgs {
  members: readonly AgentDef[]
  /** 每个成员的能力提示(已由调用方读 persona/greeting 生成)。 */
  memberHint: (a: AgentDef) => string
  autoModelToken: string
  panel: readonly DeliberationPanelMember[]
  /** 队长本轮型号(用于成本预告文案;可缺)。 */
  leaderModel?: string
  /** 当前引擎是否 Cursor(委派/审查通道文案不同)。 */
  cursorEngine: boolean
}

export function buildTeamPreamble(args: TeamPreambleArgs): string {
  const memberLines =
    args.members.length > 0
      ? args.members
          .map((a) => {
            const model = a.model
              ? a.model === args.autoModelToken
                ? '任意模型'
                : `${a.model}`
              : '默认模型'
            const provider = a.provider || '继承全局'
            return `- \`${a.id}\`${a.displayName ? `（${a.displayName}）` : ''} [${model}, ${provider}]${args.memberHint(a)}`
          })
          .join('\n')
      : '（当前没有其它已安装 agent —— 执行类任务直接自己完成即可）'

  const panelLines =
    args.panel.length >= 2
      ? args.panel.map((p) => `- \`${p.modelId}\`（${p.family}）`).join('\n')
      : '（当前可用型号不足两个不同家族,审议策略不可用 —— 判断类问题请自己回答后送审）'
  const panelSlugs = args.panel.map((p) => p.modelId)

  const delegateSingle = args.cursorEngine
    ? 'Bash `oc-memory delegate --goal "..."`（返回 `status=running` 时立即 `oc-memory delegate-wait <jobId>` 续等,不走 MCP,不用 Cursor `TaskOutput`）'
    : 'MCP `delegate_task(goal, agentId, context, effort)`'
  const delegateFanout = args.cursorEngine
    ? '同一回合并发多条 `oc-memory delegate --allow-self --model <型号> --goal "..."`'
    : '`delegate_tasks`（tasks 列表,单次最多 4 个;每项填 `model`,`agentId` 留空即派给 main）'
  const reviewCmd = (mode: TeamReviewMode) =>
    args.cursorEngine
      ? `\`oc-memory request-review --mode ${mode} --draft "..."\``
      : `\`request_review(draft, mode="${mode}")\``

  const panelExample = args.cursorEngine
    ? panelSlugs
        .map((s) => `oc-memory delegate --allow-self --model ${s} --goal "<同一个问题>"`)
        .join(' ；')
    : `delegate_tasks({ tasks: [${panelSlugs.map((s) => `{ model: "${s}", goal: "<同一个问题>" }`).join(', ')}] })`

  return [
    '【团队模式已开启】用户已授权你为这次任务动用多模型/多成员并承担相应成本。你是队长,按下面的规则先给任务分类,再选策略:',
    '',
    '## 第一步:分类',
    '- **审议类**:判断、比较、研究、方案取舍、事实核查、"这样做对不对"、开放式分析 —— 答案质量取决于视角多样性,没有唯一执行路径。',
    '- **执行类**:写/改代码、生成文档/PPT/表格、数据处理、排障修复、有明确交付物 —— 有唯一执行路径,多个模型各做一份只是浪费。',
    '- **简单类**:单一事实问答、寒暄、一句话能答完 —— 直接回答,不组队、不送审。',
    '',
    '## 审议类 → 审议策略(多模型 panel + 对比审查)',
    `panel 型号(按可用性与家族多样性已为你选好,${args.panel.length} 个不同家族):\n${panelLines}`,
    `- 把**同一个问题**(用户原文 + 必要背景,不要拆分)并行派给上面每个型号,${delegateFanout}。`,
    `  示例:${panelExample}`,
    '- 每个 panel 成员是独立答题者,不要告诉它其他成员的答案。',
    `- 全部回来后,先写草稿(综合共识、如实呈现矛盾、补盲点),再送审:${reviewCmd('deliberation')}。审查员会当 analyst 按「共识/矛盾/部分覆盖/独有洞见/盲点」五段对比 panel 回答并核对你的草稿。`,
    '- 最终答复要让用户看到:哪些是多方一致的、哪些有分歧(分歧点各方怎么说)、还有哪些没人覆盖。不要把分歧抹平成定论。',
    `- 成本预告:审议 = ${args.panel.length} 份 panel 回答 + 1 次审查 + 你自己,约为单模型直答的 ${args.panel.length + 2} 倍。只用在值得的问题上。`,
    '',
    '## 执行类 → 执行策略(领域拆分 + 证据验收)',
    `可委派的成员(已安装 agent):\n${memberLines}`,
    '- 领域匹配优先:代码/调试/测试/重构 → `coding-assistant`;科研/文献/论文 → `research-assistant`;文档/PPT/Excel/PDF/公文 → `office-assistant`。对应成员未安装就自己做或选最接近的。',
    `- 单个子任务用 ${delegateSingle};多个互相独立的子任务并行派发;有先后依赖的串行。复杂任务先用 \`TodoWrite\` 列拆解计划。`,
    '- 按子任务量级选 `effort`(low/medium/high),拿不准就不填。',
    '- 成员的大产物以「文件路径 + 摘要」回传(落在 `/home/agent/.openclaude/generated/`),综合时用 `Read` 读回来,别凭摘要臆测。',
    `- 完成后先写草稿再送审:${reviewCmd('execution')}。审查员会拿到本轮每位成员的任务、状态、回传和产物路径,逐条核对你草稿里的「已完成/已验证」是否有证据。`,
    '',
    '## 通用纪律',
    '- 委派只走平台通道(有实时进度、计费与资源约束)。平台已停用 codex 原生 `Agent`/子进程编排,不要尝试启动。',
    '- 送审时草稿只放在工具/命令参数里,不要先写进正文。拿到 `VERDICT: PASS` 再输出最终答复;`NEEDS_FIX` 就修订后再送审一次(误报可在 revisionNote 据理反驳)。送审有每轮次数上限,达到上限就输出当前最优终稿。',
    '- 审查是内部流程:最终答复不要复述审查意见、不要致歉。',
    '- 同一话题追问时,复用上一轮返回的 `resumeSessionKey` 续跑同一成员会话,省冷启动。',
    '',
    '用户任务:',
    '',
  ].join('\n')
}
