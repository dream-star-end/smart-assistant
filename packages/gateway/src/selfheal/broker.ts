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
  type ReleaseJobInsertInput,
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
} from './brokerActions.js'
import {
  type CutoverClassifyResult,
  classifyDiff,
  classifyForCutover,
  loadTrustedManifest,
} from './deploySurfaces.js'
import { releasePayloadHash } from './releaseIntake.js'
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
  /** Authoritative condition key frozen from the v5 master context at job
   *  start. Drill authorization reads ONLY this value — never the model's
   *  self-description. null/absent = not frozen = treated as non-drill. */
  conditionKey?: string | null
  /** Incident this repair belongs to (from the durable repair record). The
   *  auto-deploy enqueue freezes it into the release job; sourced from the SAME
   *  authority fetch rather than a second job read. null/absent ⇒ auto release
   *  is refused (fail-closed — a release job must be traceable to an incident). */
  incidentId?: string | null
}

/**
 * Transport-drill condition key — cross-repo contract with the v5 side
 * (packages/commercial/src/selfheal/conditionKeys.ts SELFHEAL_DRILL_TRANSPORT).
 * A repair whose FROZEN condition key equals this constant is a transport
 * drill: it may only pull context and report — verify/cutover/Tier1 are
 * rejected server-side (a SKILL instruction is guidance, not a permission
 * boundary). Exact-match only; future drill kinds extend this set explicitly.
 */
export const SELFHEAL_DRILL_TRANSPORT_KEY = 'selfheal.drill:transport_v1'

/**
 * Release-drill condition key (batch1b) — cross-repo contract with the v5 side
 * (packages/commercial/src/selfheal/conditionKeys.ts SELFHEAL_DRILL_RELEASE,
 * SAME string). A repair whose FROZEN key equals this may exercise the full
 * verify + cutover release path (still held at pending_release — a drill never
 * auto-deploys), but NOTHING else.
 */
export const SELFHEAL_DRILL_RELEASE_KEY = 'selfheal.drill:release_v1'

/**
 * Per-drill server-side action allowlist, keyed by the FROZEN condition key.
 * A drill repair may ONLY perform actions in its set; everything else — every
 * Tier1 host opcode included — is rejected before the idempotency claim.
 *
 * INVARIANT (RFC §5 "Tier1 拒一切 drill"): no drill allowlist may ever contain a
 * Tier1 host-opcode kind. Because these sets hold only block-C kinds
 * (context/report/verify/cutover), Tier1 opcodes (routed via handleTier1) are
 * structurally denied for every drill — this map is the single authority.
 */
const DRILL_ALLOWED_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [SELFHEAL_DRILL_TRANSPORT_KEY, new Set([CONTEXT_KIND, REPORT_KIND])],
  [SELFHEAL_DRILL_RELEASE_KEY, new Set([CONTEXT_KIND, REPORT_KIND, VERIFY_KIND, CUTOVER_KIND])],
])

/** Resolves the durable repair record for a repairId (or null if none). */
export type RepairAuthority = (repairId: string) => Promise<RepairAuthorityRecord | null>

/** States in which a repair may request privileged broker actions. Terminal /
 *  not-yet-started jobs are rejected. */
const ACTIVE_REPAIR_STATES = new Set(['starting', 'running'])

/** Default authority backed by the durable selfheal job store. */
const defaultRepairAuthority: RepairAuthority = async (repairId) => {
  const job = await getSelfhealJob(repairId)
  return job
    ? {
        status: job.status,
        capability: job.capability,
        releaseRevoked: job.releaseRevoked,
        conditionKey: job.conditionKey,
        incidentId: job.incidentId,
      }
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
  /** INTERNAL (never serialized): a local release job to insert in the SAME
   *  SQLite transaction as this outcome's finalize (R2-4). The auto-cutover sets
   *  it so the durable cutover broker_action and its release job commit atomically
   *  ("cutover committed ⟺ job exists") — replacing the old best-effort
   *  post-commit enqueue hook that could leave "record present, job absent". */
  releaseJobInsert?: ReleaseJobInsertInput
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
  /** 审计R2 BLOCKER + R2-4:finalize(+可选 overwrite)与 master 回调 enqueue
   *  以及可选的 release job 插入必须同一事务。失败时 claim 保持 'claimed'
   *  (replay=in_progress fail-closed),调用方上报 commit_failed —— 绝不出现
   *  "已提交却无回调 / 已提交却无 release job"的半状态。`callback` 可缺省(auto
   *  cutover 只需原子插 release job,无 master 回调)。 */
  finalizeWithCallback(
    finalize: { claimKey: string; response: string }[],
    overwriteCommitted: { claimKey: string; response: string } | undefined,
    callback:
      | {
          repairId: string
          phase: SelfhealCallbackPhase
          message: string
          detail: Record<string, unknown>
        }
      | undefined,
    releaseJobInsert?: ReleaseJobInsertInput,
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
  finalizeWithCallback: async (finalize, overwriteCommitted, callback, releaseJobInsert) => {
    await commitBrokerOutcomeWithCallback({ finalize, overwriteCommitted, callback, releaseJobInsert })
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
  /** Test-visible mirror of release jobs inserted in the SAME atomic commit
   *  (R2-4), PK-idempotent on release_request_id like the durable path. */
  readonly releaseJobs: ReleaseJobInsertInput[] = []
  async finalizeWithCallback(
    finalize: { claimKey: string; response: string }[],
    overwriteCommitted: { claimKey: string; response: string } | undefined,
    callback:
      | {
          repairId: string
          phase: SelfhealCallbackPhase
          message: string
          detail: Record<string, unknown>
        }
      | undefined,
    releaseJobInsert?: ReleaseJobInsertInput,
  ): Promise<void> {
    for (const f of finalize) await this.finalize(f.claimKey, f.response)
    if (overwriteCommitted)
      await this.overwriteCommitted(overwriteCommitted.claimKey, overwriteCommitted.response)
    if (
      callback &&
      !this.outbox.some((r) => r.repairId === callback.repairId && r.phase === callback.phase)
    )
      this.outbox.push(callback)
    if (
      releaseJobInsert &&
      !this.releaseJobs.some((j) => j.releaseRequestId === releaseJobInsert.releaseRequestId)
    )
      this.releaseJobs.push(releaseJobInsert)
  }
}

// ── cutover classifier ───────────────────────────────────────────────────────

/** Classifies a cutover's deploy surfaces (batch1b §7). Injectable so tests can
 *  stub the classification without real git/manifest; production defaults to
 *  {@link classifyForCutover} bound to the broker's runner. */
export type CutoverClassifier = (input: {
  canonicalRepo: string
  canonicalBranch: string
  sha: string
}) => Promise<CutoverClassifyResult>

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
  /** When true (OC_SELFHEAL_AUTO_DEPLOY_TIER2=1), a fully-gated cutover ENQUEUES
   *  a local release job (origin='auto') for the release worker; the broker never
   *  deploys synchronously (batch1b §11). Default false ⇒ park pending release. */
  autoDeployTier2?: boolean
  /** Deploy-surface classifier (batch1b §7). Default = {@link classifyForCutover}
   *  bound to the broker's runner (reads the trusted pre-merge manifest). */
  classifyCutover?: CutoverClassifier
  /** Resolve the surface-specific verify layers for a clone at VERIFY time
   *  (batch1b §6): classifies the diff canonical-HEAD..sha in the (de-privileged)
   *  clone so the required per-surface tests run. Default classifies against the
   *  trusted pre-merge manifest; a failure fails the verify (fail-closed). Tests
   *  inject a stub. */
  classifyClone?: (input: {
    clonePath: string
    canonicalRepo: string
    canonicalBranch: string
    sha: string
  }) => Promise<{ verifyLayers: string[] }>
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
    /** Surface-specific extra layers resolved from the classification (§6). */
    extraLayers?: string[]
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
    // Tier1 actions are OFF unless explicitly injected (positive enablement):
    // the current Tier1 implementations execute on THIS host, while v5 repair
    // targets live on the v5 master host — auto-registering them would hand
    // any active repair a wrong-host systemctl/docker lever via the raw
    // socket. The server layer injects TIER1_ACTIONS only behind
    // OC_SELFHEAL_TIER1_ENABLED=1 (see server.ts); host-routed execution is
    // the condition for ever turning that on.
    this.actions = opts.actions ?? {}
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

    // Condition-key authorization (server-side; checked before the claim so a
    // forbidden attempt never touches the idempotency ledger). The decision
    // reads the key FROZEN from the v5 master context — the model's own claims
    // and SKILL text carry no authority here.
    //
    // Unfrozen (null) ⇒ reject EVERYTHING: the jobWorker freezes the key via
    // its own HTTP fetch before any turn starts, so no legitimate socket
    // caller exists in that window — while a guessed repairId of a job stuck
    // in 'starting' would otherwise get full non-drill powers (audit R4
    // BLOCKER: "unfrozen = non-drill" was a bypass, not a default).
    const frozenKey = authz.rec.conditionKey
    if (typeof frozenKey !== 'string' || frozenKey.length === 0) {
      this.audit(req, 'rejected', { reason: 'condition_key_not_frozen' })
      return {
        ok: false,
        status: 'rejected',
        detail: {
          reason: 'repair condition key not frozen yet — no broker actions until job start',
        },
      }
    }
    // Drill repairs may ONLY perform actions in their FROZEN key's allowlist
    // (transport → context/report; release → context/report/verify/cutover).
    // Anything outside — including every Tier1 host opcode — is rejected here,
    // before the claim. A SKILL instruction is guidance, not a permission grant.
    const drillAllowed = DRILL_ALLOWED_ACTIONS.get(frozenKey)
    if (drillAllowed && !drillAllowed.has(req.actionKind)) {
      this.audit(req, 'rejected', { reason: 'drill_forbidden_action' })
      return {
        ok: false,
        status: 'rejected',
        detail: {
          reason: `drill repair may only ${[...drillAllowed].join('/')} — "${req.actionKind}" is forbidden`,
        },
      }
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
      const rji = response.releaseJobInsert
      // Strip INTERNAL fields (never serialized to the socket / durable store).
      const { masterCallback: _cb, releaseJobInsert: _rji, ...wire } = response
      if (cb || rji) {
        // 审计R2 BLOCKER + R2-4:committed 结果 + 其 master 回调 + 其 release job
        // 插入必须同一 SQLite 事务。失败 → claim 保持 'claimed'(replay=in_progress
        // fail-closed),如实上报 commit_failed;绝不 release(否则重试会重跑副作用)。
        try {
          await this.store.finalizeWithCallback(
            [{ claimKey: key, response: JSON.stringify(wire) }],
            undefined,
            cb ? { repairId: req.repairId, ...cb } : undefined,
            rji,
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
      await this.store.finalize(key, JSON.stringify(wire))
      return wire
    }
    await this.store.release(key)
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

    // (c) Auto-deploy gate. Default posture: hold for manual release. Before
    //     parking, classify the deploy surfaces against the TRUSTED pre-merge
    //     manifest (batch1b §7): the result is frozen into BOTH the durable
    //     cutover record (authoritative — the personal release-job intake
    //     re-checks deployPlanHash/manifestHash) and the pending_release callback
    //     (v5 admin display). A classifier throw (git failure / invalid manifest)
    //     is a hard, fail-closed refusal — never park an un-classified request.
    if (!this.autoDeployTier2) {
      let cls: CutoverClassifyResult
      try {
        const classifier =
          this.opts.classifyCutover ??
          ((input: { canonicalRepo: string; canonicalBranch: string; sha: string }) =>
            classifyForCutover({ ...input, run: this.run }))
        cls = await classifier({
          canonicalRepo: this.canonicalRepo,
          canonicalBranch: this.canonicalBranch,
          sha,
        })
      } catch (err) {
        return this.rejectCutover(
          req,
          `deploy-surface classification failed: ${String((err as Error).message).slice(0, 200)}`,
        )
      }
      const c = cls.classification
      // §11 detail shape. `verification` records the layers actually run by the
      // signed verification (not the classification's REQUIRED verifyLayers).
      const releaseDetail = {
        sha,
        baseSha: cls.baseSha,
        changedFiles: c.changedFiles,
        classification: {
          surfaces: c.surfaces,
          deployArgs: c.deployArgs,
          manual: c.manual,
          verifyLayers: c.verifyLayers,
          requiredAxes: c.requiredAxes,
        },
        verification: {
          layers: vr.layers.map((l) => ({ name: l.name, ok: l.ok, code: l.code })),
          ref: verificationRef,
        },
        deployPlanHash: c.deployPlanHash,
        manifestHash: c.manifestHash,
        manifestVersion: c.manifestVersion,
      }
      const manualPaths = c.manual.map((m) => m.path)
      this.audit(req, 'pending_release', {
        sha,
        baseSha: cls.baseSha,
        surfaces: c.surfaces,
        deployPlanHash: c.deployPlanHash,
        manual: c.manual.length,
      })
      this.opts.notifyPendingRelease?.({
        repairId: req.repairId,
        sha,
        // Transitional: `toolchain` now carries the classifier's manual paths
        // (its consumer, server.ts, is owned by a later wave that will rename it).
        ...(manualPaths.length ? { toolchain: manualPaths } : {}),
      })
      this.log.warn('cutover fully gated but AUTO_DEPLOY_TIER2=0 — held for manual release', {
        repairId: req.repairId,
        sha,
        surfaces: c.surfaces,
        manual: c.manual.length,
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
          ...releaseDetail,
          reason: 'awaiting one-click release (OC_SELFHEAL_AUTO_DEPLOY_TIER2=0)',
        },
        masterCallback: {
          phase: 'pending_release',
          message: 'pending_release: verified and gated — awaiting one-click release',
          detail: { phase: 'pending_release', ...releaseDetail },
        },
      }
    }

    // (d) Auto-deploy (OC_SELFHEAL_AUTO_DEPLOY_TIER2=1): ENQUEUE a durable local
    //     release job (origin='auto') — the release worker deploys it via the
    //     lane and drives its own deploying/deployed callbacks + trusted
    //     attestation. The broker no longer runs a synchronous deploy driver
    //     (batch1b §11); the worker is the single at-most-once deployer.
    return await this.enqueueAutoRelease(req, authority, sha, verificationRef, vr)
  }

  /**
   * Auto-deploy enqueue (§11): re-classify the cutover (the manual-park branch
   * above is skipped when autoDeployTier2 is on) and record a local release job
   * for the worker. A classifier throw is a hard, fail-closed refusal — never
   * enqueue an un-classified deploy. The frozen plan is the SINGLE authority the
   * worker + lane act on; a manual classification is closed `manual_required` by
   * the worker's single manual adjudicator, so we still enqueue it here.
   */
  private async enqueueAutoRelease(
    req: BrokerRequest,
    authority: RepairAuthorityRecord,
    sha: string,
    verificationRef: string,
    vr: VerifyOutcome['signed']['result'],
  ): Promise<BrokerResponse> {
    let cls: CutoverClassifyResult
    try {
      const classifier =
        this.opts.classifyCutover ??
        ((input: { canonicalRepo: string; canonicalBranch: string; sha: string }) =>
          classifyForCutover({ ...input, run: this.run }))
      cls = await classifier({
        canonicalRepo: this.canonicalRepo,
        canonicalBranch: this.canonicalBranch,
        sha,
      })
    } catch (err) {
      return this.rejectCutover(
        req,
        `deploy-surface classification failed: ${String((err as Error).message).slice(0, 200)}`,
      )
    }
    const c = cls.classification
    const releaseDetail = {
      sha,
      baseSha: cls.baseSha,
      changedFiles: c.changedFiles,
      classification: {
        surfaces: c.surfaces,
        deployArgs: c.deployArgs,
        manual: c.manual,
        verifyLayers: c.verifyLayers,
        requiredAxes: c.requiredAxes,
      },
      verification: {
        layers: vr.layers.map((l) => ({ name: l.name, ok: l.ok, code: l.code })),
        ref: verificationRef,
      },
      deployPlanHash: c.deployPlanHash,
      manifestHash: c.manifestHash,
      manifestVersion: c.manifestVersion,
    }
    const incidentId = authority.incidentId ?? ''
    if (!incidentId) return this.rejectCutover(req, 'auto release has no incident id to enqueue')
    const releaseRequestId = `auto-${req.repairId}-${Date.now()}`
    this.audit(req, 'queued', {
      sha,
      releaseRequestId,
      surfaces: c.surfaces,
      manual: c.manual.length,
    })
    // R2-4: return a COMMITTED cutover outcome carrying the release job to insert
    // in the SAME SQLite transaction as the cutover broker_action finalize
    // (handleRequest → store.finalizeWithCallback). "cutover committed ⟺ job
    // exists" now holds across a crash — no more best-effort post-commit enqueue
    // window that could leave a durable cutover record with no job. A combined
    // commit failure is fail-closed (commit_failed, claim held). The frozen
    // payload_hash is computed the same way the intake webhook does (§3.1) so a
    // later v5 re-delivery of the same rrid is a duplicate, not a conflict.
    return {
      ok: true,
      status: 'queued',
      detail: {
        ...releaseDetail,
        releaseRequestId,
        reason: 'auto-deploy release job enqueued (OC_SELFHEAL_AUTO_DEPLOY_TIER2=1)',
      },
      releaseJobInsert: {
        releaseRequestId,
        repairId: req.repairId,
        incidentId,
        payloadHash: releasePayloadHash({
          repairId: req.repairId,
          incidentId,
          sha,
          baseSha: cls.baseSha,
          deployPlanHash: c.deployPlanHash,
          manifestHash: c.manifestHash,
        }),
        approvedSha: sha,
        baseSha: cls.baseSha,
        deployPlanHash: c.deployPlanHash,
        manifestHash: c.manifestHash,
        planJson: JSON.stringify(releaseDetail),
        origin: 'auto',
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

    // (§6) Resolve the surface-specific verify layers from the classification so
    // a touched surface's required tests actually run. Fail-closed: a
    // classification failure fails the verify (a surface whose tests can't be
    // planned must never yield allPassed=true downstream).
    let extraLayers: string[]
    try {
      extraLayers = (
        await this.resolveVerifyLayers({
          clonePath,
          canonicalRepo: this.canonicalRepo,
          canonicalBranch: this.canonicalBranch,
          sha,
        })
      ).verifyLayers
    } catch (err) {
      this.audit(req, 'verify_failed', {
        sha,
        reason: `classification failed: ${String((err as Error).message).slice(0, 200)}`,
      })
      return {
        ok: false,
        status: 'verify_failed',
        detail: {
          reason: `deploy-surface classification failed: ${String((err as Error).message).slice(0, 200)}`,
        },
      }
    }

    const runVerify =
      this.opts.verifyRunner ??
      (async (input: {
        repairId: string
        sha: string
        clonePath: string
        canonicalRepo: string
        canonicalBranch: string
        extraLayers?: string[]
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
          extraLayers: input.extraLayers,
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
        extraLayers,
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

  /**
   * Resolve the surface-specific verify layers (§6) by classifying the diff
   * canonical-HEAD..sha. The manifest + base are read from the TRUSTED canonical
   * repo (root git), but the `git diff` runs in the (candidate-owned) clone
   * DE-PRIVILEGED — consistent with verify's own posture (it already runs npm/
   * tests as ocheal in that clone). Tests inject {@link SelfhealBrokerOpts.classifyClone}.
   */
  private async resolveVerifyLayers(input: {
    clonePath: string
    canonicalRepo: string
    canonicalBranch: string
    sha: string
  }): Promise<{ verifyLayers: string[] }> {
    if (this.opts.classifyClone) return this.opts.classifyClone(input)
    const manifest = await loadTrustedManifest(input.canonicalRepo, input.canonicalBranch, {
      run: this.run,
    })
    const base = await this.run('git', ['-C', input.canonicalRepo, 'rev-parse', input.canonicalBranch])
    const baseSha = base.stdout.trim()
    if (base.code !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
      throw new Error('canonical base resolution failed')
    }
    const asOcheal: RunOpts | undefined =
      this.ochealUid !== undefined && this.ochealGid !== undefined
        ? { uid: this.ochealUid, gid: this.ochealGid }
        : undefined
    const clsRun: CommandRunner = (cmd, args, opts) =>
      this.run(cmd, args, asOcheal ? { ...(opts ?? {}), ...asOcheal } : opts)
    const cls = await classifyDiff(input.clonePath, baseSha, input.sha, manifest, { run: clsRun })
    return { verifyLayers: cls.verifyLayers }
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
