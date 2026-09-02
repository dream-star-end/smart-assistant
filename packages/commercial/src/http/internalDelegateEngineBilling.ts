import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const DELEGATE_ENGINE_BILLING_ADMIT_PATH = '/internal/v3/delegate/engine-billing/admit'
export const DELEGATE_ENGINE_BILLING_SETTLE_PATH = '/internal/v3/delegate/engine-billing/settle'
export const DELEGATE_ENGINE_BILLING_ABANDON_PATH = '/internal/v3/delegate/engine-billing/abandon'

const PATHS = new Set([
  DELEGATE_ENGINE_BILLING_ADMIT_PATH,
  DELEGATE_ENGINE_BILLING_SETTLE_PATH,
  DELEGATE_ENGINE_BILLING_ABANDON_PATH,
])
const MAX_BODY_BYTES = 128 * 1024

export interface DelegateEngineBillingIdentity {
  userId: number
  containerId: number
}

export interface DelegateEngineBillingRuntime {
  handle(input: {
    path: string
    identity: DelegateEngineBillingIdentity
    body: Record<string, unknown>
  }): Promise<Record<string, unknown>>
}

export type DelegateEngineBillingHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
  path: string,
) => Promise<void>

export function isDelegateEngineBillingInternalPath(path: string): boolean {
  return PATHS.has(path)
}

export function makeDelegateEngineBillingHandler(deps: {
  identityRepo: ContainerIdentityRepo
  runtimeRef: { current: DelegateEngineBillingRuntime | null }
}): DelegateEngineBillingHandler {
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
        {
          error: {
            code: 'DELEGATE_ENGINE_BILLING_RUNTIME_UNAVAILABLE',
            message: 'runtime unavailable',
          },
        },
        requestId,
      )
      return
    }
    try {
      const body = await readBody(req, MAX_BODY_BYTES)
      const result = await runtime.handle({
        path,
        identity: { userId: identity.userId, containerId: identity.containerId },
        body,
      })
      send(res, 200, result, requestId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = statusForCode(message)
      send(
        res,
        status,
        { error: { code: message.slice(0, 100), message: 'request rejected' } },
        requestId,
      )
    }
  }
}

function statusForCode(code: string): number {
  if (code.includes('INSUFFICIENT_CREDITS')) return 402
  if (code.startsWith('DELEGATE_ENGINE_BILLING_INVALID_')) return 400
  if (code === 'DELEGATE_ENGINE_BILLING_RUNTIME_UNAVAILABLE') return 503
  return 409
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
    if (total > maxBodyBytes) throw new Error('DELEGATE_ENGINE_BILLING_INVALID_BODY_SIZE')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_BODY')
  }
  return value as Record<string, unknown>
}
