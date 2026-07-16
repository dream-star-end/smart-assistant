/**
 * Cost-free skill retrieval shadow observer.
 *
 * The observer is a strict side channel: no env means no listener, no skill
 * listing, and no network call. When enabled it deterministically samples a
 * turn, ranks the current agent-visible skill metadata under a short deadline,
 * and reports only SHA-256(message), ranked skill names, and turn identifiers.
 * It never changes the SKILLS prompt slot or model/tool execution.
 */
import { createHash } from 'node:crypto'

import type { ToolCalledEvent } from '@openclaude/protocol'
import { type SkillMetadata, buildAgentSkillStore } from '@openclaude/storage'

import { type GatewayEventBus, eventBus } from './eventBus.js'
import { createLogger } from './logger.js'
import {
  type SkillShadowRankings,
  type SkillShadowRoute,
  compactSkillShadowRankings,
  runSkillShadowRankersParallel,
} from './skillRetrievalShadow.js'
import {
  SKILL_VIEW_TOOL,
  type TraceIdResolver,
  normalizeTraceId,
  parseSkillSlug,
} from './skillUsageReporter.js'

const log = createLogger({ module: 'skillShadowReporter' })

export const SKILL_SHADOW_ENV = 'OC_SKILL_SHADOW_SAMPLE_RATE'
export const SKILL_SHADOW_PATH = '/internal/v3/skill-shadow'
export const SKILL_SHADOW_DEFAULT_SAMPLE_RATE = 0.1
export const SKILL_SHADOW_BUDGET_MS = 50

const SEND_TIMEOUT_MS = 2_000
const MAX_ACTIVE_SAMPLES = 2_000
const ACTIVE_SAMPLE_TTL_MS = 60 * 60_000

type FetchLike = (input: string, init: RequestInit) => Promise<Response>
type EventBusLike = Pick<GatewayEventBus, 'on' | 'off'>

export interface SkillShadowConfig {
  masterBaseUrl: string
  containerToken: string
  sampleRate: number
}

export type SkillShadowStatus = 'ok' | 'timeout' | 'error'

export interface SkillShadowSelectionEvent {
  kind: 'selection'
  traceId: string
  sessionKey: string
  agentId: string
  messageHash: string
  sampleRate: number
  status: SkillShadowStatus
  routes: Record<SkillShadowRoute, string[]>
  catalogSize: number
  elapsedMs: number
}

export interface SkillShadowUsageEvent {
  kind: 'usage'
  traceId: string
  skillName: string
}

export type SkillShadowEvent = SkillShadowSelectionEvent | SkillShadowUsageEvent

export interface SkillShadowReporter {
  /** Returns true when this turn entered the sample. Never awaits shadow work. */
  observeTurn(args: {
    traceId: string
    sessionKey: string
    agentId: string
    userMessage: string
  }): boolean
  stop(): void
}

/**
 * Missing/invalid/zero = disabled. `default` or `true` explicitly enables the
 * documented 10% default; a numeric value in (0,1] sets an exact rate.
 */
export function parseSkillShadowSampleRate(raw: string | undefined): number {
  if (raw === undefined) return 0
  const value = raw.trim().toLocaleLowerCase()
  if (value === 'default' || value === 'true') return SKILL_SHADOW_DEFAULT_SAMPLE_RATE
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0
}

export function readSkillShadowConfig(
  env: NodeJS.ProcessEnv = process.env,
): SkillShadowConfig | null {
  const sampleRate = parseSkillShadowSampleRate(env[SKILL_SHADOW_ENV])
  if (sampleRate <= 0) return null
  const masterBaseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const containerToken = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!masterBaseUrl || !containerToken) return null
  return {
    masterBaseUrl: masterBaseUrl.replace(/\/+$/, ''),
    containerToken,
    sampleRate,
  }
}

export function hashSkillShadowMessage(message: string): string {
  return createHash('sha256').update(message).digest('hex')
}

export function shouldSampleSkillShadow(traceId: string, rate: number): boolean {
  if (rate <= 0) return false
  if (rate >= 1) return true
  const value = createHash('sha256').update(traceId).digest().readUInt32BE(0)
  return value / 0x1_0000_0000 < rate
}

export async function sendSkillShadowEvent(
  event: SkillShadowEvent,
  config: SkillShadowConfig,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SEND_TIMEOUT_MS)
  try {
    const response = await (opts.fetchImpl ?? fetch)(
      `${config.masterBaseUrl}${SKILL_SHADOW_PATH}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.containerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      },
    )
    if (!response.ok) throw new Error(`skill shadow report returned HTTP ${response.status}`)
  } finally {
    clearTimeout(timer)
  }
}

function emptyRoutes(): Record<SkillShadowRoute, string[]> {
  return {
    existing_keyword_fallback: [],
    zh_lexical: [],
    char_ngram: [],
    bm25_multiquery: [],
  }
}

export function makeSkillShadowReporter(deps: {
  config: SkillShadowConfig
  eventBus?: EventBusLike
  resolveTraceId?: TraceIdResolver
  loadSkills?: (agentId: string) => Promise<SkillMetadata[]>
  rank?: (
    skills: readonly SkillMetadata[],
    query: string,
  ) => SkillShadowRankings | Promise<SkillShadowRankings>
  sendEvent?: (event: SkillShadowEvent) => Promise<void>
  budgetMs?: number
  now?: () => number
}): SkillShadowReporter {
  const bus = deps.eventBus ?? eventBus
  const budgetMs = Math.max(1, deps.budgetMs ?? SKILL_SHADOW_BUDGET_MS)
  const now = deps.now ?? (() => Date.now())
  const loadSkills =
    deps.loadSkills ?? (async (agentId: string) => await buildAgentSkillStore(agentId).list())
  const rank = deps.rank ?? runSkillShadowRankersParallel
  const sendEvent =
    deps.sendEvent ?? (async (event) => await sendSkillShadowEvent(event, deps.config))
  const activeSamples = new Map<string, number>()
  let stopped = false

  function report(event: SkillShadowEvent): void {
    void sendEvent(event).catch((err) => {
      // No retry by design: shadow data may be incomplete, but turn execution must
      // never wait for or accumulate a telemetry backlog.
      log.warn('skill shadow event dropped', { kind: event.kind }, err)
    })
  }

  function pruneActiveSamples(current: number): void {
    for (const [traceId, expiresAt] of activeSamples) {
      if (expiresAt <= current) activeSamples.delete(traceId)
    }
    while (activeSamples.size >= MAX_ACTIVE_SAMPLES) {
      const oldest = activeSamples.keys().next().value as string | undefined
      if (!oldest) break
      activeSamples.delete(oldest)
    }
  }

  function onToolCalled(event: ToolCalledEvent): void {
    if (stopped || event.isError || event.toolName !== SKILL_VIEW_TOOL) return
    const traceId = normalizeTraceId(deps.resolveTraceId?.(event.sessionKey))
    if (!traceId) return
    const expiresAt = activeSamples.get(traceId)
    if (!expiresAt || expiresAt <= now()) {
      activeSamples.delete(traceId)
      return
    }
    const skillName = parseSkillSlug(event.inputPreview)
    if (!skillName) return
    report({ kind: 'usage', traceId, skillName })
  }

  bus.on('tool.called', onToolCalled)

  return {
    observeTurn({ traceId, sessionKey, agentId, userMessage }): boolean {
      if (stopped) return false
      const normalizedTraceId = normalizeTraceId(traceId)
      if (!normalizedTraceId) return false
      if (!shouldSampleSkillShadow(normalizedTraceId, deps.config.sampleRate)) return false

      const startedAt = now()
      pruneActiveSamples(startedAt)
      activeSamples.set(normalizedTraceId, startedAt + ACTIVE_SAMPLE_TTL_MS)
      const messageHash = hashSkillShadowMessage(userMessage)
      let query: string | null = userMessage

      void (async () => {
        let timer: ReturnType<typeof setTimeout> | null = null
        let expired = false
        let catalogSize = 0
        const timeout = new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => {
            expired = true
            query = null
            resolve({ timedOut: true })
          }, budgetMs)
          timer.unref?.()
        })
        try {
          const work = (async () => {
            const skills = await loadSkills(agentId)
            catalogSize = skills.length
            // If metadata I/O alone consumed the budget, do not spend more CPU on
            // rankers after the timeout winner has already been reported.
            const currentQuery = query
            if (expired || currentQuery === null || now() - startedAt >= budgetMs) {
              return { timedOut: true as const }
            }
            const rankings = await rank(skills, currentQuery)
            return { skills, rankings }
          })()
          const result = await Promise.race([work, timeout])
          const elapsedMs = Math.max(0, now() - startedAt)
          if ('timedOut' in result || elapsedMs > budgetMs) {
            report({
              kind: 'selection',
              traceId: normalizedTraceId,
              sessionKey,
              agentId,
              messageHash,
              sampleRate: deps.config.sampleRate,
              status: 'timeout',
              routes: emptyRoutes(),
              catalogSize,
              elapsedMs,
            })
            return
          }
          report({
            kind: 'selection',
            traceId: normalizedTraceId,
            sessionKey,
            agentId,
            messageHash,
            sampleRate: deps.config.sampleRate,
            status: 'ok',
            routes: compactSkillShadowRankings(result.rankings),
            catalogSize: result.skills.length,
            elapsedMs,
          })
        } catch {
          report({
            kind: 'selection',
            traceId: normalizedTraceId,
            sessionKey,
            agentId,
            messageHash,
            sampleRate: deps.config.sampleRate,
            status: 'error',
            routes: emptyRoutes(),
            catalogSize,
            elapsedMs: Math.max(0, now() - startedAt),
          })
        } finally {
          query = null
          if (timer) clearTimeout(timer)
        }
      })()
      return true
    },
    stop(): void {
      if (stopped) return
      stopped = true
      activeSamples.clear()
      bus.off('tool.called', onToolCalled)
    },
  }
}

export function startSkillShadowReporter(
  opts: {
    env?: NodeJS.ProcessEnv
    eventBus?: EventBusLike
    resolveTraceId?: TraceIdResolver
  } = {},
): SkillShadowReporter | null {
  const config = readSkillShadowConfig(opts.env ?? process.env)
  if (!config) return null
  const reporter = makeSkillShadowReporter({
    config,
    eventBus: opts.eventBus,
    resolveTraceId: opts.resolveTraceId,
  })
  log.info('skill shadow reporter started', { sampleRate: config.sampleRate })
  return reporter
}
