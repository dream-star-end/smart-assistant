/**
 * Shared gateway HTTP helpers for the mcp-memory subprocess and the one-shot
 * `oc-memory` CLI. Auth is file-first (`OPENCLAUDE_GATEWAY_TOKEN_FILE`) then
 * `OPENCLAUDE_GATEWAY_TOKEN`; the gateway is loopback
 * `OPENCLAUDE_GATEWAY_PORT` (default 18789). Same scheme as the historical
 * inline helpers in index.ts — do not invent a second token path.
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

export function readGatewayToken(): string {
  const file = process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch (err: any) {
      process.stderr.write(
        `[mcp-memory] OPENCLAUDE_GATEWAY_TOKEN_FILE unreadable (${file}), falling back to env: ${err?.message ?? err}\n`,
      )
    }
  }
  return process.env.OPENCLAUDE_GATEWAY_TOKEN || ''
}

export function gatewayBaseUrl(): string {
  const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT || '18789'
  return `http://127.0.0.1:${gatewayPort}`
}

export function gatewayAuthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${readGatewayToken()}`,
  }
}

/** Opaque per-turn caller binding. Identity is inside the token; env must not override it. */
export const DELEGATE_CONTEXT_HEADER = 'x-openclaude-delegate-context'

export function readDelegateContextTokenFromFile(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.OPENCLAUDE_DELEGATE_CONTEXT_FILE
  if (!file) return ''
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export function gatewayDelegateHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers = gatewayAuthHeaders()
  const token = readDelegateContextTokenFromFile(env)
  if (token) headers[DELEGATE_CONTEXT_HEADER] = token
  return headers
}

/**
 * node:http surfaces the real transport failure on `err.code` (ECONNREFUSED,
 * ECONNRESET, socket timeout…). Fold the code into the message so delegation
 * failures are diagnosable instead of the opaque dead-end the old fetch path
 * produced.
 */
export function describeDelegateTransportError(err: any): string {
  const code = err?.code || err?.cause?.code
  const base = err?.message ?? String(err)
  return code ? `${base} (${code})` : base
}

/**
 * POST JSON to the in-container gateway over node:http. We deliberately avoid
 * global fetch / undici here: the only knob we need is "wait long enough for the
 * gateway to answer", and a socket-inactivity timeout gives exactly that without
 * pulling in undici's separate 5min headersTimeout (the original bug) or a new
 * runtime dependency for this spawned MCP subprocess.
 */
export function postJsonToGateway(
  url: string,
  opts: { headers: Record<string, string>; body: string; timeoutMs: number },
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk as Buffer))
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(opts.timeoutMs, () => {
      const err: any = new Error(
        `delegate client timeout after ${Math.round(opts.timeoutMs / 1000)}s`,
      )
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.end(opts.body)
  })
}
