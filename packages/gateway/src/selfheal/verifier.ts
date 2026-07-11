/**
 * Self-heal verifier — independent clone + four-layer test + signed result.
 *
 * The verifier is a ROOT/broker-side facility. It:
 *   1. `prepareClone` — builds `/home/ocheal/selfheal/<repairId>`, an INDEPENDENT
 *      clone of the canonical v5 checkout, chowned to `ocheal`, with the origin
 *      remote removed (no writable path back to canonical). The unprivileged
 *      codex commits inside this clone; canonical `.git` stays root-owned and is
 *      never writable by ocheal.
 *   2. `verify` — reconstructs a CLEAN tree at a candidate SHA (a git worktree of
 *      the committed sha, ignoring any dirty state) and runs the four test layers
 *      (lint / typecheck / gateway tests / web tests). It emits an HMAC-signed
 *      {@link SignedVerification}. The signing key (OC_SELFHEAL_VERIFY_HMAC) lives
 *      only in the root broker/gateway env and is scrubbed from the codex
 *      subprocess env, so ocheal cannot forge a passing verification.
 *
 * The broker's Tier2 cutover trusts ONLY a valid signature over `allPassed:true`
 * plus its own canonical-ancestry check — never codex's word.
 *
 * All external commands go through an injectable {@link CommandRunner} so this
 * module is unit-testable without real git/npm.
 */

import { execFile } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger.js'
import type { CommandRunner, RunResult } from './brokerActions.js'

const log = createLogger({ module: 'selfheal-verifier' })

/** Default shell-free command runner (execFile — args as array, no shell). */
export const defaultCommandRunner: CommandRunner = (cmd, args) =>
  new Promise<RunResult>((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000 },
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
  /** True only when every test layer (and install) passed. This is the single
   *  fact the broker gates cutover on. */
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
  /** Where to materialize the clean tree for the sha (git worktree). Default:
   *  `${clonePath}.verify`. */
  worktreeDir?: string
  /** Directory (root-owned, 0600) where the signed result is written. Default:
   *  OC_SELFHEAL_VERIFY_DIR or /var/lib/openclaude-selfheal/verifications. */
  verificationDir?: string
  layers?: VerificationLayer[]
  installStep?: VerificationLayer | null
  signingKey?: string
  run?: CommandRunner
}

export interface VerifyOutcome {
  /** Opaque handle the broker later resolves via {@link loadSignedVerification}. */
  verificationRef: string
  signed: SignedVerification
}

function verificationDirOf(opts: VerifyOpts): string {
  return (
    opts.verificationDir ??
    process.env.OC_SELFHEAL_VERIFY_DIR ??
    '/var/lib/openclaude-selfheal/verifications'
  )
}

/**
 * Reconstruct a clean tree at `sha` and run the four test layers. Produces an
 * HMAC-signed result and persists it (root-owned, 0600) so the broker can load
 * + verify it. A failed layer short-circuits the rest (allPassed=false).
 */
export async function verify(opts: VerifyOpts): Promise<VerifyOutcome> {
  const run = opts.run ?? defaultCommandRunner
  const worktreeDir = opts.worktreeDir ?? `${opts.clonePath}.verify`
  const layers = opts.layers ?? DEFAULT_VERIFICATION_LAYERS
  const installStep = opts.installStep === undefined ? DEFAULT_INSTALL_STEP : opts.installStep

  // Clean checkout of the committed sha — ignores any dirty/uncommitted state
  // in the clone. `--detach` so we never move a branch ref.
  const wt = await run('git', [
    '-C',
    opts.clonePath,
    'worktree',
    'add',
    '--detach',
    worktreeDir,
    opts.sha,
  ])
  if (wt.code !== 0) {
    throw new Error(`worktree add failed (code ${wt.code}): ${wt.stderr.slice(0, 500)}`)
  }

  const steps: VerificationLayer[] = installStep ? [installStep, ...layers] : [...layers]
  const results: VerificationLayerResult[] = []
  let allPassed = true
  for (const layer of steps) {
    const started = Date.now()
    const r = await run(
      layer.cmd,
      layer.cmd === 'npm' ? withCwd(layer.args, worktreeDir) : layer.args,
    )
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

/** npm scripts must run in the clean tree, not the broker cwd. */
function withCwd(args: string[], cwd: string): string[] {
  // `npm --prefix <dir> run <script>` runs the script from <dir>. Simpler and
  // more robust than relying on process cwd for the injected runner.
  return ['--prefix', cwd, ...args]
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
