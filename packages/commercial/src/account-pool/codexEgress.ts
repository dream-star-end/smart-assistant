/**
 * Codex account egress resolution.
 *
 * Codex traffic must not inherit process/global proxy state and must not fall
 * back to the master host direct egress.  This helper is deliberately stricter
 * than `getDispatcherForAccount`: every active codex account is expected to be
 * bound to an active egress_proxies row; any missing/invalid proxy is a
 * fail-closed operational error, not a signal to use the default route.
 */

import type { Dispatcher } from 'undici'
import { query } from '../db/queries.js'
import { decryptToBuffer } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'
import { getDispatcherForAccount } from './egressDispatcher.js'

export type CodexEgressErrorCode =
  | 'account_not_found'
  | 'provider_mismatch'
  | 'account_not_active'
  | 'proxy_missing'
  | 'proxy_inactive'
  | 'proxy_decrypt_failed'
  | 'dispatcher_unavailable'

export class CodexEgressError extends Error {
  constructor(
    readonly code: CodexEgressErrorCode,
    message: string,
    readonly details: { accountId?: string; proxyId?: string | null } = {},
    opts?: { cause?: unknown },
  ) {
    super(message, opts)
    this.name = 'CodexEgressError'
  }
}

interface RawCodexEgressRow {
  id: string
  provider: string
  status: string
  egress_proxy_id: string | null
  proxy_status: string | null
  proxy_url_enc: Buffer | null
  proxy_url_nonce: Buffer | null
}

export interface CodexEgressDispatcher {
  accountId: bigint
  proxyId: bigint
  dispatcher: Dispatcher
}

export interface CodexEgressResolverDeps {
  queryFn?: typeof query
  keyFn?: () => Buffer
  dispatcherFactory?: typeof getDispatcherForAccount
}

export async function resolveCodexAccountEgressDispatcher(
  accountId: bigint | string,
  deps: CodexEgressResolverDeps = {},
): Promise<CodexEgressDispatcher> {
  return resolveOfficialOAuthAccountEgressDispatcher(accountId, 'codex', deps)
}

export async function resolveOfficialOAuthAccountEgressDispatcher(
  accountId: bigint | string,
  provider: 'codex' | 'grok',
  deps: CodexEgressResolverDeps = {},
): Promise<CodexEgressDispatcher> {
  const id = String(accountId)
  const queryFn = deps.queryFn ?? query
  const keyFn = deps.keyFn ?? loadKmsKey
  const dispatcherFactory = deps.dispatcherFactory ?? getDispatcherForAccount

  const res = await queryFn<RawCodexEgressRow>(
    `SELECT a.id::text AS id,
            a.provider,
            a.status,
            a.egress_proxy_id::text AS egress_proxy_id,
            ep.status AS proxy_status,
            ep.url_enc AS proxy_url_enc,
            ep.url_nonce AS proxy_url_nonce
       FROM claude_accounts a
       LEFT JOIN egress_proxies ep ON ep.id = a.egress_proxy_id
      WHERE a.id = $1`,
    [id],
  )
  const row = res.rows[0]
  if (!row) {
    throw new CodexEgressError('account_not_found', `codex account ${id} not found`, { accountId: id })
  }
  if (row.provider !== provider) {
    throw new CodexEgressError(
      'provider_mismatch',
      `account ${id} is provider=${row.provider}, expected ${provider}`,
      { accountId: id, proxyId: row.egress_proxy_id },
    )
  }
  if (row.status !== 'active') {
    throw new CodexEgressError(
      'account_not_active',
      `codex account ${id} is ${row.status}`,
      { accountId: id, proxyId: row.egress_proxy_id },
    )
  }
  if (row.egress_proxy_id === null) {
    throw new CodexEgressError('proxy_missing', `codex account ${id} has no egress proxy`, {
      accountId: id,
      proxyId: null,
    })
  }
  if (row.proxy_status !== 'active' || row.proxy_url_enc === null || row.proxy_url_nonce === null) {
    throw new CodexEgressError(
      'proxy_inactive',
      `codex account ${id} egress proxy ${row.egress_proxy_id} is not active`,
      { accountId: id, proxyId: row.egress_proxy_id },
    )
  }

  let proxyUrl = ''
  const key = keyFn()
  try {
    const proxyUrlBuf = decryptToBuffer(row.proxy_url_enc, row.proxy_url_nonce, key)
    try {
      proxyUrl = proxyUrlBuf.toString('utf8')
    } finally {
      zeroBuffer(proxyUrlBuf)
    }
  } catch (err) {
    throw new CodexEgressError(
      'proxy_decrypt_failed',
      `failed to decrypt codex account ${id} egress proxy`,
      { accountId: id, proxyId: row.egress_proxy_id },
      { cause: err },
    )
  } finally {
    zeroBuffer(key)
  }

  const dispatcher = await dispatcherFactory(BigInt(row.id), proxyUrl, null)
  if (!dispatcher) {
    throw new CodexEgressError(
      'dispatcher_unavailable',
      `failed to build dispatcher for codex account ${id}`,
      { accountId: id, proxyId: row.egress_proxy_id },
    )
  }

  return {
    accountId: BigInt(row.id),
    proxyId: BigInt(row.egress_proxy_id),
    dispatcher: dispatcher as Dispatcher,
  }
}
