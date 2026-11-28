/**
 * OCV5-915 P3-2 — Loopback-only ToolBroker HTTP routes (`gateway-interface` L5).
 *
 * Exposes:
 *   POST /internal/v3/tool-broker/invoke        (requires single-use `octk1.*` capability token)
 *   POST /internal/v3/tool-broker/hook-evaluate (requires turn-bound `octh1.*` hook token)
 *   POST /internal/v3/tool-broker/mcp-execute   (requires turn-bound `octm1.*` MCP token)
 *   POST /internal/v3/tool-broker/spill-read    (requires turn-bound `octh1.*` or `octm1.*` token)
 *
 * Security invariants (R8 anti-loopback isolation):
 * - Strictly loopback (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`).
 * - Raw Gateway Bearer token alone is NEVER accepted; scoped capability / turn tokens are mandatory.
 * - Architecture invariants: `import type` for `node:http` + L0 `@openclaude/protocol/exec-env` only,
 *   zero `process.env`, zero `R2-scope` imports.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  TOOL_BROKER_LOCAL_PREFIX,
  type ToolCallEnvelope,
} from '@openclaude/protocol/exec-env'
import type { PreAuthRoutesIo } from './preAuth.js'
import { type HttpRoute, predicateRoute } from './routeTable.js'

export const TOOL_BROKER_CAPABILITY_HEADER = 'x-openclaude-capability-token'
export const TOOL_BROKER_HOOK_TOKEN_HEADER = 'x-openclaude-broker-hook-token'
export const TOOL_BROKER_MCP_TOKEN_HEADER = 'x-openclaude-broker-mcp-token'

const MAX_BROKER_BODY_BYTES = 2 * 1024 * 1024

export interface ToolBrokerLocalHttpRuntime {
  handleInvokeRequest(input: {
    readonly capabilityToken?: string
    readonly leaseId?: string
    readonly fencingToken?: string
    readonly brainGen?: number
    readonly sessionKey?: string
    readonly call: ToolCallEnvelope
    readonly mainModel?: string
  }): Promise<{ readonly status: number; readonly body: unknown }>
  handleHookEvaluate(
    hookToken: string,
    input: {
      readonly toolName: string
      readonly arguments?: Readonly<Record<string, unknown>>
      readonly command?: string
      readonly target?: string
      readonly mainModel?: string
      readonly callId?: string
      readonly mintCapabilityToken?: boolean
      readonly guardMode?: 'off' | 'warn' | 'deny'
      readonly engine?: string
    },
  ): Promise<{ readonly status: number; readonly body: unknown }>
  handleMcpExecute(
    mcpToken: string,
    input: {
      readonly toolName: string
      readonly arguments?: Readonly<Record<string, unknown>>
      readonly callId?: string
      readonly turnId?: string
      readonly timeoutMs?: number
      readonly mainModel?: string
    },
  ): Promise<{ readonly status: number; readonly body: unknown }>
  handleSpillRead(
    authToken: string,
    input: {
      readonly blobId: string
      readonly sha256?: string
      readonly offset?: number
      readonly limit?: number
    },
  ): Promise<{ readonly status: number; readonly body: unknown }> | { readonly status: number; readonly body: unknown }
}

function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function readHeader(req: IncomingMessage, name: string): string {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return (raw[0] ?? '').trim()
  return typeof raw === 'string' ? raw.trim() : ''
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isToolCallEnvelopeLike(value: unknown): value is ToolCallEnvelope {
  if (!isPlainObject(value)) return false
  return (
    value.schemaVersion === 1 &&
    typeof value.leaseId === 'string' &&
    typeof value.turnId === 'string' &&
    typeof value.callId === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.canonicalName === 'string' &&
    isPlainObject(value.arguments) &&
    typeof value.argsSha256 === 'string' &&
    isPlainObject(value.attestation)
  )
}

function parseJsonBody(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : null
  } catch (err) {
    void err
    return null
  }
}

interface ToolBrokerRouteCtx {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly parsed: Record<string, unknown>
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly runtime: ToolBrokerLocalHttpRuntime
}

async function handleInvokeAction({ req, res, parsed, sendJson, runtime }: ToolBrokerRouteCtx): Promise<void> {
  const capHeader = readHeader(req, TOOL_BROKER_CAPABILITY_HEADER)
  const capToken = capHeader || (typeof parsed.capabilityToken === 'string' ? parsed.capabilityToken.trim() : '')
  if (!capToken.startsWith('octk1.')) {
    sendJson(res, 401, {
      ok: false,
      errorCode: 'CAPABILITY_TOKEN_MALFORMED',
      errorMessage: 'Single-use octk1.* capability token required',
    })
    return
  }
  if (!isToolCallEnvelopeLike(parsed.call)) {
    sendJson(res, 400, {
      ok: false,
      errorCode: 'TOOL_CALL_ENVELOPE_REQUIRED',
      errorMessage: 'Body must contain a valid ToolCallEnvelope in `call`',
    })
    return
  }
  const out = await runtime.handleInvokeRequest({
    capabilityToken: capToken,
    leaseId: typeof parsed.leaseId === 'string' ? parsed.leaseId : undefined,
    fencingToken: typeof parsed.fencingToken === 'string' ? parsed.fencingToken : undefined,
    brainGen: typeof parsed.brainGen === 'number' ? parsed.brainGen : undefined,
    sessionKey: typeof parsed.sessionKey === 'string' ? parsed.sessionKey : undefined,
    call: parsed.call,
    mainModel: typeof parsed.mainModel === 'string' ? parsed.mainModel : undefined,
  })
  sendJson(res, out.status, out.body)
}

async function handleHookEvaluateAction({ req, res, parsed, sendJson, runtime }: ToolBrokerRouteCtx): Promise<void> {
  const hookToken =
    readHeader(req, TOOL_BROKER_HOOK_TOKEN_HEADER) ||
    (typeof parsed.hookToken === 'string' ? parsed.hookToken.trim() : '')
  if (!hookToken.startsWith('octh1.')) {
    sendJson(res, 401, {
      ok: false,
      decision: 'deny',
      code: 'TOOL_BROKER_TURN_TOKEN_INVALID',
      reason: 'Turn-bound octh1.* hook token required',
    })
    return
  }
  const toolName = typeof parsed.toolName === 'string' ? parsed.toolName.trim() : ''
  if (!toolName) {
    sendJson(res, 400, { ok: false, decision: 'deny', code: 'TOOL_NAME_REQUIRED', reason: 'toolName is required' })
    return
  }
  const guardModeRaw = parsed.guardMode
  const guardMode =
    guardModeRaw === 'off' || guardModeRaw === 'warn' || guardModeRaw === 'deny' ? guardModeRaw : undefined
  const engineRaw = typeof parsed.engine === 'string' ? parsed.engine.trim().toLowerCase() : ''
  const engine = engineRaw && engineRaw.length <= 32 ? engineRaw : undefined
  const out = await runtime.handleHookEvaluate(hookToken, {
    toolName,
    arguments: isPlainObject(parsed.arguments) ? parsed.arguments : undefined,
    command: typeof parsed.command === 'string' ? parsed.command : undefined,
    target: typeof parsed.target === 'string' ? parsed.target : undefined,
    mainModel: typeof parsed.mainModel === 'string' ? parsed.mainModel : undefined,
    callId: typeof parsed.callId === 'string' ? parsed.callId : undefined,
    mintCapabilityToken: parsed.mintCapabilityToken === true,
    guardMode,
    ...(engine ? { engine } : {}),
  })
  sendJson(res, out.status, out.body)
}

async function handleMcpExecuteAction({ req, res, parsed, sendJson, runtime }: ToolBrokerRouteCtx): Promise<void> {
  const mcpToken =
    readHeader(req, TOOL_BROKER_MCP_TOKEN_HEADER) ||
    (typeof parsed.mcpToken === 'string' ? parsed.mcpToken.trim() : '')
  if (!mcpToken.startsWith('octm1.')) {
    sendJson(res, 401, {
      ok: false,
      errorCode: 'TOOL_BROKER_TURN_TOKEN_INVALID',
      errorMessage: 'Turn-bound octm1.* MCP token required',
    })
    return
  }
  const toolName = typeof parsed.toolName === 'string' ? parsed.toolName.trim() : ''
  if (!toolName) {
    sendJson(res, 400, { ok: false, errorCode: 'TOOL_NAME_REQUIRED', errorMessage: 'toolName is required' })
    return
  }
  const out = await runtime.handleMcpExecute(mcpToken, {
    toolName,
    arguments: isPlainObject(parsed.arguments) ? parsed.arguments : undefined,
    callId: typeof parsed.callId === 'string' ? parsed.callId : undefined,
    turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
    timeoutMs: typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : undefined,
    mainModel: typeof parsed.mainModel === 'string' ? parsed.mainModel : undefined,
  })
  sendJson(res, out.status, out.body)
}

async function handleSpillReadAction({ req, res, parsed, sendJson, runtime }: ToolBrokerRouteCtx): Promise<void> {
  const authToken =
    readHeader(req, TOOL_BROKER_MCP_TOKEN_HEADER) ||
    readHeader(req, TOOL_BROKER_HOOK_TOKEN_HEADER) ||
    (typeof parsed.token === 'string' ? parsed.token.trim() : '')
  if (!authToken.startsWith('octm1.') && !authToken.startsWith('octh1.')) {
    sendJson(res, 401, {
      ok: false,
      errorCode: 'TOOL_BROKER_TURN_TOKEN_INVALID',
      errorMessage: 'Turn-bound octm1.* or octh1.* token required on /spill-read',
    })
    return
  }
  const blobId = typeof parsed.blobId === 'string' ? parsed.blobId.trim() : ''
  if (!blobId) {
    sendJson(res, 400, { ok: false, errorCode: 'BLOB_ID_REQUIRED', errorMessage: 'blobId is required' })
    return
  }
  const out = await runtime.handleSpillRead(authToken, {
    blobId,
    sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : undefined,
    offset: typeof parsed.offset === 'number' ? parsed.offset : undefined,
    limit: typeof parsed.limit === 'number' ? parsed.limit : undefined,
  })
  sendJson(res, out.status, out.body)
}

export async function handleToolBrokerLocalHttp(deps: {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly url: URL
  readonly readBody: (req: IncomingMessage, maxBytes?: number) => Promise<string>
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly runtime: ToolBrokerLocalHttpRuntime
}): Promise<void> {
  const { req, res, url, readBody, sendJson, runtime } = deps
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    sendJson(res, 403, {
      ok: false,
      errorCode: 'TOOL_BROKER_LOOPBACK_ONLY',
      errorMessage: 'ToolBroker local endpoint is restricted to loopback',
    })
    return
  }
  const prefixSlash = `${TOOL_BROKER_LOCAL_PREFIX}/`
  if (!url.pathname.startsWith(prefixSlash)) {
    sendJson(res, 404, { ok: false, errorCode: 'TOOL_BROKER_ROUTE_NOT_FOUND', errorMessage: 'Unknown ToolBroker route' })
    return
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { ok: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: 'POST required' })
    return
  }
  let bodyRaw: string
  try {
    bodyRaw = await readBody(req, MAX_BROKER_BODY_BYTES)
  } catch (err) {
    sendJson(res, 400, {
      ok: false,
      errorCode: 'INVALID_BODY',
      errorMessage: err instanceof Error ? err.message : 'Failed to read request body',
    })
    return
  }
  const parsed = parseJsonBody(bodyRaw)
  if (!parsed) {
    sendJson(res, 400, { ok: false, errorCode: 'INVALID_JSON', errorMessage: 'Request body must be a JSON object' })
    return
  }
  const action = url.pathname.slice(prefixSlash.length)
  const ctx: ToolBrokerRouteCtx = { req, res, parsed, sendJson, runtime }
  if (action === 'invoke') return await handleInvokeAction(ctx)
  if (action === 'hook-evaluate') return await handleHookEvaluateAction(ctx)
  if (action === 'mcp-execute') return await handleMcpExecuteAction(ctx)
  if (action === 'spill-read') return await handleSpillReadAction(ctx)
  sendJson(res, 404, {
    ok: false,
    errorCode: 'TOOL_BROKER_ROUTE_NOT_FOUND',
    errorMessage: `Unknown ToolBroker endpoint: ${action}`,
  })
}

export const TOOL_BROKER_LOCAL_ROUTES: readonly HttpRoute<PreAuthRoutesIo>[] = [
  predicateRoute(
    'TOOL_BROKER_LOCAL_PREFIX',
    (_req, url) => url.pathname.startsWith(`${TOOL_BROKER_LOCAL_PREFIX}/`),
    (io, req, res, url) => {
      if (!io.handleToolBrokerLocal) {
        io.sendJson(res, 503, { ok: false, errorCode: 'TOOL_BROKER_UNAVAILABLE' })
        return true
      }
      void io.handleToolBrokerLocal(req, res, url).catch((err) => io.sendInternalError(res, err))
      return true
    },
  ),
]
