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
