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


// INC-20260907-EGRESS-ZOMBIE-LISTENER: listener-first source contract deploy-gate.
// This prevents source regression; it is NOT the separate real-systemd long-stream proof.
const egressSlotUnit = readFileSync(
  join(root, 'deploy/v5-selfhost/openclaude-v5-selfhost-egress@.service'), 'utf8',
)
const selfhostDeploy = readFileSync(join(root, 'scripts/deploy-v5-selfhost.sh'), 'utf8')
const egressFail = (message: string): never => {
  throw new Error('[egress-listener-rootfix] ' + message)
}
function egressFunction(name: string): string {
  const start = selfhostDeploy.indexOf('\n' + name + '() {')
  const end = selfhostDeploy.indexOf('\n}', start)
  if (start < 0 || end < 0) egressFail('missing function ' + name)
  return selfhostDeploy.slice(start, end)
}
if (!/^Wants=.*openclaude-v5-selfhost-egress@%i.socket$/m.test(egressSlotUnit)
  || /^Requires=.*openclaude-v5-selfhost-egress@%i.socket/m.test(egressSlotUnit)) {
  egressFail('socket must be wanted, not required, so listener close precedes service drain')
}
const stopSlot = egressFunction('egress_stop_slot')
const socketStop = stopSlot.indexOf('\n  systemctl stop "$sock" || return 1')
const asyncDrain = stopSlot.indexOf('\n    systemctl stop --no-block "$svc"')
if (socketStop < 0 || asyncDrain <= socketStop
  || /systemctl stop[^\n]*"\$sock"[^\n]*"\$svc"/.test(stopSlot)) {
  egressFail('socket stop must finish in its own blocking transaction before async service stop')
}
const flipEgress = egressFunction('egress_slot_flip')
const readySlot = flipEgress.indexOf('if ! egress_wait_slot_ready "$target"; then')
const retireSlot = flipEgress.indexOf('\n    egress_stop_slot "$cur" async || return 1')
const listenerWait = flipEgress.indexOf('\n  egress_wait_single_listener "$target"')
if (readySlot < 0 || retireSlot <= readySlot || listenerWait <= retireSlot) {
  egressFail('flip must wait for new readiness, retire old listener first, then wait for a single listener')
}
console.log('[egress-listener-rootfix] PASS — listener-first source contract (systemd lifecycle proof is separate)')
