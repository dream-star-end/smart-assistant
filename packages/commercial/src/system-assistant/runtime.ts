/** Explicit composition for host-only actions. No state is opened at import time. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { SystemActionStore } from '@openclaude/storage'
import type { QueryRunner } from '../db/queries.js'
import { HttpError } from '../http/util.js'
import { normalizeConfirmationOrigin } from '../auth/browserConfirmation.js'
import { makeSystemActionsBrowserHandler } from './browserHttp.js'
import { SystemActionsService } from './service.js'
import { SystemHelpGrantSigner, type SystemHelpIdentityScope } from './helpGrant.js'
import type { SystemOperationRegistry } from './operations.js'
import { ensureSystemActionDirectory, loadOrCreateSystemActionKey } from './privateState.js'
import { currentSystemActionExecutor, persistSystemActionExecutor, recoverStoppedSystemActionExecutors } from './executorIdentity.js'

export interface SystemActionsRuntime {
  readonly service: SystemActionsService
  readonly grants: SystemHelpGrantSigner
  issueBootstrap(scope: SystemHelpIdentityScope): { token: string; expiresAt: number }
  handleBrowser(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** All internal catalog/read/prepare handlers must enter the same shutdown admission gate. */
  track<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>
  closeAdmission(): void
  closeAndDrain(): Promise<void>
}
export function openSystemActionsRuntime(deps: {
  /** Explicit trusted host StateDirectory; never a user container volume or user request field. */
  stateParent: string
  registry: SystemOperationRegistry
  jwtSecret: string | Uint8Array
  firstPartyOrigin: string
  runner: QueryRunner
  onRecoveryError?: () => void
}): SystemActionsRuntime {
  const origin = normalizeConfirmationOrigin(deps.firstPartyOrigin)
  if (!origin) throw new Error('A fixed first-party origin is required for system actions')
  ensureSystemActionDirectory(deps.stateParent)
  const root = join(deps.stateParent, 'system-actions')
  const key = loadOrCreateSystemActionKey(root)
  let opened: SystemActionStore | undefined
  let derived: SystemHelpGrantSigner | undefined
  try {
    opened = new SystemActionStore({ dbPath: join(root, 'ledger.sqlite'), key })
    derived = new SystemHelpGrantSigner(key)
  } catch (e) { opened?.close(); derived?.close(); throw e } finally { key.fill(0) }
  const ledger = opened
  const grants = derived
  if (!ledger || !grants) throw new Error('System action runtime initialization failed')
  let admission = true
  let closed = false
  let draining: Promise<void> | undefined
  let serviceDrain: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const reading = new Set<AbortController>()
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const identity = currentSystemActionExecutor()
    persistSystemActionExecutor(root, identity)
    const service = new SystemActionsService(ledger, deps.registry, identity.id)
    const browser = makeSystemActionsBrowserHandler({ service, runner: deps.runner, jwtSecret: deps.jwtSecret, firstPartyOrigin: origin })
    const recover = () => {
      if (!admission || closed) return
      try { recoverStoppedSystemActionExecutors(root, identity.id, id => ledger.markExecutorLost(id)) }
      catch { try { deps.onRecoveryError?.() } catch { /* advisory reporting cannot change execution state */ } }
    }
    recover()
    timer = setInterval(recover, 30_000)
    timer.unref()
    async function track<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (!admission || closed) throw new HttpError(503, 'UNAVAILABLE', '系统操作正在重启，请稍后重新查看。')
      const controller = new AbortController()
      reading.add(controller)
      const work = Promise.resolve().then(() => operation(controller.signal))
      pending.add(work)
      try { return await work } finally { pending.delete(work); reading.delete(controller) }
    }
    function closeAdmission(): void {
      if (!admission) return
      admission = false
      for (const controller of reading) controller.abort()
      if (timer) clearInterval(timer)
      // drain sets the service gate synchronously before its first await.
      serviceDrain = service.drain()
    }
    return {
      service, grants, track,
      issueBootstrap: scope => {
        if (!admission || closed) throw new HttpError(503, 'UNAVAILABLE', '系统操作正在重启，请稍后重新查看。')
        return grants.issueBootstrap(scope)
      },
      handleBrowser: (req, res) => track(signal => browser(req, res, signal)),
      closeAdmission,
      closeAndDrain: () => {
        closeAdmission()
        draining ??= (async () => {
          await Promise.allSettled([...pending])
          await serviceDrain
          try { ledger.close() } finally { grants.close(); closed = true }
        })()
        return draining
      },
    }
  } catch (e) {
    admission = false
    if (timer) clearInterval(timer)
    try { ledger.close() } finally { grants.close() }
    throw e
  }
}
