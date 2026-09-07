import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
