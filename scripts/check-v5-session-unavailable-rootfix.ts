import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd()
const bridge = readFileSync(join(root, 'packages/commercial/src/ws/userChatBridge.ts'), 'utf8')
const reconciler = readFileSync(
  join(root, 'packages/commercial/src/dispatch/turnDispatchReconciler.ts'),
  'utf8',
)
const sessionManager = readFileSync(join(root, 'packages/gateway/src/sessionManager.ts'), 'utf8')
const memoryDir = readFileSync(join(root, 'packages/storage/src/memoryDir.ts'), 'utf8')

const timeout = bridge.match(
  /DEFAULT_PROMPT_QUEUE_PREPARATION_TIMEOUT_MS\s*=\s*([0-9_]+)/,
)
const timeoutMs = timeout ? Number(timeout[1]!.replaceAll('_', '')) : 0
if (timeoutMs < 30_000) {
  throw new Error('[session-unavailable-rootfix] preparation budget is shorter than PG')
}
if (bridge.includes('terminalizeAllEnriching("client_disconnected_before_enrichment_transfer")')) {
  throw new Error('[session-unavailable-rootfix] browser detach still terminalizes enrichment')
}
if ((bridge.match(/trackPreparation\(async/g) ?? []).length !== 5) {
  throw new Error('[session-unavailable-rootfix] every engine preparation lane must be tracked')
}
for (const marker of [
  'classifyTurnDispatchReceipt(receipt, rec)',
  'if (disposition === "rejected")',
  'if (!acceptEnrichmentReceipt(rec)) return;',
  'getExecutors: () => uidToCronOriginExecutors.get(input.uid.toString()) ?? []',
  'if (admit.kind === "already_owned") return { kind: "in_flight" };',
  'forwardInboundFrame(frameData, frameIsBinary, frameLength, dispatchRecord)',
]) {
  if (!bridge.includes(marker)) {
    throw new Error(`[session-unavailable-rootfix] missing bridge invariant: ${marker}`)
  }
}
const rejected = reconciler.indexOf("if (res.state === 'rejected')")
const ageGate = reconciler.indexOf('if (age < stuckMs && !hasDeadEvidence) continue', rejected)
if (rejected < 0 || ageGate < 0 || rejected > ageGate) {
  throw new Error('[session-unavailable-rootfix] rejected tombstone is still behind the age gate')
}
if (!sessionManager.includes('totalBudgetMs: 60_000')) {
  throw new Error('[session-unavailable-rootfix] foreground memory barrier retry budget is missing')
}
for (const marker of ['class MemoryBarrierTimeoutError', 'while (quiesceAttempts < 3)']) {
  if (!memoryDir.includes(marker)) {
    throw new Error(`[session-unavailable-rootfix] missing memory barrier invariant: ${marker}`)
  }
}

// INC-20260906-COMMERCIAL-UNIT-HANG-DEFAULT-CODEX-MODEL: the bridge rewrites teamMode:true
// turns to DEFAULT_CODEX_ENGINE_MODEL. The model-authorization test must assert that constant
// (never a model literal) and must bound its container-frame wait, otherwise a stub assertion
// failure becomes SESSION_PERSIST_UNAVAILABLE + an unbounded await that hangs commercial-unit
// until the 30 min CI timeout (PR #557, 2026-09-06, twice).
const bridgeTests = readFileSync(
  join(root, 'packages/commercial/src/__tests__/userChatBridge.test.ts'),
  'utf8',
)
if (!/import \{[^}]*DEFAULT_CODEX_ENGINE_MODEL[^}]*\} from "@openclaude\/protocol"/.test(bridgeTests)) {
  throw new Error('[session-unavailable-rootfix] userChatBridge.test.ts must import DEFAULT_CODEX_ENGINE_MODEL')
}
if (!/model: DEFAULT_CODEX_ENGINE_MODEL,\s*teamMode: true,/.test(bridgeTests)) {
  throw new Error('[session-unavailable-rootfix] teamMode:true routing assertion must use DEFAULT_CODEX_ENGINE_MODEL, not a literal')
}
if (!bridgeTests.includes('container never received the forwarded turn within 5s')) {
  throw new Error('[session-unavailable-rootfix] persisted-before-history test lost its bounded container wait')
}
if (!bridge.includes('effectiveModel = DEFAULT_CODEX_ENGINE_MODEL;')) {
  throw new Error('[session-unavailable-rootfix] bridge no longer pins teamMode main to DEFAULT_CODEX_ENGINE_MODEL')
}

console.log(
  '[session-unavailable-rootfix] PASS — detach drain, durable cron receipt, rejected convergence and bounded memory retry are locked',
)
console.log('[session-unavailable-rootfix] PASS — INC-20260906-COMMERCIAL-UNIT-HANG-DEFAULT-CODEX-MODEL team-leader default-model test contract is locked')

// INC-20260907-MEDIA-CURSOR-PRECISION: source regression guard, not end-to-end proof.
// The mediaGeneration integration suite separately verifies real PostgreSQL ordering.
const mediaStore = readFileSync(join(root, 'packages/commercial/src/media-generation/store.ts'), 'utf8')
for (const [name, next, column, rows] of [
  ['listJobs', 'queuePosition', 'created_at', 'jobs'],
  ['listProjects', 'getProject', 'updated_at', 'projects'],
] as const) {
  const start = mediaStore.indexOf(`export async function ${name}(`)
  const end = mediaStore.indexOf(`export async function ${next}(`, start)
  const body = start >= 0 && end > start ? mediaStore.slice(start, end) : ''
  for (const marker of [
    `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`,
    `const last = result.rows[${rows}.length - 1]`,
    'encodeDateCursor(last.cursor_at, last.id)',
  ]) {
    if (!body.includes(marker)) {
      throw new Error(`[media-cursor-rootfix] ${name} precise keyset contract missing: ${marker}`)
    }
  }
  if (name === 'listProjects' && !body.includes('result.rows.map(({ cursor_at: _cursorAt, ...project }) => project)')) {
    throw new Error('[media-cursor-rootfix] listProjects must strip the private cursor column')
  }
}
const mediaEncoder = mediaStore.slice(mediaStore.indexOf('function encodeDateCursor('), mediaStore.indexOf('function decodeCursor('))
if (!mediaEncoder.includes('JSON.stringify([timestamp, id])') || mediaEncoder.includes('toISOString')) {
  throw new Error('[media-cursor-rootfix] cursor encoder must preserve the raw PostgreSQL timestamp')
}
console.log('[media-cursor-rootfix] PASS — INC-20260907-MEDIA-CURSOR-PRECISION source contracts locked')

// INC-20260907-DELEGATE-LEDGER-REAP: source regression guard, not end-to-end proof.
// The delegateDurable unit suite separately exercises real SQLite retire/prune and
// a real-interval cron heartbeat; this gate only stops the contracts regressing.
const delegateDurableSrc = readFileSync(join(root, 'packages/gateway/src/delegateDurable.ts'), 'utf8')
const delegateJobsSrc = readFileSync(join(root, 'packages/gateway/src/delegateJobs.ts'), 'utf8')
const delegateServerSrc = readFileSync(join(root, 'packages/gateway/src/server.ts'), 'utf8')
const delegateCronSrc = readFileSync(join(root, 'packages/gateway/src/cron.ts'), 'utf8')

// Retired rows must stay invisible to every runtime read/CAS. If this count drops,
// some statement started seeing audit-only rows and the ledger stopped being
// behaviourally equivalent to the old physical DELETE.
const retiredGuards = (delegateDurableSrc.match(/retired_at IS NULL/g) ?? []).length
if (retiredGuards < 10) {
  throw new Error(
    `[delegate-ledger-reap] expected >=10 "retired_at IS NULL" guards in delegateDurable.ts, found ${retiredGuards}`,
  )
}
if (!delegateDurableSrc.includes('WHERE idempotency_key IS NOT NULL AND retired_at IS NULL')) {
  throw new Error(
    '[delegate-ledger-reap] idempotency unique index must stay partial on retired_at, or a retired cron occurrence key can no longer be reused',
  )
}
for (const marker of ['casRetire(', 'prunePastRetention(', 'DELEGATE_LEDGER_RETENTION_MS', 'retired_at INTEGER']) {
  if (!delegateDurableSrc.includes(marker)) {
    throw new Error(`[delegate-ledger-reap] delegateDurable.ts lost retention contract: ${marker}`)
  }
}
for (const marker of ['reapStaleRunning(', "'heartbeat_timeout'", 'DELEGATE_HEARTBEAT_TIMEOUT_MS', 'persistRetire(']) {
  if (!delegateJobsSrc.includes(marker)) {
    throw new Error(`[delegate-ledger-reap] delegateJobs.ts lost reaper contract: ${marker}`)
  }
}
// idleSec must be captured before fail() rewrites last_activity_at.
if (!delegateJobsSrc.includes('reaped.push({ job: snap, idleSec })')) {
  throw new Error('[delegate-ledger-reap] reapStaleRunning must report the pre-reap idle span')
}
if (!delegateServerSrc.includes('_armDelegateReaper(')) {
  throw new Error('[delegate-ledger-reap] server.ts lost the reaper interval wiring')
}
// Settling the ledger row does not stop the child; the interrupt is what keeps
// "ledger failed" and "subprocess running" from diverging.
if (!delegateServerSrc.includes('delegate_heartbeat_timeout_reaped')) {
  throw new Error('[delegate-ledger-reap] server.ts lost the reap log event')
}
if (!/interrupted = this\.sessions\.interrupt\(job\.sessionKey\) === true/.test(delegateServerSrc)) {
  throw new Error('[delegate-ledger-reap] reaped rows must interrupt their child session')
}
// Protocol events are not a heartbeat (tool_use_detected never reaches onEvent),
// so the cron row needs a timer beat between claim and settle.
if (!delegateCronSrc.includes('startCronDelegateHeartbeat(')) {
  throw new Error('[delegate-ledger-reap] cron.ts lost the claimed-occurrence heartbeat')
}
if (!delegateCronSrc.includes('cronHeartbeat?.stop()')) {
  throw new Error('[delegate-ledger-reap] cron heartbeat must be stopped on every execution path')
}
console.log('[delegate-ledger-reap] PASS — INC-20260907-DELEGATE-LEDGER-REAP source contracts locked')

// INC-20260908-GROK-POOL-NO-COOLDOWN: source regression guard, not end-to-end proof.
// Unit suites (internalGrokRelay / cursorExternalSettle) exercise the classifier,
// the recorder ordering and the last_error contract; this gate only stops the
// production wiring from silently reverting to the counter-only recorder.
const grokRelaySrc = readFileSync(join(root, 'packages/commercial/src/http/internalGrokRelay.ts'), 'utf8')
const commercialIndexSrc = readFileSync(join(root, 'packages/commercial/src/index.ts'), 'utf8')
const cursorSettleSrc = readFileSync(join(root, 'packages/commercial/src/billing/cursorExternalSettle.ts'), 'utf8')
for (const marker of ['export function classifyGrokRelayStatus(', 'export function makeGrokRelayHealthRecorder(', 'health.onFailure(accountId, `grok_http_${statusCode}`)']) {
  if (!grokRelaySrc.includes(marker)) {
    throw new Error(`[grok-pool-cooldown] internalGrokRelay.ts lost health-feedback contract: ${marker}`)
  }
}
// 5xx must stay an 'upstream' outcome (visible, not a strike): a global xAI
// outage cooling every Grok account for 10 minutes would be worse than the
// bug this fixes. If someone folds 5xx back into 'failure', this fires.
if (!/if \(status >= 500\) return 'upstream'/.test(grokRelaySrc)) {
  throw new Error("[grok-pool-cooldown] classifyGrokRelayStatus must map 5xx to 'upstream', never to a health strike")
}
// The relay must be constructed with the tracker-backed recorder; the bare
// counter fallback inside makeGrokRelayHandler is for tracker-less callers only.
if (!/makeGrokRelayHandler\(\{[\s\S]{0,600}?recordStatus: makeGrokRelayHealthRecorder\(\{ health: healthTracker \}\)/.test(commercialIndexSrc)) {
  throw new Error('[grok-pool-cooldown] index.ts must wire makeGrokRelayHealthRecorder({ health: healthTracker }) into makeGrokRelayHandler')
}
// Cursor rows stay OFF the health tracker (materializer whitelist), but the
// failure path must keep writing last_error so the admin table shows it.
if (!cursorSettleSrc.includes('export function planCursorAccountUsageBump(')) {
  throw new Error('[grok-pool-cooldown] cursorExternalSettle.ts lost planCursorAccountUsageBump')
}
if (!/last_error = \$2/.test(cursorSettleSrc) || !/last_error = NULL/.test(cursorSettleSrc)) {
  throw new Error('[grok-pool-cooldown] cursor settle must write last_error on failure and clear it on success')
}
if (/health\.on(Success|Failure)\(/.test(cursorSettleSrc)) {
  throw new Error('[grok-pool-cooldown] cursor settle must not call AccountHealthTracker (materializer whitelist depends on health/status/cooldown)')
}
console.log('[grok-pool-cooldown] PASS — INC-20260908-GROK-POOL-NO-COOLDOWN source contracts locked')

// --- OCV5-180 C data-safety proof (post-201; B1 must append after this block) ---
// Helper-chain source checks first, then real node:test TAP. Do not comment-cheat
// SET LOCAL back into liveFrameClassification.ts — timeout lives in the helper.

const candidateRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const classifySrc = readFileSync(
  join(candidateRoot, 'packages/commercial/src/db/liveFrameClassification.ts'),
  'utf8',
)
const helperSrc = readFileSync(
  join(candidateRoot, 'packages/commercial/src/db/boundedReadOnly.ts'),
  'utf8',
)
const healthSrc = readFileSync(join(candidateRoot, 'packages/commercial/src/admin/businessHealth.ts'), 'utf8')
const retentionSrc = readFileSync(
  join(candidateRoot, 'packages/commercial/src/admin/auditRetention.ts'),
  'utf8',
)
if (!classifySrc.includes('withBoundedReadOnly')) {
  throw new Error('[live-frame-classify] classification must call withBoundedReadOnly')
}
if (!classifySrc.includes('isBoundedReadTimeout')) {
  throw new Error('[live-frame-classify] classification must map helper timeouts via isBoundedReadTimeout')
}
if (!classifySrc.includes('export async function classifyRetiredLiveJournals(')) {
  throw new Error('[live-frame-classify] classifyRetiredLiveJournals export missing')
}
if (!classifySrc.includes('unknown: true')) {
  throw new Error('[live-frame-classify] unknown classification arm missing')
}
if (classifySrc.includes('SET LOCAL statement_timeout')) {
  throw new Error(
    '[live-frame-classify] statement_timeout must stay in boundedReadOnly.ts, not be copied into classifySrc',
  )
}
if (!helperSrc.includes('SET LOCAL statement_timeout')) {
  throw new Error('[live-frame-classify] boundedReadOnly.ts lost SET LOCAL statement_timeout')
}
if (!/BEGIN READ ONLY/.test(helperSrc)) {
  throw new Error('[live-frame-classify] boundedReadOnly.ts lost BEGIN READ ONLY')
}
if (/\bDELETE FROM client_session_live_/.test(classifySrc) || /\bDELETE FROM client_session_live_/.test(helperSrc)) {
  throw new Error('[live-frame-classify] classification must not DELETE live frames')
}
if (!healthSrc.includes('backupFreshness: "not_in_scope"') || healthSrc.includes('ok:')) {
  throw new Error('[live-frame-classify] business health must stay off /healthz.ok and mark backup not_in_scope')
}
if (!retentionSrc.includes('"model_pricing_0903_cw_backup"')) {
  throw new Error('[live-frame-classify] model_pricing_0903_cw_backup must stay on the permanent ledger')
}

const C_FULL_LEAVES = [
  'pricing miss throws and never closes the audit row',
  'settle commits before the audit row closes (query order)',
  'close UPDATE failure keeps usage committed; retry is idempotent and closes',
  'concurrent settlers share one committed usage and close the audit once',
  'audit user mismatch refuses to settle against the foreign wallet',
  'live overrides keep unavailable status, live terminalCode and verified accountId',
  "tick scans only status='pending' and performs no writes when none are pending",
  'settle failure keeps the audit pending; the next tick settles and closes exactly once',
  'connection refusal must remain unknown in the business-health snapshot',
  'a stalled pool acquisition must not outlive the bounded health check',
  'opens BEGIN READ ONLY and never sets default_transaction_read_only on the current txn',
  'query timeout destroys the client and does not hang',
  'late connect success releases once and does not run fn',
  'late connect reject is consumed with no unhandledRejection',
  'timeout then a later call recovers',
  'query timeout on one count stays unknown and the snapshot still settles',
  'retention alone hanging still reports unknown without blocking other items',
  'classifies inflight / tapeRecoverable / uniqueCopy without DELETE',
  'timeout returns unknown with null counts, never fake 0',
  'dry-run restore samples tape reachable vs replay_live and writes nothing',
  'model_pricing_0903_cw_backup is a permanent ledger and never a TTL table',
  'live coverage reports unregistered names; timeout/error is unknown not empty-green',
  'business health snapshot has no ok field and preserves unknown',
  'serves PAC and healthz without auth; 404 elsewhere',
  'CONNECT without credentials → 407 with Proxy-Authenticate',
  'CONNECT with wrong secret → 407',
  'valid credential but not entitled (not admin, not allowlisted) → 403',
  'allowlisted host outside whitelist → 403; port 80 → 403',
  'admin CONNECT to chatgpt.com builds transparent tunnel via upstream',
  'allowlisted regular user is admitted; settings off blocks even admin',
  'client close during pending keeps reservation; 65th 429; release frees; no double count',
  'upstream failure during pending releases the reservation without 200',
  'client close + 10s upstream timeout releases reservation and real socket',
  'classifies every frontend-visible retryable code into automatic recovery or an explicit unsafe transport/admission exclusion',
  'includes transient execution failures but excludes user/action and admission failures',
  'normalizes every deployed unexpected runner label to one recovery policy',
  'requires a checkpoint for ambiguous process-loss errors',
  'mints one protocol-valid deterministic identity per source turn',
  'derives the monotonic retry counter from raw controls or compacted terminal stamps',
  'resets one first-event silent recovery, then persistently pauses the same no-progress lineage',
  'pauses a runner-loss lineage after two zero-progress attempts, not one',
  'keeps the ordinary retry budget once model, tool, or token progress exists',
  'derives checkpoint safety from exact process and external-action states',
] as const

const C_SESSION_DELETED_LEAVES = [
  'session_deleted persist is SESSION_DELETED, not retryable, and never starts container work',
  'session_deleted admit is SESSION_DELETED, not retryable, and never starts container work',
] as const

const C_FULL_FILES = [
  'packages/commercial/src/__tests__/durableCursorBilling.test.ts',
  'packages/commercial/src/__tests__/boundedReadOnly.test.ts',
  'packages/commercial/src/__tests__/liveFrameClassification.test.ts',
  'packages/commercial/src/chatgptProxy/__tests__/server.test.ts',
  'packages/protocol/src/__tests__/turnErrorTaxonomy.test.ts',
] as const

const C_SESSION_DELETED_FILES = [
  'packages/commercial/src/__tests__/userChatBridge.test.ts',
  'packages/commercial/src/__tests__/modelAuthorityBridge.test.ts',
] as const

function resolveTsx(fromRoot: string): string {
  try {
    return createRequire(join(fromRoot, 'package.json')).resolve('tsx')
  } catch (first) {
    const snapshot = '/opt/openclaude/node_modules/tsx/dist/loader.mjs'
    if (existsSync(snapshot)) return snapshot
    throw first
  }
}

function summaryValue(tap: string, key: string): number {
  const values = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))].map((m) => Number(m[1]))
  assert.equal(values.length, 1, `TAP ${key} must appear exactly once`)
  return values[0]!
}

function parseLeafLine(line: string, leafIndent: 4 | 8 = 4): { ok: boolean; name: string; skip: string | null; todo: boolean } | null {
  const match = new RegExp(`^( {${leafIndent}})(not )?ok \\d+ - (.+)$`).exec(line)
  if (!match) return null
  const rest = match[3]!
  const directive = /^(.*?)\s+#\s*(SKIP|TODO)\b(.*)$/i.exec(rest)
  if (!directive) return { ok: !match[2], name: rest.trim(), skip: null, todo: false }
  const kind = directive[2]!.toUpperCase()
  const reason = directive[3]!.replace(/^\s*:\s*/, '').trim()
  return {
    ok: !match[2],
    name: directive[1]!.trim(),
    skip: kind === 'SKIP' ? reason : null,
    todo: kind === 'TODO',
  }
}

function assertExactLeaves(actual: string[], expected: readonly string[], label: string): void {
  const counts = new Map<string, number>()
  for (const name of actual) counts.set(name, (counts.get(name) ?? 0) + 1)
  for (const name of expected) {
    assert.equal(counts.get(name), 1, `${label}: leaf must appear exactly once: ${name}`)
    counts.delete(name)
  }
  assert.equal(counts.size, 0, `${label}: unexpected leaves ${[...counts.keys()].join(', ')}`)
}

function assertFullTap(tap: string, expected: readonly string[], label: string, leafIndent: 4 | 8 = 4): void {
  assert.equal((tap.match(/^TAP version 13\r?$/gm) ?? []).length, 1, `${label}: missing TAP header`)
  assert.equal((tap.match(/^1\.\.\d+\r?$/gm) ?? []).length, 1, `${label}: missing complete root plan`)
  assert.doesNotMatch(tap, /^\s*not ok\b|^\s*Bail out!/gm)
  const leaves: string[] = []
  for (const line of tap.split(/\r?\n/)) {
    const parsed = parseLeafLine(line, leafIndent)
    if (!parsed) continue
    if (!parsed.ok || parsed.todo || parsed.skip) {
      throw new Error(`${label}: leaf must pass without skip/todo: ${line}`)
    }
    leaves.push(parsed.name)
  }
  assertExactLeaves(leaves, expected, label)
  assert.equal(summaryValue(tap, 'tests'), expected.length, `${label}: tests`)
  assert.equal(summaryValue(tap, 'pass'), expected.length, `${label}: pass`)
  assert.equal(summaryValue(tap, 'fail'), 0, `${label}: fail`)
  assert.equal(summaryValue(tap, 'cancelled'), 0, `${label}: cancelled`)
  assert.equal(summaryValue(tap, 'skipped'), 0, `${label}: skipped`)
  assert.equal(summaryValue(tap, 'todo'), 0, `${label}: todo`)
  assert.equal((tap.match(/^# duration_ms [0-9.]+\r?$/gm) ?? []).length, 1, `${label}: missing TAP completion summary`)
}

function assertSelectedTap(tap: string, expected: readonly string[], label: string, leafIndent: 4 | 8 = 4): void {
  assert.equal((tap.match(/^TAP version 13\r?$/gm) ?? []).length, 1, `${label}: missing TAP header`)
  assert.equal((tap.match(/^1\.\.\d+\r?$/gm) ?? []).length, 1, `${label}: missing complete root plan`)
  assert.doesNotMatch(tap, /^\s*not ok\b|^\s*Bail out!/gm)
  const selected: string[] = []
  let filteredSkips = 0
  for (const line of tap.split(/\r?\n/)) {
    const parsed = parseLeafLine(line, leafIndent)
    if (!parsed) continue
    const wanted = (expected as readonly string[]).includes(parsed.name)
    if (wanted) {
      if (!parsed.ok || parsed.todo || parsed.skip) {
        throw new Error(`${label}: selected leaf must pass: ${line}`)
      }
      selected.push(parsed.name)
      continue
    }
    if (parsed.todo) throw new Error(`${label}: unexpected TODO: ${line}`)
    if (!parsed.ok) throw new Error(`${label}: unexpected failure: ${line}`)
    if (parsed.skip !== 'test name does not match pattern') {
      throw new Error(`${label}: non-selected skip must be runner filter: ${line}`)
    }
    filteredSkips += 1
  }
  assertExactLeaves(selected, expected, label)
  assert.equal(summaryValue(tap, 'fail'), 0, `${label}: fail`)
  assert.equal(summaryValue(tap, 'cancelled'), 0, `${label}: cancelled`)
  assert.equal(summaryValue(tap, 'todo'), 0, `${label}: todo`)
  assert.equal(summaryValue(tap, 'pass'), expected.length, `${label}: selected pass`)
  assert.equal(summaryValue(tap, 'skipped'), filteredSkips, `${label}: filtered skips`)
  assert.equal(summaryValue(tap, 'tests'), expected.length + filteredSkips, `${label}: tests`)
  assert.equal((tap.match(/^# duration_ms [0-9.]+\r?$/gm) ?? []).length, 1, `${label}: missing TAP completion summary`)
}

async function runTapProof(opts: {
  fromRoot: string
  files: readonly string[]
  expected: readonly string[]
  label: string
  timeoutMs: number
  namePattern?: string
  leafIndent?: 4 | 8
}): Promise<void> {
  for (const rel of opts.files) {
    const abs = join(opts.fromRoot, rel)
    if (!existsSync(abs)) throw new Error(`${opts.label}: missing fixture ${rel}`)
    readFileSync(abs)
  }
  const tsx = resolveTsx(opts.fromRoot)
  const home = mkdtempSync(join(tmpdir(), 'oc-c-data-safety-proof-'))
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const dir of ['home', 'state', 'tmp']) mkdirSync(join(home, dir))
  env.HOME = join(home, 'home')
  env.OPENCLAUDE_HOME = join(home, 'state')
  env.TMPDIR = join(home, 'tmp')
  env.NO_COLOR = '1'
  const args = ['--import', tsx, '--test', '--test-reporter=tap']
  if (opts.namePattern) args.push(`--test-name-pattern=${opts.namePattern}`)
  args.push(...opts.files.map((rel) => join(opts.fromRoot, rel)))
  try {
    const tap = await new Promise<string>((resolveProof, rejectProof) => {
      const child = spawn(process.execPath, args, {
        cwd: opts.fromRoot,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let failure: Error | undefined
      const stop = (reason: string): void => {
        failure ??= new Error(reason)
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') failure = err as Error
          }
        }
      }
      const onInterrupt = (): void => stop(`${opts.label} interrupted`)
      process.on('SIGINT', onInterrupt)
      process.on('SIGTERM', onInterrupt)
      const timer = setTimeout(() => stop(`${opts.label} timed out`), opts.timeoutMs)
      const capture = (target: 'stdout' | 'stderr', data: Buffer): void => {
        bytes += data.length
        if (bytes > 8 * 1024 * 1024) {
          stop(`${opts.label} exceeded output bound`)
          return
        }
        if (target === 'stdout') stdout += data.toString('utf8')
        else stderr += data.toString('utf8')
      }
      child.stdout.on('data', (data: Buffer) => capture('stdout', data))
      child.stderr.on('data', (data: Buffer) => capture('stderr', data))
      child.on('error', (err) => {
        failure ??= err
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        process.off('SIGINT', onInterrupt)
        process.off('SIGTERM', onInterrupt)
        if (failure || code !== 0 || signal !== null) {
          rejectProof(
            new Error(`${failure?.message ?? `${opts.label} exit=${code} signal=${signal}`}\n${stdout}\n${stderr}`),
          )
          return
        }
        resolveProof(stdout)
      })
    })
    if (opts.namePattern) assertSelectedTap(tap, opts.expected, opts.label, opts.leafIndent)
    else assertFullTap(tap, opts.expected, opts.label, opts.leafIndent)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

await runTapProof({
  fromRoot: candidateRoot,
  files: C_FULL_FILES,
  expected: C_FULL_LEAVES,
  label: 'c-data-safety-full',
  timeoutMs: 120_000,
})
await runTapProof({
  fromRoot: candidateRoot,
  files: C_SESSION_DELETED_FILES,
  expected: C_SESSION_DELETED_LEAVES,
  label: 'c-session-deleted',
  timeoutMs: 60_000,
  namePattern: 'session_deleted (persist|admit) is SESSION_DELETED',
})

console.log(
  '[cursor-audit-settle-gap] PASS — INC-20260908-CURSOR-AUDIT-SETTLE-GAP executed settle-before-close unique-23505 and COMMIT-before-close',
)
console.log(
  '[chatgpt-connect-cap] PASS — INC-20260908-CHATGPT-CONNECT-CAP executed pending+active reservation transport proof',
)
console.log(
  '[session-deleted-wire] PASS — INC-20260908-SESSION-DELETED-WIRE executed admit+persist SESSION_DELETED transport proof',
)
console.log(
  '[live-frame-classify] PASS — INC-20260908-LIVE-FRAME-CLASSIFY executed bounded helper classify/unknown/connect/query proof',
)

// INC-20260908-LATE-DELEGATE-OWNER: source regression guard, not end-to-end proof.
// Isolated unit suites cover seal/sink-pending/T2 isolation, validator,
// materialize stamp, persist owner-merge, and the read-only historical planner.
const lateDelegateHelperSrc = readFileSync(join(root, 'packages/gateway/src/delegateLateCompletion.ts'), 'utf8')
const lateSessionManagerSrc = readFileSync(join(root, 'packages/gateway/src/sessionManager.ts'), 'utf8')
const lateServerSrc = readFileSync(join(root, 'packages/gateway/src/server.ts'), 'utf8')
const lateTapeSrc = readFileSync(join(root, 'packages/commercial/src/http/losslessTurnTape.ts'), 'utf8')
const latePersistSrc = readFileSync(join(root, 'packages/web-react/src/lib/persist.ts'), 'utf8')
const lateSocketSrc = readFileSync(join(root, 'packages/web-react/src/lib/chat/socket.ts'), 'utf8')
const latePgSrc = readFileSync(join(root, 'packages/commercial/src/db/pgSessionsBackend.ts'), 'utf8')
const latePlannerSrc = readFileSync(join(root, 'scripts/ops/requeue-failed-tape-jobs.ts'), 'utf8')
for (const [name, src, marker] of [
  ['delegateLateCompletion.ts', lateDelegateHelperSrc, 'export function lateDelegateLogicalRunKey('],
  ['sessionManager.ts', lateSessionManagerSrc, 'deliverLateDelegateAgentGroup('],
  ['sessionManager.ts', lateSessionManagerSrc, 'this._sealOwnerTurn(session, turnKey)'],
  ['sessionManager.ts', lateSessionManagerSrc, 'private _admitExactOwnerRun('],
  ['sessionManager.ts', lateSessionManagerSrc, "if (rec.state === 'buffered' || rec.state === 'inflight') continue"],
  ['server.ts', lateServerSrc, 'delegate card dropped: missing frozen owner locator'],
  ['losslessTurnTape.ts', lateTapeSrc, 'const groupBillingOwnerTurnKey = continuationOfTurnKey ?? turnKey'],
  ['persist.ts', latePersistSrc, 'export function reconcileLateDelegateAgentGroups('],
  ['socket.ts', lateSocketSrc, 's.messages = reconcileLateDelegateAgentGroups(s.messages)'],
  ['pgSessionsBackend.ts', latePgSrc, '{ continuationOfTurnKey: header.continuationOfTurnKey }'],
  ['pgSessionsBackend.ts', latePgSrc, 't.continuation_of_turn_key'],
  ['pgSessionsBackend.ts', latePgSrc, '{ continuationOfTurnKey: extras?.continuationOfTurnKey }'],
  ['requeue-failed-tape-jobs.ts', latePlannerSrc, 'oc-late-delegate-plan-v2\\0'],
  ['requeue-failed-tape-jobs.ts', latePlannerSrc, 'partial_request_fence'],
] as const) {
  if (!src.includes(marker)) {
    throw new Error(`[late-delegate-owner] ${name} lost exact-owner contract: ${marker}`)
  }
}
if (!lateDelegateHelperSrc.includes('.update(\'oc-late-delegate-run-v1\\0\')')) {
  throw new Error('[late-delegate-owner] tape key must derive from the logical run, not the content hash')
}
console.log('[late-delegate-owner] PASS — INC-20260908-LATE-DELEGATE-OWNER: source regression guard, not end-to-end proof.')

// Execute reviewed B1 behavior with exact leaf names/counts; no production DB.
const B1_OWNER_LEAVES = [
  "identity is deterministic and insertion-order insensitive",
  "locator validation is strict",
  "continuation args carry owner locator, empty text, deterministic 64-hex tape key",
  "seal-before: matching current turn buffers and drains with that turn",
  "sealed owner rejects re-buffer; the caller must use the late path",
  "cross-turn owner is rejected: a T1 group never buffers onto T2",
  "drain(turnKey) never takes another turn’s late entries",
  "invalid locator is rejected before touching the buffer",
  "absent parent session returns false (caller persists via frozen locator)",
  "same owner/run is idempotent in the ordinary buffer; conflict is visible",
  "cross-session owner locator is rejected even when turnKey matches",
  "writes one restricted continuation; retry is idempotent; conflict suppressed",
  "cross-session sessionKey/peer mismatch never schedules a write",
  "invalid locator never schedules a write",
  "queued outcome is reliable waiting, not a drop: retry keeps one card",
  "stageDurable failure does not cache-swallow the same payload retry",
  "concurrent same-payload late deliveries merge into one inflight write",
  "session_deleted is terminal and does not resurrect",
  "acked root run stays unique after FIFO eviction of the admission map",
  "root drain claims the logical run so late does not mint a second card",
  "256 sequential ACK of other owners cannot duplicate a live buffered run",
  "sink-pending inflight survives other-owner ACK churn; late does not mint a second card",
  "fresh manager stages a late completion without relying on local root state",
  "root persist drop is not durable: late retry of the same run is allowed",
  "seal-after path: one continuation card for T1, zero pollution in T2, no duplicate",
  "seal-before contrast: the same group buffered mid-turn rides the owner tape",
  "freezes the exact owner at launch and passes it to the buffer",
  "routes to the persistent late path when the exact-owner buffer rejects",
  "falls back to ownerless buffering when no webchat progress target exists",
  "512 capacity-rejected attempts cannot evict a live frozen owner onto T2"
] as const
await runTapProof({
  fromRoot: candidateRoot,
  files: ["packages/gateway/src/__tests__/delegateLateCompletion.test.ts"],
  expected: B1_OWNER_LEAVES,
  label: "b1-owner",
  timeoutMs: 120_000,
  leafIndent: 8,
})

const B1_SHUTDOWN_LEAVES = [
  "shutdown waits for the real durable receipt before clearing the sink, not for a local root lookup",
  "a missing managed sink rejection is consumed and releases admission for a later durable retry"
] as const
await runTapProof({
  fromRoot: candidateRoot,
  files: ["packages/gateway/src/__tests__/lateDelegateShutdown.test.ts"],
  expected: B1_SHUTDOWN_LEAVES,
  label: "b1-shutdown",
  timeoutMs: 120_000,
  leafIndent: 4,
})

const B1_ROOT_LEAVES = [
  "fingerprint changes when transcript/status change and ignores ordinal",
  "inspect: same published records are idempotent; different content conflicts; parts stay deleted",
  "inspect: missing root, incomplete records, or lookup EIO are retryable",
  "inspect: ready root without the run proceeds; other user retry; envelope session mismatch rejects",
  "prepare skips materialize when root already has the same run",
  "finalize HTTP path is idempotent and does not run Phase A visible publish",
  "finalize retries when owner records are incomplete, not when parts were legally deleted",
  "finalize conflicts when root run content differs",
  "leader: same run cannot ACK before the root is durable and visible",
  "leader: idempotent root hit must not bypass payload/envelope locator check",
  "inspect: unready root is retry; header/record identity mismatch is retry",
  "ordinary root finalize does not extra-read all parts before admission",
  "same run on purged-parts root ACKs 200 and drains",
  "no-run purged-parts root publishes Phase A and dequeues",
  "root clientMessageId stamp ACKs the same run and real drain never quarantines",
  "legacy unstamped root does not acquire a later header clientMessageId stamp",
  "root header versus published origin mismatch is an immutable conflict",
  "late group cannot hide its conflicting origin under the trusted root stamp",
  "different published content is 409 fatal, not a durable retry loop",
  "unready root queues then drains after visible+finalized records appear",
  "EIO then restore published records drains the real queue"
] as const
await runTapProof({
  fromRoot: candidateRoot,
  files: ["packages/commercial/src/__tests__/lateDelegateRootAuthority.test.ts"],
  expected: B1_ROOT_LEAVES,
  label: "b1-root",
  timeoutMs: 120_000,
  leafIndent: 4,
})

const B1_DIRECT_LEAVES = [
  "hydrateDirectTapePage deferred locator carries header owner, not a pre-stamped fixture",
  "listTurnTapeRecordsImpl forward and before stamp continuation owner from header SELECT"
] as const
await runTapProof({
  fromRoot: candidateRoot,
  files: ["packages/commercial/src/__tests__/directTapePageOwner.test.ts"],
  expected: B1_DIRECT_LEAVES,
  label: "b1-direct",
  timeoutMs: 120_000,
  leafIndent: 4,
})

const B1_PLANNER_LEAVES = [
  "parseRequeueArgs defaults to dry-run",
  "late-delegate planner: exact owner → continuation; missing root is retryable skip",
  "snapshot planner emits missing/unchecked instead of empty plans[]",
  "planner group hash covers transcript/result/status and fence is per-requestId",
  "CLI snapshot path prints per-group plans and refuses execute",
  "stage 1 requeues materialization; stage 2 skips when settlement is unverified",
  "complete materialization is not requeued",
  "verified matching billing job is kind-precise requeued",
  "verified mismatched authority stops at manual_reconcile",
  "job authority prefers column then payload",
  "waiver jobs must match turnKey and reason, not only billingAnchorId",
  "any manual_reconcile settlement blocks every settlement requeue on that tape",
  "production target matches env-file source and host, not only exact db name",
  "resolveTapeIdentities refuses tape_id LIMIT 1 collisions",
  "execute re-reads under composite FOR UPDATE in the same transaction"
] as const
await runTapProof({
  fromRoot: candidateRoot,
  files: ["scripts/__tests__/requeueFailedTapeJobs.test.ts"],
  expected: B1_PLANNER_LEAVES,
  label: "b1-planner",
  timeoutMs: 120_000,
  leafIndent: 4,
})

await runTapProof({
  fromRoot: candidateRoot,
  files: ['packages/gateway/src/__tests__/v3MasterSink.test.ts'],
  expected: ["late agent-group continuation defers visible until after parts+finalize"],
  label: 'b1-visible-order',
  timeoutMs: 60_000,
  namePattern: "late\\ agent\\-group\\ continuation\\ defers\\ visible\\ until\\ after\\ parts\\+finalize",
})
console.log("[late-delegate-owner] PASS — INC-20260908-LATE-DELEGATE-OWNER executed exact-owner seal, durable retry, root records, origin stamp and read-only planner")
