/**
 * Stable consult retry identity. MCP JSON-RPC request ids are per-call
 * transport numbers and MUST NOT be used: CCB retries of the same tool_use
 * mint a new JSON-RPC id while keeping `_meta['claudecode/toolUseId']`.
 */
export const CCB_TOOL_USE_META_KEY = 'claudecode/toolUseId'
export const CONSULT_INVOCATION_ENV = 'OPENCLAUDE_CONSULT_INVOCATION'
export const CONSULT_INVOCATION_RE = /^[A-Za-z0-9:_-]{8,128}$/

export type ConsultInvocationSource = 'header' | 'mcp-meta' | 'env'

export type ConsultInvocationResult =
  | { ok: true; invocationId: string; source: ConsultInvocationSource }
  | { ok: false; error: string }

function validId(raw: string): string | null {
  const id = raw.trim()
  return CONSULT_INVOCATION_RE.test(id) ? id : null
}

export function resolveConsultInvocationId(input: {
  header?: string | string[] | undefined
  mcpMeta?: unknown
  env?: NodeJS.ProcessEnv
  /** JSON-RPC tools/call id. Accepted only to prove it is ignored. */
  jsonRpcId?: unknown
}): ConsultInvocationResult {
  const headerRaw = Array.isArray(input.header) ? input.header[0] : input.header
  if (typeof headerRaw === 'string' && headerRaw.trim()) {
    const id = validId(headerRaw)
    if (!id) return { ok: false, error: 'x-openclaude-consult-invocation invalid' }
    return { ok: true, invocationId: id, source: 'header' }
  }

  const meta =
    input.mcpMeta && typeof input.mcpMeta === 'object' && !Array.isArray(input.mcpMeta)
      ? (input.mcpMeta as Record<string, unknown>)
      : null
  const fromMeta = typeof meta?.[CCB_TOOL_USE_META_KEY] === 'string' ? meta[CCB_TOOL_USE_META_KEY] : ''
  if (fromMeta) {
    const id = validId(fromMeta)
    if (!id) return { ok: false, error: 'mcp tool_use id invalid' }
    return { ok: true, invocationId: id, source: 'mcp-meta' }
  }

  const fromEnv = input.env?.[CONSULT_INVOCATION_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    const id = validId(fromEnv)
    if (!id) return { ok: false, error: 'OPENCLAUDE_CONSULT_INVOCATION invalid' }
    return { ok: true, invocationId: id, source: 'env' }
  }

  void input.jsonRpcId
  return {
    ok: false,
    error:
      'consult invocation requires the engine tool_use id (MCP _meta claudecode/toolUseId or x-openclaude-consult-invocation). JSON-RPC request id is not a retry identity and will not be minted.',
  }
}
