/**
 * Pre-dispatch content record. Never blocks the current user message.
 * A session stops only after an admin bans it.
 */
import { createHash } from 'node:crypto'

import { createLogger } from './logger.js'
import {
  getContentReviewStore,
  type ContentReviewRecord,
} from './contentReviewStore.js'

export const CONTENT_REVIEW_FLAG = 'OC_JEV_CONTENT_REVIEW'
export const CONTENT_REVIEW_KEY = 'OC_JEV_API_KEY'
export const CONTENT_REVIEW_URL = 'https://ai-gateway.vercel.sh/v1/evaluate'
export const CONTENT_REVIEW_MIN = 0.9
const MAX_INFLIGHT = 2

const CRITERIA: Record<string, string> = {
  none: 'ordinary request, including coding, research, operations on the user own systems, or rude but legal speech',
  policy_violation:
    'the user is requesting help to commit violence, fraud or scams, sexual content involving minors, or to make illegal weapons or drugs',
}

const log = createLogger({ module: 'jevContentReview' })

export interface ContentReviewAlert {
  reviewId: number
  sessionKey: string
  userId: string
  confidence: number
  excerpt: string
  body: string
}

type ReviewResponse = { status: number; json: () => Promise<unknown> }

export interface ContentReviewDeps {
  fetchImpl?: (
    url: string,
    init: {
      method: string
      headers: Record<string, string>
      body: string
      signal: AbortSignal
      dispatcher: object
    },
  ) => Promise<ReviewResponse>
  timeoutMs?: number
  undici?: {
    Agent: new (opts?: { connections?: number; pipelining?: number; keepAliveTimeout?: number }) => object
    fetch: (
      url: string,
      init: {
        method: string
        headers: Record<string, string>
        body: string
        signal: AbortSignal
        dispatcher: object
      },
    ) => Promise<ReviewResponse>
  }
}

let inflight = 0
let cachedAgent: object | null = null
let testDeps: ContentReviewDeps | null = null
let alerter: ((event: ContentReviewAlert) => void | Promise<void>) | null = null
const pending = new Set<Promise<void>>()

export function contentReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[CONTENT_REVIEW_FLAG] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

export function inboundSessionKey(frame: {
  sessionKey?: unknown
  agentId?: unknown
  channel?: unknown
  peer?: { kind?: unknown; id?: unknown }
}): string {
  if (typeof frame.sessionKey === 'string' && frame.sessionKey.trim()) return frame.sessionKey.trim()
  const agentId = typeof frame.agentId === 'string' && frame.agentId ? frame.agentId : 'main'
  const channel = typeof frame.channel === 'string' ? frame.channel : ''
  const kind = typeof frame.peer?.kind === 'string' ? frame.peer.kind : ''
  const id = typeof frame.peer?.id === 'string' ? frame.peer.id : ''
  if (!channel || !kind || !id) return ''
  return `agent:${agentId}:${channel}:${kind}:${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function isContentReviewSessionBanned(sessionKey: string): boolean {
  if (!sessionKey) return false
  try {
    return getContentReviewStore().isBanned(sessionKey)
  } catch {
    return false
  }
}

export function setContentReviewAlerter(
  fn: ((event: ContentReviewAlert) => void | Promise<void>) | null,
): void {
  alerter = fn
}

export function setContentReviewDepsForTests(deps: ContentReviewDeps | null): void {
  testDeps = deps
  cachedAgent = null
}

export function resetContentReviewForTests(): void {
  inflight = 0
  cachedAgent = null
  testDeps = null
  alerter = null
}

export function flushContentReviewForTests(): Promise<void> {
  return Promise.all([...pending]).then(() => undefined)
}

/** Schedule a review. Returns immediately and never throws. */
export function observeUserContentReview(input: { text: string; userId: string; sessionKey: string }): void {
  try {
    if (!contentReviewEnabled()) return
    if (!(process.env[CONTENT_REVIEW_KEY] ?? '').trim()) return
    const text = input.text.trim()
    if (text.length < 8) return
    const task = runUserContentReview(input).then(() => undefined, () => undefined)
    pending.add(task)
    void task.finally(() => pending.delete(task))
  } catch {
    // Never affect dispatch.
  }
}

export async function runUserContentReview(input: {
  text: string
  userId: string
  sessionKey: string
}): Promise<ContentReviewRecord | null> {
  const text = input.text.trim()
  if (!contentReviewEnabled() || text.length < 8) return null
  const key = (process.env[CONTENT_REVIEW_KEY] ?? '').trim()
  if (!key) return null
  if (inflight >= MAX_INFLIGHT) return null
  inflight += 1
  const signal = AbortSignal.timeout(testDeps?.timeoutMs ?? 1500)
  try {
    const body = JSON.stringify({
      model: 'typesafe-ai/jev',
      state: text.slice(0, 12_000),
      questions: { risk: { type: 'choice', criteria: CRITERIA } },
    })
    const res = await reviewFetch(key, body, signal)
    if (res.status !== 200) return null
    const parsed = parseRisk(await res.json())
    const record = getContentReviewStore().insert({
      userId: input.userId.slice(0, 80),
      sessionKey: input.sessionKey.slice(0, 240),
      textHash: createHash('sha256').update(text).digest('hex'),
      excerpt: text.slice(0, 180),
      choice: parsed.choice ?? 'none',
      confidence: parsed.confidence,
      thresholdMet: parsed.thresholdMet,
    })
    if (parsed.thresholdMet && parsed.choice === 'policy_violation' && alerter) {
      const event: ContentReviewAlert = {
        reviewId: record.id,
        sessionKey: record.sessionKey,
        userId: record.userId,
        confidence: parsed.confidence ?? 0,
        excerpt: record.excerpt,
        body: [
          `会话 ${record.sessionKey || '(未知)'}`,
          `用户 ${record.userId}`,
          `置信度 ${parsed.confidence}`,
          '',
          record.excerpt,
          '',
          '未拦截本条消息。确认后可在管理页封禁该会话。',
        ].join('\n'),
      }
      await alerter(event)
      getContentReviewStore().markAlerted(record.id)
    }
    return record
  } catch (error) {
    log.info('content review failed', { errorName: error instanceof Error ? error.name : 'Error' })
    return null
  } finally {
    inflight -= 1
  }
}

async function reviewFetch(key: string, body: string, signal: AbortSignal): Promise<ReviewResponse> {
  const dispatcher = testDeps?.fetchImpl ? { direct: true } : await directDispatcher()
  const init = {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body,
    signal,
    dispatcher,
  }
  if (testDeps?.fetchImpl) return testDeps.fetchImpl(CONTENT_REVIEW_URL, init)
  const undici = testDeps?.undici ?? ((await import('undici')) as NonNullable<ContentReviewDeps['undici']>)
  return undici.fetch(CONTENT_REVIEW_URL, init)
}

async function directDispatcher(): Promise<object> {
  if (cachedAgent) return cachedAgent
  const undici = testDeps?.undici ?? ((await import('undici')) as NonNullable<ContentReviewDeps['undici']>)
  cachedAgent = new undici.Agent({ connections: MAX_INFLIGHT, pipelining: 1, keepAliveTimeout: 30_000 })
  return cachedAgent
}

function parseRisk(body: unknown): { choice: string | null; confidence: number | null; thresholdMet: boolean } {
  const root = asRecord(body)
  const answer = asRecord(asRecord(root?.answers)?.risk)
  const choice = typeof answer?.choice === 'string' ? answer.choice : null
  const direct = finite(answer?.confidence)
  const meta = finite(asRecord(asRecord(asRecord(root?.providerMetadata)?.typesafe)?.confidence)?.risk)
  const confidence = direct ?? meta
  return {
    choice,
    confidence,
    thresholdMet: confidence !== null && confidence >= CONTENT_REVIEW_MIN && choice === 'policy_violation',
  }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
