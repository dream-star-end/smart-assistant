/**
 * Container gateway → master remote-pool lane client for delegate & remote swarm child turns (OCV5-835).
 *
 * Security & reliability invariants:
 *   - Strict paired Master internal configuration ONLY (`OPENCLAUDE_V3_MASTER_BASE_URL` +
 *     `OPENCLAUDE_V3_CONTAINER_TOKEN`), never falling back to third-party provider env vars.
 *   - Forwards parent billing attribution (`parentTurnKey`, `parentSessionId`, `delegateAgentId`)
 *     for Master verification & signed embedding into `ModelAuthorityPayload`.
 *   - Scopes `/release` to the exact `(dispatchId, ownerId, leaseEpoch, operationId, generation)`
 *     and checks HTTP 200 + `released === true` honestly (does not cache failed/unknown releases).
 */
import {
  DELEGATE_REMOTE_LANE_ENSURE_PATH,
  DELEGATE_REMOTE_LANE_RELEASE_PATH,
  type ModelAuthorityBundle,
  type RemoteExecutionBackend,
  isRemoteDriverExecutionBackend,
} from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'
import type { CcbExecutionDescriptor, TurnModelAuthority } from './subprocessSpawnConfig.js'

const ENSURE_TIMEOUT_MS = 25_000
const RELEASE_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024

export interface DelegateRemoteLaneLog {
  warn: (msg: string, fields?: Record<string, unknown>) => void
  debug?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface DelegateRemoteLaneReleaseResult {
  readonly released: boolean
  readonly state: string
}

export interface DelegateRemoteLaneLease {
  readonly canonicalModel: string
  readonly engine: 'ccb' | 'codex' | 'antigravity'
  readonly executionBackend: RemoteExecutionBackend
  readonly modelAuthority: ModelAuthorityBundle
  readonly turnModelAuthority: TurnModelAuthority
  readonly turnKey: string
  readonly billingRequestId: string
  readonly dispatchId: string
  readonly ownerId: string
  readonly leaseEpoch: number
  readonly operationId: string
  readonly generation?: string
  /** Settles the owned dispatch and releases the exact (operationId, generation) lane on Master. */
  release(opts?: {
    releaseLane?: boolean
    outcome?: 'completed' | 'interrupted' | 'executed_error'
  }): Promise<DelegateRemoteLaneReleaseResult>
}

export type DelegateRemoteLaneAcquire =
  | { ok: true; lease: DelegateRemoteLaneLease }
  | { ok: false; httpStatus: number; code: string; reason: string }

interface FetchResult {
  statusCode: number
  text: string
}

/**
 * Strictly requires paired Master internal endpoint + container token.
 * Mirrors `delegateGrokRoute.ts:182-188` — never falls back to third-party API URLs or keys.
 */
export function resolveMasterInternalEndpoint(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string
  bearer: string
} | null {
  const baseUrl = (env.OPENCLAUDE_V3_MASTER_BASE_URL ?? '').trim().replace(/\/+$/, '')
  const bearer = (env.OPENCLAUDE_V3_CONTAINER_TOKEN ?? '').trim()
  if (!baseUrl || !bearer) return null
  return { baseUrl, bearer }
}

async function postJson(
  fetcher: typeof undiciRequest,
  url: string,
  bearer: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<FetchResult> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  })
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += bytes.length
    if (total > MAX_RESPONSE_BYTES) {
      throw new Error('delegate remote lane response too large')
    }
    chunks.push(bytes)
  }
  return { statusCode: response.statusCode, text: Buffer.concat(chunks, total).toString('utf8') }
}

function parseErrorBody(text: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }
    const code =
      typeof parsed.error?.code === 'string' && parsed.error.code ? parsed.error.code : 'REMOTE_LANE_ERROR'
    const message =
      typeof parsed.error?.message === 'string' && parsed.error.message
        ? parsed.error.message
        : text.slice(0, 200)
    return { code, message }
  } catch {
    return { code: 'REMOTE_LANE_ERROR', message: text.slice(0, 200) }
  }
}

export async function acquireDelegateRemoteLane(args: {
  sessionKey: string
  model: string
  agentId?: string
  delegateAgentId?: string
  parentTurnKey?: string
  parentSessionId?: string
  turnKey?: string
  log?: DelegateRemoteLaneLog
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
}): Promise<DelegateRemoteLaneAcquire> {
  const ep = resolveMasterInternalEndpoint(args.env)
  if (!ep) {
    return {
      ok: false,
      httpStatus: 503,
      code: 'REMOTE_LANE_MASTER_UNCONFIGURED',
      reason: 'master internal endpoint or container token missing',
    }
  }
  const fetcher = args.fetcher ?? undiciRequest
  let res: FetchResult
  try {
    res = await postJson(
      fetcher,
      `${ep.baseUrl}${DELEGATE_REMOTE_LANE_ENSURE_PATH}`,
      ep.bearer,
      {
        sessionKey: args.sessionKey,
        model: args.model,
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.delegateAgentId ? { delegateAgentId: args.delegateAgentId } : {}),
        ...(args.parentTurnKey ? { parentTurnKey: args.parentTurnKey } : {}),
        ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
        ...(args.turnKey ? { turnKey: args.turnKey } : {}),
      },
      ENSURE_TIMEOUT_MS,
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    args.log?.warn('delegate_remote_lane_ensure_transport_failed', {
      sessionKey: args.sessionKey,
      model: args.model,
      reason,
    })
    return { ok: false, httpStatus: 503, code: 'REMOTE_LANE_TRANSPORT_ERROR', reason }
  }

  if (res.statusCode !== 200) {
    const { code, message } = parseErrorBody(res.text)
    args.log?.warn('delegate_remote_lane_ensure_rejected', {
      sessionKey: args.sessionKey,
      model: args.model,
      statusCode: res.statusCode,
      code,
      message,
    })
    return { ok: false, httpStatus: res.statusCode, code, reason: message }
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(res.text) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      httpStatus: 502,
      code: 'REMOTE_LANE_INVALID_JSON',
      reason: 'invalid JSON from master',
    }
  }

  const canonicalModel = typeof data.canonicalModel === 'string' ? data.canonicalModel : ''
  const engine = data.engine
  const executionBackend = data.executionBackend as RemoteExecutionBackend | undefined
  const modelAuthority = data.modelAuthority as ModelAuthorityBundle | undefined
  const turnKey = typeof data.turnKey === 'string' ? data.turnKey : ''
  const billingRequestId = typeof data.billingRequestId === 'string' ? data.billingRequestId : ''
  const dispatchId = typeof data.dispatchId === 'string' ? data.dispatchId : ''
  const ownerId = typeof data.ownerId === 'string' ? data.ownerId : ''
  const leaseEpoch = typeof data.leaseEpoch === 'number' ? data.leaseEpoch : 1

  if (
    !canonicalModel ||
    (engine !== 'ccb' && engine !== 'codex' && engine !== 'antigravity') ||
    !executionBackend ||
    !isRemoteDriverExecutionBackend(executionBackend) ||
    !modelAuthority ||
    !/^[a-f0-9]{64}$/.test(turnKey) ||
    !billingRequestId
  ) {
    return {
      ok: false,
      httpStatus: 502,
      code: 'REMOTE_LANE_MALFORMED_RESPONSE',
      reason: 'incomplete remote lane bundle from master',
    }
  }

  const operationId = executionBackend.operationId
  const generation = executionBackend.generation
  let releasedResult: DelegateRemoteLaneReleaseResult | null = null
  let inFlightRelease: Promise<DelegateRemoteLaneReleaseResult> | null = null

  const release = (opts?: {
    releaseLane?: boolean
    outcome?: 'completed' | 'interrupted' | 'executed_error'
  }): Promise<DelegateRemoteLaneReleaseResult> => {
    if (releasedResult?.released) return Promise.resolve(releasedResult)
    if (inFlightRelease) return inFlightRelease
    const task = postJson(
      fetcher,
      `${ep.baseUrl}${DELEGATE_REMOTE_LANE_RELEASE_PATH}`,
      ep.bearer,
      {
        sessionKey: args.sessionKey,
        dispatchId,
        ownerId,
        leaseEpoch,
        operationId,
        generation,
        outcome: opts?.outcome ?? 'completed',
        releaseLane: opts?.releaseLane !== false,
      },
      RELEASE_TIMEOUT_MS,
    )
      .then((reply): DelegateRemoteLaneReleaseResult => {
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(reply.text) as Record<string, unknown>
        } catch {
          /* ignore */
        }
        const state = typeof parsed.state === 'string' ? parsed.state : `http_${reply.statusCode}`
        const ok = reply.statusCode === 200 && parsed.released === true
        if (!ok) {
          args.log?.warn('delegate_remote_lane_release_not_confirmed', {
            sessionKey: args.sessionKey,
            operationId,
            statusCode: reply.statusCode,
            state,
          })
          return { released: false, state }
        }
        const out = { released: true, state }
        releasedResult = out
        return out
      })
      .catch((err): DelegateRemoteLaneReleaseResult => {
        args.log?.warn('delegate_remote_lane_release_failed', {
          sessionKey: args.sessionKey,
          operationId,
          err: err instanceof Error ? err.message : String(err),
        })
        return { released: false, state: 'transport_error' }
      })
      .finally(() => {
        if (inFlightRelease === task) inFlightRelease = null
      })
    inFlightRelease = task
    return task
  }

  const rawDesc =
    data.executionDescriptor && typeof data.executionDescriptor === 'object'
      ? (data.executionDescriptor as Record<string, unknown>)
      : {}
  const ccbDescriptor: CcbExecutionDescriptor = {
    canonicalModel,
    contextWindow: typeof rawDesc.contextWindow === 'number' ? rawDesc.contextWindow : null,
    capabilityZero: Boolean(rawDesc.capabilityZero),
    supportsThinking: rawDesc.supportsThinking !== false,
    supportsVision: Boolean(rawDesc.supportsVision),
    supportedEfforts: Array.isArray(rawDesc.supportedEfforts)
      ? rawDesc.supportedEfforts.filter((v): v is string => typeof v === 'string')
      : [],
    ...(rawDesc.contextOwner === 'box-native-v1' ? { contextOwner: 'box-native-v1' } : {}),
    executionBackend,
  }

  const turnModelAuthority: TurnModelAuthority = {
    authorityEnvelope: modelAuthority.authority,
    leaseEnvelope: modelAuthority.lease,
    executionDescriptor: ccbDescriptor,
  }

  return {
    ok: true,
    lease: {
      canonicalModel,
      engine,
      executionBackend,
      modelAuthority,
      turnModelAuthority,
      turnKey,
      billingRequestId,
      dispatchId,
      ownerId,
      leaseEpoch,
      operationId,
      generation,
      release,
    },
  }
}

export async function releaseDelegateRemoteLaneSession(args: {
  sessionKey: string
  operationId: string
  generation?: string
  log?: DelegateRemoteLaneLog
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
}): Promise<DelegateRemoteLaneReleaseResult> {
  const ep = resolveMasterInternalEndpoint(args.env)
  if (!ep) return { released: false, state: 'master_unconfigured' }
  const fetcher = args.fetcher ?? undiciRequest
  try {
    const reply = await postJson(
      fetcher,
      `${ep.baseUrl}${DELEGATE_REMOTE_LANE_RELEASE_PATH}`,
      ep.bearer,
      {
        sessionKey: args.sessionKey,
        operationId: args.operationId,
        ...(args.generation ? { generation: args.generation } : {}),
        releaseLane: true,
      },
      RELEASE_TIMEOUT_MS,
    )
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(reply.text) as Record<string, unknown>
    } catch {
      /* ignore */
    }
    const state = typeof parsed.state === 'string' ? parsed.state : `http_${reply.statusCode}`
    const released = reply.statusCode === 200 && parsed.released === true
    if (!released) {
      args.log?.warn('delegate_remote_lane_session_release_not_confirmed', {
        sessionKey: args.sessionKey,
        operationId: args.operationId,
        statusCode: reply.statusCode,
        state,
      })
    }
    return { released, state }
  } catch (err) {
    args.log?.warn('delegate_remote_lane_session_release_failed', {
      sessionKey: args.sessionKey,
      operationId: args.operationId,
      err: err instanceof Error ? err.message : String(err),
    })
    return { released: false, state: 'transport_error' }
  }
}
