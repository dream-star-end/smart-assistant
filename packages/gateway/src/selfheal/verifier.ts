/**
 * Self-heal verifier — independent clone + de-privileged advisory verification.
 *
 * The verifier is a ROOT/broker-side ORCHESTRATOR, but it NEVER executes
 * candidate-controlled code as root. It:
 *   1. `prepareClone` — builds `/home/ocheal/selfheal/<repairId>`, an INDEPENDENT
 *      clone of the canonical v5 checkout, chowned to `ocheal`, with the origin
 *      remote removed (no writable path back to canonical). The unprivileged
 *      codex commits inside this clone; canonical `.git` stays root-owned and is
 *      never writable by ocheal.
 *   2. `verify` — reconstructs a clean tree at a candidate SHA and runs the four
 *      layers (lint / typecheck / gateway / web tests). CRITICAL: every command
 *      that touches candidate-controlled content (the worktree checkout, `npm ci`
 *      and every `npm run` — all of which run scripts / hooks the candidate can
 *      edit) is spawned DE-PRIVILEGED as `ocheal` (uid/gid drop) with git hooks
 *      disabled and `OC_SELFHEAL_*` scrubbed from its env. A hostile candidate
 *      therefore gains at most `ocheal` (exactly what codex already has) — no
 *      root RCE, and it can never read the verification HMAC to forge a result.
 *
 *      The root orchestrator observes the real exit codes and emits an
 *      HMAC-signed {@link SignedVerification}. Because the HMAC key lives only in
 *      the root env (scrubbed from every de-privileged child), ocheal cannot
 *      fabricate a signed verification.
 *
 * TRUST MODEL — read carefully. `allPassed` is ADVISORY, NOT a security gate on
 * its own: a candidate controls its own package.json scripts and can make any
 * layer `exit 0`. So a valid signature proves only "the root broker ran these
 * layers de-privileged and observed exit 0" — it does NOT prove real tests ran.
 * The REAL cutover trust anchors (enforced by the broker) are:
 *   (a) canonical ancestry — checked by root git against the trusted canonical
 *       repo, importing candidate objects via an inert bundle (no upload-pack /
 *       hook execution against the untrusted clone); and
 *   (b) the human one-click release gate (OC_SELFHEAL_AUTO_DEPLOY_TIER2=0).
 * `allPassed` gates cutover only as a soft precondition on top of (a)+(b).
 *
 * All external commands go through an injectable {@link CommandRunner} so this
 * module is unit-testable without real git/npm or a real uid drop.
 */

import { execFile } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger.js'
import type { CommandRunner, RunOpts, RunResult } from './brokerActions.js'

const log = createLogger({ module: 'selfheal-verifier' })

/** Default shell-free command runner (execFile — args as array, no shell).
 *  Honors {@link RunOpts}: uid/gid drop, cwd, and an explicit child env. Whenever
 *  a uid drop is requested it ALSO scrubs every `OC_SELFHEAL_*` var from the
 *  child env (defense in depth, even if the caller passed a broad env) so a
 *  de-privileged candidate can never read the verification HMAC / capability
 *  secrets. */
export const defaultCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise<RunResult>((resolve) => {
    let env: NodeJS.ProcessEnv | undefined = opts?.env
    if (opts?.uid !== undefined) {
      const base: NodeJS.ProcessEnv = { ...(opts?.env ?? process.env) }
      for (const k of Object.keys(base)) {
        if (k.startsWith('OC_SELFHEAL_')) delete base[k]
      }
      env = base
    }
    execFile(
      cmd,
      args,
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
        cwd: opts?.cwd,
        uid: opts?.uid,
        gid: opts?.gid,
        env,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((err as unknown as { code: number }).code as number)
            : err
              ? 1
              : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })

export interface VerificationLayer {
  /** Layer name (also the audit key). */
  name: string
  /** Command + args, run in the clean tree via the injected runner. */
  cmd: string
  args: string[]
}

/** The four test layers, in order. Overridable via opts for tests. `install`
 *  is a prerequisite prep step (a clone has no node_modules) that runs before
 *  these; it is not itself counted as a pass/fail "layer". */
export const DEFAULT_VERIFICATION_LAYERS: VerificationLayer[] = [
  { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
  { name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { name: 'test:gateway', cmd: 'npm', args: ['run', 'test:gateway'] },
  { name: 'test:web', cmd: 'npm', args: ['run', 'test:web'] },
]

export const DEFAULT_INSTALL_STEP: VerificationLayer = {
  name: 'install',
  cmd: 'npm',
  args: ['ci'],
}

export interface VerificationLayerResult {
  name: string
  ok: boolean
  code: number
  durationMs: number
  /** Bounded stderr/stdout tail for the audit trail. */
  tail?: string
}

export interface VerificationResult {
  repairId: string
  sha: string
  clonePath: string
  layers: VerificationLayerResult[]
  /** True when every layer (and install) exited 0, as observed by the root
   *  orchestrator running them DE-PRIVILEGED. ADVISORY only: a candidate controls
   *  its own package.json scripts and can force `exit 0`, so this is NOT a
   *  sufficient cutover gate on its own (the broker's real gate is canonical
   *  ancestry + the human release). It is surfaced to inform that decision and
   *  used as a soft precondition. */
  allPassed: boolean
  verifiedAt: string
}

export interface SignedVerification {
  result: VerificationResult
  /** hex HMAC-SHA256 over the canonical serialization of `result`. */
  sig: string
}

// ── HMAC signing (canonical, order-stable) ───────────────────────────────────

/** Deterministic JSON with sorted object keys, so signing is stable regardless
 *  of property insertion order. Mirrors `JSON.stringify` semantics for
 *  `undefined` — object keys with an undefined value are OMITTED — so a value
 *  signed here and then round-tripped through `JSON.stringify`/`JSON.parse`
 *  (as the persisted verification is) produces an identical string. Without
 *  this, a layer's optional `tail: undefined` would be signed but dropped on
 *  reload, breaking signature verification. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function requireSigningKey(explicit?: string): string {
  const key = explicit ?? process.env.OC_SELFHEAL_VERIFY_HMAC
  if (!key || key.length < 16) {
    throw new Error('OC_SELFHEAL_VERIFY_HMAC is required (>=16 chars) to sign/verify verifications')
  }
  return key
}

export function signVerification(result: VerificationResult, key?: string): SignedVerification {
  const k = requireSigningKey(key)
  const sig = createHmac('sha256', k).update(stableStringify(result)).digest('hex')
  return { result, sig }
}

/** Constant-time signature check. Returns false on any mismatch/format error. */
export function verifySignature(signed: SignedVerification, key?: string): boolean {
  const k = requireSigningKey(key)
  const expected = createHmac('sha256', k).update(stableStringify(signed.result)).digest('hex')
  const a = Buffer.from(expected, 'hex')
  let b: Buffer
  try {
    b = Buffer.from(signed.sig, 'hex')
  } catch {
    return false
  }
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

// ── clone preparation ────────────────────────────────────────────────────────

export interface PrepareCloneOpts {
  repairId: string
  /** Canonical v5 checkout to clone FROM (root-owned, read-only for ocheal). */
  canonicalRepo: string
  /** Branch to check out in the clone. */
  canonicalBranch: string
  /** Root dir for per-repair clones (default /home/ocheal/selfheal). */
  ochealSelfhealRoot?: string
  ochealUid: number
  ochealGid: number
  run?: CommandRunner
}

export interface PrepareCloneResult {
  clonePath: string
}

/**
 * Build the independent, ocheal-owned clone. Never runs candidate-repo hooks
 * (this clones FROM trusted canonical) and strips the origin remote so ocheal
 * has no writable path back to canonical.
 */
export async function prepareClone(opts: PrepareCloneOpts): Promise<PrepareCloneResult> {
  const run = opts.run ?? defaultCommandRunner
  const root = opts.ochealSelfhealRoot ?? '/home/ocheal/selfheal'
  const clonePath = join(root, opts.repairId)

  // Idempotent recovery: a crash-re-driven job re-runs processJob; if the clone
  // already exists (from the prior attempt) reuse it rather than failing on
  // `git clone` into a non-empty dir. Ownership/remote were already fixed up.
  if (existsSync(join(clonePath, '.git'))) {
    log.info('reusing existing selfheal clone', { repairId: opts.repairId, clonePath })
    return { clonePath }
  }

  const clone = await run('git', [
    'clone',
    '--no-hardlinks',
    '--branch',
    opts.canonicalBranch,
    opts.canonicalRepo,
    clonePath,
  ])
  if (clone.code !== 0) {
    throw new Error(`clone failed (code ${clone.code}): ${clone.stderr.slice(0, 500)}`)
  }
  // Remove the writable path back to canonical — the clone must be a dead end.
  await run('git', ['-C', clonePath, 'remote', 'remove', 'origin'])
  // Hand the whole tree to ocheal so codex can git add/commit inside it.
  const chown = await run('chown', ['-R', `${opts.ochealUid}:${opts.ochealGid}`, clonePath])
  if (chown.code !== 0) {
    throw new Error(
      `chown clone to ocheal failed (code ${chown.code}): ${chown.stderr.slice(0, 500)}`,
    )
  }
  log.info('prepared independent selfheal clone', { repairId: opts.repairId, clonePath })
  return { clonePath }
}

// ── verification run ─────────────────────────────────────────────────────────

export interface VerifyOpts {
  repairId: string
  sha: string
  clonePath: string
  /** Uid the candidate-executing steps (worktree checkout, `npm ci`, every test
   *  layer) drop to. REQUIRED — these run candidate-controlled scripts/hooks and
   *  must NEVER run as root. In production this is the `ocheal` uid. */
  ochealUid: number
  /** Gid paired with {@link VerifyOpts.ochealUid}. */
  ochealGid: number
  /** HOME for the de-privileged steps (npm cache etc.). Default /home/ocheal. */
  ochealHome?: string
  /** Where to materialize the clean tree for the sha (git worktree). Default:
   *  `${clonePath}.verify`. */
  worktreeDir?: string
  /** Directory (root-owned, 0600) where the signed result is written. Default:
   *  OC_SELFHEAL_VERIFY_DIR or /var/lib/openclaude-selfheal/verifications. */
  verificationDir?: string
  /** Root-trusted canonical checkout/branch used as the complete candidate
   *  delta base for changed-file lint. */
  canonicalRepo?: string
  canonicalBranch?: string
  layers?: VerificationLayer[]
  /** Surface-specific layer NAMES to run on top of the base layers (batch1b:
   *  the classification's `verifyLayers`). Each is unioned+de-duplicated, then
   *  fail-closed validated: the name must match `^[a-z0-9:_-]+$` AND exist as a
   *  script in the checked-out tree's package.json. A name that fails either is
   *  recorded as a FAILED layer (never executed) so a surface whose required
   *  test cannot run can never yield `allPassed=true`. */
  extraLayers?: string[]
  installStep?: VerificationLayer | null
  signingKey?: string
  run?: CommandRunner
}

/** Layer/script name shape for the fail-closed extra-layer allowlist. */
const LAYER_NAME_RE = /^[a-z0-9:_-]+$/

/** Read the set of npm `scripts` names from the checked-out tree's package.json.
 *  Any read/parse error yields an empty set (fail-closed: every extra layer then
 *  reports "no such script" rather than silently passing). */
function readPackageScripts(worktreeDir: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(worktreeDir, 'package.json'), 'utf-8')) as {
      scripts?: unknown
    }
    const s = pkg.scripts
    if (s && typeof s === 'object' && !Array.isArray(s)) return new Set(Object.keys(s))
  } catch {
    /* fall through to empty — fail closed */
  }
  return new Set()
}

export interface VerifyOutcome {
  /** Opaque handle the broker later resolves via {@link loadSignedVerification}. */
  verificationRef: string
  signed: SignedVerification
}

const BIOME_FILE_RE = /\.(?:[cm]?[jt]sx?|jsonc?|css)$/

async function runChangedFileLint(
  run: CommandRunner,
  input: {
    canonicalRepo: string
    canonicalBranch: string
    worktreeDir: string
    sha: string
    deprivOpts: RunOpts
  },
): Promise<RunResult> {
  // Resolve the base only in the root-trusted canonical checkout. Candidate
  // refs are ocheal-writable and therefore cannot define the verification span.
  const base = await run('git', [
    '-C',
    input.canonicalRepo,
    'rev-parse',
    '--verify',
    input.canonicalBranch,
  ])
  const baseSha = base.stdout.trim()
  if (base.code !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
    return { code: base.code || 1, stdout: '', stderr: 'trusted canonical base resolution failed' }
  }

  // The current trusted branch must be the candidate's ancestor. If canonical
  // advanced while a repair was running, fail closed and let it redrive from a
  // fresh clone (the later cutover gate requires the same ancestry).
  const ancestry = await run(
    'git',
    ['-C', input.worktreeDir, 'merge-base', '--is-ancestor', baseSha, input.sha],
    input.deprivOpts,
  )
  if (ancestry.code !== 0) {
    return { code: ancestry.code, stdout: '', stderr: 'candidate is not based on canonical head' }
  }

  const changed = await run(
    'git',
    [
      '-C',
      input.worktreeDir,
      'diff',
      '--name-only',
      '-z',
      '--diff-filter=ACMRT',
      `${baseSha}..${input.sha}`,
      '--',
      'packages',
    ],
    input.deprivOpts,
  )
  if (changed.code !== 0) return changed
  const files = changed.stdout.split('\0').filter((path) => BIOME_FILE_RE.test(path))
  if (files.length === 0) return { code: 0, stdout: 'no changed Biome files', stderr: '' }

  return run(join(input.worktreeDir, 'node_modules/.bin/biome'), ['check', ...files], {
    ...input.deprivOpts,
    cwd: input.worktreeDir,
  })
}

function verificationDirOf(opts: VerifyOpts): string {
  return (
    opts.verificationDir ??
    process.env.OC_SELFHEAL_VERIFY_DIR ??
    '/var/lib/openclaude-selfheal/verifications'
  )
}

/**
 * Reconstruct a clean tree at `sha` and run the layers DE-PRIVILEGED (as ocheal).
 * Every step here executes candidate-controlled content (checkout hooks, npm
 * scripts), so none of it runs as root. The root orchestrator observes the exit
 * codes, signs the result (root-only HMAC), and persists it (root-owned, 0600).
 * A failed layer short-circuits the rest (allPassed=false — advisory; see file
 * header for why allPassed is not a standalone cutover gate).
 */
export async function verify(opts: VerifyOpts): Promise<VerifyOutcome> {
  const run = opts.run ?? defaultCommandRunner
  const worktreeDir = opts.worktreeDir ?? `${opts.clonePath}.verify`
  const layers = opts.layers ?? DEFAULT_VERIFICATION_LAYERS
  const usingDefaultLayers = opts.layers === undefined
  const installStep = opts.installStep === undefined ? DEFAULT_INSTALL_STEP : opts.installStep
  // Every candidate-executing command drops to ocheal with a curated, secret-free
  // env (the runner additionally scrubs OC_SELFHEAL_* as a second line of defense).
  const deprivOpts: RunOpts = {
    uid: opts.ochealUid,
    gid: opts.ochealGid,
    env: curatedChildEnv(opts.ochealHome ?? '/home/ocheal'),
  }

  // Clean checkout of the committed sha — ignores any dirty/uncommitted state in
  // the clone. `--detach` so we never move a branch ref. Git hooks are disabled
  // AND the checkout runs as ocheal, so a hostile clone-side post-checkout hook
  // can neither run as root nor run at all.
  const wt = await run(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      opts.clonePath,
      'worktree',
      'add',
      '--detach',
      worktreeDir,
      opts.sha,
    ],
    deprivOpts,
  )
  if (wt.code !== 0) {
    throw new Error(`worktree add failed (code ${wt.code}): ${wt.stderr.slice(0, 500)}`)
  }

  // Surface-specific extra layers (batch1b), fail-closed. Names already covered
  // by a base layer are dropped; the rest are validated against the tree's
  // package.json scripts + the name allowlist. Invalid ones become FAILED layers
  // that are never executed (a required surface test that can't run must never
  // let `allPassed` be true).
  const baseNames = new Set(layers.map((l) => l.name))
  const requestedExtra = (opts.extraLayers ?? []).filter((n, i, a) => a.indexOf(n) === i)
  const resolvedExtra: VerificationLayer[] = []
  const invalidExtra: { name: string; reason: string }[] = []
  if (requestedExtra.length > 0) {
    const scripts = readPackageScripts(worktreeDir)
    for (const name of requestedExtra) {
      if (baseNames.has(name)) continue
      if (!LAYER_NAME_RE.test(name)) {
        invalidExtra.push({ name, reason: 'illegal layer name' })
      } else if (!scripts.has(name)) {
        invalidExtra.push({ name, reason: 'no such npm script' })
      } else {
        resolvedExtra.push({ name, cmd: 'npm', args: ['run', name] })
      }
    }
  }

  const steps: VerificationLayer[] = [
    ...(installStep ? [installStep] : []),
    ...layers,
    ...resolvedExtra,
  ]
  const results: VerificationLayerResult[] = []
  let allPassed = true
  for (const layer of steps) {
    const started = Date.now()
    const r =
      usingDefaultLayers && layer.name === 'lint'
        ? await runChangedFileLint(run, {
            canonicalRepo:
              opts.canonicalRepo ??
              process.env.OC_SELFHEAL_CANONICAL_DIR ??
              '/opt/openclaude/openclaude-v5-aurora',
            canonicalBranch:
              opts.canonicalBranch ??
              process.env.OC_SELFHEAL_CANONICAL_BRANCH ??
              'feat/v5-aurora-rewrite',
            worktreeDir,
            sha: opts.sha,
            deprivOpts,
          })
        : await run(layer.cmd, layer.args, { ...deprivOpts, cwd: worktreeDir })
    const ok = r.code === 0
    results.push({
      name: layer.name,
      ok,
      code: r.code,
      durationMs: Date.now() - started,
      tail: (r.stderr || r.stdout).slice(-800) || undefined,
    })
    if (!ok) {
      allPassed = false
      break // fail fast — no point running later layers
    }
  }

  // Fail-closed extra layers: only relevant if everything runnable passed. A
  // single unavailable required layer forces allPassed=false without executing.
  if (allPassed && invalidExtra.length > 0) {
    const inv = invalidExtra[0]
    results.push({
      name: inv.name,
      ok: false,
      code: -1,
      durationMs: 0,
      tail: `layer unavailable: ${inv.reason}`,
    })
    allPassed = false
  }

  const result: VerificationResult = {
    repairId: opts.repairId,
    sha: opts.sha,
    clonePath: opts.clonePath,
    layers: results,
    allPassed,
    verifiedAt: new Date().toISOString(),
  }
  const signed = signVerification(result, opts.signingKey)

  const dir = verificationDirOf(opts)
  mkdirSync(dir, { recursive: true })
  const verificationRef = `${opts.repairId}`
  const file = join(dir, `${verificationRef}.json`)
  // 0600 + root-owned dir ⇒ ocheal cannot read the signed artifact (nor the
  // signature) to replay/forge it.
  writeFileSync(file, JSON.stringify(signed), { mode: 0o600 })
  log.info('verification complete', { repairId: opts.repairId, sha: opts.sha, allPassed })
  return { verificationRef, signed }
}

/** Minimal, secret-free env for the de-privileged verification steps. An
 *  allowlist (not a denylist) so no root secret leaks into candidate code; HOME
 *  points at ocheal's home so npm has a writable cache. */
function curatedChildEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home }
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM']) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

/** Load a persisted signed verification by ref (broker side, cutover gate). */
export function loadSignedVerification(
  verificationRef: string,
  verificationDir?: string,
): SignedVerification {
  const dir =
    verificationDir ??
    process.env.OC_SELFHEAL_VERIFY_DIR ??
    '/var/lib/openclaude-selfheal/verifications'
  // Ref is an opaque repairId; reject path traversal defensively.
  if (!/^[A-Za-z0-9._-]+$/.test(verificationRef)) {
    throw new Error(`invalid verificationRef "${verificationRef}"`)
  }
  const file = join(dir, `${verificationRef}.json`)
  const raw = readFileSync(file, 'utf-8')
  return JSON.parse(raw) as SignedVerification
}
