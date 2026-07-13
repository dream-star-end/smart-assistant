/**
 * Self-heal broker — root-side Unix-socket privilege gateway.
 *
 * The unprivileged `ocheal` codex has NO ability to run systemctl / docker /
 * deploy. Every privileged operation is a structured request over this ACL'd
 * Unix socket, which the root-side broker validates and performs itself:
 *
 *   Tier1  — deterministic ops from the {@link TIER1_ACTIONS} allowlist
 *            (restart_service / clean_disk / switch_node). Strict param schema,
 *            fixed shell-free commands, audit log.
 *
 *   Tier2  — production cutover: `{ sha, verificationRef }`. The broker trusts
 *            NOTHING codex says. Its REAL gate is (a) canonical ancestry — the
 *            sha must descend from the canonical branch, checked by root git in
 *            the TRUSTED canonical repo after importing the candidate objects via
 *            an INERT bundle (root never runs git in the untrusted clone, so a
 *            hostile `core.fsmonitor` / hook / upload-pack config can't execute);
 *            plus (b) the human one-click release — `OC_SELFHEAL_AUTO_DEPLOY_TIER2`
 *            defaults to 0 ⇒ the request is recorded + notified as "pending
 *            release", NOT executed; only =1 auto-cuts-over. The root-signed
 *            verification (HMAC + `allPassed` + sha/repairId match) is a SOFT
 *            precondition only: `allPassed` is advisory (a candidate controls its
 *            own test scripts), so it never substitutes for (a)+(b). When it does
 *            deploy, it runs a SELF-HELD trusted deploy driver under the global
 *            deploy flock — never a script from the candidate clone.
 *
 * Idempotency: every request is atomically CLAIMED by `repairId:actionKind`
 * (keyed also by a params hash) in a durable store BEFORE any side effect, so
 * concurrent duplicates can never both execute and a crash mid-execution never
 * re-runs the side effect. A committed outcome is replayed; a same-key request
 * with different params is a conflict. See {@link BrokerClaimStore}.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync, chownSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import {
  type BrokerClaimResult,
  type SelfhealCallbackPhase,
  commitBrokerOutcomeWithCallback,
  finalizeBrokerAction,
  getBrokerAction,
  getJob as getSelfhealJob,
  overwriteBrokerActionResponse,
  releaseBrokerClaim,
  tryClaimBrokerAction,
} from '@openclaude/storage'
import { type Logger, createLogger } from '../logger.js'
import {
  type BrokerActionDef,
  BrokerActionError,
  type CommandRunner,
  type RunOpts,
  TIER1_ACTIONS,
} from './brokerActions.js'
import { listToolchainTouches } from './deployDriver.js'
import { withRepairLock } from './executionLedger.js'
import {
  type SignedVerification,
  type VerifyOutcome,
  defaultCommandRunner,
  loadSignedVerification,
  verify as runVerification,
  stableStringify,
  verifySignature,
} from './verifier.js'

const rootLog = createLogger({ module: 'selfheal-broker' })

const CUTOVER_KIND = 'cutover'
const CONTEXT_KIND = 'context'
const VERIFY_KIND = 'verify'
const REPORT_KIND = 'report'
const RELEASE_CLAIM_KIND = 'release_approved'
const MAX_REQUEST_BYTES = 64 * 1024
const CALLBACK_TIMEOUT_MS = 20_000
const MAX_CONTEXT_BYTES = 512 * 1024
const DEFAULT_REPORT_MESSAGE_MAX = 2_000
const DEFAULT_REPORT_DETAIL_MAX = 8_192

/** Kinds whose claim key includes the params hash: they are legitimately called
 *  multiple times with different params (a new sha to verify, a new progress
 *  message) — identical retries replay, different params get a fresh claim.
 *  Tier1 and cutover keep the strict one-claim-per-repair key. */
const PARAMS_KEYED_KINDS = new Set([CONTEXT_KIND, VERIFY_KIND, REPORT_KIND])

const REPORT_OUTCOMES = new Set(['progress', 'done', 'failed'])

/** Conservative free-text redaction for report messages (design §A7/M4 scope —
 *  applied here because report text is candidate/model-authored). */
export function redactSelfhealText(input: string): string {
  return input
    .replace(/sk-\w{8,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/g, 'Bearer [redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted]')
    .replace(/xox[bap]-[A-Za-z0-9-]+/g, '[redacted]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[redacted]')
    .replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, '//[redacted]@')
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&]+/gi,
      '$1$2[redacted]',
    )
}

export interface BrokerRequest {
  repairId: string
  actionKind: string
  params?: unknown
  /** Capability token bound to this repair. The broker verifies it against the
   *  durable repair record — a valid Unix connection alone is NOT authorization. */
  capability?: string
}

/** The subset of a durable repair record the broker authorizes against. */
export interface RepairAuthorityRecord {
  status: string
  capability: string | null
  /** Durable release fuse (HIGH3): set by a cancel of a terminal job — a held
   *  pending_release cutover for this repair must never be released. */
  releaseRevoked?: boolean
}

/** Resolves the durable repair record for a repairId (or null if none). */
export type RepairAuthority = (repairId: string) => Promise<RepairAuthorityRecord | null>

/** States in which a repair may request privileged broker actions. Terminal /
 *  not-yet-started jobs are rejected. */
const ACTIVE_REPAIR_STATES = new Set(['starting', 'running'])

/** Default authority backed by the durable selfheal job store. */
const defaultRepairAuthority: RepairAuthority = async (repairId) => {
  const job = await getSelfhealJob(repairId)
  return job
    ? { status: job.status, capability: job.capability, releaseRevoked: job.releaseRevoked }
    : null
}

/** Constant-time capability comparison. Length mismatch / empty ⇒ false. */
function capabilityMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

export interface BrokerResponse {
  ok: boolean
  /** Machine-readable outcome. */
  status: string
  detail?: Record<string, unknown>
  /** INTERNAL (never serialized to the socket / durable store): a master
   *  callback that must be enqueued ATOMICALLY with this outcome's finalize
   *  (审计R2 BLOCKER — a committed cutover/release without its outbox row would
   *  permanently orphan the v5 state machine). handleRequest strips it and
   *  commits outcome+callback in one SQLite transaction. */
  masterCallback?: {
    phase: SelfhealCallbackPhase
    message: string
    detail: Record<string, unknown>
  }
}

/**
 * Map a releaseApproved outcome onto the release endpoints' HTTP status
 * (BLOCKER1). The v5 admin side treats "2xx && body.ok && body.status ===
 * 'deployed'" as success, so every non-deployed outcome MUST be non-2xx —
 * a refused/held/failed release can never be read as applied:
 *   deployed (incl. idempotent replay)          → 200
 *   pending_release / rejected (ancestry,
 *     denylist, missing record, release_revoked) → 409
 *   in_progress (unfinalized prior release)      → 423
 *   deploy_failed                                → 500
 * Store/internal exceptions never reach this mapper — the handlers catch them
 * and answer 503 directly.
 */
export function releaseHttpStatusFor(resp: BrokerResponse): number {
  switch (resp.status) {
    case 'deployed':
      return 200
    case 'pending_release':
    case 'rejected':
      return 409
    case 'in_progress':
      return 423
    case 'deploy_failed':
      return 500
    default:
      return 500
  }
}

// ── idempotency store (durable, atomic single-winner claim) ──────────────────

/**
 * The broker's idempotency + claim backend. A request is claimed by
 * `repairId:actionKind` keyed ALSO by a hash of its params, BEFORE any side
 * effect. Concurrent duplicates can never both win; a committed outcome is
 * replayed; a same-key request with different params is a conflict; and a claim
 * whose handler crashed mid-execution is reported so we never re-run a side
 * effect (at-most-once). See {@link tryClaimBrokerAction}.
 */
export interface BrokerClaimStore {
  tryClaim(input: {
    claimKey: string
    repairId: string
    actionKind: string
    paramsHash: string
  }): Promise<BrokerClaimResult>
  finalize(claimKey: string, response: string): Promise<void>
  release(claimKey: string): Promise<void>
  /** Read one committed/claimed record (release path re-verifies the durable
   *  pending_release cutover record through this). */
  get(claimKey: string): Promise<{
    paramsHash: string
    status: 'claimed' | 'committed'
    response: string | null
  } | null>
  /** Update the recorded response of a COMMITTED record (e.g. pending_release →
   *  deployed after a one-click release). Never touches claimed rows. */
  overwriteCommitted(claimKey: string, response: string): Promise<void>
  /** 审计R2 BLOCKER:finalize(+可选 overwrite)与 master 回调 enqueue 必须同一
   *  事务。失败时 claim 保持 'claimed'(replay=in_progress fail-closed),调用方
   *  上报 commit_failed —— 绝不出现"已提交却无回调"的半状态。 */
  finalizeWithCallback(
    finalize: { claimKey: string; response: string }[],
    overwriteCommitted: { claimKey: string; response: string } | undefined,
    callback: {
      repairId: string
      phase: SelfhealCallbackPhase
      message: string
      detail: Record<string, unknown>
    },
  ): Promise<void>
}

/** Default durable store backed by the root-owned selfheal SQLite DB. */
export const durableBrokerClaimStore: BrokerClaimStore = {
  tryClaim: (input) => tryClaimBrokerAction(input),
  finalize: (claimKey, response) => finalizeBrokerAction(claimKey, response),
  release: (claimKey) => releaseBrokerClaim(claimKey),
  get: async (claimKey) => {
    const rec = await getBrokerAction(claimKey)
    return rec ? { paramsHash: rec.paramsHash, status: rec.status, response: rec.response } : null
  },
  overwriteCommitted: async (claimKey, response) => {
    await overwriteBrokerActionResponse(claimKey, response)
  },
  finalizeWithCallback: async (finalize, overwriteCommitted, callback) => {
    await commitBrokerOutcomeWithCallback({ finalize, overwriteCommitted, callback })
  },
}

/** In-memory store for tests / ephemeral use only. NOT durable — a real broker
 *  must use {@link durableBrokerClaimStore} (enforced in {@link SelfhealBroker}). */
export class InMemoryBrokerClaimStore implements BrokerClaimStore {
  private readonly map = new Map<string, { paramsHash: string; response?: string }>()
  async tryClaim(input: {
    claimKey: string
    repairId: string
    actionKind: string
    paramsHash: string
  }): Promise<BrokerClaimResult> {
    const cur = this.map.get(input.claimKey)
    if (!cur) {
      this.map.set(input.claimKey, { paramsHash: input.paramsHash })
      return { outcome: 'won' }
    }
    if (cur.paramsHash !== input.paramsHash) return { outcome: 'conflict' }
    if (cur.response !== undefined) return { outcome: 'replay', response: cur.response }
    return { outcome: 'in_progress' }
  }
  async finalize(claimKey: string, response: string): Promise<void> {
    const cur = this.map.get(claimKey)
    if (cur && cur.response === undefined) cur.response = response
  }
  async release(claimKey: string): Promise<void> {
    const cur = this.map.get(claimKey)
    if (cur && cur.response === undefined) this.map.delete(claimKey)
  }
  async get(claimKey: string): Promise<{
    paramsHash: string
    status: 'claimed' | 'committed'
    response: string | null
  } | null> {
    const cur = this.map.get(claimKey)
    if (!cur) return null
    return {
      paramsHash: cur.paramsHash,
      status: cur.response !== undefined ? 'committed' : 'claimed',
      response: cur.response ?? null,
    }
  }
  async overwriteCommitted(claimKey: string, response: string): Promise<void> {
    const cur = this.map.get(claimKey)
    if (cur && cur.response !== undefined) cur.response = response
  }
  /** Test-visible outbox mirror of the durable combined commit. */
  readonly outbox: {
    repairId: string
    phase: SelfhealCallbackPhase
    message: string
    detail: Record<string, unknown>
  }[] = []
  async finalizeWithCallback(
    finalize: { claimKey: string; response: string }[],
    overwriteCommitted: { claimKey: string; response: string } | undefined,
    callback: {
      repairId: string
      phase: SelfhealCallbackPhase
      message: string
      detail: Record<string, unknown>
    },
  ): Promise<void> {
    for (const f of finalize) await this.finalize(f.claimKey, f.response)
    if (overwriteCommitted)
      await this.overwriteCommitted(overwriteCommitted.claimKey, overwriteCommitted.response)
    if (!this.outbox.some((r) => r.repairId === callback.repairId && r.phase === callback.phase))
      this.outbox.push(callback)
  }
}

// ── deploy driver ────────────────────────────────────────────────────────────

/** Executes the trusted production cutover for a validated sha. Injectable so
 *  the default posture (auto-deploy off) and tests never touch prod. */
export type DeployDriver = (
  sha: string,
  ctx: { log: Logger; repairId?: string },
) => Promise<BrokerResponse>

export interface SelfhealBrokerOpts {
  socketPath: string
  /** Numeric gid ocheal belongs to; used to chown the socket so ocheal can
   *  connect, and to de-privilege the bundle-export step of the ancestry check.
   *  When omitted, socket ACL is left to the caller (tests). */
  ochealGid?: number
  /** Numeric uid of ocheal. Required in production for the cutover ancestry
   *  check: the candidate-object bundle is exported AS ocheal so root never runs
   *  git in the untrusted clone. Omitted only in tests (which inject `run`). */
  ochealUid?: number
  /** Idempotency + claim backend. Defaults to the durable SQLite-backed store;
   *  tests inject {@link InMemoryBrokerClaimStore}. */
  store?: BrokerClaimStore
  /** Resolves the durable repair record for capability authorization. Defaults
   *  to the selfheal job store; tests inject a stub. */
  repairAuthority?: RepairAuthority
  actions?: Record<string, BrokerActionDef>
  run?: CommandRunner
  log?: Logger

  // ── cutover deps ──
  /** Canonical v5 checkout — the trusted repo for ancestry checks + object
   *  import. Default /opt/openclaude/openclaude-v5-aurora. */
  canonicalRepo?: string
  /** Branch a candidate sha must descend from. Default feat/v5-aurora-rewrite. */
  canonicalBranch?: string
  /** Root of ocheal per-repair clones (object import source). Default
   *  /home/ocheal/selfheal. */
  ochealSelfhealRoot?: string
  /** Root-owned dir holding signed verifications. */
  verificationDir?: string
  /** HMAC key to verify signed verifications. Default OC_SELFHEAL_VERIFY_HMAC. */
  verifyKey?: string
  /** When true (OC_SELFHEAL_AUTO_DEPLOY_TIER2=1), a fully-gated cutover runs the
   *  deploy driver. Default false ⇒ record + notify "pending release" only. */
  autoDeployTier2?: boolean
  /** Trusted deploy driver (invoked on auto cutover AND one-click release). */
  deployDriver?: DeployDriver
  /** Called when a gated cutover is held for manual release (default posture).
   *  `toolchain` lists deploy-toolchain files the candidate touches (if any) —
   *  such a candidate can ONLY ship via a human offline standard deploy. */
  notifyPendingRelease?: (info: { repairId: string; sha: string; toolchain?: string[] }) => void

  // ── block C action deps (context / verify / report) ──
  /** OC_SELFHEAL_CALLBACK_URL — forward tunnel base to the v5 master. The
   *  broker (root) uses the job's capability against it; the capability never
   *  reaches the codex side. */
  callbackBaseUrl?: string
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable verification runner (tests). Defaults to verifier.verify with
   *  the broker's ocheal uid/gid + verification dir + signing key. */
  verifyRunner?: (input: {
    repairId: string
    sha: string
    clonePath: string
    canonicalRepo: string
    canonicalBranch: string
  }) => Promise<VerifyOutcome>
  /** Report free-text caps (defaults 2000 / 8192 chars). */
  reportMessageMaxChars?: number
  reportDetailMaxChars?: number
}

export class SelfhealBroker {
  private server: Server | null = null
  private readonly log: Logger
  private readonly store: BrokerClaimStore
  private readonly repairAuthority: RepairAuthority
  private readonly actions: Record<string, BrokerActionDef>
  private readonly run: CommandRunner
  private readonly canonicalRepo: string
  private readonly canonicalBranch: string
  private readonly ochealSelfhealRoot: string
  private readonly ochealUid?: number
  private readonly ochealGid?: number
  private readonly autoDeployTier2: boolean

  constructor(private readonly opts: SelfhealBrokerOpts) {
    this.log = opts.log ?? rootLog
    // Durable by default; an ephemeral in-memory store would silently drop
    // replay protection across a restart (Codex HIGH #4), so it must be opted in.
    this.store = opts.store ?? durableBrokerClaimStore
    this.repairAuthority = opts.repairAuthority ?? defaultRepairAuthority
    this.actions = opts.actions ?? TIER1_ACTIONS
    this.run = opts.run ?? defaultCommandRunner
    this.canonicalRepo = opts.canonicalRepo ?? '/opt/openclaude/openclaude-v5-aurora'
    this.canonicalBranch = opts.canonicalBranch ?? 'feat/v5-aurora-rewrite'
    this.ochealSelfhealRoot = opts.ochealSelfhealRoot ?? '/home/ocheal/selfheal'
    this.ochealUid = opts.ochealUid
    this.ochealGid = opts.ochealGid
    this.autoDeployTier2 = opts.autoDeployTier2 ?? process.env.OC_SELFHEAL_AUTO_DEPLOY_TIER2 === '1'
  }

  /** Start listening on the Unix socket and apply the ocheal ACL. */
  async start(): Promise<void> {
    const sock = this.opts.socketPath
    if (existsSync(sock)) {
      try {
        unlinkSync(sock)
      } catch {
        /* stale socket removal best-effort */
      }
    }
    mkdirSync(dirname(sock), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const server = createServer((c) => this.onConnection(c))
      server.on('error', reject)
      server.listen(sock, () => {
        try {
          // ACL: rw for owner (root) + group only; world has NO access. chown to
          // root:ocheal-gid so only ocheal (and root) can connect. If ochealGid
          // is unset the socket stays root:root 0660 — secure (ocheal can't
          // connect) rather than fail-open.
          chmodSync(sock, 0o660)
          chownSync(sock, process.getuid?.() ?? 0, this.opts.ochealGid ?? process.getgid?.() ?? 0)
        } catch (err) {
          // Fail CLOSED (Codex HIGH #11): an unenforced ACL could leave this
          // privileged socket world-connectable. Tear down instead of serving.
          this.log.error('broker socket ACL failed — refusing to serve', { sock }, err)
          try {
            server.close()
          } catch {
            /* best effort */
          }
          try {
            unlinkSync(sock)
          } catch {
            /* best effort */
          }
          reject(err instanceof Error ? err : new Error('broker socket ACL failed'))
          return
        }
        this.server = server
        this.log.info('selfheal broker listening', { sock, autoDeployTier2: this.autoDeployTier2 })
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.server = null
  }

  private onConnection(conn: Socket): void {
    let buf = ''
    let done = false
    const finish = (resp: BrokerResponse) => {
      if (done) return
      done = true
      try {
        conn.write(`${JSON.stringify(resp)}\n`)
      } catch {
        /* client gone */
      }
      conn.end()
    }
    conn.setEncoding('utf-8')
    conn.on('data', (chunk: string) => {
      if (done) return
      buf += chunk
      if (buf.length > MAX_REQUEST_BYTES) {
        finish({ ok: false, status: 'rejected', detail: { reason: 'request too large' } })
        return
      }
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      let req: BrokerRequest
      try {
        req = JSON.parse(line) as BrokerRequest
      } catch {
        finish({ ok: false, status: 'rejected', detail: { reason: 'invalid JSON' } })
        return
      }
      this.handleRequest(req).then(finish, (err) => {
        this.log.error('broker request crashed', {}, err)
        finish({ ok: false, status: 'error', detail: { reason: 'internal error' } })
      })
    })
    conn.on('error', () => {
      /* ignore — client disconnects are normal */
    })
  }

  /**
   * Core request handler — also the unit-test entry point (no socket needed).
   * Applies idempotency, then routes Tier1 vs cutover.
   */
  async handleRequest(req: BrokerRequest): Promise<BrokerResponse> {
    if (
      !req ||
      typeof req.repairId !== 'string' ||
      req.repairId.length === 0 ||
      typeof req.actionKind !== 'string' ||
      req.actionKind.length === 0
    ) {
      return { ok: false, status: 'rejected', detail: { reason: 'malformed request' } }
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(req.repairId)) {
      return { ok: false, status: 'rejected', detail: { reason: 'illegal repairId' } }
    }

    // Structural isolation (design §C2, R2 BLOCKER2): release is NEVER a socket
    // action — an ocheal caller cannot be trusted about its own provenance. The
    // ONLY entries into releaseApproved() are the HMAC-verified release webhook
    // and the root break-glass route (both terminate on the in-process method).
    if (req.actionKind === 'release' || req.actionKind === RELEASE_CLAIM_KIND) {
      this.audit(req, 'rejected', { reason: 'release is not a socket action' })
      return {
        ok: false,
        status: 'rejected',
        detail: {
          reason:
            'release is not a socket action — it only enters via the signed v5 webhook or the root break-glass route',
        },
      }
    }

    // Authorization (Codex HIGH #5, amended by block C): a valid Unix socket
    // connection is NOT authorization — the request must name an ACTIVE repair.
    // Checked BEFORE the claim so an unauthorized request never touches the
    // idempotency ledger. See authorizeRepair for the capability posture.
    const authz = await this.authorizeRepair(req)
    if (!authz.ok) {
      this.log.warn('broker request unauthorized', { repairId: req.repairId, reason: authz.reason })
      return { ok: false, status: 'unauthorized', detail: { reason: authz.reason } }
    }

    // Hash the params so a same-key request with DIFFERENT params is a conflict,
    // not a silent replay of the old outcome (Codex HIGH #13). context/verify/
    // report are params-keyed (multiple legitimate invocations per repair).
    const paramsHash = createHash('sha256')
      .update(stableStringify(req.params ?? null))
      .digest('hex')
    const key = PARAMS_KEYED_KINDS.has(req.actionKind)
      ? `${req.repairId}:${req.actionKind}:${paramsHash.slice(0, 16)}`
      : `${req.repairId}:${req.actionKind}`

    // Atomically claim BEFORE any side effect (Codex HIGH #3/#4): single winner,
    // durable across restart.
    const claim = await this.store.tryClaim({
      claimKey: key,
      repairId: req.repairId,
      actionKind: req.actionKind,
      paramsHash,
    })
    if (claim.outcome === 'replay') {
      const prior = JSON.parse(claim.response ?? '{}') as BrokerResponse
      this.log.info('broker idempotent replay', { key, status: prior.status })
      return { ...prior, detail: { ...prior.detail, replayed: true } }
    }
    if (claim.outcome === 'conflict') {
      this.log.warn('broker claim conflict — key reused with different params', { key })
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'repairId:actionKind reused with different params' },
      }
    }
    if (claim.outcome === 'in_progress') {
      // A prior claim executed (or was mid-execution) and never finalized — the
      // side effect may already have happened. Fail closed: never re-execute.
      this.log.warn('broker claim in_progress — refusing to re-execute', { key })
      return {
        ok: false,
        status: 'in_progress',
        detail: { reason: 'a prior claim did not finalize; not re-executing (at-most-once)' },
      }
    }

    // We won the claim. Execute, then either finalize (side-effecting outcome is
    // permanent) or release (a non-side-effecting validation reject may be retried).
    let response: BrokerResponse
    try {
      switch (req.actionKind) {
        case CUTOVER_KIND:
          response = await this.handleCutover(req, authz.rec)
          break
        case CONTEXT_KIND:
          response = await this.handleContext(req, authz.rec)
          break
        case VERIFY_KIND:
          response = await this.handleVerify(req)
          break
        case REPORT_KIND:
          response = await this.handleReport(req, authz.rec)
          break
        default:
          response = await this.handleTier1(req)
      }
    } catch (err) {
      await this.store.release(key)
      throw err
    }
    if (this.isCommitted(response)) {
      const cb = response.masterCallback
      if (cb) {
        // 审计R2 BLOCKER:committed 结果与其 master 回调必须同一 SQLite 事务。
        // 失败 → claim 保持 'claimed'(replay=in_progress fail-closed),如实上报
        // commit_failed;绝不 release(否则重试会重跑副作用)。
        const { masterCallback: _stripped, ...wire } = response
        try {
          await this.store.finalizeWithCallback(
            [{ claimKey: key, response: JSON.stringify(wire) }],
            undefined,
            { repairId: req.repairId, ...cb },
          )
        } catch (err) {
          this.log.error(
            'broker outcome commit failed — claim held fail-closed',
            { repairId: req.repairId, actionKind: req.actionKind },
            err as Error,
          )
          this.audit(req, 'commit_failed', {
            reason: String((err as Error).message).slice(0, 200),
          })
          return {
            ok: false,
            status: 'commit_failed',
            detail: {
              reason:
                'outcome durable commit failed — claim held; retry reports in_progress (see runbook)',
            },
          }
        }
        return wire
      }
      await this.store.finalize(key, JSON.stringify(response))
    } else {
      await this.store.release(key)
    }
    return response
  }

  /**
   * Authorize a request against the durable repair record.
   *
   * Capability posture (block C final trust model): the capability NEVER
   * reaches the codex/ocheal side (M-capability — it lives only on the job row,
   * root-readable), so a socket request CANNOT be required to present it.
   * Socket-path authorization is therefore: socket ACL (only ocheal + root can
   * connect) + the request naming an ACTIVE repair. When a caller DOES present
   * a capability it must match (defense in depth for root-side tooling); a
   * wrong capability is always rejected.
   */
  private async authorizeRepair(
    req: BrokerRequest,
  ): Promise<{ ok: true; rec: RepairAuthorityRecord } | { ok: false; reason: string }> {
    let rec: RepairAuthorityRecord | null
    try {
      rec = await this.repairAuthority(req.repairId)
    } catch (err) {
      this.log.error('repair authority lookup failed — denying', { repairId: req.repairId }, err)
      return { ok: false, reason: 'authority unavailable' }
    }
    if (!rec) return { ok: false, reason: 'unknown repair' }
    if (!ACTIVE_REPAIR_STATES.has(rec.status)) return { ok: false, reason: 'repair not active' }
    if (typeof req.capability === 'string' && req.capability.length > 0) {
      if (!rec.capability || !capabilityMatches(req.capability, rec.capability)) {
        return { ok: false, reason: 'capability mismatch' }
      }
    }
    return { ok: true, rec }
  }

  private isCommitted(resp: BrokerResponse): boolean {
    return resp.ok || resp.status === 'pending_release' || resp.status === 'deployed'
  }

  private async handleTier1(req: BrokerRequest): Promise<BrokerResponse> {
    const action = this.actions[req.actionKind]
    if (!action) {
      this.audit(req, 'rejected', { reason: 'unknown action' })
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: `unknown action ${req.actionKind}` },
      }
    }
    let params: unknown
    try {
      params = action.validate(req.params)
    } catch (err) {
      const reason = err instanceof BrokerActionError ? err.message : 'invalid params'
      this.audit(req, 'rejected', { reason })
      return { ok: false, status: 'rejected', detail: { reason } }
    }
    const result = await action.execute(params, { run: this.run, log: this.log })
    this.audit(req, result.status, result.detail)
    return result
  }

  private async handleCutover(
    req: BrokerRequest,
    authority: RepairAuthorityRecord,
  ): Promise<BrokerResponse> {
    const p = (req.params ?? {}) as Record<string, unknown>
    const sha = typeof p.sha === 'string' ? p.sha : ''
    const verificationRef = typeof p.verificationRef === 'string' ? p.verificationRef : ''
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return this.rejectCutover(req, 'sha must be a full 40-char hex commit')
    }
    if (!/^[A-Za-z0-9._-]+$/.test(verificationRef)) {
      return this.rejectCutover(req, 'invalid verificationRef')
    }

    // (a) SOFT precondition: a root-signed verification (ocheal can't forge it —
    //     no HMAC key in its env) whose sha/repairId match and whose advisory
    //     `allPassed` is true. NOT a standalone trust anchor — see (b).
    let signed: SignedVerification
    try {
      signed = loadSignedVerification(verificationRef, this.opts.verificationDir)
    } catch (err) {
      return this.rejectCutover(req, `verification not found: ${(err as Error).message}`)
    }
    if (!verifySignature(signed, this.opts.verifyKey)) {
      return this.rejectCutover(req, 'verification signature invalid')
    }
    const vr = signed.result
    if (vr.repairId !== req.repairId) {
      return this.rejectCutover(req, 'verification repairId mismatch')
    }
    if (vr.sha !== sha) {
      return this.rejectCutover(req, 'verification sha mismatch')
    }
    if (!vr.allPassed) {
      return this.rejectCutover(req, 'verification did not pass all layers')
    }

    // (b) REAL trust anchor #1: sha must descend from the canonical branch —
    //     broker's own check in the trusted canonical repo (inert bundle import,
    //     no code from the untrusted clone ever runs). Combined with (c) the
    //     human release, this is what actually gates a deploy.
    const ancestor = await this.checkCanonicalAncestry(req.repairId, sha)
    if (!ancestor) {
      return this.rejectCutover(req, 'sha is not a descendant of the canonical branch')
    }

    // (c) Auto-deploy gate. Default posture: hold for manual release. The
    //     toolchain denylist is probed here too so the pending notification
    //     carries the "manual offline deploy only" annotation up front (the
    //     driver re-enforces it as the hard gate at deploy time).
    if (!this.autoDeployTier2) {
      const touched = (await listToolchainTouches(this.run, this.canonicalRepo, sha)) ?? []
      this.audit(req, 'pending_release', { sha, ...(touched.length ? { toolchain: touched } : {}) })
      this.opts.notifyPendingRelease?.({
        repairId: req.repairId,
        sha,
        ...(touched.length ? { toolchain: touched } : {}),
      })
      this.log.warn('cutover fully gated but AUTO_DEPLOY_TIER2=0 — held for manual release', {
        repairId: req.repairId,
        sha,
      })
      // Deterministic root-side pending_release marker to the master (seam
      // contract: the admin release gate requires a progress event with
      // detail.phase='pending_release', and codex cannot be relied on to send
      // it). 审计R2 BLOCKER:marker 与本 outcome 的 finalize 必须同一事务 ——
      // masterCallback 由 handleRequest 与 claim finalize 原子提交,失败则
      // claim 不提交(commit_failed,重试重跑本无副作用的 cutover 检查)。
      return {
        ok: false,
        status: 'pending_release',
        detail: {
          sha,
          ...(touched.length ? { toolchain: true, files: touched.slice(0, 20) } : {}),
          reason: 'awaiting one-click release (OC_SELFHEAL_AUTO_DEPLOY_TIER2=0)',
        },
        masterCallback: {
          phase: 'pending_release',
          message: 'pending_release: verified and gated — awaiting one-click release',
          detail: { phase: 'pending_release', sha, ...(touched.length ? { toolchain: true } : {}) },
        },
      }
    }

    // (d) Trusted, self-held deploy (driver re-checks the toolchain denylist as
    //     the execution-time hard gate, then ff-merges + runs canonical deploy).
    const driver = this.opts.deployDriver
    if (!driver) {
      return this.rejectCutover(req, 'no trusted deploy driver configured')
    }
    const result = await driver(sha, { log: this.log, repairId: req.repairId })
    this.audit(req, result.status, { sha, ...result.detail })
    if (result.status === 'deployed') {
      const trustedAttestation = await this.buildTrustedAttestation(
        req.repairId,
        authority,
        'deploy_v5',
        result.detail?.healthCheck,
      )
      // Auto-deploy path closes the loop root-side: master → 'verifying',
      // probe fence adjudicates real recovery. done 标记与 finalize 原子提交
      // (审计R2 BLOCKER,经 masterCallback → handleRequest 合并事务)。
      return {
        ...result,
        masterCallback: {
          phase: 'done',
          message: 'auto cutover deployed',
          detail: {
            phase: 'deployed',
            sha,
            ...(trustedAttestation ? { trusted_attestation: trustedAttestation } : {}),
          },
        },
      }
    }
    return result
  }

  /**
   * Root-authored attestation for the narrow fully-automatic deploy path.
   * Model-authored `report done` and human release never call this method.
   */
  private async buildTrustedAttestation(
    repairId: string,
    authority: RepairAuthorityRecord,
    action: string,
    healthCheck: unknown,
  ): Promise<Record<string, unknown> | null> {
    if (!healthCheck || typeof healthCheck !== 'object' || Array.isArray(healthCheck)) return null
    const h = healthCheck as Record<string, unknown>
    if (
      h.kind !== 'deploy-v5-smoke' ||
      h.ok !== true ||
      h.target !== 'service:v5' ||
      typeof h.checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(h.checkedAt))
    )
      return null
    const context = await this.handleContext(
      { repairId, actionKind: CONTEXT_KIND, params: {} },
      authority,
    )
    const raw = context.detail?.context
    if (!context.ok || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const c = raw as Record<string, unknown>
    const incidentId = typeof c.incidentId === 'string' ? c.incidentId : ''
    const conditionKey = typeof c.conditionKey === 'string' ? c.conditionKey : ''
    const target =
      conditionKey === 'ops.monitor:svc_v5' || conditionKey === 'ops.monitor:http_v5'
        ? 'service:v5'
        : ''
    if (!incidentId || !conditionKey || !target) return null
    return {
      version: 1,
      repairId,
      incidentId,
      conditionKey,
      target,
      action,
      executionMode: 'fully_automatic',
      executed: true,
      remoteResult: {
        ok: true,
        target,
        healthOk: true,
        checkedAt: h.checkedAt,
      },
    }
  }

  // ── block C action handlers (context / verify / report) ─────────────────────

  /** `context {repairId}` — fetch the structured incident context from the v5
   *  master using the ROOT-HELD capability (never exposed to the caller's env;
   *  the response body is the only thing the codex sees). */
  private async handleContext(
    req: BrokerRequest,
    rec: RepairAuthorityRecord,
  ): Promise<BrokerResponse> {
    const base = this.opts.callbackBaseUrl?.replace(/\/$/, '')
    if (!base) {
      this.audit(req, 'rejected', { reason: 'callback base url not configured' })
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'callback base url not configured' },
      }
    }
    if (!rec.capability) {
      this.audit(req, 'rejected', { reason: 'repair has no capability yet' })
      return { ok: false, status: 'rejected', detail: { reason: 'repair has no capability yet' } }
    }
    const f = this.opts.fetchImpl ?? fetch
    const url = `${base}/internal/v5/repairs/${encodeURIComponent(req.repairId)}/context`
    try {
      const res = await f(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${rec.capability}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      })
      if (!res.ok) {
        this.audit(req, 'context_failed', { httpStatus: res.status })
        return { ok: false, status: 'context_failed', detail: { httpStatus: res.status } }
      }
      const text = await res.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_CONTEXT_BYTES) {
        return { ok: false, status: 'context_failed', detail: { reason: 'context too large' } }
      }
      let context: unknown
      try {
        context = JSON.parse(text)
      } catch {
        return {
          ok: false,
          status: 'context_failed',
          detail: { reason: 'invalid JSON from master' },
        }
      }
      this.audit(req, 'ok')
      return { ok: true, status: 'ok', detail: { context } }
    } catch (err) {
      this.audit(req, 'context_failed', { reason: String((err as Error).message).slice(0, 200) })
      return {
        ok: false,
        status: 'context_failed',
        detail: { reason: String((err as Error).message).slice(0, 200) },
      }
    }
  }

  /** `verify {repairId, sha}` — run the de-privileged four-layer verification
   *  against the repair's clone and return the (root-signed) summary. */
  private async handleVerify(req: BrokerRequest): Promise<BrokerResponse> {
    const p = (req.params ?? {}) as Record<string, unknown>
    const sha = typeof p.sha === 'string' ? p.sha : ''
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      this.audit(req, 'rejected', { reason: 'sha must be a full 40-char hex commit' })
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'sha must be a full 40-char hex commit' },
      }
    }
    const clonePath = join(this.ochealSelfhealRoot, req.repairId)
    const runVerify =
      this.opts.verifyRunner ??
      (async (input: {
        repairId: string
        sha: string
        clonePath: string
        canonicalRepo: string
        canonicalBranch: string
      }) => {
        if (this.ochealUid === undefined || this.ochealGid === undefined) {
          throw new Error('ochealUid/ochealGid not configured — refusing a root-privileged verify')
        }
        return runVerification({
          repairId: input.repairId,
          sha: input.sha,
          clonePath: input.clonePath,
          canonicalRepo: input.canonicalRepo,
          canonicalBranch: input.canonicalBranch,
          ochealUid: this.ochealUid,
          ochealGid: this.ochealGid,
          verificationDir: this.opts.verificationDir,
          signingKey: this.opts.verifyKey,
          run: this.opts.run,
        })
      })
    try {
      const outcome = await runVerify({
        repairId: req.repairId,
        sha,
        clonePath,
        canonicalRepo: this.canonicalRepo,
        canonicalBranch: this.canonicalBranch,
      })
      const result = outcome.signed.result
      const dir =
        this.opts.verificationDir ??
        process.env.OC_SELFHEAL_VERIFY_DIR ??
        '/var/lib/openclaude-selfheal/verifications'
      const detail = {
        allPassed: result.allPassed,
        verificationRef: outcome.verificationRef,
        file: join(dir, `${outcome.verificationRef}.json`),
        layers: result.layers.map((l) => ({ name: l.name, ok: l.ok, code: l.code })),
      }
      this.audit(req, 'verified', { sha, allPassed: result.allPassed })
      return { ok: true, status: 'verified', detail }
    } catch (err) {
      this.audit(req, 'verify_failed', {
        sha,
        reason: String((err as Error).message).slice(0, 300),
      })
      return {
        ok: false,
        status: 'verify_failed',
        detail: { reason: String((err as Error).message).slice(0, 300) },
      }
    }
  }

  /** `report {repairId, outcome, message, detail?}` — forward a redacted,
   *  length-capped progress/终态 report to the v5 master (capability POST). */
  private async handleReport(
    req: BrokerRequest,
    rec: RepairAuthorityRecord,
  ): Promise<BrokerResponse> {
    const p = (req.params ?? {}) as Record<string, unknown>
    const outcome = typeof p.outcome === 'string' ? p.outcome : ''
    if (!REPORT_OUTCOMES.has(outcome)) {
      this.audit(req, 'rejected', { reason: 'outcome must be progress|done|failed' })
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'outcome must be progress|done|failed' },
      }
    }
    if (typeof p.message !== 'string' || p.message.length === 0) {
      this.audit(req, 'rejected', { reason: 'message is required' })
      return { ok: false, status: 'rejected', detail: { reason: 'message is required' } }
    }
    if (p.detail !== undefined && typeof p.detail !== 'string') {
      this.audit(req, 'rejected', { reason: 'detail must be a string when present' })
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'detail must be a string when present' },
      }
    }
    const base = this.opts.callbackBaseUrl?.replace(/\/$/, '')
    if (!base) {
      this.audit(req, 'rejected', { reason: 'callback base url not configured' })
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'callback base url not configured' },
      }
    }
    if (!rec.capability) {
      this.audit(req, 'rejected', { reason: 'repair has no capability yet' })
      return { ok: false, status: 'rejected', detail: { reason: 'repair has no capability yet' } }
    }
    const msgMax = this.opts.reportMessageMaxChars ?? DEFAULT_REPORT_MESSAGE_MAX
    const detailMax = this.opts.reportDetailMaxChars ?? DEFAULT_REPORT_DETAIL_MAX
    const message = redactSelfhealText(p.message).slice(0, msgMax)
    // Cross-repo schema (MED1): the v5 callback requires `detail` to be a JSON
    // OBJECT. The CLI/socket contract stays string-only (free text from codex),
    // so the broker wraps the redacted string as { text } before sending.
    const detailText =
      p.detail !== undefined ? redactSelfhealText(p.detail).slice(0, detailMax) : undefined
    const f = this.opts.fetchImpl ?? fetch
    const url = `${base}/internal/v5/repairs/${encodeURIComponent(req.repairId)}/${outcome}`
    try {
      const res = await f(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rec.capability}`,
        },
        body: JSON.stringify({
          message,
          ...(detailText !== undefined ? { detail: { text: detailText } } : {}),
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      })
      if (!res.ok) {
        this.audit(req, 'report_failed', { outcome, httpStatus: res.status })
        return { ok: false, status: 'report_failed', detail: { outcome, httpStatus: res.status } }
      }
      this.audit(req, 'reported', { outcome })
      return { ok: true, status: 'reported', detail: { outcome, httpStatus: res.status } }
    } catch (err) {
      this.audit(req, 'report_failed', {
        outcome,
        reason: String((err as Error).message).slice(0, 200),
      })
      return {
        ok: false,
        status: 'report_failed',
        detail: { outcome, reason: String((err as Error).message).slice(0, 200) },
      }
    }
  }

  // ── one-click release (in-process ONLY — never a socket action) ─────────────

  /**
   * Release a held cutover (design §C3). Callers: the HMAC-verified release
   * webhook (v5 admin one-click) and the root break-glass route — both hold a
   * reference to this broker instance; nothing on the ocheal socket can reach
   * this method.
   *
   * Re-verifies EVERYTHING from durable state (never trusts the request):
   *   1. the durable cutover record must exist, be committed, and be
   *      'pending_release' (the sha comes from that record, not the caller);
   *   2. its own release claim (at-most-once deploy across duplicates/crashes);
   *   3. canonical ancestry, re-checked from scratch;
   *   4. the deploy driver — whose toolchain denylist re-runs as the hard gate,
   *      so a toolchain-touching candidate is refused here too.
   */
  async releaseApproved(repairId: string): Promise<BrokerResponse> {
    if (!/^[A-Za-z0-9._:-]+$/.test(repairId)) {
      return { ok: false, status: 'rejected', detail: { reason: 'illegal repairId' } }
    }

    // Release fuse (HIGH3): a cancel of a terminal job durably revokes any held
    // release — checked at entry, before the claim, so a revoked repair can
    // never consume a release claim or reach the driver. Authority lookup
    // failure fails CLOSED (this method's outcome is a production deploy).
    let authRec: RepairAuthorityRecord | null
    try {
      authRec = await this.repairAuthority(repairId)
    } catch (err) {
      this.log.error('release authority lookup failed — refusing', { repairId }, err)
      return { ok: false, status: 'rejected', detail: { reason: 'authority unavailable' } }
    }
    if (authRec?.releaseRevoked) {
      this.log.warn('release refused — revoked by cancel', { repairId })
      this.audit({ repairId, actionKind: RELEASE_CLAIM_KIND }, 'rejected', {
        reason: 'release_revoked',
      })
      return { ok: false, status: 'rejected', detail: { reason: 'release_revoked' } }
    }

    const cutoverKey = `${repairId}:${CUTOVER_KIND}`
    const rec = await this.store.get(cutoverKey)
    if (!rec || rec.status !== 'committed' || !rec.response) {
      this.log.warn('release refused — no committed cutover record', { repairId })
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'no committed cutover record for this repair' },
      }
    }
    let prior: BrokerResponse
    try {
      prior = JSON.parse(rec.response) as BrokerResponse
    } catch {
      return { ok: false, status: 'rejected', detail: { reason: 'corrupt cutover record' } }
    }
    // The sha authority is the DURABLE record's detail (present for both a
    // pending_release and an already-released record) — never the caller.
    const sha = typeof prior.detail?.sha === 'string' ? (prior.detail.sha as string) : ''
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'cutover record has no valid sha' },
      }
    }

    // At-most-once release claim (durable): duplicates replay, a crash mid-deploy
    // is fail-closed 'in_progress' (never re-run the deploy blindly). This MUST
    // precede the pending-status check: a successful release flips the cutover
    // record to 'deployed', and a duplicate release must replay — not reject.
    const releaseKey = `${repairId}:${RELEASE_CLAIM_KIND}`
    const paramsHash = createHash('sha256').update(stableStringify({ sha })).digest('hex')
    const claim = await this.store.tryClaim({
      claimKey: releaseKey,
      repairId,
      actionKind: RELEASE_CLAIM_KIND,
      paramsHash,
    })
    if (claim.outcome === 'replay') {
      const priorRelease = JSON.parse(claim.response ?? '{}') as BrokerResponse
      this.log.info('release idempotent replay', { repairId, status: priorRelease.status })
      return { ...priorRelease, detail: { ...priorRelease.detail, replayed: true } }
    }
    if (claim.outcome === 'in_progress') {
      return {
        ok: false,
        status: 'in_progress',
        detail: { reason: 'a prior release did not finalize; not re-executing (at-most-once)' },
      }
    }
    if (claim.outcome === 'conflict') {
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: 'release claim conflict (sha changed?)' },
      }
    }
    // We won the claim — the record must still be awaiting release.
    if (prior.status !== 'pending_release') {
      await this.store.release(releaseKey)
      return {
        ok: false,
        status: 'rejected',
        detail: { reason: `cutover is not pending release (status ${prior.status})` },
      }
    }

    let response: BrokerResponse
    try {
      // HIGH2(审计R2):从 fuse 终检到 driver 执行必须与 terminal-cancel 的
      // fuse 写入共享同一 per-repair 临界区 —— 入口检查早已通过的在途 release,
      // cancel 设 fuse 后不得再进 driver。锁内 fresh 读,先赢者胜:release 先赢
      // 则锁持有至部署结束(cancel 等待,部署后取消=业务上"太迟",审计留痕);
      // cancel 先赢则这里拒绝。deploy 时长受锁保护是有意为之(bounded,单 repair)。
      response = await withRepairLock(repairId, async (): Promise<BrokerResponse> => {
        let fresh: RepairAuthorityRecord | null
        try {
          fresh = await this.repairAuthority(repairId)
        } catch (err) {
          this.log.error('release authority re-check failed — refusing', { repairId }, err)
          return { ok: false, status: 'rejected', detail: { reason: 'authority unavailable' } }
        }
        if (fresh?.releaseRevoked) {
          this.audit({ repairId, actionKind: RELEASE_CLAIM_KIND }, 'rejected', {
            reason: 'release_revoked',
          })
          return { ok: false, status: 'rejected', detail: { reason: 'release_revoked' } }
        }
        const ancestor = await this.checkCanonicalAncestry(repairId, sha)
        if (!ancestor) {
          return {
            ok: false,
            status: 'rejected',
            detail: { reason: 'sha is not a descendant of the canonical branch' },
          }
        }
        const driver = this.opts.deployDriver
        if (!driver) {
          return {
            ok: false,
            status: 'rejected',
            detail: { reason: 'no trusted deploy driver configured' },
          }
        }
        return await driver(sha, { log: this.log, repairId })
      })
    } catch (err) {
      await this.store.release(releaseKey)
      throw err
    }

    if (response.status === 'deployed') {
      // 审计R2 BLOCKER:done 标记 + release finalize + cutover 记录翻转必须同一
      // SQLite 事务 —— 部署已发生却没有 outbox 行 = master 永远等不到 done。
      // 事务失败:release claim 保持 'claimed'(replay=in_progress fail-closed,
      // 绝不重跑部署),如实上报 commit_failed(500),人工按 runbook 收口。
      try {
        await this.store.finalizeWithCallback(
          [{ claimKey: releaseKey, response: JSON.stringify(response) }],
          { claimKey: cutoverKey, response: JSON.stringify(response) },
          {
            repairId,
            phase: 'done',
            message: 'released and deployed',
            detail: { phase: 'deployed', sha },
          },
        )
      } catch (err) {
        this.log.error(
          'release outcome commit failed — claim held fail-closed',
          { repairId },
          err as Error,
        )
        this.audit({ repairId, actionKind: RELEASE_CLAIM_KIND }, 'commit_failed', {
          sha,
          reason: String((err as Error).message).slice(0, 200),
        })
        return {
          ok: false,
          status: 'commit_failed',
          detail: {
            sha,
            reason: 'deploy succeeded but durable commit failed — claim held; see runbook',
          },
        }
      }
    } else {
      // Not deployed (toolchain hold / driver failure / gate reject): release
      // the claim so a corrected future release attempt can retry.
      await this.store.release(releaseKey)
    }
    this.audit({ repairId, actionKind: RELEASE_CLAIM_KIND }, response.status, {
      sha,
      ...response.detail,
    })
    return response
  }

  private rejectCutover(req: BrokerRequest, reason: string): BrokerResponse {
    this.audit(req, 'rejected', { reason })
    this.log.warn('cutover rejected', { repairId: req.repairId, reason })
    return { ok: false, status: 'rejected', detail: { reason } }
  }

  /**
   * Verify `sha` descends from the canonical branch WITHOUT root ever running git
   * inside the untrusted ocheal clone (a hostile clone config can execute code —
   * core.fsmonitor, upload-pack / pack-objects hooks). Instead:
   *   1. ocheal (de-privileged) pins the sha under a ref and exports it to an
   *      INERT bundle file;
   *   2. root imports that bundle into the TRUSTED canonical repo — a bundle is a
   *      static pack, so no upload-pack and no hook from the clone ever runs;
   *   3. root runs the ancestry check entirely inside the canonical repo.
   * Any failure ⇒ fail closed (return false).
   */
  private async checkCanonicalAncestry(repairId: string, sha: string): Promise<boolean> {
    const clonePath = join(this.ochealSelfhealRoot, repairId)
    const bundlePath = `${clonePath}.import.bundle`
    const exportRef = `refs/selfheal/export/${repairId}`

    // Fail closed: in production (default runner, no injected mock) the export
    // MUST drop to ocheal — otherwise root git would run in the untrusted clone.
    if (this.opts.run === undefined && this.ochealUid === undefined) {
      this.log.error('cutover ancestry requires ochealUid in production', { repairId })
      return false
    }
    const asOcheal: RunOpts | undefined =
      this.ochealUid !== undefined && this.ochealGid !== undefined
        ? { uid: this.ochealUid, gid: this.ochealGid }
        : undefined
    // Neutralize code-executing config on the clone side too (these already run
    // as ocheal — defense in depth + determinism).
    const cloneGuards = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=',
      '-c',
      'uploadpack.packObjectsHook=',
    ]

    // 1a. Pin the sha under a ref we control (also fails closed if sha is absent).
    const ref = await this.run(
      'git',
      [...cloneGuards, '-C', clonePath, 'update-ref', exportRef, sha],
      asOcheal,
    )
    if (ref.code !== 0) {
      this.log.warn('cutover export ref failed', {
        repairId,
        code: ref.code,
        stderr: ref.stderr.slice(0, 300),
      })
      return false
    }
    // 1b. Export that ref to an inert bundle (as ocheal).
    const bundle = await this.run(
      'git',
      [...cloneGuards, '-C', clonePath, 'bundle', 'create', bundlePath, exportRef],
      asOcheal,
    )
    if (bundle.code !== 0) {
      this.log.warn('cutover bundle export failed', {
        repairId,
        code: bundle.code,
        stderr: bundle.stderr.slice(0, 300),
      })
      return false
    }
    // 2. Import the inert bundle into the TRUSTED canonical repo (root, hooks off).
    const imp = await this.run('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      this.canonicalRepo,
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      bundlePath,
      `+${exportRef}:refs/selfheal/import/${repairId}`,
    ])
    if (imp.code !== 0) {
      this.log.warn('cutover object import failed', {
        repairId,
        code: imp.code,
        stderr: imp.stderr.slice(0, 500),
      })
      return false
    }
    // 3. Ancestry check, entirely inside the trusted canonical repo.
    const anc = await this.run('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      this.canonicalRepo,
      'merge-base',
      '--is-ancestor',
      this.canonicalBranch,
      sha,
    ])
    // exit 0 ⇒ canonicalBranch IS an ancestor of sha (sha is a descendant).
    return anc.code === 0
  }

  private audit(req: BrokerRequest, status: string, detail?: Record<string, unknown>): void {
    this.log.info('selfheal broker action', {
      repairId: req.repairId,
      actionKind: req.actionKind,
      status,
      ...(detail ? { detail } : {}),
    })
  }
}
