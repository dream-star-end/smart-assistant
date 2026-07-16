import { randomBytes } from 'node:crypto'

export interface PluginLeaseRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

const ACQUIRE_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 else return 0 end`
const ASSERT_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return 1 else return 0 end`
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

export class PluginAccountLeaseError extends Error {
  readonly code: 'LEASE_UNAVAILABLE' | 'LEASE_BUSY' | 'LEASE_LOST'

  constructor(code: PluginAccountLeaseError['code'], message: string = code) {
    super(message)
    this.name = 'PluginAccountLeaseError'
    this.code = code
  }
}

export interface PluginAccountLease {
  readonly connectionId: string
  readonly ownerToken: string
  readonly signal: AbortSignal
  readonly lost: boolean
  assertHeld(): Promise<void>
  release(): Promise<void>
}

export async function acquirePluginAccountLease(
  redis: PluginLeaseRedis | null | undefined,
  connectionId: string,
  opts: { hardTimeoutMs: number; renewalIntervalMs?: number },
): Promise<PluginAccountLease> {
  if (!redis)
    throw new PluginAccountLeaseError('LEASE_UNAVAILABLE', 'Plugin account lease unavailable')
  if (!/^\d{1,20}$/.test(connectionId))
    throw new PluginAccountLeaseError('LEASE_UNAVAILABLE', 'invalid Plugin connection id')
  if (
    !Number.isInteger(opts.hardTimeoutMs) ||
    opts.hardTimeoutMs < 1000 ||
    opts.hardTimeoutMs > 120_000
  )
    throw new PluginAccountLeaseError('LEASE_UNAVAILABLE', 'invalid Plugin hard timeout')

  const ttlMs = opts.hardTimeoutMs + 30_000
  const renewalIntervalMs = opts.renewalIntervalMs ?? Math.min(30_000, Math.floor(ttlMs / 3))
  if (
    !Number.isInteger(renewalIntervalMs) ||
    renewalIntervalMs < 10 ||
    renewalIntervalMs >= ttlMs / 2
  )
    throw new PluginAccountLeaseError('LEASE_UNAVAILABLE', 'invalid Plugin lease renewal interval')
  const key = `plugins:account-lease:${connectionId}`
  const ownerToken = randomBytes(32).toString('hex')
  let acquired: unknown
  try {
    acquired = await redis.eval(ACQUIRE_SCRIPT, 1, key, ownerToken, ttlMs)
  } catch {
    throw new PluginAccountLeaseError(
      'LEASE_UNAVAILABLE',
      'Plugin account lease backend unavailable',
    )
  }
  if (acquired !== 1)
    throw new PluginAccountLeaseError('LEASE_BUSY', 'Plugin account is already in use')

  const abortController = new AbortController()
  let lost = false
  let released = false
  let renewing = false
  const markLost = () => {
    if (lost || released) return
    lost = true
    abortController.abort(new PluginAccountLeaseError('LEASE_LOST', 'Plugin account lease lost'))
  }
  const timer = setInterval(() => {
    if (released || lost || renewing) return
    renewing = true
    void redis
      .eval(RENEW_SCRIPT, 1, key, ownerToken, ttlMs)
      .then((held) => {
        if (held !== 1) markLost()
      })
      .catch(markLost)
      .finally(() => {
        renewing = false
      })
  }, renewalIntervalMs)
  timer.unref?.()

  return {
    connectionId,
    ownerToken,
    signal: abortController.signal,
    get lost() {
      return lost
    },
    async assertHeld(): Promise<void> {
      if (released || lost)
        throw new PluginAccountLeaseError('LEASE_LOST', 'Plugin account lease lost')
      let held: unknown
      try {
        held = await redis.eval(ASSERT_SCRIPT, 1, key, ownerToken)
      } catch {
        markLost()
        throw new PluginAccountLeaseError('LEASE_LOST', 'Plugin account lease backend unavailable')
      }
      if (held !== 1) {
        markLost()
        throw new PluginAccountLeaseError('LEASE_LOST', 'Plugin account lease lost')
      }
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      clearInterval(timer)
      await redis.eval(RELEASE_SCRIPT, 1, key, ownerToken).catch(() => {})
    },
  }
}
