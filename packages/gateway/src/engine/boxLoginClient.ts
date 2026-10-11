/** Which Claude Code login on the Box a box-resident session launches under, and what each
 * turn learned about that login's plan windows. Both are answered by the master's egress
 * (`/internal/box/login*`, container-authenticated like `/internal/box/stop`), which holds the
 * admin's selection (box_claude_profiles) and the login health shared with the Box model route.
 * Node built-ins only: the box bridge loads this file as plain node. */
import { readFileSync } from 'node:fs'

type Fetcher = typeof fetch
interface Deps {
  env?: NodeJS.ProcessEnv
  fetchImpl?: Fetcher
  readFile?: (path: string) => string
  timeoutMs?: number
}

export const BOX_LOGIN_PATH = '/internal/box/login'
export const BOX_LOGIN_SIGNALS_PATH = '/internal/box/login-signals'
export const BOX_DEFAULT_LOGIN = 'default'
const PROFILE = /^(default|[a-z0-9][a-z0-9-]{0,31})$/
const ACCOUNT = /^[1-9][0-9]{0,18}$/
/** A chat session's stable id across bridge restarts (the hash in its fifo name). */
const SESSION = /^[a-f0-9]{16}$/
/** Lines a turn may report: the plan-window line and the CLI's synthetic notices. */
const MAX_SIGNAL_LINES = 16
const MAX_SIGNAL_LINE_BYTES = 65_536

/** The master no longer has any usable login for this account (all logged out or refused).
 * The turn fails; it never runs on some other route. */
export class BoxLoginUnavailableError extends Error {
  constructor() { super('BOX_LOGIN_UNAVAILABLE') }
}

/** The egress origin, from the container's Anthropic route, or null when that route is not the
 * master's internal one. Same rule as notifyBoxUserStop: http, loopback/bridge host, no path. */
export function boxLoginUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  const base = env.ANTHROPIC_BASE_URL?.trim()
  const internal = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  if (!base || !internal || base !== internal) return null
  return checkedOrigin(base)
}

function checkedOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')
      || !['127.0.0.1', '172.31.0.1'].includes(url.hostname)) return null
    return url.origin
  } catch { return null }
}

function containerToken(env: NodeJS.ProcessEnv, readFile: (path: string) => string): string | null {
  let token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!token) {
    const path = env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
    if (!path) return null
    try { token = readFile(path).trim() } catch { return null }
  }
  return token && token.length <= 4096 && /^oc-v3\.[A-Za-z0-9._-]+$/.test(token) ? token : null
}

function endpoint(env: NodeJS.ProcessEnv, readFile: (path: string) => string, path: string):
  { url: string; token: string } | null {
  const origin = env.OC_BOX_LOGIN_URL ? checkedOrigin(env.OC_BOX_LOGIN_URL) : null
  const token = containerToken(env, readFile)
  return origin && token ? { url: `${origin}${path}`, token } : null
}

/** The login to launch under. `session` and `prefer` (the login this chat last ran on) let the
 * master keep a chat on its login across restarts, so --resume lands where its prompt cache is.
 * `default` when the account has no saved logins, or when the master cannot be asked (no internal
 * route, an older master without the endpoint, a network failure): the default login is the one
 * every Box session used before logins existed. Only an explicit "nothing usable" from the master
 * fails the turn (BoxLoginUnavailableError). */
export async function requestBoxLogin(input: { accountId: string | undefined; session?: string; prefer?: string },
  deps: Deps = {}):
  Promise<{ profile: string; source: 'master' | 'fallback'; alternatives?: number }> {
  const fallback = { profile: BOX_DEFAULT_LOGIN, source: 'fallback' as const }
  if (!input.accountId || !ACCOUNT.test(input.accountId)) return fallback
  const env = deps.env ?? process.env
  const target = endpoint(env, deps.readFile ?? ((p) => readFileSync(p, 'utf8')), BOX_LOGIN_PATH)
  if (!target) return fallback
  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(target.url, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: input.accountId,
        ...(input.session && SESSION.test(input.session) ? { session: input.session } : {}),
        ...(input.prefer && PROFILE.test(input.prefer) ? { prefer: input.prefer } : {}) }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 3_000),
    })
  } catch { return fallback }
  let body: unknown
  try { body = await response.json() } catch { body = null }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  if (response.status === 503 && record.error === 'BOX_LOGIN_UNAVAILABLE') throw new BoxLoginUnavailableError()
  if (!response.ok || typeof record.profile !== 'string' || !PROFILE.test(record.profile)) return fallback
  const alternatives = typeof record.alternatives === 'number' && Number.isSafeInteger(record.alternatives)
    && record.alternatives >= 0 ? record.alternatives : 0
  return { profile: record.profile, source: 'master', alternatives }
}

/** Best effort: what this turn's output said about the login (plan windows, a CLI notice), or that
 * the Box refused to launch it (`unsafe`). A lost report only delays what the next turn reports. */
export async function reportBoxLoginSignals(
  input: { accountId: string | undefined; profile: string; lines: readonly string[]; unsafe?: boolean },
  deps: Deps = {},
): Promise<boolean> {
  if (!input.accountId || !ACCOUNT.test(input.accountId) || !PROFILE.test(input.profile)) return false
  const lines = input.lines.filter((line) => Buffer.byteLength(line) <= MAX_SIGNAL_LINE_BYTES)
    .slice(0, MAX_SIGNAL_LINES)
  if (lines.length === 0 && !input.unsafe) return false
  const env = deps.env ?? process.env
  const target = endpoint(env, deps.readFile ?? ((p) => readFileSync(p, 'utf8')), BOX_LOGIN_SIGNALS_PATH)
  if (!target) return false
  try {
    const response = await (deps.fetchImpl ?? fetch)(target.url, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: input.accountId, profile: input.profile, lines,
        ...(input.unsafe ? { unsafe: true } : {}) }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 3_000),
    })
    await response.arrayBuffer().catch(() => undefined)
    return response.ok
  } catch { return false }
}
