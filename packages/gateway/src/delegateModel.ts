/**
 * HTTP /delegate 的 model 与 agentId 校验。与 mcp-memory/delegateArgs 同契约:
 * agentId = 平台成员([A-Za-z0-9_-]);model = catalog 型号(可含点)。
 */
export const DELEGATE_MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/
export const DELEGATE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function parseDelegateModel(
  raw: unknown,
): { ok: true; model?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  if (typeof raw !== 'string') return { ok: false, error: 'model 必须是字符串' }
  const model = raw.trim()
  if (!model) return { ok: true }
  if (!DELEGATE_MODEL_RE.test(model)) {
    return { ok: false, error: 'model 无效:须为 catalog 型号(1-64 字符,[A-Za-z0-9._:-])' }
  }
  return { ok: true, model }
}

export function isPlatformAgentId(id: string): boolean {
  return DELEGATE_AGENT_ID_RE.test(id)
}

export const SELF_DELEGATE_ERROR = '不能把任务委派给自己。确需自调用时请加 --allow-self'

/**
 * 缺 goal 的可自愈错误:告诉调用方**正确的字段名**,而不是只说 required。
 * 以 `goal required` 开头保留旧前缀,兼容既有 grep/断言。
 */
export const DELEGATE_GOAL_REQUIRED_ERROR =
  'goal required:唯一必填字段是 goal(任务描述字符串),字段名不是 task/message/prompt。最小示例 {"goal":"..."}'

export function parseDelegateAllowSelf(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === '1'
}

export function rejectSelfDelegate(opts: {
  callerAgentId?: string | null
  targetAgentId?: string | null
  allowSelf?: boolean
}): { ok: true } | { ok: false; error: string } {
  if (opts.allowSelf) return { ok: true }
  const caller = typeof opts.callerAgentId === 'string' ? opts.callerAgentId.trim() : ''
  const target = typeof opts.targetAgentId === 'string' ? opts.targetAgentId.trim() : ''
  if (!caller || !target) return { ok: true }
  if (caller === target) return { ok: false, error: SELF_DELEGATE_ERROR }
  return { ok: true }
}
