#!/usr/bin/env tsx
/**
 * Deploy-gate proofs for master-side incidents that came with the OCV5-380 selfhost merge
 * (alert inbox fallback, cron inbox delivery key, project output assets, PROJECT.md seed).
 *
 * Each proof runs the incident's own regression file on the pinned tree and requires the named
 * cases to pass: not missing, not skipped (a skip because the test PostgreSQL is down is a
 * failure here), no other case failing in that file. The alert proof runs against a real
 * PostgreSQL: TEST_DATABASE_URL must name a loopback *_test database; nothing else is read.
 *
 *   TEST_DATABASE_URL=postgres://…@127.0.0.1:…/…_test npx --no-install tsx scripts/check-v5-master-incident-proofs.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scopeBoxExecToProfile } from '../packages/commercial/src/http/proxy/boxProfileExec.js'
import { BoxProfileHealth } from '../packages/commercial/src/http/proxy/boxProfileHealth.js'
import { isBoxLaunchRequest } from '../packages/commercial/src/http/proxy/boxClaudeProfile.js'

type Proof = { incident: string; slug: string; file: string; db: boolean; cases: readonly string[] }

export const MASTER_INCIDENT_PROOFS: readonly Proof[] = [
  {
    incident: 'INC-20261031-TURN-LABEL-UNDERCOUNT', slug: 'inc-20261031-turn-label-realpg', db: true,
    file: 'packages/commercial/src/__tests__/openTurnAttribution.integ.test.ts',
    cases: [
      'real PG attribution one: debit 132 once, refresh label 132',
      'real PG attribution none: debit 132 once, refresh label 97',
      'real PG attribution many: debit 132 once, refresh label 97',
      'real PG attribution unkeyed: debit 132 once, refresh label 97',
    ],
  },
  {
    incident: 'INC-20261026-REFRESH-GRACE', slug: 'inc-20261026-refresh-grace-realpg', db: true,
    file: 'packages/commercial/src/__tests__/login.integ.test.ts',
    cases: [
      'reuse rotated refresh at 11s / 40s (default grace=45) → REFRESH_RACE',
      'reuse rotated refresh at 50s (default grace=45) → still theft',
    ],
  },
  {
    incident: 'INC-20261109-MUSE-ORIGIN-SCHEMA', slug: 'inc-20261109-muse-origin-schema', db: false,
    file: 'packages/commercial/src/__tests__/museDurable.test.ts',
    cases: ["INC-20261109-MUSE-ORIGIN-SCHEMA: explicit metadata stays strict and out of the bridge spec", "INC-20261109-MUSE-ORIGIN-SCHEMA: HTTP reaches real origin ownership gate before insertion", "INC-20261109-MUSE-ORIGIN-SCHEMA: real oc-muse video submits origin and acknowledges one conversation result"],
  },
  {
    incident: 'INC-20261029-BOX-STOPPED-CREDIT-HOLD', slug: 'inc-20261029-box-stopped-credit-hold', db: true,
    file: 'packages/commercial/src/billing/boxBillingRecovery.integ.test.ts',
    cases: ['late proven Box stops release retained credit reservations without charging'],
  },
  {
    incident: 'INC-20261009-ALERT-INBOX-FALLBACK', slug: 'inc-20261009-alert-inbox-fallback', db: true,
    file: 'packages/commercial/src/__tests__/alertOutboxInboxFallback.integ.test.ts',
    cases: [
      '同 dedupe_key 重复兜底 → 只写 1 条,第二次 inbox_fallback=false',
      'uid=1 不是 admin(个人版)→ 发给最小的非系统种子 active admin',
      'uid=1 是 active admin(商业版)→ 仍发给 uid=1',
    ],
  },
  {
    incident: 'INC-20261009-INBOX-DELIVERY-KEY-500', slug: 'inc-20261009-inbox-delivery-key-500', db: false,
    file: 'packages/commercial/src/__tests__/internalInboxPost.test.ts',
    cases: ['delivery key already delivered with other content → 200 duplicate, not 500 (OCV5-365)'],
  },
  {
    incident: 'INC-20261008-PROJECT-OUTPUTS-INVISIBLE', slug: 'inc-20261008-project-outputs-invisible', db: false,
    file: 'packages/commercial/src/__tests__/internalProjectAssets.test.ts',
    cases: [
      'registers into the tenant from the container identity, never from the body',
      "the project frozen at turn start wins over the session's current project",
      'a deleted, missing or foreign session registers nothing',
    ],
  },
  {
    incident: 'INC-20261008-PROJECT-OUTPUTS-INVISIBLE', slug: 'inc-20261008-project-outputs-invisible-container', db: false,
    file: 'packages/gateway/src/__tests__/projectAssetOutputsMaster.test.ts',
    cases: [
      'registers on the master with the project frozen at turn start',
      'a master outage spools the registration and the next collection sends it once',
    ],
  },
  {
    incident: 'INC-20261008-PROJECT-MD-SEED-OVERWRITE', slug: 'inc-20261008-project-md-seed-overwrite', db: false,
    file: 'packages/storage/src/__tests__/projectContext.test.ts',
    cases: [
      'a hand-edited PROJECT.md with a stale hash is preserved, not replaced by the seed',
      'a deliberate clear is never refilled by a stale PG mirror',
      'a seed racing a human write cannot overwrite it (checked under the lock)',
    ],
  },
  {
    incident: 'INC-20261026-MUSE-SOURCE-CHUNK-256K', slug: 'inc-20261026-muse-source-chunk-256k', db: false,
    file: 'packages/commercial/src/__tests__/museBridge.test.ts',
    cases: ['hello source_chunk_bytes is never below the bridge default and within its hard limit'],
  },
  {
    incident: 'INC-20261026-STUDIO-MUSE-RETRY-REPLAY', slug: 'inc-20261026-studio-muse-retry-replay', db: false,
    file: 'packages/commercial/src/__tests__/studioProviders.test.ts',
    cases: ['muse: a retry after a failed job submits the next job of the chain, never replays the failure (INC-20261026-STUDIO-MUSE-RETRY-REPLAY)'],
  },
  {
    incident: 'INC-20261027-STUDIO-COMPOSE-CHANNEL-LAYOUT', slug: 'inc-20261027-studio-compose-channel-layout', db: false,
    file: 'packages/commercial/src/__tests__/studioCompose.test.ts',
    cases: ['the film audio reaches the encoder as fltp 48 kHz stereo, never negotiated (INC-20261027-STUDIO-COMPOSE-CHANNEL-LAYOUT)'],
  },
  {
    incident: 'INC-20261027-STUDIO-RETRY-PROVIDER-EXCLUDED', slug: 'inc-20261027-studio-retry-provider-excluded', db: true,
    file: 'packages/commercial/src/__tests__/studioOrchestrator.integ.test.ts',
    cases: ["after a failed video the user's frame pick retries the same provider (INC-20261027-STUDIO-RETRY-PROVIDER-EXCLUDED)"],
  },
  {
    incident: 'INC-20261027-STUDIO-REGENERATE-REDOES-FRAME', slug: 'inc-20261027-studio-regenerate-redoes-frame', db: true,
    file: 'packages/commercial/src/__tests__/studioAnnotations.integ.test.ts',
    cases: ['keeping the first frame redoes only the video, from the frame on screen (INC-20261027-STUDIO-REGENERATE-REDOES-FRAME)'],
  },
  {
    incident: 'INC-20261027-STUDIO-ADOPT-WRONG-TAKE', slug: 'inc-20261027-studio-adopt-wrong-take', db: false,
    file: 'packages/commercial/src/__tests__/studioInterpret.test.ts',
    cases: ['the version the note is on and the one in use are marked (INC-20261027-STUDIO-ADOPT-WRONG-TAKE)'],
  },
  {
    incident: 'INC-20261027-STUDIO-COMPOSE-FAILED-NO-RETRY', slug: 'inc-20261027-studio-compose-failed-no-retry', db: true,
    file: 'packages/commercial/src/__tests__/studioComposeFlow.integ.test.ts',
    cases: ['after a failed compose the user can ask the director to compose again, free (INC-20261027-STUDIO-COMPOSE-FAILED-NO-RETRY)'],
  },
  {
    incident: 'INC-20261029-BOX-LOGIN-EXPIRED-STOP-REASON', slug: 'inc-20261029-box-login-expired-stop-reason', db: false,
    file: 'packages/commercial/src/http/proxy/boxInteractivePrintParity.test.ts',
    cases: ['an API error stand-in is the named upstream refusal on both decoders and a login signal, as on -p'],
  },
  {
    incident: 'INC-20261029-SESSION-WS-BOUNDARY', slug: 'inc-20261029-session-ws-boundary', db: false,
    file: 'packages/gateway/src/__tests__/promptToolRecovery.test.ts',
    cases: ['keeps file search/deletion inside the current conversation unless the user names another one'],
  },
  {
    incident: 'INC-20261114-LOCAL-CATALOG-OWNER', slug: 'inc-20261114-local-catalog-owner', db: false,
    file: 'packages/commercial/src/__tests__/internalModelCatalog.test.ts',
    cases: ['remote_pool CCB rows do not emit local-catalog context_owner while exact Box rows still do (INC-20261114-LOCAL-CATALOG-OWNER)'],
  },
  {
    incident: 'INC-20261114-CATALOG-EPOCH-409', slug: 'inc-20261114-catalog-epoch-409', db: false,
    file: 'packages/commercial/src/__tests__/internalModelCatalog.test.ts',
    cases: ['OCV5-745 catalog response carries projection_algo_version matching epoch endpoint (INC-20261114-CATALOG-EPOCH-409)'],
  },
  {
    incident: 'INC-20261114-CC5-NULL-RECEIPT-DRAIN', slug: 'inc-20261114-cc5-null-receipt-drain', db: true,
    file: 'packages/commercial/src/__tests__/remoteNativeTurnBilling.test.ts',
    cases: ['cc5-native-v1 null-receipt recovery aborts dead crash, rotates still-live turns, and guards completed outcome (INC-20261114-CC5-NULL-RECEIPT-DRAIN)'],
  },
  {
    incident: 'INC-20261115-CONTAINER-SWAP-FRAMESEQ', slug: 'inc-20261115-container-swap-frameseq', db: true,
    file: 'packages/commercial/src/__tests__/sessionSnapshot.test.ts',
    cases: [
      'idle session arbitrates cross-container cursor_reset only when containerId is supplied (INC-20261115-CONTAINER-SWAP-FRAMESEQ)',
      'cursor_reset takes priority over containerLinkGap and sequence_gap on open dispatch (INC-20261115-CONTAINER-SWAP-FRAMESEQ)',
      'cursor_reset defers byte_limit on first page with oversize frame and exposes byte_limit on follow-up page (INC-20261115-CONTAINER-SWAP-FRAMESEQ)',
    ],
  },
  {
    incident: 'INC-20261116-REMOTE-V4-FENCE-ORPHAN', slug: 'inc-20261116-remote-v4-fence-orphan', db: false,
    file: 'packages/gateway/src/__tests__/remotePoolTerminalSettlement.test.ts',
    cases: [
      'mid-turn CC5_TOOLHOST_EXECUTION_UNKNOWN after completed tool persists crashed tape and terminal inbox once (INC-20261116-REMOTE-V4-FENCE-ORPHAN)',
      'escalated user Stop during hung tool persists USER_CANCELLED tape instead of dropping on finalized null summary (INC-20261116-REMOTE-V4-FENCE-ORPHAN)',
      'planned gateway beginPlannedShutdown mid-turn persists SERVICE_RESTART with no_response waiver instead of RUNNER_CRASHED (INC-20261116-REMOTE-V4-FENCE-ORPHAN)',
      'pre-dispatch explicit user Stop waits for master ACK before surfacing error while pre-dispatch fence persists crashed tape (INC-20261116-REMOTE-V4-FENCE-ORPHAN)',
    ],
  },
  {
    incident: 'INC-20261117-CC5-BASH-TIMEOUT-PS-ENOENT', slug: 'inc-20261117-cc5-bash-timeout-ps-enoent', db: false,
    file: 'packages/gateway/src/__tests__/cc5BashTimeoutProof.test.ts',
    cases: [
      'candidate Cc5ToolHost + ShellCommand Bash timeout without ps in PATH returns timed-out tool result, reaps setsid descendants, keeps host alive, and defaults to 600000ms (INC-20261117-CC5-BASH-TIMEOUT-PS-ENOENT)',
    ],
  },
  {
    incident: 'INC-20261117-CC5-BASH-TIMEOUT-PS-ENOENT', slug: 'inc-20261117-remote-v4-null-receipt-drain', db: true,
    file: 'packages/commercial/src/__tests__/remoteDriverTurnBillingNullReceipt.test.ts',
    cases: [
      'offline contract: recoverRemoteDriverTurnBilling rotates live turns, aborts proven-dead null-receipt turns, and clears per_turn thread claim only (OCV5-777)',
      'isolated PG: recoverRemoteDriverTurnBilling executes CTE SQL end-to-end against real PostgreSQL tables (OCV5-777)',
    ],
  },
  {
    incident: 'INC-20261117-REMOTE-V4-DRAIN-CC-AUTH', slug: 'inc-20261117-remote-v4-drain-cc-auth', db: false,
    file: 'packages/gateway/src/__tests__/remotePoolDrainAndCcAuthProof.test.ts',
    cases: [
      'synthetic CC verification_required API error classifies as non-recoverable AUTH_ERROR and settled turn clears lease timer + localStopped for clean cutover drain (INC-20261117-REMOTE-V4-DRAIN-CC-AUTH)',
      'undispatched /abandon resets localStopped for clean idle teardown and late /tool/stopped re-drives stop() closure (INC-20261117-REMOTE-V4-DRAIN-CC-AUTH)',
      'cross-window 20-turn mixed replay preserves synthetic errorCode without conflict while tampered duplicate fences with REMOTE_TERMINAL_CONFLICT (INC-20261117-REMOTE-V4-DRAIN-CC-AUTH)',
    ],
  },
]

function fail(message: string): never {
  throw new Error(`[master-incident-proofs] ${message}`)
}

/** A loopback *_test database, as the other proof gates require. */
export function assertTestDsn(raw: string | undefined): string {
  if (!raw) fail('TEST_DATABASE_URL is required (a loopback *_test database)')
  let url: URL
  try { url = new URL(raw) } catch { fail('TEST_DATABASE_URL is not a URL') }
  if (!/^postgres(ql)?:$/.test(url.protocol)) fail('TEST_DATABASE_URL is not postgres')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('TEST_DATABASE_URL is not loopback')
  if (!/_test$/.test(url.pathname.slice(1))) fail('TEST_DATABASE_URL does not name a *_test database')
  if (url.search) fail('TEST_DATABASE_URL must not carry query overrides')
  return raw
}

type Leaf = { name: string; ok: boolean; skip: boolean }

/** Every reported test point of node --test's TAP output, nested ones included. */
export function tapLeaves(tap: string): Leaf[] {
  const leaves: Leaf[] = []
  for (const line of tap.split('\n')) {
    const m = /^\s*(not )?ok \d+ - (.*?)(\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line)
    if (m) leaves.push({ name: m[2]!, ok: !m[1], skip: Boolean(m[3]) })
  }
  return leaves
}

export function judge(proof: Proof, tap: string, status: number | null): string[] {
  const leaves = tapLeaves(tap)
  const out: string[] = []
  for (const name of proof.cases) {
    const leaf = leaves.find((item) => item.name === name)
    if (!leaf) fail(`${proof.incident}: case missing — ${name}`)
    if (leaf.skip) fail(`${proof.incident}: case skipped — ${name}`)
    if (!leaf.ok) fail(`${proof.incident}: case failed — ${name}`)
    out.push(`[${proof.slug}] PASS — ${name}`)
  }
  const failed = leaves.filter((item) => !item.ok).map((item) => item.name)
  if (failed.length || status !== 0) fail(`${proof.incident}: ${proof.file} not green (${failed.join('; ') || `exit ${status}`})`)
  return out
}

/** Real wrapper fault injection: no test-module import and no model/Box launch. */
async function profileAttributionProof(): Promise<string> {
  const nonce = 'a'.repeat(24)
  const cwd = `/tmp/ocv5-289-run-${nonce}`
  const rejected = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n'
  const bytes = Buffer.from(rejected)
  const envelope = JSON.stringify({ offset: bytes.length, data: bytes.toString('base64') })
  let launches = 0
  let reads = 0
  for (const kind of ['unknown', 'missing_nonce', 'raw_stdout', 'known_owner'] as const) {
    const health = new BoxProfileHealth(() => 1_000)
    if (kind === 'known_owner') health.noteRun(nonce, '7:a')
    const request = { command: '/p', args: ['--read', ...(kind === 'missing_nonce' ? [] : [cwd]), '0', '65536'],
      cwd: '/tmp', environment: {} }
    const response = { stdout: kind === 'raw_stdout' ? rejected : envelope,
      stderrBytes: 0, exitCode: 0 as const }
    const seen: unknown[] = []
    const chunks: string[] = []
    const inner: Parameters<typeof scopeBoxExecToProfile>[0] = { run: async (input, opts) => {
      if (isBoxLaunchRequest(input)) { launches++; throw new Error('proof must never launch a model') }
      reads++
      seen.push(input)
      opts?.onStdout?.(response.stdout)
      return response
    } }
    const exec = scopeBoxExecToProfile(inner, { key: '7:default', profile: 'default', health })
    assert.equal(await exec.run(request, { timeoutMs: 1000, maxResponseBytes: 65_536,
      onStdout: (chunk) => chunks.push(chunk) }), response)
    assert.equal(seen[0], request, 'read command and byte offsets must pass through unchanged')
    assert.deepEqual(chunks, [response.stdout], 'caller receives exact stdout')
    assert.equal(health.get('7:default'), undefined, `${kind}: observer health must not be polluted`)
    if (kind === 'known_owner') assert.equal(health.cooldownActive('7:a'), true)
    else assert.equal(health.get('7:a'), undefined)
  }
  assert.equal(reads, 4, 'all real scopedExec fault injections must be reached')
  assert.equal(launches, 0)
  return '[inc-20261102-box-profile-observer-attribution] PASS — unknown observers never poison login health; known owners remain exact; zero launches'
}

type FileGroup = {
  file: string
  db: boolean
  entries: Array<{ index: number; proof: Proof }>
}

export function groupProofsByFile(proofs: readonly Proof[]): FileGroup[] {
  const byFile = new Map<string, FileGroup>()
  const groups: FileGroup[] = []
  proofs.forEach((proof, index) => {
    const existing = byFile.get(proof.file)
    if (existing) {
      existing.db = existing.db || proof.db
      existing.entries.push({ index, proof })
    } else {
      const group: FileGroup = { file: proof.file, db: proof.db, entries: [{ index, proof }] }
      byFile.set(proof.file, group)
      groups.push(group)
    }
  })
  return groups
}

function resolveNoDbConcurrency(): number {
  const raw = process.env.OC_V5_MASTER_PROOF_CONCURRENCY
  if (raw && /^\d+$/.test(raw)) {
    return Math.max(1, Math.min(6, Number(raw)))
  }
  return Math.max(2, Math.min(3, Math.floor(cpus().length / 6) || 2))
}

function resolveDbConcurrency(): number {
  const raw = process.env.OC_V5_MASTER_PROOF_DB_CONCURRENCY
  if (raw && /^\d+$/.test(raw)) {
    return Math.max(1, Math.min(4, Number(raw)))
  }
  return cpus().length >= 8 ? 3 : 2
}

// Longest-processing-time-first ordering for heavy DB and no-DB proofs reduces tail latency.
const HEAVY_DB_ORDER: readonly string[] = [
  'packages/commercial/src/__tests__/login.integ.test.ts',
  'packages/commercial/src/__tests__/studioComposeFlow.integ.test.ts',
  'packages/commercial/src/__tests__/studioAnnotations.integ.test.ts',
  'packages/commercial/src/__tests__/openTurnAttribution.integ.test.ts',
  'packages/commercial/src/__tests__/studioOrchestrator.integ.test.ts',
  'packages/commercial/src/__tests__/alertOutboxInboxFallback.integ.test.ts',
]

const HEAVY_NODB_FILES = new Set([
  'packages/gateway/src/__tests__/remotePoolDrainAndCcAuthProof.test.ts',
  'packages/gateway/src/__tests__/cc5BashTimeoutProof.test.ts',
  'packages/gateway/src/__tests__/remotePoolTerminalSettlement.test.ts',
])

// Strip all PG/DSN/loader overrides so DB workers can only reach their assigned slot DSN
// and no-DB workers never inherit any database URL.
const STRIPPED_WORKER_ENV_KEYS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'NATIVE_FINANCE_TEST_DATABASE_URL',
  'OCV5_289_JOURNAL_TEST_DATABASE_URL',
  'OC_V5_PROOF_TEST_DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'PGSERVICE',
  'PGOPTIONS',
  'PGSSLMODE',
  'NODE_OPTIONS',
  'NODE_PATH',
] as const

export function buildWorkerEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts: { db: boolean; dsn?: string; tmpdir: string },
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...baseEnv }
  for (const key of STRIPPED_WORKER_ENV_KEYS) {
    delete clean[key]
  }
  clean.TMPDIR = opts.tmpdir
  if (opts.db) {
    if (!opts.dsn) fail('internal error: DB worker missing slot DSN')
    clean.TEST_DATABASE_URL = opts.dsn
  }
  return clean
}

type EphemeralDbCleanupResult = {
  ok: boolean
  failures: string[]
}

type EphemeralDbPool = {
  dsns: string[]
  cleanup: () => EphemeralDbCleanupResult
}

export function resolvePersistentGateDbRegistry(privateTmp: string): string | null {
  const explicit = process.env.OC_V5_GATE_DB_REGISTRY?.trim()
  if (explicit) {
    const absReg = resolve(explicit)
    const absTmp = resolve(privateTmp)
    if (absReg === absTmp || absReg.startsWith(`${absTmp}/`)) {
      return null
    }
    return absReg
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return '/var/lib/openclaude-v5-commercial/gate-test-dbs'
  }
  // Non-root without an explicit persistent registry falls back to serialized shared DSN
  // so drop failures can never lose the only ownership token when privateTmp is deleted.
  return null
}

function allocateEphemeralDbPool(baseDsn: string, count: number, privateTmp: string): EphemeralDbPool {
  const helper = join(process.cwd(), 'scripts/lib/gateTestDb.mjs')
  const registryDir = resolvePersistentGateDbRegistry(privateTmp)
  if (count <= 1 || !existsSync(helper) || !registryDir) {
    return { dsns: [baseDsn], cleanup: () => ({ ok: true, failures: [] }) }
  }
  const helperEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OC_V5_GATE_BASE_DSN: baseDsn,
    OC_V5_GATE_DB_REGISTRY: registryDir,
  }
  try {
    execFileSync(process.execPath, [helper, 'sweep'], {
      cwd: process.cwd(),
      env: helperEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
    })
  } catch {
    // Best-effort orphan sweep; creation failure below falls back cleanly to shared DSN.
  }
  const created: Array<{ name: string; url: string }> = []
  const cleanup = (): EphemeralDbCleanupResult => {
    const failures: string[] = []
    while (created.length > 0) {
      const item = created.pop()!
      try {
        execFileSync(process.execPath, [helper, 'drop', item.name], {
          cwd: process.cwd(),
          env: helperEnv,
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 30_000,
        })
      } catch (err) {
        // Keep persistent registry record intact so the next sweep can reclaim the DB.
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`${item.name}: ${msg}`)
      }
    }
    return { ok: failures.length === 0, failures }
  }
  try {
    for (let i = 0; i < count; i++) {
      const url = execFileSync(process.execPath, [helper, 'create', String(process.pid)], {
        cwd: process.cwd(),
        env: helperEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      }).trim()
      const m = /\/(ocv5_gate_[0-9]+_[0-9a-f]{12}_test)$/.exec(url)
      if (!m) throw new Error('unexpected ephemeral gate DB URL')
      created.push({ name: m[1]!, url })
    }
    return { dsns: created.map((c) => c.url), cleanup }
  } catch {
    const rollback = cleanup()
    if (!rollback.ok) {
      fail(
        `ephemeral gate DB pool creation failed and rollback drop failed; registry entries retained for sweep: ${rollback.failures.join('; ')}`,
      )
    }
    return { dsns: [baseDsn], cleanup: () => ({ ok: true, failures: [] }) }
  }
}

const FILE_TIMEOUT_MS = 240_000
const MAX_BUFFER_BYTES = 64 * 1024 * 1024

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    return code === 'EPERM'
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const m = /^State:\s+(\S)/m.exec(status)
    if (m && m[1] === 'Z') return false
  } catch {
    return false
  }
  return true
}

function collectDescendants(roots: Iterable<number>, seen: Set<number>): void {
  const byParent = new Map<number, number[]>()
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const m = /^PPid:\s+(\d+)/m.exec(status)
      if (!m) continue
      const ppid = Number(m[1])
      let list = byParent.get(ppid)
      if (!list) {
        list = []
        byParent.set(ppid, list)
      }
      list.push(pid)
    } catch {
      // Process exited while scanning /proc.
    }
  }
  const queue = [...roots, ...seen]
  while (queue.length > 0) {
    const cur = queue.pop()!
    const kids = byParent.get(cur)
    if (!kids) continue
    for (const kid of kids) {
      if (kid !== process.pid && !seen.has(kid)) {
        seen.add(kid)
        queue.push(kid)
      }
    }
  }
}

export async function terminateProcessTree(rootPid: number, graceMs = 1_500): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 1 || rootPid === process.pid) return
  const seen = new Set<number>([rootPid])
  collectDescendants([rootPid], seen)

  const signalAll = (sig: NodeJS.Signals) => {
    collectDescendants([rootPid], seen)
    for (const pid of seen) {
      if (pid !== process.pid) {
        try { process.kill(pid, sig) } catch {}
      }
    }
  }

  signalAll('SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    collectDescendants([rootPid], seen)
    let anyAlive = false
    for (const pid of seen) {
      if (isPidAlive(pid)) {
        anyAlive = true
        break
      }
    }
    if (!anyAlive) return
    await new Promise((r) => setTimeout(r, 50))
  }

  signalAll('SIGKILL')
  const killDeadline = Date.now() + 2_000
  while (Date.now() < killDeadline) {
    collectDescendants([rootPid], seen)
    let anyAlive = false
    for (const pid of seen) {
      if (isPidAlive(pid)) {
        anyAlive = true
        break
      }
    }
    if (!anyAlive) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

type ActiveChild = {
  child: ChildProcess
  pid: number | null
}

function runProofFile(
  file: string,
  env: NodeJS.ProcessEnv,
  active: Set<ActiveChild>,
): Promise<{ stdout: string; status: number | null; elapsedMs: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const started = Date.now()
    // Keep workers in the outer process group (detached: false) so an outer supervisor
    // PGID SIGKILL on lease loss reaps every npx/tsx/node worker atomically; normal
    // timeout/abort reaps the entire descendant tree via /proc in terminateProcessTree.
    const child = spawn(
      'npx',
      ['--no-install', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', file],
      { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const entry: ActiveChild = { child, pid: typeof child.pid === 'number' ? child.pid : null }
    active.add(entry)
    let stdout = ''
    let stderr = ''
    let totalBytes = 0
    let settled = false
    let timedOut = false
    let overflowed = false

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active.delete(entry)
      fn()
    }

    const drainTreeAndSettle = (fn: () => void) => {
      if (entry.pid !== null) {
        void terminateProcessTree(entry.pid, 1_500).finally(() => settle(fn))
      } else {
        settle(fn)
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      if (entry.pid !== null) {
        void terminateProcessTree(entry.pid, 1_500)
      } else {
        try { child.kill('SIGTERM') } catch {}
      }
    }, FILE_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      totalBytes += Buffer.byteLength(chunk)
      if (totalBytes > MAX_BUFFER_BYTES) {
        overflowed = true
        if (entry.pid !== null) {
          void terminateProcessTree(entry.pid, 500)
        } else {
          try { child.kill('SIGKILL') } catch {}
        }
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk
    })
    child.on('error', (err) => {
      drainTreeAndSettle(() => rejectRun(new Error(`${file}: ${err.message}`)))
    })
    child.on('close', (code, signal) => {
      if (timedOut) {
        drainTreeAndSettle(() => rejectRun(new Error(`${file}: timed out after ${FILE_TIMEOUT_MS}ms`)))
        return
      }
      if (overflowed) {
        drainTreeAndSettle(() => rejectRun(new Error(`${file}: TAP output exceeded ${MAX_BUFFER_BYTES} bytes`)))
        return
      }
      if (signal) {
        drainTreeAndSettle(() => rejectRun(new Error(`${file}: killed by signal ${signal}${stderr ? ` (${stderr.trim().slice(0, 200)})` : ''}`)))
        return
      }
      drainTreeAndSettle(() => resolveRun({ stdout, status: code, elapsedMs: Date.now() - started }))
    })
  })
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  isAborted: () => boolean,
  onAbort: () => void,
  worker: (item: T, slot: number) => Promise<void>,
): Promise<void> {
  let next = 0
  let firstErr: unknown = null
  const runners = Array.from({ length: Math.min(limit, items.length) }, async (_unused, slot) => {
    while (firstErr === null && !isAborted()) {
      const i = next++
      if (i >= items.length) return
      try {
        await worker(items[i]!, slot)
      } catch (err) {
        if (firstErr === null) firstErr = err
        onAbort()
        return
      }
    }
  })
  await Promise.allSettled(runners)
  if (firstErr !== null) throw firstErr
}

async function main(): Promise<void> {
  const dsn = assertTestDsn(process.env.TEST_DATABASE_URL)
  // Isolate tsx compile cache per invocation so bloated /tmp/tsx-0 (tens of thousands of stale
  // entries) never stalls startup or contends across concurrent workers.
  const privateTmp = mkdtempSync(join(tmpdir(), 'oc-master-proofs-tmp-'))
  const groups = groupProofsByFile(MASTER_INCIDENT_PROOFS)
  const dbOrderRank = (file: string) => {
    const idx = HEAVY_DB_ORDER.indexOf(file)
    return idx >= 0 ? idx : HEAVY_DB_ORDER.length
  }
  const dbGroups = groups
    .filter((g) => g.db)
    .sort((a, b) => dbOrderRank(a.file) - dbOrderRank(b.file))
  const heavyNoDb = groups.filter((g) => !g.db && HEAVY_NODB_FILES.has(g.file))
  const lightNoDb = groups.filter((g) => !g.db && !HEAVY_NODB_FILES.has(g.file))
  // Interleave heavy subprocess-spawning suites with light ones so heavy suites do not
  // all saturate CPU/timers simultaneously while still starting early to hide tail latency.
  const noDbGroups: FileGroup[] = []
  let hi = 0
  let li = 0
  while (hi < heavyNoDb.length || li < lightNoDb.length) {
    if (hi < heavyNoDb.length) noDbGroups.push(heavyNoDb[hi++]!)
    for (let k = 0; k < 2 && li < lightNoDb.length; k++) noDbGroups.push(lightNoDb[li++]!)
  }
  const dbPool = allocateEphemeralDbPool(dsn, Math.min(resolveDbConcurrency(), dbGroups.length), privateTmp)
  const resultsByIndex: string[][] = Array.from({ length: MASTER_INCIDENT_PROOFS.length }, () => [])
  const active = new Set<ActiveChild>()
  let aborted = false
  let signalReceived: NodeJS.Signals | null = null

  const terminateAllActive = async (): Promise<void> => {
    const snapshot = [...active]
    await Promise.allSettled(
      snapshot.map(async (entry) => {
        if (entry.pid !== null) {
          await terminateProcessTree(entry.pid, 1_500)
        } else {
          try { entry.child.kill('SIGTERM') } catch {}
        }
      }),
    )
  }

  const triggerAbort = () => {
    if (aborted) return
    aborted = true
    void terminateAllActive()
  }

  const onSig = (sig: NodeJS.Signals) => {
    if (!signalReceived) signalReceived = sig
    triggerAbort()
  }
  process.once('SIGINT', onSig)
  process.once('SIGTERM', onSig)

  let workerSeq = 0
  const executeGroup = async (group: FileGroup, slot: number): Promise<void> => {
    if (aborted) return
    const workerTmp = mkdtempSync(join(privateTmp, `w${++workerSeq}-`))
    const slotDsn = dbPool.dsns[slot % dbPool.dsns.length]!
    const env = buildWorkerEnv(process.env, { db: group.db, dsn: slotDsn, tmpdir: workerTmp })
    try {
      const run = await runProofFile(group.file, env, active)
      if (aborted) return
      for (const { index, proof } of group.entries) {
        resultsByIndex[index] = judge(proof, run.stdout, run.status)
      }
      if (process.env.OC_V5_MASTER_PROOF_TIMING === '1') {
        process.stderr.write(`[master-incident-proofs] ${group.db ? `db[${slot}]` : 'nodb'} ${(run.elapsedMs / 1000).toFixed(1)}s ${group.file}\n`)
      }
    } finally {
      try { rmSync(workerTmp, { recursive: true, force: true }) } catch {}
    }
  }

  let profileLine = ''
  let primaryError: unknown = null
  let cleanupResult: EphemeralDbCleanupResult = { ok: true, failures: [] }
  try {
    const settled = await Promise.allSettled([
      profileAttributionProof(),
      runPool(noDbGroups, resolveNoDbConcurrency(), () => aborted, triggerAbort, executeGroup),
      runPool(dbGroups, dbPool.dsns.length, () => aborted, triggerAbort, executeGroup),
    ])
    // Ensure every active worker process group is fully drained before dropping DBs or removing TMPDIR.
    await terminateAllActive()
    if (settled[0].status === 'fulfilled') {
      profileLine = settled[0].value
    } else {
      primaryError = settled[0].reason
    }
    for (const outcome of settled.slice(1)) {
      if (outcome.status === 'rejected' && primaryError === null) {
        primaryError = outcome.reason
      }
    }
  } finally {
    await terminateAllActive()
    process.off('SIGINT', onSig)
    process.off('SIGTERM', onSig)
    cleanupResult = dbPool.cleanup()
    try { rmSync(privateTmp, { recursive: true, force: true }) } catch {}
  }

  if (signalReceived) {
    process.exit(signalReceived === 'SIGINT' ? 130 : 143)
  }
  if (primaryError !== null) {
    if (primaryError instanceof Error && primaryError.message.startsWith('[master-incident-proofs]')) {
      throw primaryError
    }
    fail(primaryError instanceof Error ? primaryError.message : String(primaryError))
  }
  if (!cleanupResult.ok) {
    fail(`failed to drop ephemeral gate DB(s); registry entries retained for sweep: ${cleanupResult.failures.join('; ')}`)
  }

  const lines: string[] = [profileLine]
  for (const groupLines of resultsByIndex) lines.push(...groupLines)
  for (const line of lines) console.log(line)
  console.log(`[master-incident-proofs] PASS ${lines.length} cases`)
}

if (import.meta.url === `file://${process.argv[1]}`) void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
