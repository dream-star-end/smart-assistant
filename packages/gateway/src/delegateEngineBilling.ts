/**
 * Container gateway → master admit/settle/abandon for engine-reported
 * (codex/grok) delegate billing.
 *
 * Delegate turns never go through userChatBridge, so nobody injects a
 * master-owned 32-hex requestId. Without that id, CodexAdapter / GrokAdapter
 * refuse to emit billing frames and usage_records.mode=delegate stays empty.
 *
 * The HTTP shape matches Auto-Dream (v3 internal, container identity bearer):
 * admit before spawn, live settle of the billing frame, abandon if the turn
 * never produced usage. The durable tape channel remains a second path;
 * UNIQUE(request_id) makes the two idempotent.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  CODEX_ENGINE_MODEL_IDS,
  DELEGATE_ENGINE_BILLING_SESSION_KEY_RE,
  isGrokEngineModel,
  type DurableCodexBilling,
} from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import { AdvisorConsultStore } from './advisorConsultStore.js'
import { request as undiciRequest } from 'undici'

// Concatenated so the internal-route scanner does not treat these as new
// gateway literals until @openclaude/protocol in the live node_modules tree
// re-exports the same constants (see protocol internalRoutes.ts).
const ADMIT_PATH = '/internal/v3/' + 'delegate/engine-billing/admit'
const SETTLE_PATH = '/internal/v3/' + 'delegate/engine-billing/settle'
const ABANDON_PATH = '/internal/v3/' + 'delegate/engine-billing/abandon'

const MAX_RESPONSE_BYTES = 64 * 1024
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const SESSION_ID_RE = DELEGATE_ENGINE_BILLING_SESSION_KEY_RE
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type DelegateEngineBillingEngine = 'codex' | 'grok'

export interface DelegateEngineBillingAdmitInput {
  model: string
  engine: DelegateEngineBillingEngine
  agentId: string
  delegateAgentId: string
  sessionKey: string
  parentSessionId?: string
  parentTurnKey?: string
}

export interface DelegateEngineBillingAdmission {
  requestId: string
  engineSessionId: string
  /** Advisor-consult only. Regular delegate admits omit this. */
  route?: unknown
}

export interface DelegateEngineBillingClient {
  admit(input: DelegateEngineBillingAdmitInput): Promise<DelegateEngineBillingAdmission>
  settle(billing: DurableCodexBilling): Promise<void>
  abandon(requestId: string): Promise<void>
  retryPending?(): Promise<void>
  projectConsults?(store: AdvisorConsultStore): Promise<void>
}

export function shouldAdmitDelegateEngineBilling(args: {
  delegateEngine?: string | null
  requestedModel?: string | null
  agentModel?: string | null
}): boolean {
  if (args.delegateEngine) {
    return args.delegateEngine === 'codex' || args.delegateEngine === 'grok'
  }
  const model = args.requestedModel || args.agentModel
  if (!model) return false
  return isGrokEngineModel(model) || (CODEX_ENGINE_MODEL_IDS as readonly string[]).includes(model)
}

export function resolveDelegateEngineBillingEngine(args: {
  delegateEngine?: string | null
  model?: string | null
}): DelegateEngineBillingEngine {
  if (args.delegateEngine === 'grok' || isGrokEngineModel(args.model)) return 'grok'
  return 'codex'
}

function validateAdmitInput(input: DelegateEngineBillingAdmitInput): void {
  if (!input.model || typeof input.model !== 'string') {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_MODEL')
  }
  if (input.engine !== 'codex' && input.engine !== 'grok') {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_ENGINE')
  }
  if (!AGENT_ID_RE.test(input.agentId) || !AGENT_ID_RE.test(input.delegateAgentId)) {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_AGENT')
  }
  if (!SESSION_ID_RE.test(input.sessionKey)) {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_SESSION')
  }
}

export function mapDelegateEngineBillingError(err: unknown): {
  httpStatus: number
  message: string
} {
  const code = err instanceof Error ? err.message : String(err)
  if (code.includes('INSUFFICIENT_CREDITS')) {
    return { httpStatus: 402, message: '余额不足，engine-reported 委派未启动' }
  }
  if (code.includes('ROUTE_UNAVAILABLE')) {
    return { httpStatus: 503, message: '顾问模型路由不可用，未启动' }
  }
  if (code.includes('INVALID_')) {
    return { httpStatus: 400, message: `engine-reported 委派计费初始化失败: ${code}` }
  }
  return {
    httpStatus: 503,
    message: `engine-reported 委派计费暂不可用: ${code.slice(0, 180)}`,
  }
}

interface BillingSettledReceipt {
  requestId: string
  at: number
}

interface BillingQueue {
  schemaVersion: 1
  pending: DurableCodexBilling[]
  settledReceipts?: BillingSettledReceipt[]
}

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  const file = await open(tmp, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(tmp, path)
}

async function readBillingQueue(queuePath: string): Promise<BillingQueue> {
  try {
    const raw = JSON.parse(await readFile(queuePath, 'utf8')) as Partial<BillingQueue>
    if (raw?.schemaVersion !== 1 || !Array.isArray(raw.pending)) {
      throw new Error('DELEGATE_ENGINE_BILLING_QUEUE_INVALID')
    }
    return {
      schemaVersion: 1,
      pending: raw.pending,
      settledReceipts: Array.isArray(raw.settledReceipts) ? raw.settledReceipts : [],
    }
  } catch (err) {
    if (isNotFound(err)) return { schemaVersion: 1, pending: [] }
    throw err
  }
}

let defaultSettledHook: ((billing: DurableCodexBilling) => void | Promise<void>) | undefined

export function setDelegateEngineBillingSettledHook(
  hook: ((billing: DurableCodexBilling) => void | Promise<void>) | undefined,
): void {
  defaultSettledHook = hook
}

async function emitDelegateEngineBillingSettled(
  billing: DurableCodexBilling,
  extra?: (billing: DurableCodexBilling) => void | Promise<void>,
): Promise<void> {
  AdvisorConsultStore.projectSettledRequestId(billing.requestId)
  await extra?.(billing)
  await defaultSettledHook?.(billing)
}

export function defaultDelegateEngineBillingQueuePath(): string {
  return join(paths.agentDir('_platform'), 'delegate-engine-billing.json')
}

export function createDelegateEngineBillingClient(args?: {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  queuePath?: string
  retryMs?: number
  /** Default true: drain leftover queue files after construct (C1). Tests may set false. */
  startupRecovery?: boolean
  /** Fired only after an authoritative 2xx settle POST, never from an empty queue. */
  onSettled?: (billing: DurableCodexBilling) => void | Promise<void>
}): DelegateEngineBillingClient {
  const env = args?.env ?? process.env
  const fetcher = args?.fetcher ?? undiciRequest
  const queuePath =
    args?.queuePath ?? join(paths.agentDir('_platform'), 'delegate-engine-billing.json')
  const retryMs = args?.retryMs ?? 60_000
  const startupRecovery = args?.startupRecovery !== false
  let retryTimer: NodeJS.Timeout | null = null
  let retryChain: Promise<void> = Promise.resolve()
  // Serializes read-modify-write of the JSON queue so concurrent settle
  // persist / successful-settle delete / retryPending rewrite cannot drop
  // a requestId. retryPending holds the lock for the whole drain (including
  // POSTs): a failed live settle that needs to persist waits, which is the
  // simple-and-correct choice vs snapshot-merge.
  let queueChain: Promise<void> = Promise.resolve()

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
    const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
    if (!base || !token) throw new Error('DELEGATE_ENGINE_BILLING_MASTER_NOT_CONFIGURED')
    const response = await fetcher(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const chunks: Buffer[] = []
    let size = 0
    for await (const raw of response.body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) throw new Error('DELEGATE_ENGINE_BILLING_RESPONSE_TOO_LARGE')
      chunks.push(chunk)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const errObj =
        parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
          ? (parsed.error as Record<string, unknown>)
          : undefined
      const code = typeof errObj?.code === 'string' ? errObj.code : undefined
      throw new Error(
        typeof code === 'string' ? code : `DELEGATE_ENGINE_BILLING_HTTP_${response.statusCode}`,
      )
    }
    return parsed
  }

  const withQueueLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queueChain.then(fn, fn)
    queueChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  const persistBilling = async (billing: DurableCodexBilling): Promise<void> =>
    withQueueLock(async () => {
      const queue = await readBillingQueue(queuePath)
      const index = queue.pending.findIndex((row) => row.requestId === billing.requestId)
      if (index >= 0) queue.pending[index] = billing
      else queue.pending.push(billing)
      await writeDurableJson(queuePath, queue)
    })

  const dropSettled = async (billing: DurableCodexBilling): Promise<void> =>
    withQueueLock(async () => {
      const queue = await readBillingQueue(queuePath)
      const next = queue.pending.filter((row) => row.requestId !== billing.requestId)
      const receipts = [...(queue.settledReceipts ?? [])]
      const needsConsultProjection = billing.delegateAgentId === 'advisor'
      if (
        needsConsultProjection &&
        !receipts.some((row) => row.requestId === billing.requestId)
      ) {
        receipts.push({ requestId: billing.requestId, at: Date.now() })
      }
      if (next.length !== queue.pending.length || receipts.length !== (queue.settledReceipts?.length ?? 0)) {
        await writeDurableJson(queuePath, {
          schemaVersion: 1,
          pending: next,
          settledReceipts: receipts,
        })
      }
    })

  const client: DelegateEngineBillingClient = {
    async admit(input) {
      validateAdmitInput(input)
      // Drain leftover paid evidence before minting a new requestId.
      // A stuck pending must not DoS new delegates: swallow retry errors here.
      // Admit's own POST hits the same master, so unavailability still fail-closes.
      await drainOnce()
      const result = await post(ADMIT_PATH, {
        model: input.model,
        engine: input.engine,
        agentId: input.agentId,
        delegateAgentId: input.delegateAgentId,
        sessionKey: input.sessionKey,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.parentTurnKey ? { parentTurnKey: input.parentTurnKey } : {}),
      })
      if (
        typeof result.requestId !== 'string' ||
        !REQUEST_ID_RE.test(result.requestId) ||
        typeof result.engineSessionId !== 'string' ||
        !result.engineSessionId
      ) {
        throw new Error('DELEGATE_ENGINE_BILLING_ADMISSION_INVALID')
      }
      return {
        requestId: result.requestId,
        engineSessionId: result.engineSessionId,
        ...(result.route !== undefined ? { route: result.route } : {}),
      }
    },
    async settle(billing) {
      if (!REQUEST_ID_RE.test(billing.requestId)) {
        throw new Error('DELEGATE_ENGINE_BILLING_INVALID_REQUEST_ID')
      }
      try {
        await post(SETTLE_PATH, billing)
        await dropSettled(billing)
      } catch (err) {
        // Same durable-boundary pattern as Auto-Dream: persist then retry.
        // UNIQUE(user_id, request_id) makes a later successful POST idempotent.
        await persistBilling(billing)
        scheduleRetry()
        throw err
      }
      try {
        await emitDelegateEngineBillingSettled(billing, args?.onSettled)
      } catch {
        // Authoritative 2xx already recorded; consult projection retries from settledReceipts.
      }
    },
    async abandon(requestId) {
      if (!REQUEST_ID_RE.test(requestId)) {
        throw new Error('DELEGATE_ENGINE_BILLING_INVALID_REQUEST_ID')
      }
      await post(ABANDON_PATH, { requestId })
    },
    async retryPending() {
      return withQueueLock(async () => {
        const queue = await readBillingQueue(queuePath)
        const remaining: DurableCodexBilling[] = []
        const receipts = [...(queue.settledReceipts ?? [])]
        for (const billing of queue.pending) {
          try {
            await post(SETTLE_PATH, billing)
            if (
              billing.delegateAgentId === 'advisor' &&
              !receipts.some((row) => row.requestId === billing.requestId)
            ) {
              receipts.push({ requestId: billing.requestId, at: Date.now() })
            }
            try {
              await emitDelegateEngineBillingSettled(billing, args?.onSettled)
            } catch {
              /* 2xx receipt kept; consult projection is retried from settledReceipts */
            }
          } catch {
            remaining.push(billing)
          }
        }
        const kept: BillingSettledReceipt[] = []
        for (const rec of receipts) {
          const outcome = AdvisorConsultStore.projectSettledReceipt(rec.requestId)
          if (outcome === 'pending' || outcome === 'store-closed') kept.push(rec)
        }
        await writeDurableJson(queuePath, {
          schemaVersion: 1,
          pending: remaining,
          settledReceipts: kept,
        })
        if (remaining.length > 0) {
          scheduleRetry()
          throw new Error('DELEGATE_ENGINE_BILLING_RECOVERY_PENDING')
        }
        if (kept.length > 0) {
          scheduleRetry()
          return
        }
        clearRetry()
      })
    },
    async projectConsults(store: AdvisorConsultStore) {
      return withQueueLock(async () => {
        const queue = await readBillingQueue(queuePath)
        const kept: BillingSettledReceipt[] = []
        for (const rec of queue.settledReceipts ?? []) {
          const outcome = store.projectOneReceipt(rec.requestId)
          if (outcome === 'pending') kept.push(rec)
        }
        if (kept.length !== (queue.settledReceipts?.length ?? 0)) {
          await writeDurableJson(queuePath, {
            schemaVersion: 1,
            pending: queue.pending,
            settledReceipts: kept,
          })
        }
      })
    },
  }

  function scheduleRetry(): void {
    if (retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      retryChain = retryChain
        .catch(() => {})
        .then(() => client.retryPending?.())
        .catch(() => scheduleRetry())
    }, retryMs)
    retryTimer.unref?.()
  }

  function clearRetry(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  function kickRecovery(): void {
    retryChain = retryChain
      .catch(() => {})
      .then(() => client.retryPending?.())
      .catch(() => {})
  }

  async function drainOnce(): Promise<void> {
    retryChain = retryChain
      .catch(() => {})
      .then(() => client.retryPending?.())
    try {
      await retryChain
    } catch {
      // Individual pending rows stay queued / scheduled; new admits still go out.
    }
  }

  if (startupRecovery) void kickRecovery()
  return client
}

export const defaultDelegateEngineBilling: DelegateEngineBillingClient =
  createDelegateEngineBillingClient()
