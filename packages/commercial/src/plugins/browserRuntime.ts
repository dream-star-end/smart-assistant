/**
 * Generic managed-browser Plugin state machine.
 *
 * Slice B deliberately ships no production launcher or driver. A future
 * launcher may register only after it provides a socket-level allowlist and the
 * exact capability attestation below; Playwright routing is defense in depth,
 * never the primary network boundary.
 */

import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { DnsResolver, PinnedAddress } from '../connectors/outboundPolicy.js'
import { normalizeHttpsOrigin, resolvePinnedAddress } from '../connectors/outboundPolicy.js'
import { type BrowserStorageStateV1, validateBrowserStorageState } from './accounts.js'
import {
  type ManagedBrowserPluginContractV1,
  REQUIRED_BROWSER_FORBIDDEN_CHANNELS,
  validateRuntimePluginJson,
} from './contracts.js'

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/

export const REQUIRED_BROWSER_LAUNCHER_CAPABILITIES = Object.freeze({
  networkIsolation: 'socket-allowlist-v1' as const,
  hardTermination: 'launcher-barrier-v1' as const,
  ephemeralProfile: 'verified-cleanup-v1' as const,
  forbiddenChannels: REQUIRED_BROWSER_FORBIDDEN_CHANNELS,
  exactPinnedTls: true as const,
  noEnvProxy: true as const,
  noExtensions: true as const,
  noCrashDump: true as const,
  noTracing: true as const,
  environment: 'allowlist-v1' as const,
})

export type ManagedBrowserLauncherCapabilities = typeof REQUIRED_BROWSER_LAUNCHER_CAPABILITIES

export class ManagedBrowserRuntimeError extends Error {
  readonly code:
    | 'DRIVER_UNAVAILABLE'
    | 'LAUNCHER_UNAVAILABLE'
    | 'INSECURE_LAUNCHER'
    | 'NETWORK_POLICY'
    | 'DNS_POLICY'
    | 'ACTION_NOT_FOUND'
    | 'TIMEOUT'
    | 'CLEANUP_FAILED'
    | 'EXECUTION_FAILED'

  constructor(code: ManagedBrowserRuntimeError['code'], message: string = code) {
    super(message)
    this.name = 'ManagedBrowserRuntimeError'
    this.code = code
  }
}

export interface ManagedBrowserPinnedOrigin {
  origin: string
  hostname: string
  port: number
  ip: string
  family: 4
}

export interface ManagedBrowserRequest {
  url: string
  method: string
  /** Every redirect hop is a new request and must call this guard again. */
  isRedirect?: boolean
}

export type ManagedBrowserRequestGuard = (
  request: ManagedBrowserRequest,
) => ManagedBrowserPinnedOrigin

export interface ManagedBrowserLaunchArgs {
  profileDir: string
  storageState: BrowserStorageStateV1
  pins: readonly ManagedBrowserPinnedOrigin[]
  requestGuard: ManagedBrowserRequestGuard
  signal: AbortSignal
  /** Trusted host path supplied by the platform, never by a Plugin artifact. */
  inputDirectory?: string
}

export interface ManagedBrowserSession {
  /** Opaque platform-controlled handle. It is never sourced from marketplace bytes. */
  readonly driverSession: unknown
  exportStorageState(): Promise<unknown>
  close(): Promise<void>
}

export interface ManagedBrowserLauncherV1 {
  id: string
  version: string
  capabilities: ManagedBrowserLauncherCapabilities
  launch(args: ManagedBrowserLaunchArgs): Promise<ManagedBrowserSession>
  /** Resolves only after this invocation can no longer own a live browser/profile handle. */
  terminate(profileDir: string): Promise<void>
}

export interface ManagedBrowserDriverV1 {
  id: string
  version: string
  launcherId: string
  launcherVersion: string
  maximumNetwork: {
    origins: readonly string[]
    methods: readonly ('GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE')[]
  }
  execute(args: {
    session: unknown
    actionId: string
    params: Record<string, unknown>
    signal: AbortSignal
    beforeDispatch?: () => Promise<void>
  }): Promise<unknown>
}

export const PRODUCTION_MANAGED_BROWSER_DRIVERS: ReadonlyMap<string, ManagedBrowserDriverV1> =
  new Map()
export const PRODUCTION_MANAGED_BROWSER_LAUNCHERS: ReadonlyMap<string, ManagedBrowserLauncherV1> =
  new Map()

function registryKey(id: string, version: string): string {
  return `${id}@${version}`
}

function assertRegistryIdentity(id: string, version: string, label: string): void {
  if (!ID_RE.test(id) || !VERSION_RE.test(version))
    throw new ManagedBrowserRuntimeError('DRIVER_UNAVAILABLE', `${label} identity is invalid`)
}

export function assertSecureBrowserLauncher(launcher: ManagedBrowserLauncherV1): void {
  assertRegistryIdentity(launcher.id, launcher.version, 'launcher')
  const actual = launcher.capabilities as unknown as Record<string, unknown>
  const expected = REQUIRED_BROWSER_LAUNCHER_CAPABILITIES as unknown as Record<string, unknown>
  if (
    Object.keys(actual).sort().join('\0') !== Object.keys(expected).sort().join('\0') ||
    actual.networkIsolation !== expected.networkIsolation ||
    actual.hardTermination !== expected.hardTermination ||
    actual.ephemeralProfile !== expected.ephemeralProfile ||
    actual.exactPinnedTls !== true ||
    actual.noEnvProxy !== true ||
    actual.noExtensions !== true ||
    actual.noCrashDump !== true ||
    actual.noTracing !== true ||
    actual.environment !== expected.environment ||
    typeof launcher.launch !== 'function' ||
    typeof launcher.terminate !== 'function' ||
    !Array.isArray(actual.forbiddenChannels) ||
    actual.forbiddenChannels.join('\0') !== REQUIRED_BROWSER_FORBIDDEN_CHANNELS.join('\0')
  )
    throw new ManagedBrowserRuntimeError(
      'INSECURE_LAUNCHER',
      'managed-browser launcher lacks the required isolation capabilities',
    )
}

function normalizedOriginSet(origins: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const raw of origins) {
    try {
      const origin = normalizeHttpsOrigin(raw)
      if (out.has(origin))
        throw new ManagedBrowserRuntimeError('NETWORK_POLICY', 'duplicate driver origin')
      out.add(origin)
    } catch (error) {
      if (error instanceof ManagedBrowserRuntimeError) throw error
      throw new ManagedBrowserRuntimeError('NETWORK_POLICY', 'driver origin is unsafe')
    }
  }
  return out
}

function assertContractWithinDriverMaximum(
  contract: ManagedBrowserPluginContractV1,
  driver: ManagedBrowserDriverV1,
): void {
  const maxOrigins = normalizedOriginSet(driver.maximumNetwork.origins)
  const maxMethods = new Set(driver.maximumNetwork.methods)
  if (contract.runtime.network.origins.some((origin) => !maxOrigins.has(origin)))
    throw new ManagedBrowserRuntimeError('NETWORK_POLICY', 'signed origin exceeds driver maximum')
  if (contract.runtime.network.methods.some((method) => !maxMethods.has(method)))
    throw new ManagedBrowserRuntimeError('NETWORK_POLICY', 'signed method exceeds driver maximum')
}

export async function resolveManagedBrowserPins(
  contract: ManagedBrowserPluginContractV1,
  resolver?: DnsResolver,
): Promise<ManagedBrowserPinnedOrigin[]> {
  const pins: ManagedBrowserPinnedOrigin[] = []
  for (const origin of contract.runtime.network.origins) {
    const url = new URL(origin)
    let pin: PinnedAddress
    try {
      pin = await resolvePinnedAddress(url.hostname, resolver)
    } catch {
      throw new ManagedBrowserRuntimeError('DNS_POLICY', 'managed-browser origin DNS is unsafe')
    }
    if (pin.family !== 4)
      throw new ManagedBrowserRuntimeError('DNS_POLICY', 'managed-browser v1 requires an IPv4 pin')
    pins.push({
      origin,
      hostname: url.hostname,
      port: Number(url.port || '443'),
      ip: pin.ip,
      family: 4,
    })
  }
  return pins
}

export function makeManagedBrowserRequestGuard(
  contract: ManagedBrowserPluginContractV1,
  pins: readonly ManagedBrowserPinnedOrigin[],
): ManagedBrowserRequestGuard {
  const byOrigin = new Map(pins.map((pin) => [pin.origin, pin]))
  const methods = new Set(contract.runtime.network.methods)
  return (request) => {
    if (!methods.has(request.method as 'GET' | 'HEAD' | 'POST'))
      throw new ManagedBrowserRuntimeError('NETWORK_POLICY', 'browser request method is not signed')
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      throw new ManagedBrowserRuntimeError('NETWORK_POLICY', 'browser request URL is invalid')
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
      throw new ManagedBrowserRuntimeError(
        'NETWORK_POLICY',
        'browser request must be credential-free HTTPS',
      )
    const origin = `https://${url.hostname.toLowerCase()}:${url.port || '443'}`
    const pin = byOrigin.get(origin)
    if (!pin)
      throw new ManagedBrowserRuntimeError('NETWORK_POLICY', 'browser request origin is not signed')
    return pin
  }
}

function combineAbort(
  parent: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal
  timedOut: () => boolean
  stop: () => void
} {
  const controller = new AbortController()
  let didTimeout = false
  const abortFromParent = () => controller.abort(parent.reason)
  if (parent.aborted) abortFromParent()
  else parent.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort(new ManagedBrowserRuntimeError('TIMEOUT', 'managed-browser action timed out'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    stop: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', abortFromParent)
    },
  }
}

function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function awaitCleanupBarrier(operation: Promise<void>, timeoutMs = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    operation,
    new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('browser cleanup barrier timed out')), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export class ManagedBrowserRuntime {
  constructor(
    private readonly opts: {
      drivers?: ReadonlyMap<string, ManagedBrowserDriverV1>
      launchers?: ReadonlyMap<string, ManagedBrowserLauncherV1>
      profileRoot: string
      expectedOwnerUid?: number
      resolver?: DnsResolver
      removeProfile?: (path: string) => Promise<void>
      cleanupTimeoutMs?: number
    },
  ) {}

  private resolveContractRuntime(contract: ManagedBrowserPluginContractV1): {
    driver: ManagedBrowserDriverV1
    launcher: ManagedBrowserLauncherV1
  } {
    const driver = (this.opts.drivers ?? PRODUCTION_MANAGED_BROWSER_DRIVERS).get(
      registryKey(contract.runtime.driverId, contract.runtime.driverVersion),
    )
    if (!driver)
      throw new ManagedBrowserRuntimeError(
        'DRIVER_UNAVAILABLE',
        'managed-browser driver unavailable',
      )
    assertRegistryIdentity(driver.id, driver.version, 'driver')
    if (
      driver.id !== contract.runtime.driverId ||
      driver.version !== contract.runtime.driverVersion
    )
      throw new ManagedBrowserRuntimeError(
        'DRIVER_UNAVAILABLE',
        'managed-browser driver pin mismatch',
      )
    assertContractWithinDriverMaximum(contract, driver)
    const launcher = (this.opts.launchers ?? PRODUCTION_MANAGED_BROWSER_LAUNCHERS).get(
      registryKey(driver.launcherId, driver.launcherVersion),
    )
    if (!launcher)
      throw new ManagedBrowserRuntimeError(
        'LAUNCHER_UNAVAILABLE',
        'secure browser launcher unavailable',
      )
    assertSecureBrowserLauncher(launcher)
    if (launcher.id !== driver.launcherId || launcher.version !== driver.launcherVersion)
      throw new ManagedBrowserRuntimeError(
        'LAUNCHER_UNAVAILABLE',
        'managed-browser launcher pin mismatch',
      )
    return { driver, launcher }
  }

  /** Pure registry/trust check used by discovery, setup status and invocation fences. */
  supportsContract(contract: ManagedBrowserPluginContractV1): boolean {
    try {
      this.resolveContractRuntime(contract)
      return true
    } catch {
      return false
    }
  }

  async runAction(args: {
    contract: ManagedBrowserPluginContractV1
    storageState: BrowserStorageStateV1
    actionId: string
    params: Record<string, unknown>
    signal: AbortSignal
    /** Platform-owned durable fence. Signed Plugin params can never provide it. */
    beforeDispatch?: () => Promise<void>
    /** Platform-owned, invocation-scoped read-only input directory. */
    inputDirectory?: string
  }): Promise<{ result: unknown; storageState: BrowserStorageStateV1 }> {
    const action = args.contract.actions.find((candidate) => candidate.id === args.actionId)
    if (!action)
      throw new ManagedBrowserRuntimeError('ACTION_NOT_FOUND', 'managed-browser action not found')
    validateRuntimePluginJson(action.params, args.params, 'params')
    if (args.signal.aborted) throw args.signal.reason
    const { driver, launcher } = this.resolveContractRuntime(args.contract)
    const pins = await resolveManagedBrowserPins(args.contract, this.opts.resolver)
    const requestGuard = makeManagedBrowserRequestGuard(args.contract, pins)
    const storageState = validateBrowserStorageState(args.storageState, args.contract)

    const root = resolve(this.opts.profileRoot)
    if (!isAbsolute(this.opts.profileRoot))
      throw new ManagedBrowserRuntimeError(
        'CLEANUP_FAILED',
        'browser profile root must be absolute',
      )
    await mkdir(root, { recursive: true, mode: 0o700 })
    let rootStat = await lstat(root)
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      rootStat.uid !== (this.opts.expectedOwnerUid ?? 0)
    )
      throw new ManagedBrowserRuntimeError('CLEANUP_FAILED', 'browser profile root is unsafe')
    await chmod(root, 0o700)
    rootStat = await lstat(root)
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      rootStat.uid !== (this.opts.expectedOwnerUid ?? 0) ||
      (rootStat.mode & 0o777) !== 0o700
    )
      throw new ManagedBrowserRuntimeError('CLEANUP_FAILED', 'browser profile root is unsafe')
    const profileDir = await mkdtemp(join(root, 'invoke-'))
    await chmod(profileDir, 0o700)
    const combined = combineAbort(args.signal, action.timeoutSeconds * 1000)
    let session: ManagedBrowserSession | null = null
    let completed: { result: unknown; storageState: BrowserStorageStateV1 } | null = null
    let failure: unknown = null
    let cleanupFailure: unknown = null
    try {
      if (combined.signal.aborted) throw combined.signal.reason
      session = await awaitAbortable(
        launcher.launch({
          profileDir,
          storageState,
          pins,
          requestGuard,
          signal: combined.signal,
          ...(args.inputDirectory ? { inputDirectory: args.inputDirectory } : {}),
        }),
        combined.signal,
      )
      if (combined.signal.aborted) throw combined.signal.reason
      const result = await awaitAbortable(
        driver.execute({
          session: session.driverSession,
          actionId: action.id,
          params: args.params,
          signal: combined.signal,
          ...(args.beforeDispatch ? { beforeDispatch: args.beforeDispatch } : {}),
        }),
        combined.signal,
      )
      if (combined.signal.aborted) throw combined.signal.reason
      validateRuntimePluginJson(action.result, result, 'result')
      const nextState = validateBrowserStorageState(
        await awaitAbortable(session.exportStorageState(), combined.signal),
        args.contract,
      )
      completed = { result, storageState: nextState }
    } catch (error) {
      failure = error
    } finally {
      combined.stop()
      if (session) {
        try {
          await awaitCleanupBarrier(session.close(), this.opts.cleanupTimeoutMs)
        } catch (error) {
          cleanupFailure ??= error
        }
      }
      try {
        await awaitCleanupBarrier(launcher.terminate(profileDir), this.opts.cleanupTimeoutMs)
      } catch (error) {
        cleanupFailure ??= error
      }
      try {
        await awaitCleanupBarrier(
          (async () => {
            if (this.opts.removeProfile) await this.opts.removeProfile(profileDir)
            else await rm(profileDir, { recursive: true, force: true })
            const remains = await lstat(profileDir).catch(() => null)
            if (remains) throw new Error('profile directory still exists')
          })(),
          this.opts.cleanupTimeoutMs,
        )
      } catch (error) {
        cleanupFailure ??= error
      }
    }
    if (cleanupFailure)
      throw new ManagedBrowserRuntimeError('CLEANUP_FAILED', 'managed-browser cleanup failed')
    if (failure) {
      if (combined.timedOut())
        throw new ManagedBrowserRuntimeError('TIMEOUT', 'managed-browser action timed out')
      throw failure
    }
    if (!completed)
      throw new ManagedBrowserRuntimeError(
        'EXECUTION_FAILED',
        'managed-browser action did not complete',
      )
    return completed
  }

  /** Compatibility guard for callers that intentionally expose a read-only surface. */
  async runReadAction(args: {
    contract: ManagedBrowserPluginContractV1
    storageState: BrowserStorageStateV1
    actionId: string
    params: Record<string, unknown>
    signal: AbortSignal
  }): Promise<{ result: unknown; storageState: BrowserStorageStateV1 }> {
    const action = args.contract.actions.find((candidate) => candidate.id === args.actionId)
    if (!action || action.effect !== 'read')
      throw new ManagedBrowserRuntimeError(
        'ACTION_NOT_FOUND',
        'managed-browser read action not found',
      )
    return this.runAction(args)
  }
}
