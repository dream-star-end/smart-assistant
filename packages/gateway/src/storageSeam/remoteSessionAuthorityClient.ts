/**
 * OCV5-907 Wave 2 (P1-1) — Container-side HTTP client implementing L0
 * `SessionAuthorityStore` plus narrow container-owned PATCH methods against
 * Master `/internal/v3/authority-state/*`.
 *
 * Security & durability invariants (R1 Audit B1/B2/B4/B6/W2/W6):
 * - Zero `process.env` reads.
 * - Narrow PATCH routes (`patchResumePointer`, `patchPromptState`,
 *   `patchCapsuleRef`) never transmit master-owned placement fields or
 *   `pendingInstallMigration`.
 * - Preserves HTTP 409 conflict codes so `AuthorityStateBridge` fails closed.
 * - Marks HTTP 404 (unsupported route on legacy Master) so runtimes can
 *   negative-cache and avoid repeated cold-turn round trips.
 * - `AbortController` timer spans BOTH fetch headers AND full JSON body read.
 */
import { AUTHORITY_STATE_INTERNAL_PREFIX } from '@openclaude/protocol'
import type {
  AuthoritativeRollingCheckpoint,
  AuthorityEngineKind,
  EngineStateCapsuleRef,
  PlacementMigrationRecord,
  ResumeLadderTier,
  SessionAuthorityEpoch,
  SessionAuthorityStore,
  SessionEnginePointer,
} from '@openclaude/protocol/storage-seam'
import type { LocalPromptStateRecord } from './authorityStateBridge.js'

export type AuthorityFetchImpl = (
  url: string,
  init?: RequestInit,
) => Promise<Response>

export interface RemoteSessionAuthorityStoreOptions {
  readonly masterBaseUrl: string
  readonly containerToken: string
  readonly timeoutMs?: number
  readonly fetchImpl?: AuthorityFetchImpl
}

export interface NarrowResumePatchInput {
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly nativeSessionId: string | null
  readonly history?: readonly string[]
  readonly rejectedIds?: readonly string[]
  readonly totalCostUsd?: number
  readonly historyContextVersion?: number | null
  readonly promotedFromHistory?: boolean
  readonly expectedPlacementEpoch?: number
  readonly createIfAbsentOnly?: boolean
  readonly reset?: boolean
}

export interface NarrowCapsulePatchInput {
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly expectedPlacementEpoch: number
  readonly capsuleId: string
  readonly manifestBlobId: string
  readonly engineVersion: string
  readonly createdAt: string
  readonly nativeSessionId?: string | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
}

const DEFAULT_TIMEOUT_MS = 4_000

const CONFLICT_CODES = new Set<string>([
  'SESSION_PLACEMENT_EPOCH_MISMATCH',
  'SESSION_PLACEMENT_MIGRATING',
  'CHECKPOINT_PLACEMENT_EPOCH_MISMATCH',
  'PLACEMENT_EPOCH_CONFLICT',
])

export class CodedAuthorityRpcError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'CodedAuthorityRpcError'
    this.code = code
    this.status = status
  }
}

export function isAuthorityEndpointUnsupportedError(err: unknown): boolean {
  return err instanceof CodedAuthorityRpcError && err.status === 404
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '')
}

async function cancelBodySafe(res: Response): Promise<void> {
  try {
    if (res.body && !res.bodyUsed) {
      await res.body.cancel()
    }
  } catch {
    /* best effort */
  }
}

async function readJsonWithDeadline(
  res: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  if (signal.aborted) {
    await cancelBodySafe(res)
    throw new Error('AUTHORITY_RPC_TIMEOUT')
  }
  const onAbort = () => {
    void cancelBodySafe(res)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const parsed: unknown = await new Promise<unknown>((resolve, reject) => {
      const abortReject = () => reject(new Error('AUTHORITY_RPC_TIMEOUT'))
      signal.addEventListener('abort', abortReject, { once: true })
      res
        .json()
        .then(
          (val) => {
            signal.removeEventListener('abort', abortReject)
            resolve(val)
          },
          () => {
            signal.removeEventListener('abort', abortReject)
            if (signal.aborted) abortReject()
            else resolve(null)
          },
        )
    })
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function extractErrorCode(payload: Record<string, unknown> | null, fallback: string): string {
  const errObj = payload?.error
  if (errObj && typeof errObj === 'object' && !Array.isArray(errObj)) {
    const code = (errObj as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  if (typeof payload?.code === 'string' && payload.code.length > 0) {
    return payload.code
  }
  return fallback
}

export class RemoteSessionAuthorityStore implements SessionAuthorityStore {
  private readonly baseUrl: string
  private readonly containerToken: string
  private readonly timeoutMs: number
  private readonly fetchImpl: AuthorityFetchImpl

  constructor(options: RemoteSessionAuthorityStoreOptions) {
    this.baseUrl = normalizeBaseUrl(options.masterBaseUrl)
    this.containerToken = options.containerToken
    this.timeoutMs = Math.max(200, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  private async requestJson<T>(
    subpath: string,
    init: { readonly method: 'GET' | 'PUT' | 'POST' | 'PATCH'; readonly body?: unknown },
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const url = `${this.baseUrl}${AUTHORITY_STATE_INTERNAL_PREFIX}${subpath}`
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.containerToken}`,
        accept: 'application/json',
      }
      let encodedBody: string | undefined
      if (init.body !== undefined) {
        headers['content-type'] = 'application/json'
        encodedBody = JSON.stringify(init.body)
      }
      const res = await this.fetchImpl(url, {
        method: init.method,
        headers,
        ...(encodedBody !== undefined ? { body: encodedBody } : {}),
        signal: controller.signal,
      })
      const payload = await readJsonWithDeadline(res, controller.signal)
      if (!res.ok) {
        const code = extractErrorCode(payload, `AUTHORITY_HTTP_${res.status}`)
        if (res.status === 409 && CONFLICT_CODES.has(code)) {
          throw new CodedAuthorityRpcError(code, res.status, code)
        }
        throw new CodedAuthorityRpcError(
          code,
          res.status,
          `Authority RPC ${init.method} ${subpath} failed (${res.status}: ${code})`,
        )
      }
      return (payload ?? {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  async getEpoch(_tenantId: string, sessionKey: string): Promise<SessionAuthorityEpoch | null> {
    const q = encodeURIComponent(sessionKey)
    const data = await this.requestJson<{ readonly epoch?: SessionAuthorityEpoch | null }>(
      `epoch?sessionKey=${q}`,
      { method: 'GET' },
    )
    return data.epoch ?? null
  }

  async getPointer(_tenantId: string, sessionKey: string): Promise<SessionEnginePointer | null> {
    const q = encodeURIComponent(sessionKey)
    const data = await this.requestJson<{ readonly pointer?: SessionEnginePointer | null }>(
      `pointer?sessionKey=${q}`,
      { method: 'GET' },
    )
    return data.pointer ?? null
  }

  /** Narrow container-owned resume patch (never mutates poolKind or reserved metadata). */
  async patchResumePointer(input: NarrowResumePatchInput): Promise<SessionEnginePointer> {
    const data = await this.requestJson<{ readonly pointer?: SessionEnginePointer }>('pointer', {
      method: 'PUT',
      body: {
        sessionKey: input.sessionKey,
        engine: input.engine,
        nativeSessionId: input.reset ? null : input.nativeSessionId,
        ...(input.history !== undefined ? { history: [...input.history] } : {}),
        ...(input.rejectedIds !== undefined ? { rejectedIds: [...input.rejectedIds] } : {}),
        ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
        ...(input.historyContextVersion !== undefined
          ? { historyContextVersion: input.historyContextVersion }
          : {}),
        ...(input.promotedFromHistory !== undefined
          ? { promotedFromHistory: input.promotedFromHistory }
          : {}),
        ...(input.expectedPlacementEpoch !== undefined
          ? { expectedPlacementEpoch: input.expectedPlacementEpoch }
          : {}),
        ...(input.createIfAbsentOnly ? { createIfAbsentOnly: true } : {}),
        ...(input.reset ? { reset: true } : {}),
      },
    })
    if (!data.pointer) throw new Error('AUTHORITY_RPC_EMPTY_POINTER')
    return data.pointer
  }

  /** Narrow prompt-state merge (preserves pendingInstallMigration & _capsuleMeta). */
  async patchPromptState(
    record: LocalPromptStateRecord,
    engine: AuthorityEngineKind,
    expectedPlacementEpoch: number,
  ): Promise<SessionEnginePointer> {
    const data = await this.requestJson<{ readonly pointer?: SessionEnginePointer }>('prompt-state', {
      method: 'PATCH',
      body: {
        sessionKey: record.sessionKey,
        engine,
        expectedPlacementEpoch,
        promptState: {
          v: 1,
          sessionKey: record.sessionKey,
          conversationId: record.conversationId,
          inputsKey: record.inputsKey,
          ...(record.slotHashes ? { slotHashes: record.slotHashes } : {}),
          injectedAfterBaseline: record.injectedAfterBaseline,
          updatedAt: record.updatedAt,
        },
      },
    })
    if (!data.pointer) throw new Error('AUTHORITY_RPC_EMPTY_POINTER')
    return data.pointer
  }

  /** Narrow capsule ref patch (preserves pendingInstallMigration & promptState). */
  async patchCapsuleRef(input: NarrowCapsulePatchInput): Promise<SessionEnginePointer> {
    const data = await this.requestJson<{ readonly pointer?: SessionEnginePointer }>('capsule', {
      method: 'PATCH',
      body: {
        sessionKey: input.sessionKey,
        engine: input.engine,
        expectedPlacementEpoch: input.expectedPlacementEpoch,
        capsuleId: input.capsuleId,
        manifestBlobId: input.manifestBlobId,
        engineVersion: input.engineVersion,
        createdAt: input.createdAt,
        ...(input.nativeSessionId !== undefined ? { nativeSessionId: input.nativeSessionId } : {}),
        ...(input.usageBaseline !== undefined ? { usageBaseline: input.usageBaseline } : {}),
      },
    })
    if (!data.pointer) throw new Error('AUTHORITY_RPC_EMPTY_POINTER')
    return data.pointer
  }

  async upsertPointer(
    _tenantId: string,
    pointer: SessionEnginePointer,
    expectedEpoch?: number,
  ): Promise<SessionEnginePointer> {
    const totalCostUsd =
      typeof pointer.usageBaseline?.totalCostUsd === 'number'
        ? pointer.usageBaseline.totalCostUsd
        : undefined
    return this.patchResumePointer({
      sessionKey: pointer.sessionKey,
      engine: pointer.engine,
      nativeSessionId: pointer.nativeSessionId,
      history: pointer.history,
      rejectedIds: pointer.rejectedIds,
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      historyContextVersion: pointer.historyContextVersion ?? null,
      promotedFromHistory: pointer.promotedFromHistory,
      ...(expectedEpoch !== undefined
        ? { expectedPlacementEpoch: expectedEpoch }
        : { createIfAbsentOnly: true }),
    })
  }

  async getLatestCheckpoint(
    _tenantId: string,
    sessionKey: string,
    placementEpoch?: number,
  ): Promise<AuthoritativeRollingCheckpoint | null> {
    const q = encodeURIComponent(sessionKey)
    const epochPart =
      placementEpoch !== undefined && Number.isSafeInteger(placementEpoch) && placementEpoch >= 1
        ? `&placementEpoch=${placementEpoch}`
        : ''
    const data = await this.requestJson<{
      readonly checkpoint?: AuthoritativeRollingCheckpoint | null
    }>(`checkpoint?sessionKey=${q}${epochPart}`, { method: 'GET' })
    return data.checkpoint ?? null
  }

  async saveCheckpoint(
    _tenantId: string,
    checkpoint: AuthoritativeRollingCheckpoint,
  ): Promise<void> {
    await this.requestJson('checkpoint', {
      method: 'POST',
      body: {
        sessionKey: checkpoint.sessionKey,
        sessionId: checkpoint.sessionId,
        checkpointGeneration: checkpoint.checkpointGeneration,
        expectedPlacementEpoch: checkpoint.placementEpoch,
        mode: checkpoint.mode,
        anchorSeq: checkpoint.anchorSeq,
        sourceEngine: checkpoint.sourceEngine,
        summary: checkpoint.summary,
        ...(checkpoint.instructions !== undefined ? { instructions: checkpoint.instructions } : {}),
      },
    })
  }

  async ackCheckpoint(
    _tenantId: string,
    sessionKey: string,
    checkpointGeneration: string,
    turnKey: string,
  ): Promise<boolean> {
    const data = await this.requestJson<{ readonly acked?: boolean }>('checkpoint/ack', {
      method: 'POST',
      body: {
        sessionKey,
        checkpointGeneration,
        turnKey,
      },
    })
    return data.acked === true
  }

  async beginPlacementMigration(
    _tenantId: string,
    _migration: Omit<PlacementMigrationRecord, 'state' | 'completedAt'>,
  ): Promise<PlacementMigrationRecord> {
    throw new Error('PLACEMENT_MIGRATION_MASTER_ONLY')
  }

  async commitPlacementMigration(
    _tenantId: string,
    _migrationId: string,
    _outcome: {
      readonly continuityTier: ResumeLadderTier
      readonly capsuleRef?: EngineStateCapsuleRef | null
    },
  ): Promise<PlacementMigrationRecord> {
    throw new Error('PLACEMENT_MIGRATION_MASTER_ONLY')
  }

  async abortPlacementMigration(
    _tenantId: string,
    _migrationId: string,
    _reason: string,
  ): Promise<PlacementMigrationRecord> {
    throw new Error('PLACEMENT_MIGRATION_MASTER_ONLY')
  }
}
