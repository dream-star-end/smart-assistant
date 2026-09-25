/** Best-effort notification for an explicit browser Stop of a Box-backed CCB
 * turn. The gateway keeps the request alive after interrupting the CLI; a
 * plain HTTP disconnect never calls this path. No paid/tool call is retried. */
import { readFileSync } from 'node:fs'

type Fetcher = typeof fetch
const SESSION = /^[A-Za-z0-9._:-]{1,256}$/
const TURN = /^[a-f0-9]{64}$/

export async function notifyBoxUserStop(input: { sessionId: string; turnKey: string },
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetcher;
    readFile?: (path: string) => string } = {}): Promise<'stopped' | 'pending' | 'skipped'> {
  if (!SESSION.test(input.sessionId) || !TURN.test(input.turnKey)) return 'skipped'
  const env = deps.env ?? process.env
  const base = env.ANTHROPIC_BASE_URL?.trim()
  const internal = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  if (!base || !internal || base !== internal) return 'skipped'
  let url: URL
  try {
    url = new URL(base)
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')
      || !['127.0.0.1', '172.31.0.1'].includes(url.hostname)) return 'skipped'
    url.pathname = '/internal/box/stop'
  } catch { return 'skipped' }
  let token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!token) {
    const path = env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
    if (!path) return 'skipped'
    try { token = (deps.readFile ?? ((p) => readFileSync(p, 'utf8')))(path).trim() }
    catch { return 'skipped' }
  }
  if (!token || token.length > 4096 || !/^oc-v3\.[A-Za-z0-9._-]+$/.test(token)) return 'skipped'
  const response = await (deps.fetchImpl ?? fetch)(url, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: input.sessionId, oc_turn_key: input.turnKey }),
    signal: AbortSignal.timeout(70_000),
  })
  if (!response.ok) return 'pending'
  let body: unknown
  try { body = await response.json() } catch { return 'pending' }
  return body && typeof body === 'object' && !Array.isArray(body)
    && (body as { status?: unknown }).status === 'stopped' ? 'stopped' : 'pending'
}
