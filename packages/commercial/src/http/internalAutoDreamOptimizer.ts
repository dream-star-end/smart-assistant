import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const AUTO_DREAM_OPTIMIZER_ADMIT_PATH = '/internal/v3/auto-dream/admit'
export const AUTO_DREAM_OPTIMIZER_SETTLE_PATH = '/internal/v3/auto-dream/settle'
export const AUTO_DREAM_OPTIMIZER_ABANDON_PATH = '/internal/v3/auto-dream/abandon'
export const AUTO_DREAM_OPTIMIZER_FINDINGS_PATH = '/internal/v3/auto-dream/findings'
export const AUTO_DREAM_OPTIMIZER_ACTION_PATH = '/internal/v3/auto-dream/action'

const PATHS = new Set([
  AUTO_DREAM_OPTIMIZER_ADMIT_PATH,
  AUTO_DREAM_OPTIMIZER_SETTLE_PATH,
  AUTO_DREAM_OPTIMIZER_ABANDON_PATH,
  AUTO_DREAM_OPTIMIZER_FINDINGS_PATH,
  AUTO_DREAM_OPTIMIZER_ACTION_PATH,
])
const MAX_BODY_BYTES = 128 * 1024
const LEGACY_ADMIT_MAX_BODY_BYTES = 1024 * 1024

export interface AutoDreamOptimizerIdentity {
  userId: number
  containerId: number
}

export interface AutoDreamOptimizerRuntime {
  handle(input: {
    path: string
    identity: AutoDreamOptimizerIdentity
    body: Record<string, unknown>
  }): Promise<Record<string, unknown>>
}

export type AutoDreamCodexRouteDecision =
  | {
      kind: 'api_relay'
      token: string
      baseUrl: string
      modelProvider: string
      providerName?: string | null
      wireApi?: string | null
      preferredAuthMethod?: string | null
      disableResponseStorage?: boolean | null
    }
  | { kind: 'official_oauth' }
  | { kind: 'unavailable' }

export function projectAutoDreamCodexRoute(route: AutoDreamCodexRouteDecision | null): {
  token: string | null
  routeFrame: Record<string, unknown>
} | null {
  if (!route || route.kind === 'unavailable') return null
  if (route.kind === 'official_oauth') {
    return {
      token: null,
      routeFrame: {
        modelProvider: 'oc_chatgpt_official',
        baseUrl: 'http://127.0.0.1:18789/internal/v3/codex-relay/backend-api/codex',
        providerName: 'OpenAI (OpenClaude relay)',
        wireApi: 'responses',
        preferredAuthMethod: 'chatgpt',
        disableResponseStorage: true,
        requiresOpenaiAuth: true,
      },
    }
  }
  return {
    token: route.token,
    routeFrame: {
      baseUrl: route.baseUrl,
      modelProvider: route.modelProvider,
      providerName: route.providerName ?? null,
      wireApi: route.wireApi ?? 'responses',
      preferredAuthMethod: route.preferredAuthMethod ?? 'apikey',
      disableResponseStorage: route.disableResponseStorage ?? true,
    },
  }
}

export type AutoDreamOptimizerHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
  path: string,
) => Promise<void>

export function isAutoDreamOptimizerInternalPath(path: string): boolean {
  return PATHS.has(path)
}

export function makeAutoDreamOptimizerHandler(deps: {
  identityRepo: ContainerIdentityRepo
  runtimeRef: { current: AutoDreamOptimizerRuntime | null }
}): AutoDreamOptimizerHandler {
  return async (req, res, ctx, path) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    if (req.method !== 'POST') {
      send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } }, requestId)
      return
    }
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        send(
          res,
          401,
          { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } },
          requestId,
        )
        return
      }
      throw err
    }
    const runtime = deps.runtimeRef.current
    if (!runtime) {
      send(
        res,
        503,
        { error: { code: 'AUTO_DREAM_RUNTIME_UNAVAILABLE', message: 'runtime unavailable' } },
        requestId,
      )
      return
    }
    try {
      const body = await readBody(
        req,
        path === AUTO_DREAM_OPTIMIZER_ADMIT_PATH ? LEGACY_ADMIT_MAX_BODY_BYTES : MAX_BODY_BYTES,
      )
      const result = await runtime.handle({
        path,
        identity: { userId: identity.userId, containerId: identity.containerId },
        body,
      })
      send(res, 200, result, requestId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message.startsWith('AUTO_DREAM_INVALID_') ? 400 : 409
      send(
        res,
        status,
        { error: { code: message.slice(0, 100), message: 'request rejected' } },
        requestId,
      )
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify({ requestId, ...(body as object) }))
}

async function readBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    total += chunk.length
    if (total > maxBodyBytes) throw new Error('AUTO_DREAM_INVALID_BODY_SIZE')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AUTO_DREAM_INVALID_BODY')
  }
  return value as Record<string, unknown>
}
