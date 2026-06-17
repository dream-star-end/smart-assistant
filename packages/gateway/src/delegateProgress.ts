const DEFAULT_TEXT_LIMIT = 800
const TOOL_PREVIEW_LIMIT = 180

export type DelegateProgressPhase =
  | 'start'
  | 'text'
  | 'thinking'
  | 'plan'
  | 'tool'
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
  /**
   * 完整子 agent block payload(text/thinking/tool_use/tool_result/tool_output_tail),供新前端
   * 复用主聊天富渲染(`_appendSubagentBlock`)。旧前端不读此字段、走 `text`/`phase` 降级,两侧兼容。
   * 仅「透传模式」(makeDelegateBlockPassthrough)产生;start/done/error/plan 仍是纯摘要帧无 block。
   */
  block?: unknown
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

// 透传模式每个 string 字段的上限。解析层已对各字段硬截(inputPreview 500 / inputJson 8000 /
// tool_result preview 3000),这里只是兜底防御,不做语义截断,故给宽上限。
const DELEGATE_PASSTHROUGH_FIELD_CAP = 16_000

/**
 * 富渲染文本清洗:剥危险控制字符(保留 \t/\n)、归一 \r\n,**不折叠空白**(否则破坏代码缩进/diff)、
 * 不 trim,超 cap 截断。区别于 sanitizeDelegateProgressText(那个会折叠多空格,适合摘要 chip 不适合富渲染)。
 */
function sanitizeRichTextForDelegate(raw: unknown, cap = DELEGATE_PASSTHROUGH_FIELD_CAP): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 故意匹配并剥离危险控制字符(保留 \t=09/\n=0a),富文本清洗
  const controlStripped = String(raw ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
  const s = controlStripped.replace(/\r\n?/g, '\n')
  if (s.length <= cap) return s
  return `${s.slice(0, Math.max(0, cap - 1))}…`
}

/**
 * 浅拷贝子 agent block,仅对已知自由文本字段做富文本清洗(保留缩进/换行),不丢字段、不语义截断。
 * 透传给前端 `_appendSubagentBlock` 复用主聊天富渲染。
 */
function sanitizeBlockForDelegate(block: any): any {
  if (!block || typeof block !== 'object') return block
  const out: Record<string, unknown> = { ...block }
  for (const f of ['text', 'inputPreview', 'inputJson', 'preview', 'tail']) {
    if (typeof out[f] === 'string') out[f] = sanitizeRichTextForDelegate(out[f])
  }
  return out
}

/**
 * 把子 agent 的执行 block 以**完整 payload** 透传成 delegate_progress 帧(取代 summarize 的降级):
 *   - `block` 字段携带完整子 block(thinking 不再 drop、tool 输入/输出不再砍 180/800),供**新前端**
 *     复用主聊天富渲染。
 *   - 同时保留 `phase`/`text`/`toolName`/`isError`(复用 summarizeDelegateProgressEvent)给**旧前端**
 *     降级显示;thinking 走 summarize 返回 null → 这里补一个 phase='thinking' 的最小帧(旧前端按
 *     phase 跳过 thinking,行为与旧版一致;新前端用 block 渲染)。
 * 只透传可渲染的 5 类块;其它(plan/start/done/error 由 caller 单独发摘要帧)返回 null。
 */
export function makeDelegateBlockPassthrough(
  event: any,
  runId: string,
  agentId: string,
): DelegateProgressBlock | null {
  if (!event || event.kind !== 'block' || !event.block) return null
  const b = event.block as any
  const RENDERABLE = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'tool_output_tail'])
  if (!RENDERABLE.has(b.kind)) return null
  const legacy = summarizeDelegateProgressEvent(event, runId, agentId)
  const phase: DelegateProgressPhase =
    legacy?.phase ?? (b.kind === 'thinking' ? 'thinking' : b.kind === 'text' ? 'text' : 'tool')
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
    block: sanitizeBlockForDelegate(b),
  }
}
