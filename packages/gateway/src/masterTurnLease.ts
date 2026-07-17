/** Container gateway → commercial master rolling turn-lease client. */

import { request as undiciRequest } from 'undici'

const RENEW_PATH = '/internal/v3/turn-lease/renew'
const ATTEMPT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 32 * 1024

export interface RenewedTurnLease {
  lease: string
  expiresAt: number
}

export interface RenewTurnLeaseOpts {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
}

export async function renewTurnLease(
  turnKey: string,
  lease: string,
  opts: RenewTurnLeaseOpts = {},
): Promise<RenewedTurnLease> {
  const env = opts.env ?? process.env
  const baseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL?.replace(/\/+$/, '')
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!baseUrl || !bearer) throw new Error('commercial master lease renewal is not configured')
  const fetcher = opts.fetcher ?? undiciRequest
  const response = await fetcher(`${baseUrl}${RENEW_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ turnKey, lease }),
    headersTimeout: ATTEMPT_TIMEOUT_MS,
    bodyTimeout: ATTEMPT_TIMEOUT_MS,
  })
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_RESPONSE_BYTES) throw new Error('turn lease renewal response too large')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks, total).toString('utf8')
  if (response.statusCode !== 200) {
    throw new Error(`turn lease renewal HTTP ${response.statusCode}: ${text.slice(0, 200)}`)
  }
  const body = JSON.parse(text) as { lease?: unknown; expiresAt?: unknown }
  if (
    typeof body.lease !== 'string' ||
    body.lease.length === 0 ||
    typeof body.expiresAt !== 'number' ||
    !Number.isSafeInteger(body.expiresAt)
  ) {
    throw new Error('turn lease renewal response malformed')
  }
  return { lease: body.lease, expiresAt: body.expiresAt }
}
