import type { SystemActionDetail, SystemActionSummary } from '@openclaude/protocol/browser'
import type { AuthSession, Preferences } from '../types'
import { ApiError, AuthEpochStaleError, bearerHeaders, jsonOrThrow } from './http'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const NONCE = /^[A-Za-z0-9_-]{43}$/
const STATES = new Set(['prepared', 'approved_waiting_browser', 'executing', 'succeeded', 'failed', 'denied', 'expired', 'unknown'])
const EXECUTORS = new Set(['master', 'control', 'browser'])
export type ReceiptObserver = (receipt: SystemActionSummary, context: { assertCurrent: () => void }) => void | Promise<void>
export type SystemActionsClient = {
  getPreferencesSnapshot(): Promise<Preferences>
  getDetail(id: string): Promise<SystemActionDetail>
  getResult(id: string): Promise<SystemActionSummary>
  getConfirmation(id: string): Promise<{ detail: SystemActionDetail; nonce: string }>
  confirm(id: string, proof: { nonce: string; previewHash: string }): Promise<SystemActionSummary>
  deny(id: string): Promise<SystemActionSummary>
  reconcile(id: string): Promise<SystemActionSummary>
}
function invalidResponse(): never {
  throw new ApiError({ status: 502, code: 'SYSTEM_ACTION_INVALID_RESPONSE', message: '这项操作无法核验，请刷新状态。' })
}
function staleConfirmation(): never {
  throw new ApiError({ status: 409, code: 'SYSTEM_ACTION_CONFIRMATION_STALE', message: '请重新打开确认。' })
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function fields(value: unknown): boolean {
  return Array.isArray(value) && value.every(v => object(v) && typeof v.label === 'string' && typeof v.value === 'string')
}
function summary(value: unknown, id: string): SystemActionSummary {
  if (!object(value) || value.id !== id || typeof value.operationId !== 'string' || typeof value.title !== 'string'
    || typeof value.state !== 'string' || !STATES.has(value.state) || typeof value.executor !== 'string' || !EXECUTORS.has(value.executor)
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt) || !Number.isSafeInteger(value.expiresAt)) invalidResponse()
  const result = value.result
  if (result !== null && (!object(result) || typeof result.summary !== 'string' || !['done', 'accepted', 'awaiting_user'].includes(String(result.completion)))) invalidResponse()
  return value as unknown as SystemActionSummary
}
function detail(value: unknown, id: string): SystemActionDetail {
  summary(value, id)
  if (!object(value) || typeof value.previewHash !== 'string' || !HASH.test(value.previewHash)) invalidResponse()
  const p = value.preview
  if (p !== null && (!object(p) || typeof p.title !== 'string' || typeof p.description !== 'string' || typeof p.scope !== 'string'
    || !fields(p.before) || !fields(p.after) || !Array.isArray(p.consequences) || !p.consequences.every(v => typeof v === 'string')
    || typeof p.destructive !== 'boolean' || !object(p.price) || !['none', 'fixed', 'usage'].includes(String(p.price.kind))
    || typeof p.price.label !== 'string' || (p.price.rates !== undefined && !fields(p.price.rates)))) invalidResponse()
  return value as unknown as SystemActionDetail
}

/** Each client is bound to one access generation. No approval request is refreshed or replayed. */
export function createSystemActionsApi(options: {
  auth: AuthSession
  currentAuth: () => AuthSession | null
  deviceId: string
  onReceipt?: ReceiptObserver
  onReceiptError?: () => void
}): SystemActionsClient {
  const { auth, currentAuth, deviceId, onReceipt, onReceiptError } = options
  if (!UUID.test(deviceId)) staleConfirmation()
  const captured = auth.snapshot()
  const generation = auth.getAccessGeneration()
  function assertCurrent(): void {
    const now = auth.snapshot()
    if (currentAuth() !== auth || !captured.token || now.epoch !== captured.epoch || now.token !== captured.token
      || auth.getAccessGeneration() !== generation) throw new AuthEpochStaleError()
  }
  assertCurrent()
  function actionPath(id: string, suffix = ''): string {
    if (!UUID.test(id)) staleConfirmation()
    return `/api/me/system-actions/${encodeURIComponent(id)}${suffix}`
  }
  function approvalPath(id: string, action: 'challenge' | 'confirm' | 'deny' | 'reconcile'): string {
    if (!UUID.test(id)) staleConfirmation()
    return `/api/auth/system-actions/${encodeURIComponent(id)}/${action}`
  }
  async function request<T>(path: string, decode: (value: unknown) => T, body?: Record<string, unknown>): Promise<T> {
    assertCurrent()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store', redirect: 'error',
        headers: bearerHeaders(captured.token, body !== undefined),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      })
      assertCurrent()
      const value = await jsonOrThrow<unknown>(response)
      assertCurrent()
      return decode(value)
    } catch (error) { assertCurrent(); throw error }
    finally { clearTimeout(timer) }
  }
  function reportObserverError(): void {
    try { assertCurrent(); onReceiptError?.() } catch { /* A stale receipt cannot update another identity. */ }
  }
  function observe<T extends SystemActionSummary>(receipt: T): T {
    assertCurrent()
    if (onReceipt) {
      try { void Promise.resolve(onReceipt(receipt, { assertCurrent })).catch(reportObserverError) }
      catch { reportObserverError() }
    }
    return receipt
  }
  const issued = new Map<string, { nonce: string; previewHash: string; expiresAt: number }>()
  const getDetail = async (id: string) => observe(await request(actionPath(id), value => detail(value, id)))
  const getResult = async (id: string) => observe(await request(actionPath(id, '/result'), value => summary(value, id)))
  return {
    getDetail, getResult,
    getPreferencesSnapshot: () => request('/api/me/preferences', value => {
      if (!object(value)) invalidResponse()
      return value
    }),
    async getConfirmation(id) {
      issued.delete(id)
      const fresh = await getDetail(id)
      assertCurrent()
      if (fresh.state !== 'prepared' || fresh.executor !== 'master' || !fresh.preview || fresh.expiresAt <= Date.now()) staleConfirmation()
      const challenge = await request(approvalPath(id, 'challenge'), value => {
        if (!object(value) || typeof value.nonce !== 'string' || !NONCE.test(value.nonce)) invalidResponse()
        const next = detail(value.detail, id)
        if (next.state !== 'prepared' || next.executor !== 'master' || !next.preview || next.previewHash !== fresh.previewHash
          || next.expiresAt <= Date.now()) staleConfirmation()
        return { detail: next, nonce: value.nonce }
      }, { deviceId, previewHash: fresh.previewHash })
      issued.set(id, { nonce: challenge.nonce, previewHash: challenge.detail.previewHash, expiresAt: challenge.detail.expiresAt })
      if (issued.size > 64) { const oldest = issued.keys().next().value; if (oldest !== undefined) issued.delete(oldest) }
      return challenge
    },
    async confirm(id, proof) {
      assertCurrent()
      const expected = issued.get(id)
      issued.delete(id)
      if (!expected || expected.nonce !== proof.nonce || expected.previewHash !== proof.previewHash || expected.expiresAt <= Date.now()) staleConfirmation()
      return observe(await request(approvalPath(id, 'confirm'), value => summary(value, id), { deviceId, nonce: proof.nonce, previewHash: proof.previewHash }))
    },
    async reconcile(id) {
      assertCurrent(); issued.delete(id)
      return observe(await request(approvalPath(id, 'reconcile'), value => summary(value, id), {}))
    },
    async deny(id) {
      assertCurrent(); issued.delete(id)
      return observe(await request(approvalPath(id, 'deny'), value => summary(value, id), {}))
    },
  }
}
