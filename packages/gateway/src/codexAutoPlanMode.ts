type ConversationMode = 'default' | 'plan'

type AgentLike = {
  provider?: string
  runnerKind?: string
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text))
}

function isExplicitImplementationRequest(text: string): boolean {
  return hasAny(text, [
    /按(上面|这个|该|此).{0,12}(计划|方案).{0,12}(开始|实施|执行|继续)/i,
    /(开始|直接|继续).{0,8}(实施|执行|改|做|写|跑)/i,
    /^(go ahead|proceed|implement it|start implementation)\b/i,
  ])
}

function isExplicitPlanRequest(text: string): boolean {
  return hasAny(text, [
    /(制定|生成|创建|输出|写|出|给(我)?).{0,8}(一份|一个)?(.{0,8})(计划|方案|实施方案|计划文档)/,
    /(计划|方案|计划文档).{0,12}(先|看看|评审|确认|review)/i,
    /先.{0,8}(给|出|制定|写|做).{0,12}(计划|方案)/,
    /(只|仅).{0,8}(制定|生成|创建|输出|写|给).{0,12}(计划|方案)/,
    /(先|暂时|只|仅).{0,12}(不要|别).{0,8}(实施|执行|改|写代码|动代码)/,
    /\b(plan|planning document|plan-only|plan only|proposal)\b/i,
  ])
}

export function shouldAutoPlanTurn(userText = '', _attachmentCount = 0): boolean {
  const text = String(userText || '').trim()
  if (!text) return false

  // Explicit implementation/resume phrasing should not bounce back into plan mode.
  if (isExplicitImplementationRequest(text)) return false

  // Protocol-level plan mode is now an explicit user intent only. Generic
  // complexity, keywords, and attachments stay in default mode so Codex can
  // autonomously decide whether to maintain a visible plan/todo while still
  // being allowed to execute in the same turn.
  return isExplicitPlanRequest(text)
}

export function resolveCodexConversationMode(args: {
  requestedMode?: ConversationMode
  agent?: AgentLike | null
  model?: string
  text?: string | null
  attachmentCount?: number
}): ConversationMode | undefined {
  if (args.requestedMode === 'default' || args.requestedMode === 'plan') {
    return args.requestedMode
  }
  if (args.agent?.provider !== 'codex-native' || args.agent?.runnerKind !== 'app-server') {
    return undefined
  }
  if (!args.model || !/^gpt-/.test(args.model)) {
    return undefined
  }
  return shouldAutoPlanTurn(args.text ?? '', args.attachmentCount ?? 0) ? 'plan' : 'default'
}
