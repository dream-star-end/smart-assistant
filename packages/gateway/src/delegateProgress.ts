import type { TurnTokenUsageSnapshot } from '@openclaude/protocol'

const DEFAULT_TEXT_LIMIT = 800
const TOOL_PREVIEW_LIMIT = 180

export type DelegateProgressPhase =
  | 'start'
  | 'text'
  | 'thinking'
  | 'plan'
  | 'tool'
  | 'usage'
  | 'done'
  | 'error'

export type DelegateProgressBlock = {
  kind: 'delegate_progress'
  runId: string
  agentId: string
  phase: DelegateProgressPhase
  text?: string
  toolName?: string
  isError?: boolean
  /**
   * 委派目标的原始 goal,仅 start 帧携带。前端用 (agentId, goal) 把整个委派 run
   * 唯一关联回队长那次 delegate_task 工具卡,从而把进度嵌进同一张 agent-group 卡。
   * 不做摘要折叠 / 截断改写,保持与队长 tool_use input.goal 同源以便精确匹配。
   */
  goal?: string
  /** Exact async handle returned by send_to_agent; avoids goal-key ambiguity. */
  jobId?: string
  /** Absolute usage snapshot for one exact child execution. `runId` may be
   * rebound to a first-level visible card; this id never changes. */
  usageRunId?: string
  usage?: TurnTokenUsageSnapshot
  /**
   * 完整子 agent block payload(text/thinking/tool_use/tool_result/tool_output_tail),供新前端
   * 复用主聊天富渲染(`_appendSubagentBlock`)。旧前端不读此字段、走 `text`/`phase` 降级,两侧兼容。
   * 仅「透传模式」(makeDelegateBlockPassthrough)产生;start/done/error/plan 仍是纯摘要帧无 block。
   */
  block?: unknown
}

export function makeDelegateUsageProgressBlock(args: {
  runId: string
  usageRunId: string
  agentId: string
  usage: TurnTokenUsageSnapshot
}): DelegateProgressBlock {
  return {
    kind: 'delegate_progress',
    runId: args.runId,
    usageRunId: args.usageRunId,
    agentId: args.agentId,
    phase: 'usage',
    usage: { ...args.usage },
  }
}

export function sanitizeDelegateProgressText(
  raw: unknown,
  maxLen = DEFAULT_TEXT_LIMIT,
  opts: { trim?: boolean } = {},
): string {
  let normalized = String(raw ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
  if (opts.trim !== false) normalized = normalized.trim()
  if (!normalized) return ''
  if (normalized.length <= maxLen) return normalized
  return `${normalized.slice(0, Math.max(0, maxLen - 1))}…`
}

/** Goal-as-correlation-key max length. Goals are short task descriptions; this
 *  is just a wire-size guard. The frontend slices `input.goal` to the same cap
 *  before comparing, so equality still holds after truncation. */
const DELEGATE_GOAL_KEY_CAP = 1024

/** Normalize a goal for use as a (agentId, goal) correlation key. Normalizes
 *  newlines and trims, but deliberately does NOT fold internal whitespace
 *  (unlike sanitizeDelegateProgressText) so it stays byte-identical to the
 *  leader's raw delegate_task `input.goal` the frontend compares against
 *  (the frontend applies the same trim + slice). */
export function normalizeDelegateGoalKey(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, DELEGATE_GOAL_KEY_CAP)
}

export function makeDelegateProgressBlock(args: {
  runId: string
  agentId: string
  phase: DelegateProgressPhase
  text?: unknown
  toolName?: unknown
  isError?: boolean
  goal?: unknown
  jobId?: unknown
  maxLen?: number
  preserveWhitespace?: boolean
}): DelegateProgressBlock {
  const block: DelegateProgressBlock = {
    kind: 'delegate_progress',
    runId: args.runId,
    agentId: args.agentId,
    phase: args.phase,
  }
  const text = sanitizeDelegateProgressText(args.text, args.maxLen ?? DEFAULT_TEXT_LIMIT, {
    trim: !args.preserveWhitespace,
  })
  if (text) block.text = text
  const toolName = sanitizeDelegateProgressText(args.toolName, 80)
  if (toolName) block.toolName = toolName
  if (args.isError !== undefined) block.isError = Boolean(args.isError)
  if (typeof args.jobId === 'string' && /^dlgjob-[A-Za-z0-9-]{1,160}$/.test(args.jobId)) {
    block.jobId = args.jobId
  }
  if (args.goal !== undefined) {
    const goal = normalizeDelegateGoalKey(args.goal)
    if (goal) block.goal = goal
  }
  return block
}

function planText(block: any): string {
  const parts: string[] = []
  if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
  if (typeof block.explanation === 'string' && block.explanation.trim()) {
    parts.push(block.explanation.trim())
  }
  if (Array.isArray(block.steps) && block.steps.length > 0) {
    const steps = block.steps
      .slice(0, 8)
      .map((s: any) => {
        const step = sanitizeDelegateProgressText(s?.step, 120)
        const status = sanitizeDelegateProgressText(s?.status, 24)
        return step ? `- ${status ? `[${status}] ` : ''}${step}` : ''
      })
      .filter(Boolean)
      .join('\n')
    if (steps) parts.push(steps)
  }
  return parts.join('\n')
}

export function summarizeDelegateProgressEvent(
  event: any,
  runId: string,
  agentId: string,
): DelegateProgressBlock | null {
  if (!event || event.kind !== 'block' || !event.block) return null
  const block = event.block as any
  switch (block.kind) {
    case 'text':
      return makeDelegateProgressBlock({
        runId,
        agentId,
        phase: 'text',
        text: block.text,
        preserveWhitespace: true,
      })
    case 'thinking':
      // Chain-of-thought is internal scratch. Streaming the raw reasoning
      // monologue turned the delegate card into a wall of italic text (and
      // leaks the member's private reasoning). Drop it from the progress feed —
      // the card still carries real text output, tool chips and the final
      // result, which is enough live signal.
      return null
    case 'plan':
      return makeDelegateProgressBlock({ runId, agentId, phase: 'plan', text: planText(block) })
    case 'tool_use': {
      const toolName = block.toolName || 'tool'
      const preview = sanitizeDelegateProgressText(block.inputPreview, TOOL_PREVIEW_LIMIT)
      return makeDelegateProgressBlock({
        runId,
        agentId,
        phase: 'tool',
        toolName,
        text: preview ? `调用工具 ${toolName}: ${preview}` : `调用工具 ${toolName}`,
      })
    }
    case 'tool_result': {
      const toolName = block.toolName || 'tool'
      return makeDelegateProgressBlock({
        runId,
        agentId,
        phase: 'tool',
        toolName,
        isError: Boolean(block.isError),
        text: `${toolName} ${block.isError ? '执行出错' : '执行完成'}`,
      })
    }
    case 'tool_output_tail':
      return makeDelegateProgressBlock({
        runId,
        agentId,
        phase: 'tool',
        toolName: 'Bash',
        text: 'Bash 输出更新中',
      })
    default:
      return null
  }
}

/**
 * 把子 agent 的执行 block 以**完整 payload** 透传成 delegate_progress 帧(取代 summarize 的降级):
 *   - `block` 字段携带完整子 block(thinking 不再 drop、tool 输入/输出不再砍 180/800),供**新前端**
 *     复用主聊天富渲染。
 *   - 同时保留 `phase`/`text`/`toolName`/`isError`(复用 summarizeDelegateProgressEvent)给**旧前端**
 *     降级显示;thinking 走 summarize 返回 null → 这里补一个 phase='thinking' 的最小帧(旧前端按
 *     phase 跳过 thinking,行为与旧版一致;新前端用 block 渲染)。
 * React treats these values as text rather than HTML, so the trusted engine
 * block can be forwarded byte-for-byte. Presentation summaries remain a
 * separate legacy field and never rewrite the authoritative `block`.
 */
export function makeDelegateBlockPassthrough(
  event: any,
  runId: string,
  agentId: string,
): DelegateProgressBlock | null {
  if (!event || event.kind !== 'block' || !event.block) return null
  const b = event.block as any
  const RENDERABLE = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'tool_output_tail', 'plan', 'goal'])
  if (!RENDERABLE.has(b.kind)) return null
  const legacy = summarizeDelegateProgressEvent(event, runId, agentId)
  const phase: DelegateProgressPhase =
    legacy?.phase ??
    (b.kind === 'thinking' ? 'thinking' : b.kind === 'text' ? 'text' : b.kind === 'plan' || b.kind === 'goal' ? 'plan' : 'tool')
  const base: DelegateProgressBlock = legacy ?? {
    kind: 'delegate_progress',
    runId,
    agentId,
    phase,
  }
  return {
    ...base,
    kind: 'delegate_progress',
    runId,
    agentId,
    phase,
    block: { ...b },
  }
}

/**
 * 沿委派父链向上追溯所需的最小会话视图(解耦具体 SessionManager,便于纯函数单测)。
 */
export type DelegateChainSession = {
  sessionKey: string
  channel: string
  peerId: string
  agentId: string
  userId?: string
  /** 直接父会话键;仅 delegate 子会话在创建时物化(webchat 根会话为 undefined)。 */
  parentSessionKey?: string
  /** 本(delegate)会话进度卡的 runId;嵌套子委派复用**一级**委派的该值挂回同一张卡。 */
  progressRunId?: string
}

/**
 * 委派进度路由决策:进度帧要投递到哪个 webchat 祖先会话,以及(嵌套时)如何挂回
 * 用户可见的那张**一级**委派卡。
 */
export type DelegateProgressRouting = {
  /** 进度投递目标 = 最近的 webchat 祖先会话。非嵌套(一级)时即直接 webchat 父。 */
  target: { sessionKey: string; channel: string; peerId: string; userId?: string }
  /** 直接父是否为 delegate 会话(true = 二级+嵌套委派,进度要挂到一级卡)。 */
  nested: boolean
  /** 一级委派会话(其父为 webchat)的进度卡 runId;嵌套帧复用它 append 到同一张卡。
   *  非嵌套时 undefined(调用方用本委派自身 runId)。一级会话未开进度时也可能缺失,
   *  调用方退回自身 runId → 独立进度卡兜底(仍可见,不丢)。 */
  firstLevelRunId?: string
  /** 从一级委派到直接父的 agent 名链(top-down);给嵌套帧文本打层级前缀用。
   *  非嵌套时为空数组。 */
  ancestorAgentPath: string[]
}

/**
 * 从「本次委派请求携带的直接父会话键」出发,沿父链向上追溯到**最近的 webchat 祖先会话**,
 * 得到进度投递目标与嵌套挂卡信息。取代旧的「父非 webchat 即返回 null(丢弃嵌套进度)」。
 *
 * 语义与不变量:
 *   - 一级(直接父即 webchat):`nested=false`,`target` 与旧 `_resolveDelegateProgressTarget`
 *     完全一致(sessionKey/channel/peerId/userId),`firstLevelRunId=undefined`,路径为空。
 *   - 二级+(直接父是 delegate):沿 `parentSessionKey` 逐跳向上,跳过中间 delegate 会话,
 *     命中 webchat 祖先即为 `target`;`nested=true`,`firstLevelRunId` = 链中**最后一个**
 *     delegate(其父即 webchat = 一级委派)的 `progressRunId`。
 *   - 反 spoof:`sourceAgent` 只在**直接父**这一跳校验(祖先 agent 天然不同,不校验)。
 *   - 防御性一律返回 null(丢弃,与旧行为一致,绝不抛错):
 *       · 直接父键缺失/非字符串;
 *       · 父链某跳会话不在内存(断链);
 *       · 出现环(visited)或深度超上限(maxDepth,默认 5);
 *       · 途中碰到既非 webchat 也非 delegate 的祖先(cron/webhook 等);
 *       · 走到链尾仍未碰到 webchat。
 */
export function resolveDelegateProgressRouting(args: {
  parentSessionKey: unknown
  sourceAgent?: unknown
  getSession: (key: string) => DelegateChainSession | undefined
  maxDepth?: number
}): DelegateProgressRouting | null {
  const startKey = args.parentSessionKey
  if (typeof startKey !== 'string' || !startKey) return null
  const maxDepth = args.maxDepth ?? 5
  const visited = new Set<string>()
  const delegateChain: DelegateChainSession[] = [] // bottom-up: [直接父, …, 一级委派]
  let key: string | undefined = startKey
  let hops = 0
  let isImmediate = true
  while (typeof key === 'string' && key) {
    if (++hops > maxDepth) return null // 防超深/兜底防环
    if (visited.has(key)) return null // 防环
    visited.add(key)
    const s = args.getSession(key)
    if (!s) return null // 断链
    if (
      isImmediate &&
      typeof args.sourceAgent === 'string' &&
      args.sourceAgent &&
      s.agentId !== args.sourceAgent
    ) {
      return null // 反 spoof:直接父归属校验失败
    }
    if (s.channel === 'webchat') {
      const nested = delegateChain.length > 0
      const firstLevel = nested ? delegateChain[delegateChain.length - 1] : undefined
      return {
        target: {
          sessionKey: s.sessionKey,
          channel: s.channel,
          peerId: s.peerId,
          userId: s.userId,
        },
        nested,
        firstLevelRunId: firstLevel?.progressRunId,
        // reverse → top-down(一级委派名在前,直接父名在后)
        ancestorAgentPath: delegateChain.map((d) => d.agentId).reverse(),
      }
    }
    if (s.channel !== 'delegate') return null // 非 webchat/delegate 祖先 → 丢弃
    delegateChain.push(s)
    key = s.parentSessionKey
    isImmediate = false
  }
  return null // 链尾仍无 webchat 祖先
}

/**
 * 把「本(嵌套)委派自己的一帧进度」重写成「挂到用户可见的**一级**委派卡上的一行带层级
 * 前缀的**非终态**文本」。不新增任何协议字段 —— 产物仍是既有 DelegateProgressBlock。
 *
 *   - `runId` 复用一级委派卡的 runId(args.runId)→ 前端按 runId 把本行 append 进那张卡;
 *   - `agentId` 保留本嵌套委派的目标 agent;
 *   - `phase` 一律降为 'text'(**非终态**):嵌套委派的 done/error 绝不能用 done/error 帧
 *     关掉一级卡(一级 agent 往往在子委派返回后继续跑),故 done/error 也转成文本行;
 *   - 文本前缀 `↳ <一级名↳…↳本级名>: ` 让用户一眼区分这是「子 agent 的子委派」进度;
 *   - 结尾补 '\n' 便于前端把连续文本子块 coalesce 成多行而不粘连。
 *
 * Rich blocks keep their original payload and only have the routing identity
 * rebound to the first-level card. Synthetic lifecycle-only frames become a
 * non-terminal text child so they cannot close the parent early.
 */
export function toNestedDelegateProgressLine(
  source: DelegateProgressBlock,
  args: { runId: string; agentId: string; label: string },
): DelegateProgressBlock | null {
  if (source.phase === 'usage' && source.usage && source.usageRunId) {
    return {
      ...source,
      runId: args.runId,
      agentId: args.agentId,
    }
  }
  if (source.block && typeof source.block === 'object') {
    return {
      ...source,
      runId: args.runId,
      agentId: args.agentId,
    }
  }
  let detail: string | undefined
  switch (source.phase) {
    case 'done':
      detail = source.text ? `完成:${source.text}` : '完成'
      break
    case 'error':
      detail = source.text ? `失败:${source.text}` : '失败'
      break
    default:
      // start / plan / tool:直接用摘要文本
      detail = source.text
  }
  const trimmed = (detail ?? '').trim()
  if (!trimmed) return null
  const text = `↳ ${args.label}: ${trimmed}\n`
  return {
    kind: 'delegate_progress',
    runId: args.runId,
    agentId: args.agentId,
    phase: 'text',
    text,
    block: { kind: 'text', text },
  }
}
