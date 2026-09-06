/**
 * delegate_task / delegate_tasks 入参规范化:agentId 与 model 必须分开。
 * agentId = 平台成员;model = catalog 型号。把型号塞进 agentId 会打到
 * `/api/agents/<dotted>/delegate`,vanilla 网关回 HTML,MCP 再 JSON.parse 炸。
 */
export const DELEGATE_MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/
export const DELEGATE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const MODEL_HINT = '型号请改用 model 参数,例如 model="cursor-grok-4.6-high-fast"'

export function normalizeDelegateModel(
  raw: unknown,
): { ok: true; model?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  if (typeof raw !== 'string') return { ok: false, error: 'model 必须是字符串' }
  const model = raw.trim()
  if (!model) return { ok: true }
  if (!DELEGATE_MODEL_RE.test(model)) {
    return {
      ok: false,
      error: 'model 无效:须为 catalog 型号(1-64 字符,[A-Za-z0-9._:-])',
    }
  }
  return { ok: true, model }
}

export const SELF_DELEGATE_ERROR = '不能把任务委派给自己。确需自调用时请加 --allow-self'
/** MCP 工具侧的同义提示:`--allow-self` 是 oc-memory CLI 旗标,MCP 调用方看不到 CLI。 */
export const SELF_DELEGATE_MCP_HINT =
  '不能把任务委派给自己(agentId 与当前成员相同)。确需自调用(例如同成员换 model 跑一份)请传 allowSelf: true;否则改派其他成员,如 agentId="coding-assistant"'

export function parseDelegateAllowSelf(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === '1'
}

/**
 * 把网关回传的 CLI 口径自委派错误改写成 MCP 口径(参数名 allowSelf 而非 --allow-self)。
 * 其它文本原样返回。
 */
export function rewriteSelfDelegateErrorForMcp(text: string): string {
  return text.includes(SELF_DELEGATE_ERROR)
    ? text.replace(SELF_DELEGATE_ERROR, SELF_DELEGATE_MCP_HINT)
    : text
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

export function normalizeDelegateAgentId(
  raw: unknown,
): { ok: true; agentId?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true }
  if (typeof raw !== 'string') return { ok: false, error: 'agentId 必须是字符串' }
  const agentId = raw.trim()
  if (!agentId) return { ok: true }
  if (agentId.includes('.') || !DELEGATE_AGENT_ID_RE.test(agentId)) {
    return {
      ok: false,
      error: `agentId 只能是平台成员 id(如 coding-assistant)。${MODEL_HINT}`,
    }
  }
  return { ok: true, agentId }
}
