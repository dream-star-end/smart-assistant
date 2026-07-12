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

import { createHash } from 'node:crypto'
import { chmodSync, chownSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import {
  type BrokerClaimResult,
  finalizeBrokerAction,
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
import {
  type SignedVerification,
  defaultCommandRunner,
  loadSignedVerification,
  stableStringify,
  verifySignature,
} from './verifier.js'

const rootLog = createLogger({ module: 'selfheal-broker' })

const CUTOVER_KIND = 'cutover'
const MAX_REQUEST_BYTES = 64 * 1024

export interface BrokerRequest {
  repairId: string
  actionKind: string
  params?: unknown
}

export interface BrokerResponse {
  ok: boolean
  /** Machine-readable outcome. */
  status: string
  detail?: Record<string, unknown>
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
}

/** Default durable store backed by the root-owned selfheal SQLite DB. */
export const durableBrokerClaimStore: BrokerClaimStore = {
  tryClaim: (input) => tryClaimBrokerAction(input),
  finalize: (claimKey, response) => finalizeBrokerAction(claimKey, response),
  release: (claimKey) => releaseBrokerClaim(claimKey),
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
}

// ── deploy driver ────────────────────────────────────────────────────────────

/** Executes the trusted production cutover for a validated sha. Injectable so
 *  the default posture (auto-deploy off) and tests never touch prod. */
export type DeployDriver = (sha: string, ctx: { log: Logger }) => Promise<BrokerResponse>

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
  /** Trusted deploy driver (only invoked when autoDeployTier2 and all gates
   *  pass). */
  deployDriver?: DeployDriver
  /** Called when a gated cutover is held for manual release (default posture). */
  notifyPendingRelease?: (info: { repairId: string; sha: string }) => void
}

export class SelfhealBroker {
  private server: Server | null = null
  private readonly log: Logger
  private readonly store: BrokerClaimStore
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

    const key = `${req.repairId}:${req.actionKind}`
    // Hash the params so a same-key request with DIFFERENT params is a conflict,
    // not a silent replay of the old outcome (Codex HIGH #13).
    const paramsHash = createHash('sha256').update(stableStringify(req.params ?? null)).digest('hex')

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
      response =
        req.actionKind === CUTOVER_KIND ? await this.handleCutover(req) : await this.handleTier1(req)
    } catch (err) {
      await this.store.release(key)
      throw err
    }
    if (this.isCommitted(response)) {
      await this.store.finalize(key, JSON.stringify(response))
    } else {
      await this.store.release(key)
    }
    return response
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

  private async handleCutover(req: BrokerRequest): Promise<BrokerResponse> {
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

    // (c) Auto-deploy gate. Default posture: hold for manual release.
    if (!this.autoDeployTier2) {
      this.audit(req, 'pending_release', { sha })
      this.opts.notifyPendingRelease?.({ repairId: req.repairId, sha })
      this.log.warn('cutover fully gated but AUTO_DEPLOY_TIER2=0 — held for manual release', {
        repairId: req.repairId,
        sha,
      })
      return {
        ok: false,
        status: 'pending_release',
        detail: { sha, reason: 'awaiting one-click release (OC_SELFHEAL_AUTO_DEPLOY_TIER2=0)' },
      }
    }

    // (d) Trusted, self-held deploy under the global deploy flock.
    const driver = this.opts.deployDriver
    if (!driver) {
      return this.rejectCutover(req, 'no trusted deploy driver configured')
    }
    const result = await driver(sha, { log: this.log })
    this.audit(req, result.status, { sha, ...result.detail })
    return result
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
