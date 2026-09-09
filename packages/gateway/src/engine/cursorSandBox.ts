/** Optional, account-bound Sand inference transport through an already-running
 * Grok Bot Box. Account credentials stay in the existing encrypted pool;
 * gateway credentials are obtained from that account's official control plane
 * and are kept only in this resolver's memory. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cursorSessionChecksum } from '@openclaude/protocol'

const POLICY_PATH = '/run/oc/cursor-auth/.sand-box-policy.json'
const CONTROL_BASE = 'https://api2.cursor.sh/aiserver.v1.GrokBotService/'
const RELAY_PATH = '/sand-stream-relay/aiserver.v1.InferenceService/Stream'
const HEX = /^[0-9a-f]{64}$/
export const CURSOR_SAND_BOX_MAX_POLICY_BYTES = 2 * 1024 * 1024
export const CURSOR_SAND_BOX_MAX_ACCOUNTS = 4096
const MAX_CONTROL = 64 * 1024

export class CursorSandBoxError extends Error {
  constructor(code: string) { super(`CURSOR_SAND_BOX_${code}`); this.name = 'CursorSandBoxError' }
}
export function isCursorSandBoxError(message: string): boolean {
  return /\bCURSOR_SAND_BOX_[A-Z0-9_]+\b/.test(message)
}
export function cursorSandBoxTicketError(message: string, code?: unknown): string | null {
  const authCode = typeof code === 'string' && /unauthenticated|permission_denied|not_logged_in|authentication|unauthorized|forbidden/i.test(code)
  if (!authCode && /quota|rate.?limit|usage limit|subscription|\b429\b/i.test(message)) return null
  return authCode || /auth|credential|forbidden|not.?logged.?in|token.*(?:expired|invalid)|\b40[13]\b/i.test(message)
    ? 'CURSOR_SAND_BOX_INFERENCE_TICKET_REJECTED [non-retryable]'
    : null
}
export interface CursorSandBoxPolicy {
  version: 1
  accounts: Array<{ accountId: string; subjectHash: string; machineHash: string }>
}
export function parseCursorSandBoxPolicy(value: unknown): CursorSandBoxPolicy {
  const p = value as Partial<CursorSandBoxPolicy> | null
  if (!p || p.version !== 1 || !Array.isArray(p.accounts) || p.accounts.length > CURSOR_SAND_BOX_MAX_ACCOUNTS) throw new CursorSandBoxError('POLICY_INVALID')
  const seen = new Set<string>()
  const accounts = p.accounts.map((a) => {
    if (!a || typeof a.accountId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(a.accountId)
      || typeof a.subjectHash !== 'string' || !HEX.test(a.subjectHash)
      || typeof a.machineHash !== 'string' || !HEX.test(a.machineHash) || seen.has(a.accountId)) {
      throw new CursorSandBoxError('POLICY_INVALID')
    }
    seen.add(a.accountId)
    return { accountId: a.accountId, subjectHash: a.subjectHash, machineHash: a.machineHash }
  })
  return { version: 1, accounts }
}
/** Explicit path is for isolated filesystem verification; production uses the fixed root-owned path. */
export function readCursorSandBoxPolicy(policyPath = POLICY_PATH): CursorSandBoxPolicy | null {
  const r = spawnSync('/usr/bin/sudo', ['-n', '/bin/cat', policyPath], {
    encoding: 'utf8', maxBuffer: CURSOR_SAND_BOX_MAX_POLICY_BYTES, timeout: 5_000,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.error || r.status !== 0 || Buffer.byteLength(r.stdout ?? '', 'utf8') > CURSOR_SAND_BOX_MAX_POLICY_BYTES) {
    if (!r.error && r.status === 1 && r.stderr?.includes(`${policyPath}: No such file or directory`)) return null
    throw new CursorSandBoxError('POLICY_UNAVAILABLE')
  }
  try { return parseCursorSandBoxPolicy(JSON.parse(r.stdout)) }
  catch { throw new CursorSandBoxError('POLICY_INVALID') }
}

export interface CursorSandBoxConnection {
  readonly url: string
  readonly gatewayToken: string
  readonly networkToken: string
  readonly tokenHash: string
  readonly expiresAt: number
}
type FetchFn = (url: string, init: RequestInit) => Promise<Response>
const digest = (s: string): string => createHash('sha256').update(s).digest('hex')
function secret(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(value)) throw new CursorSandBoxError('DESCRIPTOR_INVALID')
  return value
}

export class CursorSandBoxResolver {
  private cached: CursorSandBoxConnection | null = null
  constructor(private readonly options: {
    accountId: string
    credentialKind: 'api_key' | 'session'
    fetchImpl: FetchFn
    readPolicy?: () => CursorSandBoxPolicy | null
    now?: () => number
    controlTimeoutMs?: number
  }) {}

  clear(): void { this.cached = null }

  invalidate(connection: CursorSandBoxConnection): void {
    if (this.cached === connection) this.cached = null
  }

  private async control(method: string, token: string, machine: string, parent: AbortSignal): Promise<Record<string, unknown>> {
    if (parent.aborted) throw new CursorSandBoxError('CANCELLED')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    parent.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, this.options.controlTimeoutMs ?? 15_000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancelReader = (): void => { void reader?.cancel().catch(() => {}) }
    controller.signal.addEventListener('abort', cancelReader, { once: true })
    try {
      const response = await this.options.fetchImpl(`${CONTROL_BASE}${method}`, {
        method: 'POST', body: '{}', redirect: 'error', signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json', 'connect-protocol-version': '1',
          'x-cursor-client-type': 'sand', 'x-cursor-client-source': 'sand-desktop', 'x-cursor-client-version': '0.44.0',
          'x-sand-box-namespace': 'prod', 'x-ghost-mode': 'true',
          'x-cursor-checksum': cursorSessionChecksum(machine, (this.options.now ?? Date.now)()),
        },
      })
      if (controller.signal.aborted) throw new CursorSandBoxError('CANCELLED')
      if (response.status === 401 || response.status === 403) throw new Error(`CURSOR_SAND_AUTH_BOX_CONTROL_${response.status}`)
      if (!response.ok || !response.body) throw new CursorSandBoxError('CONTROL_UNAVAILABLE')
      reader = response.body.getReader()
      if (controller.signal.aborted) throw new CursorSandBoxError('CANCELLED')
      const chunks: Buffer[] = []
      let size = 0
      for (;;) {
        const chunk = await reader.read()
        if (controller.signal.aborted) throw new CursorSandBoxError('CANCELLED')
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_CONTROL) throw new CursorSandBoxError('CONTROL_RESPONSE_TOO_LARGE')
        chunks.push(Buffer.from(chunk.value))
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CursorSandBoxError('CONTROL_RESPONSE_INVALID')
      return body as Record<string, unknown>
    } catch (e) {
      if (e instanceof CursorSandBoxError || (e instanceof Error && /^CURSOR_SAND_AUTH_BOX_CONTROL_/.test(e.message))) throw e
      throw new CursorSandBoxError(controller.signal.aborted ? 'CANCELLED' : 'CONTROL_FAILED')
    } finally {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
      controller.abort()
      controller.signal.removeEventListener('abort', cancelReader)
      reader?.releaseLock()
    }
  }

  async resolve(token: string, machine: string | null, signal: AbortSignal): Promise<CursorSandBoxConnection | null> {
    if (signal.aborted) throw new CursorSandBoxError('CANCELLED')
    const policy = (this.options.readPolicy ?? readCursorSandBoxPolicy)()
    const entry = policy?.accounts.find((a) => a.accountId === this.options.accountId)
    if (!entry) { this.cached = null; return null }
    if (this.options.credentialKind !== 'session' || !machine) throw new CursorSandBoxError('IDENTITY_MISMATCH')
    const now = (this.options.now ?? Date.now)()
    let claims: { type?: unknown; sub?: unknown; exp?: unknown }
    try { claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) }
    catch { throw new CursorSandBoxError('IDENTITY_MISMATCH') }
    if (!claims || typeof claims !== 'object' || Array.isArray(claims) || claims.type !== 'session' || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512
      || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now
      || digest(claims.sub) !== entry.subjectHash || digest(machine) !== entry.machineHash) {
      throw new CursorSandBoxError('IDENTITY_MISMATCH')
    }
    const tokenHash = digest(token)
    if (this.cached?.tokenHash === tokenHash && this.cached.expiresAt > now) return this.cached
    const state = await this.control('GetSandBoxRunState', token, machine, signal)
    if (state.state !== 'SAND_BOX_RUN_STATE_RUNNING') throw new CursorSandBoxError('NOT_RUNNING')
    const response = await this.control('EnsureSandBox', token, machine, signal)
    let url: URL
    try {
      if (typeof response.gatewayUrl !== 'string' || response.gatewayUrl.length > 2048) throw new Error()
      url = new URL(response.gatewayUrl)
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.cursorvm.com') || url.username || url.password || url.search || url.hash) throw new Error()
    } catch { throw new CursorSandBoxError('DESCRIPTOR_INVALID') }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${RELAY_PATH}`
    const connection: CursorSandBoxConnection = {
      url: url.href, gatewayToken: secret(response.gatewayToken), networkToken: secret(response.networkToken),
      tokenHash, expiresAt: Math.min((this.options.now ?? Date.now)() + 60_000, claims.exp * 1000),
    }
    if (signal.aborted) throw new CursorSandBoxError('CANCELLED')
    this.cached = connection
    return connection
  }
}

export function cursorSandBoxHeaders(connection: CursorSandBoxConnection, original: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${connection.gatewayToken}`, 'x-anyrun-network-token': connection.networkToken,
  }
  for (const key of ['content-type', 'connect-protocol-version', 'connect-content-encoding', 'connect-accept-encoding', 'x-request-id', 'x-session-id']) {
    if (original[key]) headers[key] = original[key]
  }
  return headers
}
