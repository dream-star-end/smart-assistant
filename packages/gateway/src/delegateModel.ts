/**
 * HTTP /delegate 的 model 与 agentId 校验。与 mcp-memory/delegateArgs 同契约:
 * agentId = 平台成员([A-Za-z0-9_-]);model = catalog 型号(可含点)。
 */
export const DELEGATE_MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/
export const DELEGATE_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function parseDelegateModel(raw: unknown): { ok: true; model?: string } | { ok: false; error: string } {
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
