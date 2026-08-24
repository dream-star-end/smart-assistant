/**
 * V3 commercial — internal endpoint for container → master codex token refresh.
 *
 * Co-resident with anthropicProxy on the same listener (plain 18791 self-host
 * + mTLS 18443 remote-host); routed by URL path.
 *
 * Why this exists:
 *   In v3 commercial, each per-user docker container runs a personal-version
 *   gateway that drives `codex app-server --listen stdio://`. When codex
 *   receives 401 Unauthorized from upstream, it issues a JSON-RPC server →
 *   client request `account/chatgptAuthTokens/refresh` to ask the gateway for
 *   a fresh access token.
 *
 *   The container's gateway has no DB / KMS / refresh_token — those live on
 *   master only (commercial account pool). So the container forwards the
 *   reverse-RPC over HTTP to this endpoint, master refreshes via OAuth using
 *   the bound codex_account, persists the new token to DB + the per-container
 *   `auth.json`, and returns the new access_token + chatgpt_account_id to the
 *   container so codex can keep streaming the in-flight turn.
 *
 *   Without this path, every codex 401 would fail the turn — observable as
 *   `[turn failed: auth refresh request failed: code=-32601 method 'account/
 *   chatgptAuthTokens/refresh' not implemented by openclaude-gateway]`.
 *
 * Trust boundary:
 *   - Auth via `verifyContainerIdentity` — same double-factor as anthropicProxy
 *     (oc-v3.<containerId>.<secret> bearer + (host_uuid, bound_ip) row lookup).
 *   - The container's identity dictates which codex_account_id we refresh:
 *     master reads `agent_containers.codex_account_id` for the verified
 *     containerId, never trusting any body-supplied account hint.
 *     `previousAccountId` (codex protocol param) is purely informational; we
 *     log it but do not use it for routing.
 *
 * Race-safety:
 *   Container identity proves the request comes from the *current* active
 *   container. It does NOT prove the codex_account_id observed at request
 *   start is still the binding when we go to write auth.json. Lazy migrate
 *   (in `acquire`) can rebind the container to a different account between
 *   our initial SELECT and the file write. So we mirror codexAccountActor's
 *   `writeForOneContainer`:
 *     1. Initial unlocked SELECT for codex_account_id (just to know which
 *        account to refresh).
 *     2. Refresh that account (no lock — refresh.ts has its own dedup +
 *        DB persist).
 *     3. BEGIN; SELECT ... FOR UPDATE recheck → return a Decision:
 *          state must still be 'active'
 *          codex_account_id must still equal what we refreshed
 *          account_status must still be 'active'
 *          user_id must still equal identity.userId (defense in depth — if
 *            container row was somehow rebound to another user, abort)
 *          isLocal/hostUuid (route hint captured under lock).
 *        COMMIT.
 *     4. AFTER tx commit, write the per-container auth.json (local fs or
 *        remote node-agent PUT depending on the captured host_uuid).
 *
 *   ⚠ The file write is intentionally OUTSIDE the tx. v1.0.115 wrote it
 *   inside FOR UPDATE which serialized a 60s remote node-agent HTTP PUT on
 *   a PG pool client + the `agent_containers` row lock. Under codex 401
 *   bursts that drained the pg pool and wedged the entire master event loop
 *   (handlers stuck on pool.connect()). v1.0.116 moved the IO out.
 *
 *   Drift at step 3 → 409 CONTAINER_BINDING_CHANGED. The next codex retry
 *   will pick up the new binding's already-fresh token via the file (which
 *   the migrating writer wrote synchronously under the same FOR UPDATE).
 *
 *   New race window introduced by step 4 being post-tx: if the container row
 *   is rebound between commit and our writeRemote completing (~ms-s), we
 *   could write a soon-stale token to the (still by container id) auth.json.
 *   This is acceptable because (a) access_token is 1h max, (b) acquire/lazy
 *   migrate writes auth.json under its own FOR UPDATE next turn, (c) we
 *   have no admin path that rebinds a running container today (commit
 *   ad0a7fa1 noted host migration is "future-proof" only).
 *
 *   ⚠ FUTURE: when a host_uuid migration / container rebind path is added,
 *   this endpoint MUST gain a fence (e.g. node-agent receipt validates
 *   expected (containerId, accountId) matches a label / generation) — until
 *   then, that future feature MUST first deactivate the row before
 *   migration so this endpoint hits the 'drift' branch.
 *
 * In-flight refresh dedup:
 *   `refreshCodexAccountToken` already holds a per-accountId in-flight Map.
 *   So if N containers bound to the same codex account simultaneously hit
 *   this endpoint, only one OAuth call goes upstream; the others await the
 *   same Promise and write their own per-container files independently.
 *
 * Rate limiting:
 *   Per (uid, codex_account_id) — protects the upstream OAuth endpoint and
 *   keeps a runaway container from burning quota. 60s window, 6 attempts:
 *   codex retries on 401 in fast succession (a few times in flight is normal),
 *   so 6 leaves headroom for legitimate bursts but kills tight loops.
 *
 * Errors (HTTP code → meaning):
 *   401 UNAUTHORIZED              container identity check failed
 *   404 NO_BOUND_ACCOUNT          row exists but codex_account_id IS NULL
 *                                 (legacy / unbound container; codex CLI is
 *                                  not expected here, but be explicit)
 *   422 ACCOUNT_NOT_FOUND         bound account_id no longer in claude_accounts
 *                                 (admin deleted it mid-flight)
 *   429 RATE_LIMITED              per-(uid, account) rate limit hit
 *   409 CONTAINER_BINDING_CHANGED state/account_id/user_id drift between
 *                                 refresh and FOR UPDATE recheck
 *   503 NETWORK_TRANSIENT         OAuth network call failed (codex/codex
 *                                 gateway should retry — Retry-After: 1)
 *   502 REFRESH_FAILED            OAuth returned non-2xx / bad JSON / no
 *                                 access_token / persist failure (account
 *                                 already disabled by refresh.ts; permanent)
 *   500 FILE_WRITE_FAILED         atomic rename or remote PUT failed
 *   500 INTERNAL                  catch-all (logged, not retried)
 *
 * Note: There is no body-shape contract this endpoint accepts. Codex sends
 *   `{ previousAccountId: string|null, reason: 'unauthorized' }`; we read
 *   `reason` and `previousAccountId` purely for logging and ignore the rest.
 *   The container forwards the params blob unchanged.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PoolClient } from 'pg'
import { z } from 'zod'

import {
  type LazyMigrateOutcome,
  type WriteAuthDeps,
  acquireAndPickInTx,
  commitCodexRebindInTx,
  fetchSnapshotAndWriteContainerAuth,
} from '../account-pool/codexLazyMigrate.js'
import {
  type RefreshCodexDeps,
  RefreshError,
  refreshCodexAccountToken,
} from '../account-pool/refresh.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { extractChatGptAccountId } from '../codex-auth/extractAccountId.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import {
  type RateLimitRedis,
  checkRateLimit,
  recordRateLimitEvent,
} from '../middleware/rateLimit.js'
import { HttpError, REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

/** Path the container's reverse-RPC forwarder POSTs to. Mounted on both the
 *  plain self-host listener (18791) and the mTLS remote-host listener (18443). */
export { CODEX_TOKEN_REFRESH_PATH } from '@openclaude/protocol'

/** Body cap — codex's request params are tiny ({reason, previousAccountId}),
 *  but allow some slack for protocol drift. 4 KiB is generous. */
const MAX_BODY_BYTES = 4 * 1024

/** Body schema — best-effort, all fields optional. Drift-tolerant: codex
 *  may add fields in future versions; we don't .strict() to avoid breaking
 *  on benign additions. We only read `reason` and `previousAccountId` for
 *  log context. */
const BodySchema = z
  .object({
    reason: z.string().max(64).optional(),
    previousAccountId: z.string().max(128).nullable().optional(),
  })
  .passthrough()

/** Rate limit: per-(uid, account) sliding-ish window. 60s × 6 attempts is
 *  generous enough for codex's retry-on-401 burst yet kills tight loops. */
const RATE_LIMIT_WINDOW_S = 60
const RATE_LIMIT_MAX = 6
const RATE_LIMIT_SCOPE = 'codex_token_refresh'

/** Storage interface — narrow to what we need so unit tests can inject
 *  a memory backend. `tx` and `query` from `db/queries.js` satisfy this
 *  via thin wrappers in the wiring site.
 *
 *  Both reads MUST LEFT JOIN claude_accounts on codex_account_id and
 *  surface `accountStatus`. The handler refuses to refresh tokens for
 *  non-`active` accounts (disabled/quarantined/deleted) so the reverse
 *  RPC path cannot bypass lazy-migrate's "non-active → rebind" rule.
 */
export interface ContainerAccountRow {
  codexAccountId: bigint | null
  userId: bigint
  state: string
  hostUuid: string | null
  /** claude_accounts.status of the bound codex account, or null if no
   *  account is bound (codexAccountId IS NULL) or the join missed. */
  accountStatus: string | null
}
export interface CodexTokenRefreshDb {
  /** Initial unlocked read of the container's bound codex account
   *  (with claude_accounts.status surfaced via LEFT JOIN). */
  readContainerAccount(containerId: number): Promise<ContainerAccountRow | null>
  /** Run the FOR UPDATE recheck + write callback inside a single tx.
   *  The callback sees the row state (still active? still same account?
   *  still same user? account still active?). It either returns 'ok'
   *  (commit), 'drift' (commit with no write — drift detected), or
   *  throws (rollback). */
  txWithLock<T>(
    containerId: number,
    fn: (client: PoolClient, row: ContainerAccountRow | null) => Promise<T>,
  ): Promise<T>
}

/** Pluggable file-write target: local fs vs remote node-agent. */
export interface CodexTokenRefreshFileWriter {
  writeLocal(args: {
    rootDir: string
    containerId: string
    containerUid: number
    containerGid: number
    auth: { accessToken: string; lastRefreshIso: string }
  }): Promise<void>
  writeRemote?(
    hostUuid: string,
    containerId: string,
    accessToken: string,
    lastRefreshIso: string,
  ): Promise<void>
}

export interface CodexTokenRefreshHandlerDeps {
  identityRepo: ContainerIdentityRepo
  db: CodexTokenRefreshDb
  fileWriter: CodexTokenRefreshFileWriter
  /** Required: rootDir for per-container auth.json local writes
   *  (= OC_V3_CODEX_CONTAINER_DIR). */
  codexContainerDir: string
  /** Required: container agent uid/gid for chown of the written file. */
  containerUid: number
  containerGid: number
  /** Required: host_uuid of master self. Used to decide local vs remote write. */
  selfHostId: string | null
  /** Rate limit redis (same backend as anthropicProxy / handlers). */
  rateLimitRedis: RateLimitRedis
  /** Inject for tests; production reuses the same refresh.ts singleton path. */
  refreshFn?: typeof refreshCodexAccountToken
  /** Refresh dep injection for tests (mock http etc). */
  refreshDeps?: RefreshCodexDeps
  logger?: Logger
  /** Date.now override for tests. */
  now?: () => number
  /** v1.0.120 feat/codex-disable-rebind:M1 in-turn rebind 三 helper 注入点。
   *  生产用默认 import,单测 stub 出来避免 `client.query(null)`(test fake 的
   *  txWithLock 通常传 null client)。 */
  acquireAndPickInTxFn?: typeof acquireAndPickInTx
  commitCodexRebindInTxFn?: typeof commitCodexRebindInTx
  fetchSnapshotAndWriteContainerAuthFn?: typeof fetchSnapshotAndWriteContainerAuth
}

export interface CodexTokenRefreshHandlerCtx {
  hostUuid: string
  boundIp: string
}

export type CodexTokenRefreshHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CodexTokenRefreshHandlerCtx,
) => Promise<void>

export function makeCodexTokenRefreshHandler(
  deps: CodexTokenRefreshHandlerDeps,
): CodexTokenRefreshHandler {
  const log = (deps.logger ?? rootLogger).child({
    subsys: 'internalCodexTokenRefresh',
  })
  const refreshFn = deps.refreshFn ?? refreshCodexAccountToken
  const acquireAndPickInTxFn = deps.acquireAndPickInTxFn ?? acquireAndPickInTx
  const commitCodexRebindInTxFn = deps.commitCodexRebindInTxFn ?? commitCodexRebindInTx
  const fetchAndWriteFn =
    deps.fetchSnapshotAndWriteContainerAuthFn ?? fetchSnapshotAndWriteContainerAuth

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    const reqLog = log.child({
      requestId,
      hostUuid: ctx.hostUuid,
      boundIp: ctx.boundIp,
      method: req.method ?? 'GET',
    })

    if (req.method !== 'POST') {
      sendJsonError(res, 405, 'METHOD_NOT_ALLOWED', 'POST required', requestId)
      return
    }

    // 1) Container identity (same double-factor as anthropicProxy)
    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn('identity_failed', { errcode: err.code })
        sendJsonError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
        return
      }
      throw err
    }
    const uid = identity.userId
    const userLog = reqLog.child({ uid, containerId: identity.containerId })

    // 2) Read body (best-effort — log only). Drift-tolerant on shape.
    let bodyCtx: { reason?: string; previousAccountId?: string | null } = {}
    try {
      const raw = await readBoundedJson(req, MAX_BODY_BYTES)
      const parsed = BodySchema.safeParse(raw)
      if (parsed.success) {
        bodyCtx = parsed.data
      } else {
        userLog.info('body_unparseable', { issues: parsed.error.issues })
      }
    } catch (err) {
      // Empty body is fine — codex sometimes sends no params? unlikely but
      // benign. Body cap exceeded → 413 (give-up signal to container).
      if (err instanceof HttpError) {
        if (err.status === 413) {
          sendJsonError(res, 413, err.code, err.message, requestId)
          return
        }
        // 400 INVALID_JSON / EMPTY_BODY: codex can send `{reason:"unauthorized"}`
        // verbatim, but if the gateway forwarded an empty body or junk we still
        // refresh — the container's ask is implicit in hitting this endpoint.
        userLog.info('body_read_soft_fail', { code: err.code })
      } else {
        throw err
      }
    }

    // 3) Initial unlocked read: which account is this container bound to?
    let initialRow: ContainerAccountRow | null
    try {
      initialRow = await deps.db.readContainerAccount(identity.containerId)
    } catch (err) {
      userLog.error('read_container_account_threw', { err: err as Error })
      sendJsonError(res, 500, 'INTERNAL', 'container row read failed', requestId)
      return
    }
    if (!initialRow) {
      // Container was deleted between identity check and our read. Should be
      // extremely rare; identity check already passed FOR active row. Treat
      // as 409 — codex retry is the right action.
      userLog.warn('container_row_vanished_after_identity')
      sendJsonError(
        res,
        409,
        'CONTAINER_BINDING_CHANGED',
        'container row vanished after identity check',
        requestId,
      )
      return
    }
    if (initialRow.userId !== BigInt(uid)) {
      // Defense in depth: identity userId must match container row's user_id.
      // verifyContainerIdentity already enforces this transitively (the row
      // *is* the source of identity.userId), but assert again here so any
      // future identity-cache regression cannot poison cross-tenant.
      userLog.error('identity_userid_mismatch', {
        identityUid: uid,
        rowUid: String(initialRow.userId),
      })
      sendJsonError(res, 401, 'UNAUTHORIZED', 'container identity verification failed', requestId)
      return
    }
    if (initialRow.codexAccountId === null) {
      userLog.warn('no_bound_account', {
        previousAccountId: bodyCtx.previousAccountId ?? null,
      })
      sendJsonError(res, 404, 'NO_BOUND_ACCOUNT', 'container has no codex account bound', requestId)
      return
    }
    // `accountId` is the account we'll proceed to refresh + write for.
    // Default is the bound account from initialRow; M1 in-turn rebind may
    // override it below (already_active fall-through). `let` (not `const`)
    // for that reason.
    let accountId: bigint = initialRow.codexAccountId

    if (initialRow.accountStatus !== 'active') {
      // M1 in-turn self-heal (plan v3 feat/codex-disable-rebind):
      //
      // Previously this returned 422 ACCOUNT_NOT_ACTIVE and relied on the
      // next user inbound to trigger acquire()'s lazy migrate. But when the
      // disable comes from admin (DB-only — OpenAI still honors the old
      // token), codex CLI never sees a 401 → never re-issues this RPC →
      // acquire path doesn't run between turns → user's current turn just
      // fails. So we now actively pick a fresh active account here.
      //
      // Consistency model is **weak** (M1): tx-inner pick + UPDATE; tx-outer
      // fetch+write. Write failure leaves row=new, auth=old; the next 401
      // burst hits the happy refreshFn path (row.status now active) and
      // self-heals auth.json. We accept this trade for not holding a PG row
      // lock through a 60s remote node-agent PUT (v1.0.115 wedge).
      //
      // The strong-consistency counterpart is M2 codexDisableFanout: that
      // runs as a background N=4 actor when the account disable event
      // fires, so it can safely keep the file write inside the tx.
      userLog.warn('account_not_active_attempt_inturn_rebind', {
        codexAccountId: String(initialRow.codexAccountId),
        accountStatus: initialRow.accountStatus ?? '(null)',
        previousAccountId: bodyCtx.previousAccountId ?? null,
      })

      let outcome: LazyMigrateOutcome
      try {
        outcome = await deps.db.txWithLock(
          identity.containerId,
          async (client, _row) => {
            // `_row` from txWithLock is ignored — acquireAndPickInTx does
            // its own SELECT ... FOR UPDATE OF ac. Re-locking the same row
            // in the same tx is a no-op in PG (already held), so the second
            // SELECT is just a cheap re-read with the latest visible state.
            const o = await acquireAndPickInTxFn(client, identity.containerId, BigInt(uid))
            if (o.kind === 'rebound') {
              await commitCodexRebindInTxFn(client, identity.containerId, o.newAccountId)
            }
            return o
          },
        )
      } catch (err) {
        userLog.error('inturn_rebind_tx_threw', { err: err as Error })
        sendJsonError(res, 500, 'INTERNAL', 'in-turn lazy migrate tx failed', requestId)
        return
      }

      switch (outcome.kind) {
        case 'pool_empty':
          // No active codex account anywhere — same observable outcome as the
          // old 422 path, but log distinct so ops can tell "pool empty"
          // from "transient drift".
          userLog.warn('inturn_rebind_pool_empty')
          sendJsonError(
            res,
            422,
            'ACCOUNT_NOT_ACTIVE',
            'codex account pool empty; no active account to migrate to',
            requestId,
          )
          return
        case 'vanished':
          userLog.warn('inturn_rebind_container_vanished_under_lock')
          sendJsonError(
            res,
            409,
            'CONTAINER_BINDING_CHANGED',
            'container row vanished during in-turn migrate',
            requestId,
          )
          return
        case 'state_inactive':
          userLog.warn('inturn_rebind_state_inactive_under_lock')
          sendJsonError(
            res,
            409,
            'CONTAINER_BINDING_CHANGED',
            'container state changed during in-turn migrate',
            requestId,
          )
          return
        case 'user_mismatch':
          // Same semantics as happy-path step 6: a userId change under the
          // lock is treated as binding drift, not as an auth failure.
          userLog.error('inturn_rebind_user_mismatch_under_lock')
          sendJsonError(
            res,
            409,
            'CONTAINER_BINDING_CHANGED',
            'container user_id changed during in-turn migrate',
            requestId,
          )
          return
        case 'no_bound_account':
          // codex_account_id became NULL between the unlocked initial read
          // and the FOR UPDATE — extremely rare admin race. Match the
          // earlier-in-handler null-bound path.
          userLog.warn('inturn_rebind_no_bound_account_under_lock')
          sendJsonError(
            res,
            404,
            'NO_BOUND_ACCOUNT',
            'container codex_account_id became NULL during in-turn migrate',
            requestId,
          )
          return
        case 'rebound': {
          // tx already committed row.codex_account_id = newAccountId.
          // Now write per-container auth.json OUTSIDE the tx — same reason
          // as the happy path step 6b (v1.0.115 wedge: don't pin a PG row
          // lock through remote node-agent IO).
          const writeAuthDeps: WriteAuthDeps = {
            selfHostId: deps.selfHostId,
            containerUid: deps.containerUid,
            containerGid: deps.containerGid,
            codexContainerDir: deps.codexContainerDir,
            putRemoteCodexAuth: deps.fileWriter.writeRemote,
            writeLocalFn: deps.fileWriter.writeLocal,
          }
          let written: Awaited<ReturnType<typeof fetchSnapshotAndWriteContainerAuth>>
          try {
            written = await fetchAndWriteFn({
              accountId: outcome.newAccountId,
              containerId: identity.containerId,
              hostUuidUnderLock: outcome.hostUuidUnderLock,
              deps: writeAuthDeps,
            })
          } catch (err) {
            // row has been committed to newAccountId already; auth.json is
            // still the old token. Next OpenAI 401 → reverse-refresh hits
            // this endpoint again → initialRow.accountStatus = 'active'
            // (new account) → happy refreshFn path → auth.json gets the new
            // token. User's CURRENT turn fails; they may need to manually
            // resend. Plan v3 accepts this as the M1 weak-consistency
            // self-heal trade-off.
            userLog.error('inturn_rebind_write_failed', {
              err: err as Error,
              newAccountId: String(outcome.newAccountId),
            })
            sendJsonError(
              res,
              500,
              'FILE_WRITE_FAILED',
              'auth.json write failed after in-turn rebind; retry',
              requestId,
            )
            return
          }
          userLog.info('inturn_rebind_ok', {
            newAccountId: String(outcome.newAccountId),
            chatgptAccountId: written.chatgptAccountId ?? '(unparseable)',
            plan: outcome.plan,
          })
          sendJsonOk(
            res,
            200,
            {
              accessToken: written.accessToken,
              // codex protocol marks chatgptAccountId as required string;
              // empty fallback matches the happy-path's same fallback.
              chatgptAccountId: written.chatgptAccountId ?? '',
              chatgptPlanType: outcome.plan,
            },
            requestId,
          )
          return
        }
        case 'already_active': {
          // A concurrent path (M2 fanout / another acquire) already migrated
          // the row to an active account between our initial unlocked read
          // and this FOR UPDATE. Fall through to the happy refresh path,
          // targeting that new account.
          userLog.info('inturn_rebind_already_active_concurrent', {
            newAccountId: String(outcome.currentAccountId),
          })
          accountId = outcome.currentAccountId
          break
        }
      }
    }

    const accountLog = userLog.child({
      codexAccountId: String(accountId),
      reason: bodyCtx.reason,
      previousAccountId: bodyCtx.previousAccountId ?? null,
    })

    // 4) Rate limit per (uid, accountId).
    const rlIdentifier = `u:${uid}:a:${String(accountId)}`
    let rlBlocked = false
    let rlRetryAfter = RATE_LIMIT_WINDOW_S
    try {
      const decision = await checkRateLimit(
        deps.rateLimitRedis,
        {
          scope: RATE_LIMIT_SCOPE,
          windowSeconds: RATE_LIMIT_WINDOW_S,
          max: RATE_LIMIT_MAX,
        },
        rlIdentifier,
      )
      if (!decision.allowed) {
        rlBlocked = true
        rlRetryAfter = decision.retryAfterSeconds
      }
    } catch (err) {
      // Redis flake: fail-open. Refresh is the load-bearing path; we'd rather
      // burn a few extra OAuth calls than block a real 401 recovery on redis.
      accountLog.warn('rate_limit_redis_threw_fail_open', { err: err as Error })
    }
    if (rlBlocked) {
      accountLog.warn('rate_limited', { retryAfter: rlRetryAfter })
      // fire-and-forget event log; don't block request on DB
      void recordRateLimitEvent(RATE_LIMIT_SCOPE, rlIdentifier, true)
      sendJsonError(
        res,
        429,
        'RATE_LIMITED',
        'too many codex token refresh attempts; retry later',
        requestId,
        { 'retry-after': String(rlRetryAfter) },
      )
      return
    }

    // 5) Refresh upstream. This is dedup'd internally by refreshCodexInflight
    //    keyed on accountId, so concurrent containers bound to the same account
    //    don't multiply OAuth calls.
    let refreshed: Awaited<ReturnType<typeof refreshFn>>
    try {
      refreshed = await refreshFn(accountId, deps.refreshDeps ?? {})
    } catch (err) {
      if (err instanceof RefreshError) {
        if (err.code === 'account_not_found') {
          accountLog.warn('refresh_account_not_found')
          sendJsonError(
            res,
            422,
            'ACCOUNT_NOT_FOUND',
            'bound codex account no longer exists',
            requestId,
          )
          return
        }
        if (err.code === 'network_transient') {
          accountLog.warn('refresh_network_transient', { err })
          sendJsonError(
            res,
            503,
            'NETWORK_TRANSIENT',
            'codex OAuth refresh network failure; retry',
            requestId,
            { 'retry-after': '1' },
          )
          return
        }
        // http_error / bad_response / persist_error / no_refresh_token —
        // refresh.ts has already disabled the account; permanent for now.
        accountLog.error('refresh_hard_fail', { code: err.code, status: err.status })
        sendJsonError(
          res,
          502,
          'REFRESH_FAILED',
          `codex token refresh failed (${err.code})`,
          requestId,
        )
        return
      }
      accountLog.error('refresh_unknown_threw', { err: err as Error })
      sendJsonError(res, 500, 'INTERNAL', 'refresh threw unknown error', requestId)
      return
    }

    let accessTokenStr = ''
    let chatgptAccountId: string | null = null
    try {
      accessTokenStr = refreshed.token.toString('utf8')
      chatgptAccountId = extractChatGptAccountId(accessTokenStr)

      // 6) FOR UPDATE recheck — tx returns a Decision, no IO held under lock.
      //    File write happens AFTER commit (step 7) to avoid serializing
      //    60s remote node-agent PUTs on PG pool clients (v1.0.115 regression
      //    that wedged the master event loop under codex 401 bursts).
      type Decision =
        | { kind: 'ok'; isLocal: true }
        | { kind: 'ok'; isLocal: false; hostUuid: string }
        | { kind: 'drift'; why: string }
        | { kind: 'vanished' }
        | { kind: 'user_mismatch' }

      let decision: Decision
      try {
        decision = await deps.db.txWithLock(
          identity.containerId,
          async (_client, row): Promise<Decision> => {
            if (!row) return { kind: 'vanished' }
            if (row.state !== 'active') {
              return { kind: 'drift', why: `state=${row.state}` }
            }
            if (row.codexAccountId === null || row.codexAccountId !== accountId) {
              return {
                kind: 'drift',
                why: `account_id=${row.codexAccountId === null ? 'null' : String(row.codexAccountId)}`,
              }
            }
            // Account-level recheck: account could have been disabled /
            // quarantined / deleted between initial gate and this lock.
            // Even though refresh.ts may have already persisted a new token,
            // we must NOT write that token to auth.json — the next turn will
            // lazy-migrate to a fresh active account.
            if (row.accountStatus !== 'active') {
              return {
                kind: 'drift',
                why: `account_status=${row.accountStatus ?? 'null'}`,
              }
            }
            if (row.userId !== BigInt(uid)) {
              return { kind: 'user_mismatch' }
            }
            // Decide local vs remote based on row.host_uuid (snapshot under
            // lock — see the file-header race note about future host
            // migration paths).
            const isLocal =
              deps.selfHostId === null || row.hostUuid === null || row.hostUuid === deps.selfHostId
            if (isLocal) return { kind: 'ok', isLocal: true }
            // isLocal=false ⇒ row.hostUuid is non-null and differs from selfHostId.
            return { kind: 'ok', isLocal: false, hostUuid: row.hostUuid as string }
          },
        )
      } catch (err) {
        accountLog.error('tx_recheck_threw', { err: err as Error })
        sendJsonError(res, 500, 'INTERNAL', 'binding recheck failed', requestId)
        return
      }

      if (decision.kind === 'vanished') {
        accountLog.warn('container_row_vanished_under_lock')
        sendJsonError(res, 409, 'CONTAINER_BINDING_CHANGED', 'container row vanished', requestId)
        return
      }
      if (decision.kind === 'user_mismatch') {
        // identity passed step 1 + initial-row gate; if user_id changes
        // under the lock, the binding has effectively been re-pointed to
        // another tenant (extremely rare — would imply admin tooling
        // manually rebinding mid-flight). Treat as drift, not as auth
        // failure (codex round 2 non-blocking suggestion: unify under 409
        // CONTAINER_BINDING_CHANGED for ops triage).
        accountLog.error('user_mismatch_under_lock')
        sendJsonError(
          res,
          409,
          'CONTAINER_BINDING_CHANGED',
          'container user_id changed during refresh',
          requestId,
        )
        return
      }
      if (decision.kind === 'drift') {
        accountLog.warn('binding_drift_under_lock', { why: decision.why })
        sendJsonError(
          res,
          409,
          'CONTAINER_BINDING_CHANGED',
          'container binding changed during refresh',
          requestId,
        )
        return
      }

      // 6b) Write per-container auth.json — OUTSIDE the tx. See file-header
      //     race note for why this is safe.
      const lastRefreshIso = new Date().toISOString()
      try {
        if (decision.isLocal) {
          await deps.fileWriter.writeLocal({
            rootDir: deps.codexContainerDir,
            containerId: String(identity.containerId),
            containerUid: deps.containerUid,
            containerGid: deps.containerGid,
            auth: { accessToken: accessTokenStr, lastRefreshIso },
          })
        } else {
          if (!deps.fileWriter.writeRemote) {
            throw new Error(
              `internalCodexTokenRefresh: container ${identity.containerId} on remote host ${decision.hostUuid} but writeRemote not wired`,
            )
          }
          await deps.fileWriter.writeRemote(
            decision.hostUuid,
            String(identity.containerId),
            accessTokenStr,
            lastRefreshIso,
          )
        }
      } catch (err) {
        accountLog.error('post_tx_write_failed', { err: err as Error })
        sendJsonError(res, 500, 'FILE_WRITE_FAILED', 'auth.json write failed; retry', requestId)
        return
      }

      // 7) Success — return shape that matches codex's
      //    ChatgptAuthTokensRefreshResponse schema: required {accessToken,
      //    chatgptAccountId} + optional {chatgptPlanType}.
      //
      //    chatgptAccountId is extracted from the JWT itself; if extraction
      //    fails (malformed JWT — should be impossible for a successful refresh)
      //    we fall back to empty string. codex protocol marks the field as
      //    required string; sending "" is the least-bad signal that something
      //    is off without breaking schema validation on its end.
      accountLog.info('refresh_ok', {
        chatgptAccountId: chatgptAccountId ?? '(unparseable)',
      })
      sendJsonOk(
        res,
        200,
        {
          accessToken: accessTokenStr,
          chatgptAccountId: chatgptAccountId ?? '',
          chatgptPlanType: refreshed.plan,
        },
        requestId,
      )
    } finally {
      // refresh.ts contract: callers MUST zero the buffers it returns.
      try {
        refreshed.token.fill(0)
      } catch {
        /* */
      }
      try {
        refreshed.refresh?.fill(0)
      } catch {
        /* */
      }
      // Best-effort string clear; JS strings are immutable but unset the
      // reference so the buffer is GC-reclaimable sooner.
      accessTokenStr = ''
      chatgptAccountId = null
    }
  }
}

// ─── private helpers ────────────────────────────────────────────────────────

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const b = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += b.length
    if (total > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${maxBytes} bytes`)
    }
    chunks.push(b)
  }
  if (total === 0) {
    // Empty body is acceptable here — codex protocol will always send
    // {reason, previousAccountId}, but a forwarded body could be lost.
    // Return undefined; BodySchema.safeParse(undefined) returns success
    // for an all-optional shape.
    return {}
  }
  const text = Buffer.concat(chunks, total).toString('utf-8')
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new HttpError(400, 'INVALID_JSON', `body is not valid JSON: ${(err as Error).message}`)
  }
}

function sendJsonOk(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  requestId: string,
): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body, 'utf-8')),
    [REQUEST_ID_HEADER]: requestId,
  })
  res.end(body)
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) return
  const body = JSON.stringify({
    error: { code, message },
    request_id: requestId,
  })
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body, 'utf-8')),
    [REQUEST_ID_HEADER]: requestId,
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v
  }
  res.writeHead(status, headers)
  res.end(body)
}
