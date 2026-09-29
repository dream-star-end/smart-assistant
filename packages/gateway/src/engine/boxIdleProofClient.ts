/** Read-only idle proof over the same local egress identity as Box stop. */
import { readFileSync } from 'node:fs'

type Fetcher = typeof fetch
const SESSION = /^[A-Za-z0-9._:-]{1,256}$/
const TURN = /^[a-f0-9]{64}$/

export type IdleProofResponse =
  | { status: 'skipped' }
  | { status: 'pending'; reason: string }
  | { status: 'not_found' }
  | {
      status: 'terminal'
      sessionId: string
      turnKey: string
      requestId: string
      revision: string
      compactRequired: boolean
      capsuleSha256: string
      summaryText?: string
    }
  | {
      status: 'terminal_set'
      sessionId: string
      turnKey: string
      revision: string
      requestIds: string[]
    }

export async function fetchBoxIdleProof(input: { sessionId: string; turnKey: string },
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetcher;
    readFile?: (path: string) => string } = {}): Promise<IdleProofResponse> {
  if (!SESSION.test(input.sessionId) || !TURN.test(input.turnKey)) return { status: 'skipped' }
  const env = deps.env ?? process.env
  const base = env.ANTHROPIC_BASE_URL?.trim()
  const internal = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  if (!base || !internal || base !== internal) return { status: 'skipped' }
  let url: URL
  try {
    url = new URL(base)
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')
      || !['127.0.0.1', '172.31.0.1'].includes(url.hostname)) return { status: 'skipped' }
    url.pathname = '/internal/box/idle-proof'
  } catch { return { status: 'skipped' } }
  let token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!token) {
    const path = env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
    if (!path) return { status: 'skipped' }
    try { token = (deps.readFile ?? ((p) => readFileSync(p, 'utf8')))(path).trim() }
    catch { return { status: 'skipped' } }
  }
  if (!token || token.length > 4096 || !/^oc-v3\.[A-Za-z0-9._-]+$/.test(token)) return { status: 'skipped' }
  const response = await (deps.fetchImpl ?? fetch)(url, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: input.sessionId, oc_turn_key: input.turnKey }),
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 404) return { status: 'not_found' }
  if (!response.ok) return { status: 'pending', reason: 'http' }
  let body: unknown
  try { body = await response.json() } catch { return { status: 'pending', reason: 'body' } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 'pending', reason: 'body' }
  const row = body as Record<string, unknown>
  if (row.status === 'pending') return { status: 'pending', reason: typeof row.reason === 'string' ? row.reason : 'pending' }
  if (row.status === 'terminal_set') {
    const ids = row.requestIds
    if (row.sessionId !== input.sessionId || row.turnKey !== input.turnKey
      || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)
      || !Array.isArray(ids) || ids.length < 2
      || ids.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(ids).size !== ids.length
      || [...ids].sort().join('\0') !== ids.join('\0')
      || 'requestId' in row || 'capsuleSha256' in row || 'summaryText' in row || 'compactRequired' in row) {
      return { status: 'pending', reason: 'body' }
    }
    return {
      status: 'terminal_set',
      sessionId: input.sessionId,
      turnKey: input.turnKey,
      revision: row.revision,
      requestIds: ids as string[],
    }
  }
  if (row.status !== 'terminal' || row.sessionId !== input.sessionId || row.turnKey !== input.turnKey
    || typeof row.requestId !== 'string' || typeof row.revision !== 'string'
    || typeof row.compactRequired !== 'boolean' || typeof row.capsuleSha256 !== 'string') {
    return { status: 'pending', reason: 'body' }
  }
  return {
    status: 'terminal',
    sessionId: input.sessionId,
    turnKey: input.turnKey,
    requestId: row.requestId,
    revision: row.revision,
    compactRequired: row.compactRequired,
    capsuleSha256: row.capsuleSha256,
    ...(typeof row.summaryText === 'string' ? { summaryText: row.summaryText } : {}),
  }
}
