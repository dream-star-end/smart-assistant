/** Rolling signed turn-lease renewal for active long CCB turns. */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
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
  verify?: (
    req: IncomingMessage,
    ctx: { hostUuid: string; boundIp: string },
  ) => Promise<import('../auth/containerIdentity.js').ContainerIdentity>
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
      identity = await (deps.verify
        ? deps.verify(req, ctx)
        : verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization))
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
      lease = verifyTurnLease(raw.lease, signer.reader().keyring(), now, { allowExpired: true })
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

      // This immutable mapping follows open-dispatch retention (never GC).
      // Once turn_key is bound, renewal is a constant-size point lookup and
      // remains valid across arbitrarily long tools and journal retention.
      const dispatch = await client.query<{
        turn_key: string | null
        canonical_model: string
        attempt_no: number
        dispatch_attempt_no: number
        status: string
        terminal_at: Date | null
        producer_fenced_at: Date | null
        agent_container_id: string | null
      }>(
        `SELECT atd.turn_key, atd.canonical_model, atd.attempt_no,
                td.attempt_no AS dispatch_attempt_no, td.status, td.terminal_at,
                td.producer_fenced_at, td.agent_container_id::text
           FROM authority_turn_dispatches atd
           JOIN turn_dispatches td ON td.dispatch_id=atd.dispatch_id
          WHERE atd.authority_turn_id=$1 AND atd.user_id=$2
          FOR UPDATE OF atd, td`,
        [lease.authorityTurnId, identity.userId],
      )
      const active = dispatch.rows[0]
      if (active && (
        !['admitted', 'accepted'].includes(active.status) ||
        active.terminal_at !== null || active.producer_fenced_at !== null ||
        active.attempt_no !== active.dispatch_attempt_no ||
        active.canonical_model !== lease.canonicalModel ||
        active.agent_container_id !== String(identity.containerId)
      )) {
        await client.query('ROLLBACK')
        sendJson(res, 409, { error: { code: 'TURN_NOT_ACTIVE', message: 'active turn identity rejected' } })
        return
      }
      // Expired signatures authenticate identity only. A historical journal
      // can never reactivate a completed/revoked dispatch.
      if (!active && lease.expiresAt <= now) {
        await client.query('ROLLBACK')
        sendJson(res, 409, { error: { code: 'TURN_NOT_ACTIVE', message: 'active dispatch not found' } })
        return
      }
      if (active?.turn_key !== null && active?.turn_key !== undefined && active.turn_key !== raw.turnKey) {
        await client.query('ROLLBACK')
        sendJson(res, 409, { error: { code: 'TURN_KEY_MISMATCH', message: 'turn key does not match active dispatch' } })
        return
      }

      const evidenceSource: 'journal' | 'dispatch' = active ? 'dispatch' : 'journal'
      if (!active || active.turn_key === null) {
        // First-bind compatibility only: bounded time window, scalar existence
        // checks, and at most two Codex candidate ids. Never load the complete
        // request history or derive a total task deadline from journal age.
        const evidence = await client.query<{
          conflicting: boolean
          matching: boolean
          bindable: string[]
        }>(
          `SELECT
             EXISTS(SELECT 1 FROM request_finalize_journal
               WHERE user_id=$1 AND container_id=$2 AND ctx->>'authorityTurnId'=$3
                 AND created_at >= to_timestamp($5::double precision / 1000)
                 AND ctx->>'turnKey' IS NOT NULL AND ctx->>'turnKey'<>$4
               LIMIT 1) AS conflicting,
             EXISTS(SELECT 1 FROM request_finalize_journal
               WHERE user_id=$1 AND container_id=$2 AND ctx->>'authorityTurnId'=$3
                 AND created_at >= to_timestamp($5::double precision / 1000)
                 AND ctx->>'turnKey'=$4 LIMIT 1) AS matching,
             ARRAY(SELECT request_id FROM request_finalize_journal
               WHERE user_id=$1 AND container_id=$2 AND ctx->>'authorityTurnId'=$3
                 AND created_at >= to_timestamp($5::double precision / 1000)
                 AND ctx->>'turnKey' IS NULL AND ctx->>'source'='codex_bridge'
                 AND state='inflight'
               ORDER BY request_id LIMIT 2 FOR UPDATE) AS bindable`,
          [identity.userId, identity.containerId, lease.authorityTurnId,
            raw.turnKey, now - 13 * 60 * 60_000],
        )
        const proof = evidence.rows[0]
        if (!proof || proof.conflicting) {
          await client.query('ROLLBACK')
          sendJson(res, 409, { error: { code: 'TURN_KEY_MISMATCH', message: 'turn key conflicts with active evidence' } })
          return
        }
        if (!active && !proof.matching) {
          // Legacy Codex admissions precede gateway turn-key derivation.
          // Preserve the one-row inflight first binding for unexpired leases.
          if (proof.bindable.length !== 1) {
            await client.query('ROLLBACK')
            sendJson(res, 409, { error: { code: 'TURN_NOT_ACTIVE', message: 'active turn evidence not found' } })
            return
          }
          const bound = await client.query(
            `UPDATE request_finalize_journal
                SET ctx=jsonb_set(ctx,'{turnKey}',to_jsonb($2::text),true), updated_at=NOW()
              WHERE request_id=$1 AND state='inflight'
                AND ctx->>'source'='codex_bridge' AND ctx->>'turnKey' IS NULL`,
            [proof.bindable[0], raw.turnKey],
          )
          if (bound.rowCount !== 1) {
            await client.query('ROLLBACK')
            sendJson(res, 409, { error: { code: 'TURN_NOT_ACTIVE', message: 'active turn key binding lost' } })
            return
          }
        }
        if (active) {
          // Lease-only Cursor has no proxy journals. Authenticated exact
          // dispatch identity permits its first binding, atomically once.
          const bound = await client.query(
            `UPDATE authority_turn_dispatches SET turn_key=$3
              WHERE authority_turn_id=$1 AND user_id=$2 AND turn_key IS NULL`,
            [lease.authorityTurnId, identity.userId, raw.turnKey],
          )
          if (bound.rowCount !== 1) {
            await client.query('ROLLBACK')
            sendJson(res, 409, { error: { code: 'TURN_KEY_MISMATCH', message: 'durable turn key binding lost' } })
            return
          }
        }
      }

      const epoch = await client.query<{ epoch: string }>(
        'SELECT epoch::text AS epoch FROM model_security_epoch WHERE id FOR SHARE',
      )
      if (!epoch.rowCount || BigInt(epoch.rows[0]!.epoch) !== BigInt(lease.securityEpoch)) {
        await client.query('ROLLBACK')
        sendJson(res, 409, {
          error: { code: 'MODEL_CONFIG_CHANGED', message: 'model security epoch changed' },
        })
        return
      }

      const expiresAt = now + TURN_LEASE_TTL_MS
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
        evidence: evidenceSource,
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
