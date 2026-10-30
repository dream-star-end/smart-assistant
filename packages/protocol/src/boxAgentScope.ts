import { createHash } from 'node:crypto'

export const BOX_AGENT_SCOPE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export interface BoxAgentScopeIdentity {
  scopeId: string
  rootSessionId: string
  sessionId: string
  agentId: string
  turnKey: string
}
export interface BoxAgentScopeControl extends BoxAgentScopeIdentity {
  subtype: 'box_agent_scope'
  version: 1
  operation: 'register' | 'detach' | 'explicit-stop' | 'finish'
  parentScopeId: string | null
  background: boolean
  sequence: number
}
export interface BoxAgentScopeControlResult {
  scopeId: string
  sequence: number
  status: 'active' | 'pending' | 'stopped'
}
/** RFC 9562 UUIDv5, mirrored with CCB's existing uuid dependency. */
export function deriveBoxAgentSession(rootSessionId: string, agentId: string): string {
  if (!BOX_AGENT_SCOPE_UUID.test(rootSessionId) || !/^[A-Za-z0-9._:-]{1,256}$/.test(agentId)) {
    throw new Error('BOX_AGENT_SCOPE_IDENTITY_INVALID')
  }
  const bytes = createHash('sha1')
    .update(Buffer.from(rootSessionId.replaceAll('-', ''), 'hex'))
    .update(`openclaude-box-agent-api-v1:${agentId}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function parseBoxAgentScopeIdentity(value: unknown): BoxAgentScopeIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.scopeId !== 'string' || !BOX_AGENT_SCOPE_UUID.test(v.scopeId)
    || typeof v.rootSessionId !== 'string' || !BOX_AGENT_SCOPE_UUID.test(v.rootSessionId)
    || typeof v.sessionId !== 'string' || !BOX_AGENT_SCOPE_UUID.test(v.sessionId)
    || typeof v.agentId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(v.agentId)
    || typeof v.turnKey !== 'string' || !/^[a-f0-9]{64}$/.test(v.turnKey)) return null
  if (deriveBoxAgentSession(v.rootSessionId, v.agentId) !== v.sessionId) return null
  return { scopeId: v.scopeId, rootSessionId: v.rootSessionId, sessionId: v.sessionId,
    agentId: v.agentId, turnKey: v.turnKey }
}
export function parseBoxAgentScopeControl(value: unknown): BoxAgentScopeControl | null {
  const identity = parseBoxAgentScopeIdentity(value)
  if (!identity) return null
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'agentId,background,operation,parentScopeId,rootSessionId,scopeId,sequence,sessionId,subtype,turnKey,version'
    || v.subtype !== 'box_agent_scope' || v.version !== 1
    || !['register', 'detach', 'explicit-stop', 'finish'].includes(String(v.operation))
    || !(v.parentScopeId === null || (typeof v.parentScopeId === 'string' && BOX_AGENT_SCOPE_UUID.test(v.parentScopeId)))
    || typeof v.background !== 'boolean' || (v.background && v.parentScopeId !== null)
    || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1) return null
  return { ...identity, subtype: 'box_agent_scope', version: 1,
    operation: v.operation as BoxAgentScopeControl['operation'],
    parentScopeId: v.parentScopeId as string | null, background: v.background,
    sequence: Number(v.sequence) }
}
