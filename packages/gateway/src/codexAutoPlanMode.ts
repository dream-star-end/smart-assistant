type ConversationMode = 'default' | 'plan'

type AgentLike = {
  provider?: string
  runnerKind?: string
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text))
}

export function shouldAutoPlanTurn(userText = '', attachmentCount = 0): boolean {
  const text = String(userText || '').trim()
  const hasAttachments = attachmentCount > 0
  if (!text && !hasAttachments) return false

  // Explicit implementation/resume phrasing should not bounce back into plan mode.
  if (
    hasAny(text, [
      /按(上面|这个|该|此).{0,12}(计划|方案).{0,12}(开始|实施|执行|继续)/i,
      /(开始|直接|继续).{0,8}(实施|执行|改|做|写|跑)/i,
      /^(go ahead|proceed|implement it|start implementation)\b/i,
    ])
  ) {
    return false
  }

  // Honor explicit plan/review requests even when short.
  if (
    hasAny(text, [
      /(生成|制定|写|给|出|创建|输出).{0,10}(计划|方案|实施方案|计划文档)/,
      /(计划|方案|计划文档).{0,10}(先|看看|评审|确认|review)/i,
      /\b(plan|planning document|proposal)\b/i,
    ])
  ) {
    return true
  }

  let score = 0
  if (text.length >= 220) score += 2
  else if (text.length >= 120) score += 1
  if (hasAttachments) score += 1

  if (
    hasAny(text, [
      /(实现|新增|接入|迁移|重构|部署|上线|修复|排查|调试|优化|改造|设计|补测试|兼容|回滚)/,
      /\b(implement|add|migrate|refactor|deploy|fix|debug|optimize|design|test|rollback)\b/i,
    ])
  )
    score += 1

  if (
    hasAny(text, [
      /(先.+再|然后|同时|并且|多个|全套|完整|端到端|从.+到|流程|步骤|阶段)/,
      /\b(first|then|also|multiple|end-to-end|workflow|pipeline|steps?)\b/i,
      /[;；].+[;；]/,
    ])
  )
    score += 1

  if (
    hasAny(text, [
      /(数据库|协议|runner|parser|网关|前端|后端|缓存|权限|认证|安全|并发|多端|schema|API|UI|service worker|gateway|codex)/i,
      /\b(src|packages|modules|server|client|schema|auth|permission|cache|concurrent)\b/i,
      /[\w.-]+\/(?:[\w.-]+\/)?[\w.-]+\.(?:ts|js|tsx|jsx|css|html|py|go|rs|json|yaml|yml)\b/i,
    ])
  )
    score += 1

  if (
    hasAny(text, [
      /(不要|不能).{0,20}(破坏|影响|回归)|高风险|生产|线上|兼容|灰度|迁移/,
      /\b(prod|production|compat|risky|migration)\b/i,
    ])
  )
    score += 1

  return score >= 2
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
