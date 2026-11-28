/**
 * OCV5-915 P3-2 — Loopback ToolBroker MCP execution client (`mcp-memory` L3).
 *
 * Routes registered local CLI MCP tools (`oc_bash`, `oc_grep`, `oc_glob` — plus direct
 * `oc_read`/`oc_find`/`oc_tree` helpers) through `/internal/v3/tool-broker/mcp-execute`
 * when turn-scoped broker config is injected, preserving:
 * - B03: Strict `unconfigured | configured | misconfigured` resolution — ONLY genuinely
 *        unconfigured standalone CLIs fall back to local execution; any partial/corrupt/
 *        unreadable broker config fails closed with zero local execution.
 * - B09: Structured `oc_bash` job outcomes (`status=running job_id=...`, `killed`,
 *        non-zero exit `isError: true`, `cwd`, `lifecycle_class`) and `>256 KiB` spill.
 * - B14: Stable invocation identity extracted from MCP `_meta` / JSON-RPC `requestId`
 *        (NEVER hashing arguments) forwarded to Gateway WAL `idempotencyKey`.
 *
 * Architecture invariants:
 * - Zero `process.env` (takes `env` parameter explicitly)
 * - Zero `node:http` / `fetch` (reuses `postJsonToGateway` from `./gatewayClient.js`)
 * - Zero `syncIo` (`node:fs/promises` only), zero `emptyCatch`, zero `typeEscape`.
 */
import { readFile } from 'node:fs/promises'
import { isLoopbackBrokerUrl, scrubToolBrokerEnv } from '@openclaude/protocol/exec-env'
import { describeDelegateTransportError, postJsonToGateway } from './gatewayClient.js'

export { scrubToolBrokerEnv }

const TOOL_BROKER_LOCAL_PREFIX = '/internal/v3/tool-broker'

export const MCP_BROKER_ROUTED_TOOLS = [
  'oc_bash',
  'oc_read',
  'oc_grep',
  'oc_glob',
  'oc_find',
  'oc_tree',
] as const

export type McpBrokerRoutedTool = (typeof MCP_BROKER_ROUTED_TOOLS)[number]

const MCP_BROKER_TOOL_SET: ReadonlySet<string> = new Set(MCP_BROKER_ROUTED_TOOLS)
const MCP_TOKEN_HEADER = 'x-openclaude-broker-mcp-token'
const DEFAULT_BROKER_TIMEOUT_MS = 120_000
const CALL_ID_META_KEYS = [
  'claudecode/toolUseId',
  'openclaude/callId',
  'callId',
  'toolUseId',
  'toolCallId',
  'tool_use_id',
] as const
const TURN_ID_META_KEYS = ['openclaude/turnId', 'turnId', 'turn_id'] as const

export interface McpToolTextResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface McpToolBrokerConfig {
  readonly brokerUrl: string
  readonly mcpToken: string
  readonly leaseId?: string
  readonly turnId?: string
}

export type McpToolBrokerConfigResolution =
  | { readonly state: 'unconfigured' }
  | { readonly state: 'configured'; readonly config: McpToolBrokerConfig }
  | { readonly state: 'misconfigured'; readonly code: string; readonly reason: string }

export interface McpToolCallIdentity {
  readonly callId?: string
  readonly turnId?: string
}

export interface McpSpilledBlobRef {
  readonly type: 'blob_ref'
  readonly blobId: string
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: number
}

export function isMcpBrokerRoutedTool(name: string): name is McpBrokerRoutedTool {
  return MCP_BROKER_TOOL_SET.has(name)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isSpilledBlobRef(value: unknown): value is McpSpilledBlobRef {
  return (
    isPlainRecord(value) &&
    value.type === 'blob_ref' &&
    typeof value.blobId === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.bytes === 'number'
  )
}

function pickFirstNonEmptyString(
  record: Readonly<Record<string, unknown>> | null,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const val = record[key]
    if (typeof val === 'string' && val.trim().length > 0) return val.trim()
  }
  return undefined
}

/**
 * B14: Extract stable invocation identity from trusted MCP request metadata / JSON-RPC
 * `requestId`. NEVER hashes arguments — two distinct calls with identical args get
 * distinct `callId`s, while a dropped-response retry with the same `_meta` or `requestId`
 * carries the exact same `callId` into Gateway WAL.
 */
export function extractMcpToolCallIdentity(
  reqParams: unknown,
  extra?: { readonly requestId?: string | number } | null,
  env?: Readonly<Record<string, string | undefined>>,
): McpToolCallIdentity {
  const params = isPlainRecord(reqParams) ? reqParams : null
  const meta = params && isPlainRecord(params._meta) ? params._meta : null
  let callId = pickFirstNonEmptyString(meta, CALL_ID_META_KEYS)
  if (!callId && extra && (typeof extra.requestId === 'string' || typeof extra.requestId === 'number')) {
    const rawId = String(extra.requestId).trim()
    if (rawId.length > 0) callId = `mcp_rpc_${rawId}`
  }
  const envTurnId = (env?.OPENCLAUDE_TOOL_BROKER_TURN_ID ?? '').trim()
  const turnId = pickFirstNonEmptyString(meta, TURN_ID_META_KEYS) ?? (envTurnId || undefined)
  return {
    ...(callId ? { callId } : {}),
    ...(turnId ? { turnId } : {}),
  }
}

async function readMcpTokenSource(
  tokenFile: string,
  inlineToken: string,
): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly code: string; readonly reason: string }> {
  if (!tokenFile) return { ok: true, token: inlineToken }
  try {
    return { ok: true, token: (await readFile(tokenFile, 'utf8')).trim() }
  } catch (err) {
    return {
      ok: false,
      code: 'TOOL_BROKER_TOKEN_FILE_UNREADABLE',
      reason: `Failed to read ToolBroker MCP token file: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function readTrimmedEnv(env: Readonly<Record<string, string | undefined>>, key: string): string {
  return (env[key] ?? '').trim()
}

/**
 * B03: Discriminated resolution separating genuinely unconfigured standalone CLIs from
 * configured-but-broken broker environments (which MUST fail closed with zero local exec).
 */
export async function resolveMcpToolBrokerConfigState(
  env: Readonly<Record<string, string | undefined>>,
): Promise<McpToolBrokerConfigResolution> {
  const brokerUrlRaw = readTrimmedEnv(env, 'OPENCLAUDE_TOOL_BROKER_URL')
  const tokenFile = readTrimmedEnv(env, 'OPENCLAUDE_TOOL_BROKER_MCP_TOKEN_FILE')
  const inlineToken = readTrimmedEnv(env, 'OPENCLAUDE_TOOL_BROKER_MCP_TOKEN')
  const leaseId = readTrimmedEnv(env, 'OPENCLAUDE_TOOL_BROKER_LEASE_ID') || undefined
  const turnId = readTrimmedEnv(env, 'OPENCLAUDE_TOOL_BROKER_TURN_ID') || undefined
  const requiredFlag = readTrimmedEnv(env, 'OPENCLAUDE_TOOL_BROKER_REQUIRED')

  const hasSignal =
    [brokerUrlRaw, tokenFile, inlineToken, leaseId ?? '', turnId ?? ''].some(Boolean) ||
    requiredFlag === '1' ||
    requiredFlag === 'true'
  if (!hasSignal) return { state: 'unconfigured' }
  if (!brokerUrlRaw) {
    return {
      state: 'misconfigured',
      code: 'TOOL_BROKER_URL_MISSING',
      reason: 'ToolBroker configuration present but OPENCLAUDE_TOOL_BROKER_URL is missing',
    }
  }
  if (!isLoopbackBrokerUrl(brokerUrlRaw)) {
    return {
      state: 'misconfigured',
      code: 'TOOL_BROKER_URL_INVALID',
      reason: 'OPENCLAUDE_TOOL_BROKER_URL must be a loopback http:// URL',
    }
  }
  const tokenRead = await readMcpTokenSource(tokenFile, inlineToken)
  if (!tokenRead.ok) {
    return { state: 'misconfigured', code: tokenRead.code, reason: tokenRead.reason }
  }
  if (!tokenRead.token.startsWith('octm1.')) {
    return {
      state: 'misconfigured',
      code: 'TOOL_BROKER_TOKEN_INVALID',
      reason: 'ToolBroker MCP credential is missing or does not start with octm1.',
    }
  }
  return {
    state: 'configured',
    config: {
      brokerUrl: brokerUrlRaw.replace(/\/+$/, ''),
      mcpToken: tokenRead.token,
      ...(leaseId ? { leaseId } : {}),
      ...(turnId ? { turnId } : {}),
    },
  }
}

export async function resolveMcpToolBrokerConfig(
  env: Readonly<Record<string, string | undefined>>,
): Promise<McpToolBrokerConfig | null> {
  const res = await resolveMcpToolBrokerConfigState(env)
  return res.state === 'configured' ? res.config : null
}

function formatMcpBrokerErrorResult(
  toolName: string,
  result: Record<string, unknown>,
  status: string,
): McpToolTextResult {
  const code = typeof result.errorCode === 'string' ? result.errorCode : status.toUpperCase()
  const msg = typeof result.errorMessage === 'string' ? result.errorMessage : `${toolName} failed (${status})`
  const detachedCard = isPlainRecord(result.detachedCard) ? result.detachedCard : null
  const suffix =
    detachedCard && typeof detachedCard.approvalId === 'string'
      ? `\napproval_id=${detachedCard.approvalId}`
      : ''
  return { content: [{ type: 'text', text: `${toolName}: [${code}] ${msg}${suffix}` }], isError: true }
}

function formatSpilledBlobPayload(output: McpSpilledBlobRef, previewRaw: unknown): McpToolTextResult {
  const preview = typeof previewRaw === 'string' ? previewRaw : ''
  const header = `[tool-broker:spilled blob_id=${output.blobId} bytes=${output.bytes} sha256=${output.sha256} mime=${output.mimeType}]`
  const blobJson = JSON.stringify(output)
  const body = preview ? `${header}\n${blobJson}\n--- preview ---\n${preview}` : `${header}\n${blobJson}`
  return { content: [{ type: 'text', text: body }] }
}

export function formatMcpBrokerExecutePayload(
  toolName: string,
  payload: unknown,
): McpToolTextResult {
  if (!isPlainRecord(payload)) {
    return { content: [{ type: 'text', text: `${toolName}: malformed ToolBroker response` }], isError: true }
  }
  const result = isPlainRecord(payload.result) ? payload.result : null
  if (!result) {
    const code = typeof payload.errorCode === 'string' ? payload.errorCode : 'TOOL_BROKER_ERROR'
    const msg = typeof payload.errorMessage === 'string' ? payload.errorMessage : 'ToolBroker rejected call'
    return { content: [{ type: 'text', text: `${toolName}: [${code}] ${msg}` }], isError: true }
  }
  const status = typeof result.status === 'string' ? result.status : 'error'
  if (status !== 'ok') return formatMcpBrokerErrorResult(toolName, result, status)

  const output = result.output
  if (isSpilledBlobRef(output)) return formatSpilledBlobPayload(output, payload.preview)
  if (isPlainRecord(output) && typeof output.text === 'string') {
    return output.isError === true
      ? { content: [{ type: 'text', text: output.text }], isError: true }
      : { content: [{ type: 'text', text: output.text }] }
  }
  if (typeof output === 'string') return { content: [{ type: 'text', text: output }] }
  return { content: [{ type: 'text', text: output === undefined ? '' : JSON.stringify(output) }] }
}

export async function executeViaMcpToolBroker(input: {
  readonly toolName: string
  readonly args: unknown
  readonly env: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly callId?: string
  readonly turnId?: string
}): Promise<McpToolTextResult | null> {
  if (!isMcpBrokerRoutedTool(input.toolName)) return null
  const resolution = await resolveMcpToolBrokerConfigState(input.env)
  if (resolution.state === 'unconfigured') return null
  if (resolution.state === 'misconfigured') {
    return {
      content: [
        {
          type: 'text',
          text: `${input.toolName}: [${resolution.code}] ${resolution.reason}`,
        },
      ],
      isError: true,
    }
  }
  const cfg = resolution.config

  const normalizedArgs = isPlainRecord(input.args) ? input.args : {}
  const clientWaitMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(50, Math.min(600_000, Math.floor(input.timeoutMs)))
      : undefined
  const httpTimeoutMs =
    clientWaitMs !== undefined ? Math.max(5_000, Math.min(660_000, clientWaitMs + 60_000)) : DEFAULT_BROKER_TIMEOUT_MS
  // B09: Keep outer broker hard-kill timeout strictly above oc_bash soft-wait window so
  // kill_on_timeout=false returns status=running cleanly instead of abort-killing the job.
  const brokerDeadlineMs =
    input.toolName === 'oc_bash' && clientWaitMs !== undefined
      ? Math.min(660_000, clientWaitMs + 30_000)
      : clientWaitMs
  const url = `${cfg.brokerUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`
  const resolvedTurnId = input.turnId ?? cfg.turnId
  const body = JSON.stringify({
    toolName: input.toolName,
    arguments: normalizedArgs,
    ...(input.callId ? { callId: input.callId } : {}),
    ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
    ...(brokerDeadlineMs !== undefined ? { timeoutMs: brokerDeadlineMs } : {}),
  })

  try {
    const res = await postJsonToGateway(url, {
      headers: {
        'Content-Type': 'application/json',
        [MCP_TOKEN_HEADER]: cfg.mcpToken,
      },
      body,
      timeoutMs: httpTimeoutMs,
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(res.body)
    } catch (err) {
      void err
      return {
        content: [
          {
            type: 'text',
            text: `${input.toolName}: ToolBroker returned non-JSON HTTP ${res.statusCode}`,
          },
        ],
        isError: true,
      }
    }
    return formatMcpBrokerExecutePayload(input.toolName, parsed)
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `${input.toolName}: ToolBroker transport failed: ${describeDelegateTransportError(err)}`,
        },
      ],
      isError: true,
    }
  }
}

export async function readSpilledBlobViaMcpToolBroker(input: {
  readonly blobId: string
  readonly sha256?: string
  readonly offset?: number
  readonly limit?: number
  readonly env: Readonly<Record<string, string | undefined>>
}): Promise<{ readonly ok: boolean; readonly data?: Record<string, unknown>; readonly error?: string; readonly errorCode?: string }> {
  const resolution = await resolveMcpToolBrokerConfigState(input.env)
  if (resolution.state === 'unconfigured') return { ok: false, error: 'ToolBroker not configured' }
  if (resolution.state === 'misconfigured') {
    return { ok: false, errorCode: resolution.code, error: resolution.reason }
  }
  const cfg = resolution.config
  const url = `${cfg.brokerUrl}${TOOL_BROKER_LOCAL_PREFIX}/spill-read`
  try {
    const res = await postJsonToGateway(url, {
      headers: {
        'Content-Type': 'application/json',
        [MCP_TOKEN_HEADER]: cfg.mcpToken,
      },
      body: JSON.stringify({
        blobId: input.blobId,
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
      timeoutMs: 30_000,
    })
    const parsed: unknown = JSON.parse(res.body)
    if (res.statusCode === 200 && isPlainRecord(parsed) && parsed.ok === true) {
      return { ok: true, data: parsed }
    }
    const errCode = isPlainRecord(parsed) && typeof parsed.errorCode === 'string' ? parsed.errorCode : undefined
    const errMsg =
      isPlainRecord(parsed) && typeof parsed.errorMessage === 'string'
        ? parsed.errorMessage
        : `HTTP ${res.statusCode}`
    return { ok: false, ...(errCode ? { errorCode: errCode } : {}), error: errMsg }
  } catch (err) {
    return { ok: false, error: describeDelegateTransportError(err) }
  }
}
