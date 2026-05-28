// OpenClaude — Codex explicit plan routing
// Protocol-level Codex plan mode is intentionally explicit-only. Complex
// ordinary requests stay in default mode; Codex can still choose to maintain a
// visible plan/todo inside that turn without being forced into read-only mode.
let _forceDefaultNextSubmit = false

function _hasAny(text, patterns) {
  return patterns.some((re) => re.test(text))
}

export function shouldAutoPlan(userText = '', _attachments = []) {
  const text = String(userText || '').trim()
  if (!text) return false

  // Explicit implementation/resume phrasing should not bounce back into plan mode.
  if (
    _hasAny(text, [
      /按(上面|这个|该|此).{0,12}(计划|方案).{0,12}(开始|实施|执行|继续)/i,
      /(开始|直接|继续).{0,8}(实施|执行|改|做|写|跑)/i,
      /^(go ahead|proceed|implement it|start implementation)\b/i,
    ])
  ) {
    return false
  }

  return _hasAny(text, [
    /(制定|生成|创建|输出|写|出|给(我)?).{0,8}(一份|一个)?(.{0,8})(计划|方案|实施方案|计划文档)/,
    /(计划|方案|计划文档).{0,12}(先|看看|评审|确认|review)/i,
    /先.{0,8}(给|出|制定|写|做).{0,12}(计划|方案)/,
    /(只|仅).{0,8}(制定|生成|创建|输出|写|给).{0,12}(计划|方案)/,
    /(先|暂时|只|仅).{0,12}(不要|别).{0,8}(实施|执行|改|写代码|动代码)/,
    /\b(plan|planning document|plan-only|plan only|proposal)\b/i,
  ])
}

export function requestDefaultNextSubmit() {
  _forceDefaultNextSubmit = true
}

export function getConversationModeForSubmit(_userText = '', _attachments = []) {
  if (_forceDefaultNextSubmit) {
    _forceDefaultNextSubmit = false
    return 'default'
  }
  // Do not infer plan mode in the browser. Leaving this undefined lets the
  // gateway apply the explicit-plan detector while avoiding stale frontend
  // heuristics that can force image/design tasks into read-only mode.
  return undefined
}
