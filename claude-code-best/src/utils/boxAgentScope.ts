/** Invocation-owned Box API identity. Never put this object in telemetry or transcripts. */
import { randomUUID } from 'node:crypto'
import { v5 as uuidv5 } from 'uuid'
import { getSessionId } from '../bootstrap/state.js'
import { getAgentContext, runWithAgentContext } from './agentContext.js'

export type BoxAgentControl = {
  subtype: 'box_agent_scope'
  version: 1
  operation: 'register' | 'detach' | 'explicit-stop' | 'finish'
  scopeId: string
  rootSessionId: string
  sessionId: string
  agentId: string
  turnKey: string
  parentScopeId: string | null
  background: boolean
  sequence: number
}
export type BoxAgentControlResult = {
  scopeId: string
  sequence: number
  status: 'active' | 'pending' | 'stopped'
}
type Origin = {
  rootSessionId: string
  extraMetadata: string | undefined
  turnKey: string
  headers: Record<string, string>
  descriptor: string | undefined
}
export type BoxAgentInvocation = {
  origin: Origin
  scopeId: string
  agentId: string
  sessionId: string
  parentScopeId: string | null
  background: boolean
  sequence: number
  registered: boolean
  closed: boolean
  pending?: Promise<BoxAgentControlResult>
  removeAbort?: () => void
  cancelOperation?: 'explicit-stop' | 'finish'
  retireRetry?: ReturnType<typeof setTimeout>
}

const ownedHeaders = new Set([
  'x-oc-model-authority', 'x-oc-turn-lease', 'x-oc-trace-id',
  'x-oc-local-catalog', 'x-openclaude-trace-id', 'traceparent', 'tracestate',
])
const scopes = new Map<string, BoxAgentInvocation>()
let transport: ((request: BoxAgentControl) => Promise<BoxAgentControlResult>) | undefined

export function bindBoxAgentControlTransport(
  send: (request: BoxAgentControl) => Promise<BoxAgentControlResult>,
): void { transport = send }

export function isBoxApiModel(model: string | undefined): boolean {
  return typeof model === 'string' && /^box-api-claude-[a-z0-9.-]+$/.test(model.replace(/\[(1|2)m\]/gi, '').trim().toLowerCase())
}

export function deriveBoxAgentSession(rootSessionId: string, agentId: string): string {
  return uuidv5(`openclaude-box-agent-api-v1:${agentId}`, rootSessionId)
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    result[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return result
}

export function currentBoxAgentInvocation(): BoxAgentInvocation | undefined {
  const context = getAgentContext()
  return context?.agentType === 'subagent' ? context.boxInvocation : undefined
}

/** Call at the synchronous entrance to Agent/SendMessage, before any await. */
export function captureBoxAgentOrigin(): Origin | undefined {
  const inherited = currentBoxAgentInvocation()
  if (inherited) return inherited.origin
  const extraMetadata = process.env.CLAUDE_CODE_EXTRA_METADATA
  let metadata: Record<string, unknown>
  try { metadata = JSON.parse(extraMetadata ?? '{}') } catch { return undefined }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || typeof metadata.oc_turn_key !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.oc_turn_key)) return undefined
  const headers = Object.fromEntries(Object.entries(parseHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS))
    .filter(([name]) => ownedHeaders.has(name)))
  // Standalone/non-platform CCB keeps its established behavior.
  if (!headers['x-oc-model-authority'] && !headers['x-oc-turn-lease']) return undefined
  return { rootSessionId: getSessionId(), extraMetadata, turnKey: metadata.oc_turn_key,
    headers, descriptor: process.env.OC_MODEL_EXECUTION_DESCRIPTOR }
}

export function createBoxAgentInvocation(origin: Origin | undefined, agentId: string,
  background: boolean): BoxAgentInvocation | undefined {
  if (!origin) return undefined
  const parent=currentBoxAgentInvocation()
  if(parent?.closed) throw new Error('BOX_AGENT_SCOPE_CLOSED')
  const scope: BoxAgentInvocation = { origin, agentId, scopeId: randomUUID(),
    sessionId: deriveBoxAgentSession(origin.rootSessionId, agentId),
    parentScopeId: background ? null : parent?.scopeId ?? null,
    background, sequence: 0, registered: false, closed: false }
  scopes.set(scope.scopeId, scope)
  return scope
}

async function control(scope: BoxAgentInvocation, operation: BoxAgentControl['operation']): Promise<BoxAgentControlResult> {
  if (!transport) throw new Error('BOX_AGENT_CONTROL_UNAVAILABLE')
  // Serialize controls per invocation; a lost response never rolls sequence back.
  const previous = scope.pending
  const send = async () => {
    if (previous) await previous.catch(() => {})
    const sequence = ++scope.sequence
    const result = await transport!({ subtype: 'box_agent_scope', version: 1, operation,
      scopeId: scope.scopeId, sessionId: scope.sessionId, agentId: scope.agentId,
      rootSessionId: scope.origin.rootSessionId, turnKey: scope.origin.turnKey,
      parentScopeId: scope.parentScopeId, background: scope.background, sequence })
    if (result.scopeId !== scope.scopeId || result.sequence !== sequence) throw new Error('BOX_AGENT_CONTROL_ACK_MISMATCH')
    return result
  }
  scope.pending = send()
  return scope.pending
}

/** getAnthropicClient awaits this before constructing a paid Box request. */
export async function ensureBoxAgentScope(model: string | undefined, agentId?: string): Promise<void> {
  const scope = currentBoxAgentInvocation()
  if (!scope || !isBoxApiModel(model)) return
  if (agentId !== undefined && agentId !== scope.agentId) throw new Error('BOX_AGENT_CONTEXT_MISMATCH')
  await registerInvocation(scope,new Set())
}

async function registerInvocation(scope:BoxAgentInvocation,ancestors:Set<string>):Promise<void> {
  if (scope.closed) throw new Error('BOX_AGENT_SCOPE_CLOSED')
  if(ancestors.has(scope.scopeId)) throw new Error('BOX_AGENT_LINEAGE_INVALID')
  ancestors.add(scope.scopeId)
  if(scope.parentScopeId) {
    const parent=scopes.get(scope.parentScopeId)
    if(!parent) throw new Error('BOX_AGENT_PARENT_MISSING')
    // Automatic compaction/utility queries may run before their parent's
    // first API. Register the real parent chain first, with no model call.
    await registerInvocation(parent,ancestors)
  }
  if (scope.registered) return
  const result = await control(scope, 'register')
  if (result.status !== 'active' || scope.closed) throw new Error('BOX_AGENT_SCOPE_NOT_ACTIVE')
  scope.registered = true
}

export function boxAgentMetadata(model: string | undefined, agentId?: string): {
  extraMetadata: string | undefined; sessionId: string; scopeId?: string
} | undefined {
  const scope = currentBoxAgentInvocation()
  if (!scope) return undefined
  if (scope.closed && isBoxApiModel(model)) throw new Error('BOX_AGENT_SCOPE_CLOSED')
  if (agentId !== undefined && agentId !== scope.agentId) throw new Error('BOX_AGENT_CONTEXT_MISMATCH')
  return { extraMetadata: scope.origin.extraMetadata,
    sessionId: isBoxApiModel(model) ? scope.sessionId : scope.origin.rootSessionId,
    ...(isBoxApiModel(model) ? { scopeId: scope.scopeId } : {}) }
}

export function scopedBoxHeaders(current: Record<string, string>,
  scope: BoxAgentInvocation | undefined = currentBoxAgentInvocation()): Record<string, string> {
  if (!scope) return current
  const headers = Object.fromEntries(Object.entries(current)
    .filter(([name]) => !ownedHeaders.has(name.toLowerCase())))
  return { ...headers, ...scope.origin.headers }
}

export function scopedBoxDescriptor(): { value: string | undefined } | undefined {
  const scope = currentBoxAgentInvocation()
  return scope ? { value: scope.origin.descriptor } : undefined
}

/** Only an identical authority envelope may refresh its original lease. */
export function renewBoxAgentOrigins(variables: Record<string, string>): void {
  if (!Object.hasOwn(variables, 'ANTHROPIC_CUSTOM_HEADERS')) return
  const next = parseHeaders(variables.ANTHROPIC_CUSTOM_HEADERS)
  if (!next['x-oc-model-authority'] || !next['x-oc-turn-lease']) return
  for (const scope of scopes.values()) {
    if (!scope.closed && scope.origin.headers['x-oc-model-authority'] === next['x-oc-model-authority']) {
      scope.origin.headers['x-oc-turn-lease'] = next['x-oc-turn-lease']!
    }
  }
}

export function linkBoxAgentAbort(scope: BoxAgentInvocation | undefined, signal: AbortSignal): void {
  if (!scope || scope.background) return
  const abort = () => { void stopBoxAgentInvocation(scope).catch(() => {}) }
  scope.removeAbort = () => signal.removeEventListener('abort', abort)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
}

export async function detachBoxAgentInvocation(scope: BoxAgentInvocation | undefined): Promise<void> {
  if (!scope) return
  if (scope.closed) throw new Error('BOX_AGENT_SCOPE_CLOSED')
  if (scope.pending) await scope.pending
  // No remote scope exists before registration; its eventual first register
  // will carry background=true. Non-Box agents never create remote controls.
  if (scope.registered) {
    const result=await control(scope, 'detach')
    if(result.status !== 'active' || scope.closed) throw new Error('BOX_AGENT_SCOPE_NOT_ACTIVE')
  }
  scope.background = true
  scope.parentScopeId = null
  scope.removeAbort?.()
}

export async function stopBoxAgentInvocation(scope: BoxAgentInvocation): Promise<'pending' | 'stopped'> {
  scope.closed = true
  scope.cancelOperation = 'explicit-stop'
  const result = await control(scope, 'explicit-stop')
  return result.status === 'stopped' ? 'stopped' : 'pending'
}

export async function stopBoxAgentById(agentId: string): Promise<'pending' | 'stopped' | undefined> {
  const invocations = [...scopes.values()].filter(scope => scope.agentId === agentId)
  // Close even a delayed first request synchronously before yielding for IPC.
  for (const scope of invocations) scope.closed = true
  const targets = invocations.filter(scope => scope.registered || scope.pending)
  if (!targets.length) return undefined
  const results = await Promise.all(targets.map(scope => stopBoxAgentInvocation(scope).catch(() => 'pending' as const)))
  return results.every(status => status === 'stopped') ? 'stopped' : 'pending'
}

/** Normal completion fences future calls, but never asserts a physical terminal proof. */
export async function finishBoxAgentInvocation(scope: BoxAgentInvocation | undefined): Promise<void> {
  if (!scope) return
  scope.closed = true
  scope.removeAbort?.()
  if (scope.retireRetry) {clearTimeout(scope.retireRetry);scope.retireRetry=undefined}
  scope.cancelOperation ??= 'finish'
  try {
    if (scope.registered || scope.pending) {
      // A lost registration ACK may have reached the gateway. Re-register
      // this exact closed generation before retrying its terminal intent.
      if (!scope.registered) {await control(scope,'register');scope.registered=true}
      await control(scope,scope.cancelOperation)
    }
    scopes.delete(scope.scopeId)
  } catch(error) {
    // Retain closed RAM intent until the gateway durably owns it. Never retry
    // the API/model; only this idempotent control can be sent again.
    scope.retireRetry=setTimeout(() => {
      scope.retireRetry=undefined
      void finishBoxAgentInvocation(scope).catch(() => {})
    },5000)
    scope.retireRetry.unref?.()
    throw error
  }
}

/** Utility forks have their own real query agentId, even inside an Agent.
 * Give that explicit auxiliary invocation its own API identity and retain the
 * parent's frozen origin/cancellation lineage. Root utility forks stay legacy. */
export async function withBoxAgentAuxiliaryInvocation<T>(agentId:string|undefined,
  signal:AbortSignal,run:() => Promise<T>):Promise<T> {
  const parent=currentBoxAgentInvocation()
  if (!parent) return run()
  if (parent.closed) throw new Error('BOX_AGENT_SCOPE_CLOSED')
  if (!agentId || agentId === parent.agentId) throw new Error('BOX_AGENT_AUXILIARY_ID_INVALID')
  const invocation=createBoxAgentInvocation(parent.origin,agentId,false)!
  linkBoxAgentAbort(invocation,signal)
  try {return await runWithAgentContext({agentType:'subagent',agentId,boxInvocation:invocation},run)}
  finally {await finishBoxAgentInvocation(invocation).catch(() => {})}
}
