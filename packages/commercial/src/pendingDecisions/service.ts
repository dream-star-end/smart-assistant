/**
 * Unified Pending Decisions Aggregation Service.
 *
 * Combines `turn_permission`, `connector_write`, `taskboard`, and `browser_handoff`
 * behind a single per-uid isolated list & idempotent resolve interface.
 */

import {
  PENDING_DECISION_SOURCES,
  emptyPendingDecisionCounts,
  isPendingDecisionAction,
  parsePendingDecisionId,
  type ListPendingDecisionsResponse,
  type PendingDecisionItem,
  type PendingDecisionSource,
  type PendingDecisionWarning,
  type ResolvePendingDecisionRequest,
  type ResolvePendingDecisionResponse,
} from '@openclaude/protocol'
import {
  PendingDecisionError,
  type PendingDecisionLifecycleHooks,
  type PendingDecisionSourceAdapter,
} from './types.js'

const RISK_ORDER: Record<PendingDecisionItem['riskLevel'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

export interface ListPendingDecisionsOptions {
  sources?: readonly PendingDecisionSource[]
  limit?: number
}

export interface PendingDecisionsService {
  list(userId: string, opts?: ListPendingDecisionsOptions): Promise<ListPendingDecisionsResponse>
  resolve(
    userId: string,
    decisionId: string,
    req: ResolvePendingDecisionRequest,
  ): Promise<ResolvePendingDecisionResponse>
  /** Notify subscribers (e.g., IM push adapters) when a new pending decision is created. */
  notifyCreated(item: PendingDecisionItem): Promise<void>
  onCreated(listener: (item: PendingDecisionItem) => void | Promise<void>): () => void
  onResolved(
    listener: (result: ResolvePendingDecisionResponse, userId: string) => void | Promise<void>,
  ): () => void
}

export interface PendingDecisionsServiceDeps {
  sources: readonly PendingDecisionSourceAdapter[]
  now?: () => number
  hooks?: PendingDecisionLifecycleHooks
}

export function createPendingDecisionsService(
  deps: PendingDecisionsServiceDeps,
): PendingDecisionsService {
  const now = deps.now ?? (() => Date.now())
  const sourceMap = new Map<PendingDecisionSource, PendingDecisionSourceAdapter>()
  for (const adapter of deps.sources) {
    sourceMap.set(adapter.source, adapter)
  }

  const createdListeners = new Set<(item: PendingDecisionItem) => void | Promise<void>>()
  const resolvedListeners = new Set<
    (result: ResolvePendingDecisionResponse, userId: string) => void | Promise<void>
  >()
  if (deps.hooks?.onCreated) createdListeners.add(deps.hooks.onCreated)
  if (deps.hooks?.onResolved) resolvedListeners.add(deps.hooks.onResolved)

  function normalizeUserId(userId: string): string {
    const trimmed = String(userId ?? '').trim()
    if (!trimmed) {
      throw new PendingDecisionError('INVALID_ID', 'userId is required')
    }
    return trimmed
  }

  return {
    async list(userId, opts): Promise<ListPendingDecisionsResponse> {
      const uid = normalizeUserId(userId)
      const nowMs = now()
      const limit = Math.max(1, Math.min(opts?.limit ?? 100, 200))
      const requestedSources =
        opts?.sources && opts.sources.length > 0 ? opts.sources : PENDING_DECISION_SOURCES

      const warnings: PendingDecisionWarning[] = []
      const settled = await Promise.all(
        requestedSources.map(async (source) => {
          const adapter = sourceMap.get(source)
          if (!adapter) return [] as PendingDecisionItem[]
          try {
            const rows = await adapter.listPending(uid, { limit, nowMs })
            // Defensive per-uid filter at aggregation boundary so a misbehaving adapter
            // can never leak another user's pending decisions.
            return rows.filter((item) => item.userId === uid)
          } catch (err) {
            warnings.push({
              source,
              code: err instanceof PendingDecisionError ? err.code : 'SOURCE_UNAVAILABLE',
              message: err instanceof Error ? err.message : String(err),
            })
            return [] as PendingDecisionItem[]
          }
        }),
      )

      const allItems = settled.flat().sort((a, b) => {
        // Expiring soonest first (if both have expiry), then higher risk, then oldest first.
        const aExp = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY
        const bExp = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY
        if (aExp !== bExp) return aExp - bExp
        const riskDiff = RISK_ORDER[b.riskLevel] - RISK_ORDER[a.riskLevel]
        if (riskDiff !== 0) return riskDiff
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      })

      const sliced = allItems.slice(0, limit)
      const bySource = emptyPendingDecisionCounts()
      for (const item of sliced) {
        bySource[item.source] += 1
      }

      return {
        items: sliced,
        counts: {
          total: sliced.length,
          bySource,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
        generatedAt: new Date(nowMs).toISOString(),
      }
    },

    async resolve(userId, decisionId, req): Promise<ResolvePendingDecisionResponse> {
      const uid = normalizeUserId(userId)
      const parsed = parsePendingDecisionId(decisionId)
      if (!parsed) {
        throw new PendingDecisionError('INVALID_ID', `invalid pending decision id: ${decisionId}`)
      }
      if (!isPendingDecisionAction(req?.decision)) {
        throw new PendingDecisionError('INVALID_ACTION', 'decision must be "approve" or "deny"')
      }
      const adapter = sourceMap.get(parsed.source)
      if (!adapter) {
        throw new PendingDecisionError(
          'SOURCE_UNAVAILABLE',
          `pending decision source unavailable: ${parsed.source}`,
        )
      }

      const result = await adapter.resolve(uid, parsed.sourceId, req, now())
      // Side-effect listeners run at most once per decision: never fire on idempotent replays.
      if (!result.idempotentReplay) {
        for (const listener of resolvedListeners) {
          try {
            await listener(result, uid)
          } catch {
            // Listener failure must never roll back or mask an already-committed resolution.
          }
        }
      }
      return result
    },

    async notifyCreated(item: PendingDecisionItem): Promise<void> {
      for (const listener of createdListeners) {
        try {
          await listener(item)
        } catch {
          // Best-effort notification fan-out.
        }
      }
    },

    onCreated(listener) {
      createdListeners.add(listener)
      return () => {
        createdListeners.delete(listener)
      }
    },

    onResolved(listener) {
      resolvedListeners.add(listener)
      return () => {
        resolvedListeners.delete(listener)
      }
    },
  }
}
