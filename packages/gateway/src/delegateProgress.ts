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

export function makeDelegateProgressBlock(args: {
  runId: string
  agentId: string
  phase: DelegateProgressPhase
  text?: unknown
  toolName?: unknown
  isError?: boolean
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
