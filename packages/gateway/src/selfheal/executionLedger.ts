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
 * Minimal, injection-free repair prompt. Only the constrained repairId is
 * interpolated — NO free text from the dispatch payload ever reaches the model
 * (the payload carries ids only, and repairId is regex-validated at intake).
 * All incident context is pulled by the agent itself via the read-only v5
 * context callback (contract §拉上下文), gated by its short-lived capability.
 */
export function buildRepairPrompt(repairId: string): string {
  return [
    `selfheal repair ${repairId}.`,
    '严格按 skill v5-incident-repair 执行:先调用回调 ack,再拉取结构化上下文,按等级执行修复并回报 progress/verify/done。',
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
    },
    getOutput: () => output,
    getError: () => error,
  }
}
