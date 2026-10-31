import { readFileSync } from 'node:fs'
import { BOX_AGENT_SCOPE_PATH, type BoxAgentScopeIdentity } from '@openclaude/protocol'

export type BoxScopeRemoteReceipt = {
  scopeId: string; status: 'active' | 'pending' | 'stopped'
  fence: 'active' | 'cancelled'
  proof?: 'prelaunch_cancelled' | 'all_physical_runs_terminal'
}
export async function controlBoxAgentScope(identity: BoxAgentScopeIdentity,
  operation: 'register' | 'cancel' | 'status',
  reason?: 'explicit-stop' | 'finish' | 'owner-lost',
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; readFile?: (path: string) => string } = {},
): Promise<BoxScopeRemoteReceipt> {
  const env = deps.env ?? process.env
  const base = env.ANTHROPIC_BASE_URL?.trim()
  if (!base || base !== env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()) throw new Error('BOX_SCOPE_TRANSPORT_UNAVAILABLE')
  const url = new URL(base)
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
    || !['127.0.0.1', '172.31.0.1'].includes(url.hostname)) throw new Error('BOX_SCOPE_TRANSPORT_INVALID')
  url.pathname = BOX_AGENT_SCOPE_PATH
  let token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!token) {
    const path = env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
    if (path) token = (deps.readFile ?? ((p) => readFileSync(p, 'utf8')))(path).trim()
  }
  if (!token || token.length > 4096 || !/^oc-v3\.[A-Za-z0-9._-]+$/.test(token)) throw new Error('BOX_SCOPE_TOKEN_UNAVAILABLE')
  const response = await (deps.fetchImpl ?? fetch)(url, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...identity, operation, ...(operation === 'cancel' ? { reason } : {}) }),
    signal: AbortSignal.timeout(70_000) })
  if (!response.ok) throw new Error('BOX_SCOPE_CONTROL_PENDING')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BOX_SCOPE_RECEIPT_INVALID')
  const v = value as Record<string, unknown>
  if (v.scopeId !== identity.scopeId || !['active', 'pending', 'stopped'].includes(String(v.status))
    || !['active', 'cancelled'].includes(String(v.fence))
    || (v.status === 'active' && v.fence !== 'active')
    || (v.status !== 'active' && v.fence !== 'cancelled')
    || (v.status === 'stopped' && !['prelaunch_cancelled', 'all_physical_runs_terminal'].includes(String(v.proof)))) {
    throw new Error('BOX_SCOPE_RECEIPT_INVALID')
  }
  return v as unknown as BoxScopeRemoteReceipt
}
