/** Rolling signed turn-lease renewal for active long CCB turns. */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  AUTHORITY_TURN_MAX_LIFETIME_MS,
  ModelAuthorityError,
  TURN_LEASE_TTL_MS,
  type TurnLease,
  verifyTurnLease,
} from '@openclaude/protocol'
import type { Pool } from 'pg'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { lockTurnBillingKeys } from '../billing/turnLock.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import type { AuthoritySigner } from '../ws/authoritySigner.js'
import { REQUEST_ID_HEADER, ensureRequestId, isObj, setSecurityHeaders } from './util.js'

export { TURN_LEASE_RENEW_PATH } from '@openclaude/protocol'
const MAX_BODY_BYTES = 24 * 1024
const TURN_KEY_RE = /^[0-9a-f]{64}$/

export interface TurnLeaseRenewHandlerDeps {
  identityRepo: ContainerIdentityRepo
  pgPool: Pool
  getSigner: () => AuthoritySigner | undefined
  now?: () => number
  logger?: Logger
}

export interface TurnLeaseRenewHandlerCtx {
  hostUuid: string
  boundIp: string
}

export type TurnLeaseRenewHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TurnLeaseRenewHandlerCtx,
) => Promise<void>

export function makeTurnLeaseRenewHandler(deps: TurnLeaseRenewHandlerDeps): TurnLeaseRenewHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalTurnLeaseRenew' })
  return async (req, res, ctx) => {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } })
      return
    }

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        log.warn('turn_lease_renew_identity_failed', { requestId, errcode: err.code })
        sendJson(res, 401, {
          error: { code: 'UNAUTHORIZED', message: 'container identity verification failed' },
        })
        return
      }
      throw err
    }

    let raw: unknown
    try {
      raw = await readBoundedJson(req, MAX_BODY_BYTES)
    } catch {
      sendJson(res, 400, { error: { code: 'INVALID_BODY', message: 'invalid JSON body' } })
      return
    }
    if (
      !isObj(raw) ||
      typeof raw.turnKey !== 'string' ||
      !TURN_KEY_RE.test(raw.turnKey) ||
      typeof raw.lease !== 'string' ||
      raw.lease.length > 20_000
    ) {
      sendJson(res, 400, { error: { code: 'INVALID_BODY', message: 'turnKey or lease malformed' } })
      return
    }

    const signer = deps.getSigner()
    if (!signer) {
      sendJson(res, 503, {
        error: { code: 'SIGNER_UNAVAILABLE', message: 'lease signer unavailable' },
      })
      return
    }
    const now = (deps.now ?? Date.now)()
    let lease: TurnLease
    try {
      lease = verifyTurnLease(raw.lease, signer.reader().keyring(), now)
    } catch (err) {
      const code = err instanceof ModelAuthorityError ? err.code : 'INVALID'
      log.warn('turn_lease_renew_verify_failed', { requestId, code })
      sendJson(res, 403, {
        error: { code: 'LEASE_INVALID', message: 'signed turn lease rejected' },
      })
      return
    }
    if (lease.uid !== identity.userId || lease.containerId !== identity.containerId) {
      sendJson(res, 403, {
        error: { code: 'LEASE_IDENTITY_MISMATCH', message: 'lease identity mismatch' },
      })
      return
    }

    const client = await deps.pgPool.connect()
    try {
      await client.query('BEGIN')
      await lockTurnBillingKeys(client, BigInt(identity.userId), [raw.turnKey])

      const terminal = await client.query(
        `SELECT 1 FROM server_authored_turn_anchor_map
          WHERE user_id=$1 AND turn_key=$2 LIMIT 1`,
        [`c:${identity.userId}`, raw.turnKey],
      )
      const waived = await client.query(
        'SELECT 1 FROM turn_waivers WHERE user_id=$1 AND turn_key=$2 LIMIT 1',
        [identity.userId, raw.turnKey],
      )
      if (terminal.rowCount || waived.rowCount) {
        await client.query('ROLLBACK')
        sendJson(res, 409, { error: { code: 'TURN_FINALIZED', message: 'turn already finalized' } })
        return
      }

      const evidence = await client.query<{
        request_id: string
        state: string
        source: string | null
        turn_key: string | null
        created_at_ms: string
      }>(
        `SELECT request_id, state, ctx->>'source' AS source,
                ctx->>'turnKey' AS turn_key,
                FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_at_ms
           FROM request_finalize_journal
          WHERE user_id=$1 AND container_id=$2
            AND ctx->>'authorityTurnId'=$3
            AND created_at >= NOW() - INTERVAL '13 hours'
          ORDER BY request_id
          FOR UPDATE`,
        [identity.userId, identity.containerId, lease.authorityTurnId],
      )
      if (!evidence.rowCount) {
        await client.query('ROLLBACK')
        sendJson(res, 409, {
          error: { code: 'TURN_NOT_ACTIVE', message: 'active turn evidence not found' },
        })
        return
      }

      const evidenceStartedAt = Math.min(
        ...evidence.rows.map((row) => Number(row.created_at_ms)),
      )
      if (!Number.isSafeInteger(evidenceStartedAt)) {
        await client.query('ROLLBACK')
        sendJson(res, 409, {
          error: { code: 'TURN_NOT_ACTIVE', message: 'active turn evidence is malformed' },
        })
        return
      }
      // Keep the signed v1 lease wire shape unchanged for rolling old
      // gateways/egress readers. The absolute lifetime anchor is durable
      // server evidence, not a new lease field that old strict parsers reject.
      // A previously experimental originalIssuedAt is accepted only as a
      // conservative earlier bound, then stripped from the renewed envelope.
      const absoluteStartedAt = Math.min(
        evidenceStartedAt,
        lease.issuedAt,
        lease.originalIssuedAt ?? Number.POSITIVE_INFINITY,
      )
      const absoluteExpiresAt = absoluteStartedAt + AUTHORITY_TURN_MAX_LIFETIME_MS
      if (now >= absoluteExpiresAt) {
        await client.query('ROLLBACK')
        sendJson(res, 409, {
          error: { code: 'TURN_LIFETIME_EXCEEDED', message: 'turn lifetime exceeded' },
        })
        return
      }
      // Proxy journals already carry the gateway's signed-attribution
      // turnKey. Codex bridge journals are admitted one hop earlier (before
      // the gateway derives its lossless key), so the first authenticated
      // renewal binds that one still-inflight row exactly once. Thereafter a
      // different key is rejected rather than creating a second billing lane.
      const conflicting = evidence.rows.some(
        (row) => row.turn_key !== null && row.turn_key !== raw.turnKey,
      )
      if (conflicting) {
        await client.query('ROLLBACK')
        sendJson(res, 409, {
          error: { code: 'TURN_KEY_MISMATCH', message: 'turn key does not match active evidence' },
        })
        return
      }
      if (!evidence.rows.some((row) => row.turn_key === raw.turnKey)) {
        const bindable = evidence.rows.filter(
          (row) =>
            row.turn_key === null && row.state === 'inflight' && row.source === 'codex_bridge',
        )
        if (evidence.rows.length !== 1 || bindable.length !== 1) {
          await client.query('ROLLBACK')
          sendJson(res, 409, {
            error: { code: 'TURN_NOT_ACTIVE', message: 'active turn key is not bound' },
          })
          return
        }
        const bound = await client.query(
          `UPDATE request_finalize_journal
              SET ctx=jsonb_set(ctx,'{turnKey}',to_jsonb($2::text),true),
                  updated_at=NOW()
            WHERE request_id=$1 AND state='inflight'
              AND ctx->>'source'='codex_bridge'
              AND ctx->>'turnKey' IS NULL`,
          [bindable[0]!.request_id, raw.turnKey],
        )
        if ((bound.rowCount ?? 0) !== 1) {
          await client.query('ROLLBACK')
          sendJson(res, 409, {
            error: { code: 'TURN_NOT_ACTIVE', message: 'active turn key binding lost' },
          })
          return
        }
      }

      const epoch = await client.query<{ epoch: string }>(
        'SELECT epoch::text AS epoch FROM model_security_epoch WHERE id',
      )
      if (!epoch.rowCount || BigInt(epoch.rows[0]!.epoch) !== BigInt(lease.securityEpoch)) {
        await client.query('ROLLBACK')
        sendJson(res, 409, {
          error: { code: 'MODEL_CONFIG_CHANGED', message: 'model security epoch changed' },
        })
        return
      }

      const expiresAt = Math.min(now + TURN_LEASE_TTL_MS, absoluteExpiresAt)
      const { originalIssuedAt: _legacyOriginalIssuedAt, ...legacyWireLease } = lease
      const renewed = {
        ...legacyWireLease,
        keyId: signer.activeKeyId,
        issuedAt: now,
        expiresAt,
      }
      const envelope = signer.signTurnLease(renewed)
      await client.query('COMMIT')
      log.info('turn_lease_renewed', {
        requestId,
        userId: String(identity.userId),
        containerId: identity.containerId,
        turnKey: raw.turnKey,
        authorityTurnId: lease.authorityTurnId,
        expiresAt,
      })
      sendJson(res, 200, { ok: true, lease: envelope, expiresAt })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      log.error('turn_lease_renew_failed', {
        requestId,
        turnKey: raw.turnKey,
        err: (err as Error).message,
      })
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'lease renewal failed' } })
    } finally {
      client.release()
    }
  }
}

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += bytes.length
    if (total > maxBytes) throw new Error('request too large')
    chunks.push(bytes)
  }
  if (total === 0) throw new Error('empty body')
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}
