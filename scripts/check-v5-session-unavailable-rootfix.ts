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

console.log(
  '[session-unavailable-rootfix] PASS — detach drain, durable cron receipt, rejected convergence and bounded memory retry are locked',
)
