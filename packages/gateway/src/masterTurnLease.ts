/** Container gateway → commercial master rolling turn-lease client. */
import { TURN_LEASE_RENEW_PATH as RENEW_PATH } from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'
const ATTEMPT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 32 * 1024

export interface RenewedTurnLease { lease: string; expiresAt: number }

export class RenewTurnLeaseError extends Error {
  readonly retryable: boolean
  constructor(readonly status: number, readonly code: string) {
    super(`turn lease renewal rejected: ${code}`)
    this.name = 'RenewTurnLeaseError'
    this.retryable = status === 429 || status >= 500
  }
}
export interface RenewTurnLeaseOpts {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  signal?: AbortSignal
}
export async function renewTurnLease(
  turnKey: string,
  lease: string,
  opts: RenewTurnLeaseOpts = {},
): Promise<RenewedTurnLease> {
  const env = opts.env ?? process.env
  const baseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL?.replace(/\/+$/, '')
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!baseUrl || !bearer) throw new RenewTurnLeaseError(400, 'RENEWAL_NOT_CONFIGURED')
  const response = await (opts.fetcher ?? undiciRequest)(`${baseUrl}${RENEW_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ turnKey, lease }),
    headersTimeout: ATTEMPT_TIMEOUT_MS,
    bodyTimeout: ATTEMPT_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_RESPONSE_BYTES) throw new Error('turn lease renewal response too large')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks, total).toString('utf8')
  if (response.statusCode !== 200) {
    let code = 'RENEWAL_REJECTED'
    try {
      const body = JSON.parse(text)
      if (typeof body?.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(body.error.code))
        code = body.error.code
    } catch {}
    throw new RenewTurnLeaseError(response.statusCode, code)
  }
  const body = JSON.parse(text) as { lease?: unknown; expiresAt?: unknown }
  if (typeof body.lease !== 'string' || body.lease.length === 0 ||
    typeof body.expiresAt !== 'number' || !Number.isSafeInteger(body.expiresAt)) {
    throw new Error('turn lease renewal response malformed')
  }
  return { lease: body.lease, expiresAt: body.expiresAt }
}

export interface RefreshTurnModelAuthorityLeaseOpts extends RenewTurnLeaseOpts {
  retryDelayMs?: number
  renew?: typeof renewTurnLease
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  onRetry?: (error: unknown, failures: number) => void
}
function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('turn lease renewal aborted')
}
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  assertActive(signal)
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Preserve the latest credential before the caller attempts a fallible stdin update.
 * Transport/control-plane outages do not impose a new task deadline. Stop and
 * the logical-turn watchdog own cancellation; signed policy rejects fail closed. */
export async function refreshTurnModelAuthorityLease(
  turnKey: string,
  authority: { leaseEnvelope: string },
  opts: RefreshTurnModelAuthorityLeaseOpts = {},
): Promise<RenewedTurnLease> {
  let failures = 0
  for (;;) {
    assertActive(opts.signal)
    try {
      const renewed = await (opts.renew ?? renewTurnLease)(turnKey, authority.leaseEnvelope, opts)
      assertActive(opts.signal)
      authority.leaseEnvelope = renewed.lease
      return renewed
    } catch (error) {
      assertActive(opts.signal)
      if (error instanceof RenewTurnLeaseError && !error.retryable) throw error
      failures += 1
      opts.onRetry?.(error, failures)
      await (opts.wait ?? waitForRetry)(opts.retryDelayMs ?? 60_000, opts.signal)
    }
  }
}
