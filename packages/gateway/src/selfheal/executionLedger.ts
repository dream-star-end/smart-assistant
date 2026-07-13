// Self-heal execution glue (slice ② / block B2a).
//
// Small, dependency-light domain helpers shared by the jobWorker (which drives
// repair turns) and the cancel path in server.ts. Keeping session-key
// derivation, the repair prompt, and the turn-output sink here means both
// call sites agree on the *same* deterministic session key — which is what
// makes crash recovery idempotent (a re-driven repair rebuilds the identical
// AgentSession) and what lets cancel find the exact session to kill.
//
// The at-most-once ledger primitives themselves live in
// @openclaude/storage/selfhealStore (enqueueExecution / claimQueuedTurn / …);
// this module deliberately holds no SQL.

import { SELFHEAL_AGENT_ID } from '@openclaude/storage'
import type { SessionStreamEvent } from '../sessionManager.js'

/** Agent id the jobWorker runs repairs under. Single authority lives in
 *  @openclaude/storage/config (also the runAsUser binding); re-exported here so
 *  existing gateway import sites are unchanged. */
export { SELFHEAL_AGENT_ID }

/**
 * Deterministic session key for a repair. Stable across process restarts so a
 * re-claimed (crash-recovered) job rebuilds the SAME AgentSession, and so the
 * cancel endpoint can locate the session from just the repair_id.
 */
export function selfhealSessionKey(repairId: string): string {
  return `selfheal:${repairId}`
}

/**
 * Per-repair keyed async mutex (design §A2 execution-side fence). The jobWorker
 * holds this lock across its terminal-state CAS + turn initiation, and the
 * cancel path holds the SAME lock across its status CAS + session teardown, so
 * the two can never interleave inside a repair: cancel-first ⇒ the worker's CAS
 * loses and zero turns are submitted; worker-first ⇒ cancel sees the live
 * session and tears it down before confirming `terminated`.
 *
 * Single-process premise (registered constraint): the personal gateway is one
 * node process (better-sqlite3 in-process); if it ever goes multi-process this
 * must be upgraded to a cross-process flock. The SQLite-transaction guards in
 * selfhealStore (enqueue/claim check job status) remain as the second fence.
 */
const _repairLockTails = new Map<string, Promise<void>>()

export function withRepairLock<T>(repairId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _repairLockTails.get(repairId) ?? Promise.resolve()
  // Run after the predecessor SETTLES (success or failure) — a crashed critical
  // section must never wedge the lock.
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  _repairLockTails.set(repairId, tail)
  void tail.then(() => {
    // GC the chain tail once no successor replaced it.
    if (_repairLockTails.get(repairId) === tail) _repairLockTails.delete(repairId)
  })
  return run
}

/**
 * Minimal, injection-free repair prompt. Only the constrained repairId and the
 * root-controlled clone path are interpolated — NO free text from the dispatch
 * payload ever reaches the model (the payload carries ids only, and repairId is
 * regex-validated at intake). All incident context is pulled by the agent
 * itself via `oc-selfheal context` (the broker holds the capability — the model
 * never sees credentials of any kind).
 */
export function buildRepairPrompt(repairId: string, clonePath: string): string {
  return [
    `selfheal repair ${repairId}.`,
    `工作目录(独立 clone,已就绪):${clonePath}`,
    '所有代码调查、修改、git commit 都只在该目录内进行;不得触碰 canonical 仓库或其它路径。',
    '特权操作与回报一律通过 `oc-selfheal` CLI(它只连 broker socket;你不持有任何凭据):',
    `  oc-selfheal context ${repairId}                     拉取结构化事件上下文`,
    `  oc-selfheal report ${repairId} progress|done|failed <message>   回报进度/终态`,
    `  oc-selfheal verify ${repairId} <sha>                对 clone 内 commit 跑降权四层验证`,
    `  oc-selfheal cutover ${repairId} <sha>               验证通过后申请上线(默认停在待人工放行)`,
    '严格按 skill v5-incident-repair 执行:先 report progress 确认接单,再 context 拉上下文,按等级修复;红线禁区以该 skill 为准。',
  ].join('\n')
}

export interface RepairTurnSink {
  onEvent: (e: SessionStreamEvent) => void
  /** Accumulated assistant text (for local logging / job telemetry only). */
  getOutput: () => string
  /** First error surfaced by the turn, if any. */
  getError: () => string | undefined
}

/**
 * Build an onEvent handler for a repair turn. Mirrors the cron/webhook sinks:
 * accumulates assistant text and captures the first error. The authoritative
 * repair status flows to v5 via the codex agent's own callbacks — this sink is
 * only for the gateway-local job lifecycle view.
 */
export function createRepairTurnSink(): RepairTurnSink {
  let output = ''
  let error: string | undefined
  return {
    onEvent: (e: SessionStreamEvent) => {
      if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
      if (e.kind === 'error' && !error) error = e.error
      if (e.kind === 'final' && e.meta?.isError === true && !error) {
        error = 'repair turn returned is_error=true'
      }
    },
    getOutput: () => output,
    getError: () => error,
  }
}
